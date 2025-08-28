// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes, isSameDay, isBefore, startOfToday, startOfMonth, endOfMonth } = require('date-fns');
const axios = require('axios');
const rateLimit = require('express-rate-limit'); // Import rate-limiting package

// ----- Firebase Configuration -----
try {
  const serviceAccount = require('./serviceAccountKey.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
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
const PAYSTACK_SECRET_KEY = 'sk_test_c75e440a7b40c66a47a8ab73605ec0ac3cdbaece';
const PAYSTACK_API_URL = 'https://api.paystack.co/transaction/initialize';
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify/';

// --- SECURITY: Rate Limiter ---
// Apply to all API routes to prevent abuse
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 100, // Limit each IP to 100 requests per window
	standardHeaders: true,
	legacyHeaders: false,
});
app.use('/api/', apiLimiter);


// --- Middleware to verify user is a manager ---
const isManager = async (req, res, next) => {
    const { authorization } = req.headers;
    if (!authorization || !authorization.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Unauthorized: No token provided.' });
    }
    const idToken = authorization.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (decodedToken.role === 'manager') {
            req.user = decodedToken;
            return next();
        } else {
            return res.status(403).send({ error: 'Forbidden: User is not a manager.' });
        }
    } catch (error) {
        return res.status(401).send({ error: 'Unauthorized: Invalid token.' });
    }
};

// ----- API Endpoints -----

app.get('/', (req, res) => res.send('Welcome API!'));

app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    const userProfile = { email: userRecord.email, name: userRecord.displayName, loyaltyPoints: 0, freeWashes: 0, role: 'customer' };
    await db.collection('users').doc(userRecord.uid).set(userProfile);
    res.status(201).send({ uid: userRecord.uid });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

app.post('/api/assign-manager-role', isManager, async (req, res) => { // Protected endpoint
    const { email } = req.body;
    if (!email) { return res.status(400).send({ error: 'Email is required.' }); }
    try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().setCustomUserClaims(user.uid, { role: 'manager' });
        await db.collection('users').doc(user.uid).update({ role: 'manager' });
        res.status(200).send({ message: `Successfully assigned manager role to ${email}` });
    } catch (error) {
        res.status(500).send({ error: 'Could not assign manager role.' });
    }
});

app.get('/api/services', async (req, res) => {
  try {
    const servicesSnapshot = await db.collection('services').get();
    const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.status(200).send(servicesList);
  } catch (error) {
    res.status(500).send({ error: 'Failed to fetch services.' });
  }
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) { return res.status(400).send({ error: 'Date query is required.' }); }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    if (isBefore(requestedDate, startOfToday())) { return res.status(200).send([]); }
    
    const dailySettingDoc = await db.collection('dailySettings').doc(date).get();
    let activeBays;
    if (dailySettingDoc.exists) {
        activeBays = dailySettingDoc.data().activeBays;
    } else {
        const globalSettingsDoc = await db.collection('settings').doc('washSettings').get();
        activeBays = globalSettingsDoc.exists ? globalSettingsDoc.data().activeBays : 1;
    }

    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);
    const openingHourUTC = 6, closingHourUTC = 14, slotInterval = 15;
    
    const allSlots = [];
    let currentTime = new Date(startOfRequestedDay);
    currentTime.setUTCHours(openingHourUTC, 0, 0, 0);
    const closingDateTime = new Date(startOfRequestedDay);
    closingDateTime.setUTCHours(closingHourUTC, 0, 0, 0);
    while (currentTime < closingDateTime) {
      allSlots.push(format(addMinutes(currentTime, 120), 'HH:mm'));
      currentTime = addMinutes(currentTime, slotInterval);
    }

    const bookingsSnapshot = await db.collection('bookings').where('startTime', '>=', startOfRequestedDay).where('startTime', '<=', endOfRequestedDay).get();
    const occupiedSlotCounts = {};
    for (const doc of bookingsSnapshot.docs) {
      const booking = doc.data();
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      if (!serviceDoc.exists) continue;
      const duration = serviceDoc.data().durationInMinutes;
      let slotTime = booking.startTime.toDate();
      for (let i = 0; i < Math.ceil(duration / slotInterval); i++) {
        const formattedSlot = format(addMinutes(slotTime, 120), 'HH:mm');
        occupiedSlotCounts[formattedSlot] = (occupiedSlotCounts[formattedSlot] || 0) + 1;
        slotTime = addMinutes(slotTime, slotInterval);
      }
    }

    const blockedSlotsSnapshot = await db.collection('blockedSlots').where('date', '==', date).get();
    const blockedSlots = new Set(blockedSlotsSnapshot.docs.map(doc => doc.data().slot));

    let availableSlots = allSlots.filter(slot => 
        ((occupiedSlotCounts[slot] || 0) < activeBays) && !blockedSlots.has(slot)
    );

    if (isSameDay(requestedDate, new Date())) {
      const currentTimeSAST = format(addMinutes(new Date(), 120), 'HH:mm');
      availableSlots = availableSlots.filter(slot => slot > currentTimeSAST);
    }
    res.status(200).send(availableSlots);
  } catch (error) {
    res.status(500).send({ error: 'Failed to fetch availability.' });
  }
});

