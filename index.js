// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes, isSameDay, isBefore, startOfToday } = require('date-fns');
const axios = require('axios');

// ----- Firebase Configuration -----
try {
  const serviceAccount = require('./serviceAccountKey.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  }
} catch (e) {
  console.error("CRITICAL: Firebase Admin SDK initialization failed!", e);
}
const db = admin.firestore();

// ----- App Configuration -----
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

// --- Paystack Credentials ---
// Your actual test key has been added here.
const PAYSTACK_SECRET_KEY = 'sk_test_c75e440a7b40c66a47a8ab73605ec0ac3cdbaece';
const PAYSTACK_API_URL = 'https://api.paystack.co/transaction/initialize';

// ----- API Endpoints -----

app.get('/', (req, res) => res.send('Welcome API!'));

app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: name,
    });
    const userProfile = {
      email: userRecord.email,
      name: userRecord.displayName,
      loyaltyPoints: 0,
      freeWashes: 0,
    };
    await db.collection('users').doc(userRecord.uid).set(userProfile);
    res.status(201).send({ uid: userRecord.uid });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

app.get('/api/services', async (req, res) => {
  try {
    const servicesSnapshot = await db.collection('services').get();
    const servicesList = [];
    servicesSnapshot.forEach((doc) => {
      servicesList.push({ id: doc.id, ...doc.data() });
    });
    res.status(200).send(servicesList);
  } catch (error) {
    console.error("Error in /api/services:", error);
    res.status(500).send({ error: 'Failed to fetch services.' });
  }
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).send({ error: 'Date query parameter is required.' });
  }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    if (isBefore(requestedDate, startOfToday())) {
      return res.status(200).send([]);
    }
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);
    const openingHourUTC = 6;
    const closingHourUTC = 14;
    const slotInterval = 15;
    const allSlots = [];
    let currentTime = new Date(startOfRequestedDay);
    currentTime.setUTCHours(openingHourUTC, 0, 0, 0);
    const closingDateTime = new Date(startOfRequestedDay);
    closingDateTime.setUTCHours(closingHourUTC, 0, 0, 0);
    while (currentTime < closingDateTime) {
      const sastTime = addMinutes(currentTime, 120);
      allSlots.push(format(sastTime, 'HH:mm'));
      currentTime = addMinutes(currentTime, slotInterval);
    }
    const bookingsSnapshot = await db.collection('bookings').where('startTime', '>=', startOfRequestedDay).where('startTime', '<=', endOfRequestedDay).get();
    const occupiedSlots = new Set();
    for (const doc of bookingsSnapshot.docs) {
      const booking = doc.data();
      const bookingStartTime = booking.startTime.toDate();
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      if (!serviceDoc.exists) continue;
      const duration = serviceDoc.data().durationInMinutes;
      const numberOfSlotsToOccupy = Math.ceil(duration / slotInterval);
      let slotTime = new Date(bookingStartTime);
      for (let i = 0; i < numberOfSlotsToOccupy; i++) {
        const sastSlotTime = addMinutes(slotTime, 120);
        occupiedSlots.add(format(sastSlotTime, 'HH:mm'));
        slotTime = addMinutes(slotTime, slotInterval);
      }
    }
    let availableSlots = allSlots.filter(slot => !occupiedSlots.has(slot));
    const now = new Date();
    if (isSameDay(requestedDate, now)) {
      const currentTimeSAST = format(addMinutes(now, 120), 'HH:mm');
      availableSlots = availableSlots.filter(slot => slot > currentTimeSAST);
    }
    res.status(200).send(availableSlots);
  } catch (error) {
    console.error('Error in /api/availability:', error);
    res.status(500).send({ error: 'Failed to fetch availability.' });
  }
});

app.post('/api/payments/checkout', async (req, res) => {
  try {
    const { amount, email } = req.body;
    if (!amount || !email) {
      return res.status(400).send({ error: 'Amount and email are required.' });
    }
    const amountInCents = Math.round(amount * 100);
    const data = { email, amount: amountInCents, currency: 'ZAR' };
    const config = {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    };
    const paystackResponse = await axios.post(PAYSTACK_API_URL, data, config);
    res.status(200).send({ authorization_url: paystackResponse.data.data.authorization_url });
  } catch (error) {
    console.error("Error creating Paystack transaction:", error.response?.data || error.message);
    res.status(500).send({ error: 'Failed to initialize payment.' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { userId, serviceId, startTime } = req.body;
    if (!userId || !serviceId || !startTime) {
      return res.status(400).send({ error: 'Missing required booking information.' });
    }
    const newBooking = {
      userId,
      serviceId,
      startTime: new Date(startTime),
      status: 'paid',
      createdAt: new Date(),
    };
    const docRef = await db.collection('bookings').add(newBooking);
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
      const currentPoints = userDoc.data().loyaltyPoints || 0;
      const newPoints = currentPoints + 1;
      if (newPoints >= 10) {
        await userRef.update({
          loyaltyPoints: 0,
          freeWashes: admin.firestore.FieldValue.increment(1),
        });
      } else {
        await userRef.update({ loyaltyPoints: newPoints });
      }
    }
    res.status(201).send({
      message: 'Booking created successfully!',
      bookingId: docRef.id,
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send({ error: 'Failed to create booking.' });
  }
});

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});





