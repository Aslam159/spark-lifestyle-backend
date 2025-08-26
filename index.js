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
  // ... (existing isManager middleware code)
};

// ----- API Endpoints -----

app.get('/', (req, res) => res.send('Welcome API!'));

// ... (your existing signup, services, payment, and booking endpoints)

// --- UPDATED: Availability Endpoint with Daily Settings Logic ---
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

    // 1. Check for a date-specific setting first
    const dailySettingDoc = await db.collection('dailySettings').doc(date).get();
    let activeBays;
    if (dailySettingDoc.exists) {
        activeBays = dailySettingDoc.data().activeBays;
    } else {
        // 2. Fall back to the global setting
        const globalSettingsDoc = await db.collection('settings').doc('washSettings').get();
        activeBays = globalSettingsDoc.exists ? globalSettingsDoc.data().activeBays : 1;
    }

    // ... (rest of the availability logic remains the same)
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
    const occupiedSlotCounts = {};
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
        const formattedSlot = format(sastSlotTime, 'HH:mm');
        occupiedSlotCounts[formattedSlot] = (occupiedSlotCounts[formattedSlot] || 0) + 1;
        slotTime = addMinutes(slotTime, slotInterval);
      }
    }
    let availableSlots = allSlots.filter(slot => (occupiedSlotCounts[slot] || 0) < activeBays);
    const now = new Date();
    if (isSameDay(requestedDate, now)) {
      const currentTimeSAST = format(addMinutes(now, 120), 'HH:mm');
      availableSlots = availableSlots.filter(slot => slot > currentTimeSAST);
    }
    res.status(200).send(availableSlots);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).send({ error: 'Failed to fetch availability.' });
  }
});


// --- UPDATED: Manager endpoints to handle daily settings ---
app.get('/api/manager/settings', isManager, async (req, res) => {
    const { date } = req.query; // Expects a date like '2025-08-27'
    if (!date) {
        return res.status(400).send({ error: "Date is required." });
    }
    try {
        const dailySettingDoc = await db.collection('dailySettings').doc(date).get();
        if (dailySettingDoc.exists) {
            return res.status(200).send(dailySettingDoc.data());
        }
        // If no daily setting, return the global default
        const globalSettingsDoc = await db.collection('settings').doc('washSettings').get();
        if (!globalSettingsDoc.exists) {
            return res.status(404).send({ error: 'Default settings not found.' });
        }
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
        // Create or update the setting for a specific day
        await db.collection('dailySettings').doc(date).set({ activeBays: count });
        res.status(200).send({ message: `Active bays for ${date} successfully set to ${count}.` });
    } catch (error) {
        res.status(500).send({ error: 'Failed to update settings.' });
    }
});


// ... (rest of your endpoints)

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});