app.post('/api/payments/checkout', async (req, res) => {
  try {
    const { amount, email } = req.body;
    const amountInCents = Math.round(amount * 100);
    const data = { email, amount: amountInCents, currency: 'ZAR' };
    const config = { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } };
    const paystackResponse = await axios.post(PAYSTACK_API_URL, data, config);
    res.status(200).send({ authorization_url: paystackResponse.data.data.authorization_url, reference: paystackResponse.data.data.reference });
  } catch (error) {
    res.status(500).send({ error: 'Failed to initialize payment.' });
  }
});

// --- UPDATED: SSRF Security Fix ---
app.get('/api/payments/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    // Sanitize the input to prevent SSRF attacks
    const validReferenceRegex = /^[a-zA-Z0-9_]+$/;
    if (!validReferenceRegex.test(reference)) {
        return res.status(400).send({ error: 'Invalid transaction reference format.' });
    }

    const config = { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } };
    const paystackResponse = await axios.get(`${PAYSTACK_VERIFY_URL}${reference}`, config);
    res.status(200).send({ status: paystackResponse.data.data.status });
  } catch (error) {
    res.status(500).send({ error: 'Failed to verify payment.' });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { userId, serviceId, startTime } = req.body;
    const correctUTCTime = addMinutes(new Date(startTime), -120);
    const dateKey = format(correctUTCTime, 'yyyy-MM-dd');

    const dailySettingDoc = await db.collection('dailySettings').doc(dateKey).get();
    let activeBays;
    if (dailySettingDoc.exists) {
        activeBays = dailySettingDoc.data().activeBays;
    } else {
        const globalSettingsDoc = await db.collection('settings').doc('washSettings').get();
        activeBays = globalSettingsDoc.exists ? globalSettingsDoc.data().activeBays : 1;
    }
    
    const existingBookings = await db.collection('bookings').where('startTime', '==', correctUTCTime).get();
    if (existingBookings.size >= activeBays) {
      return res.status(409).send({ error: 'Sorry, this time slot was just taken. Please select another time.' });
    }

    const newBooking = { userId, serviceId, startTime: correctUTCTime, status: 'paid', createdAt: new Date(), bayId: (existingBookings.size + 1) };
    const docRef = await db.collection('bookings').add(newBooking);

    const userRef = db.collection('users').doc(userId);
    let userDoc = await userRef.get();

    if (!userDoc.exists) {
        const authUser = await admin.auth().getUser(userId);
        const newUserProfile = {
            email: authUser.email,
            name: authUser.displayName,
            loyaltyPoints: 0,
            freeWashes: 0,
            role: 'customer'
        };
        await userRef.set(newUserProfile);
        userDoc = await userRef.get();
    }

    const currentPoints = userDoc.data().loyaltyPoints || 0;
    const newPoints = currentPoints + 1;
    if (newPoints >= 10) {
      await userRef.update({ loyaltyPoints: 0, freeWashes: admin.firestore.FieldValue.increment(1) });
    } else {
      await userRef.update({ loyaltyPoints: newPoints });
    }
    
    res.status(201).send({ message: 'Booking created successfully!', bookingId: docRef.id });
  } catch (error) {
    console.error('[Booking] CRITICAL ERROR creating booking:', error);
    res.status(500).send({ error: 'Failed to create booking.' });
  }
});

