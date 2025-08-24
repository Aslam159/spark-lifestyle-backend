// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes } = require('date-fns');

// ----- Firebase Configuration -----
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin SDK initialized successfully.");
} catch (e) {
  console.error("CRITICAL: Firebase Admin SDK initialization failed!", e);
}
const db = admin.firestore();

// ----- App Configuration -----
const app = express();
app.use(cors());
app.use(express.json());
const PORT = 3001;

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
    console.error("ERROR inside /api/services:", error);
    res.status(500).send({ error: 'Failed to fetch services.' });
  }
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).send({ error: 'Date query parameter is required.' });
  }
  try {
    // --- FINAL TIMEZONE FIX: All calculations will be in UTC ---
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);
    
    // Operating hours in SAST (UTC+2) converted to UTC
    const openingHourUTC = 6; // 8 AM SAST
    const closingHourUTC = 14; // 4 PM SAST
    const slotInterval = 15;
    
    const allSlots = [];
    let currentTime = new Date(startOfRequestedDay);
    currentTime.setUTCHours(openingHourUTC, 0, 0, 0);
    const closingDateTime = new Date(startOfRequestedDay);
    closingDateTime.setUTCHours(closingHourUTC, 0, 0, 0);

    // Generate all slots and format them to SAST for the app
    while (currentTime < closingDateTime) {
      // Add 2 hours to display the time in SAST
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
        // Add 2 hours to the booking time to match the SAST display format
        const sastSlotTime = addMinutes(slotTime, 120);
        occupiedSlots.add(format(sastSlotTime, 'HH:mm'));
        slotTime = addMinutes(slotTime, slotInterval);
      }
    }
    const availableSlots = allSlots.filter(slot => !occupiedSlots.has(slot));
    res.status(200).send(availableSlots);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).send({ error: 'Failed to fetch availability.' });
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
      status: 'booked',
      createdAt: new Date(),
    };
    const docRef = await db.collection('bookings').add(newBooking);
    res.status(201).send({
      message: 'Booking created successfully!',
      bookingId: docRef.id,
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send({ error: 'Failed to fetch booking.' });
  }
});

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});

