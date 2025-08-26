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

// ... (your existing signup, services, payment, and booking endpoints)
app.post('/auth/signup', async (req, res) => { /* ... */ });
app.post('/api/assign-manager-role', async (req, res) => { /* ... */ });
app.get('/api/services', async (req, res) => { /* ... */ });


app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) { return res.status(400).send({ error: 'Date query is required.' }); }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    if (isBefore(requestedDate, startOfToday())) { return res.status(200).send([]); }
    
    // Get settings
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
    
    // Generate all possible slots
    const allSlots = [];
    let currentTime = new Date(startOfRequestedDay);
    currentTime.setUTCHours(openingHourUTC, 0, 0, 0);
    const closingDateTime = new Date(startOfRequestedDay);
    closingDateTime.setUTCHours(closingHourUTC, 0, 0, 0);
    while (currentTime < closingDateTime) {
      allSlots.push(format(addMinutes(currentTime, 120), 'HH:mm'));
      currentTime = addMinutes(currentTime, slotInterval);
    }

    // Get customer bookings
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

    // --- NEW: Get manager-blocked slots ---
    const blockedSlotsSnapshot = await db.collection('blockedSlots').where('date', '==', date).get();
    const blockedSlots = new Set(blockedSlotsSnapshot.docs.map(doc => doc.data().slot));

    // Filter out slots
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

// ... (your existing payment and booking endpoints)

// --- NEW: Manager endpoints for blocking slots ---
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
        const slotId = `${date}_${slot}`; // Create a unique ID for the slot
        const slotRef = db.collection('blockedSlots').doc(slotId);
        const doc = await slotRef.get();

        if (doc.exists) {
            // If the slot is already blocked, unblock it
            await slotRef.delete();
            res.status(200).send({ message: `Slot ${slot} on ${date} has been unblocked.` });
        } else {
            // Otherwise, block it
            await slotRef.set({ date, slot });
            res.status(200).send({ message: `Slot ${slot} on ${date} has been blocked.` });
        }
    } catch (error) {
        res.status(500).send({ error: 'Failed to update blocked slot.' });
    }
});


// ... (rest of your endpoints)
// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});