app.get('/api/manager/bookings', isManager, async (req, res) => {
  const { date } = req.query;
  if (!date) { return res.status(400).send({ error: 'Date query parameter is required.' }); }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);
    const bookingsSnapshot = await db.collection('bookings').where('startTime', '>=', startOfRequestedDay).where('startTime', '<=', endOfRequestedDay).orderBy('startTime', 'asc').get();
    const detailedBookings = await Promise.all(bookingsSnapshot.docs.map(async (doc) => {
      const booking = doc.data();
      const userDoc = await db.collection('users').doc(booking.userId).get();
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      return {
        id: doc.id,
        ...booking,
        userName: userDoc.exists ? userDoc.data().name : 'Unknown User',
        serviceName: serviceDoc.exists ? serviceDoc.data().name : 'Unknown Service',
        startTimeSAST: format(addMinutes(booking.startTime.toDate(), 120), 'HH:mm'),
      };
    }));
    res.status(200).send(detailedBookings);
  } catch (error) {
    console.error('[Manager] CRITICAL ERROR fetching manager bookings:', error);
    res.status(500).send({ error: 'Failed to fetch bookings.' });
  }
});

app.get('/api/manager/bookings/summary', isManager, async (req, res) => {
    const { month, year } = req.query;
    if (!month || !year) {
        return res.status(400).send({ error: 'Month and year are required.' });
    }
    try {
        const startDate = startOfMonth(new Date(year, month - 1, 1));
        const endDate = endOfMonth(startDate);
        const bookingsSnapshot = await db.collection('bookings').where('startTime', '>=', startDate).where('startTime', '<=', endDate).get();
        const serviceCounts = {};
        await Promise.all(bookingsSnapshot.docs.map(async (doc) => {
            const booking = doc.data();
            const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
            if (serviceDoc.exists) {
                const serviceName = serviceDoc.data().name;
                serviceCounts[serviceName] = (serviceCounts[serviceName] || 0) + 1;
            }
        }));
        const summaryArray = Object.keys(serviceCounts).map(serviceName => ({
            serviceName,
            count: serviceCounts[serviceName]
        }));
        res.status(200).send(summaryArray);
    } catch (error) {
        console.error('[Manager] Error fetching booking summary:', error);
        res.status(500).send({ error: 'Failed to fetch booking summary.' });
    }
});

app.get('/api/manager/settings', isManager, async (req, res) => {
    const { date } = req.query;
    if (!date) { return res.status(400).send({ error: "Date is required." }); }
    try {
        const dailySettingDoc = await db.collection('dailySettings').doc(date).get();
        if (dailySettingDoc.exists) { return res.status(200).send(dailySettingDoc.data()); }
        const globalSettingsDoc = await db.collection('settings').doc('washSettings').get();
        if (!globalSettingsDoc.exists) { return res.status(404).send({ error: 'Default settings not found.' }); }
        res.status(200).send(globalSettingsDoc.data());
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch settings.' });
    }
});

app.post('/api/manager/settings/activeBays', isManager, async (req, res) => {
    const { count, date } = req.body;
    if (typeof count !== 'number' || (count !== 1 && count !== 2) || !date) {
        return res.status(400).send({ error: 'Invalid count or date provided.' });
    }
    try {
        await db.collection('dailySettings').doc(date).set({ activeBays: count });
        res.status(200).send({ message: `Active bays for ${date} successfully set to ${count}.` });
    } catch (error) {
        res.status(500).send({ error: 'Failed to update settings.' });
    }
});

app.get('/api/manager/blocked-slots', isManager, async (req, res) => {
    const { date } = req.query;
    if (!date) { return res.status(400).send({ error: 'Date is required.' }); }
    try {
        const snapshot = await db.collection('blockedSlots').where('date', '==', date).get();
        const slots = snapshot.docs.map(doc => doc.data().slot);
        res.status(200).send(slots);
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch blocked slots.' });
    }
});

app.post('/api/manager/blocked-slots', isManager, async (req, res) => {
    const { date, slot } = req.body;
    if (!date || !slot) { return res.status(400).send({ error: 'Date and slot are required.' }); }
    try {
        const slotId = `${date}_${slot}`;
        const slotRef = db.collection('blockedSlots').doc(slotId);
        const doc = await slotRef.get();
        if (doc.exists) {
            await slotRef.delete();
            res.status(200).send({ message: `Slot ${slot} on ${date} has been unblocked.` });
        } else {
            await slotRef.set({ date, slot });
            res.status(200).send({ message: `Slot ${slot} on ${date} has been blocked.` });
        }
    } catch (error) {
        res.status(500).send({ error: 'Failed to update blocked slot.' });
    }
});

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});
