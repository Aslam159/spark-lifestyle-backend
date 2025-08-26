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

// ... (your existing signup, services, availability, payment, and booking endpoints)
app.post('/auth/signup', async (req, res) => { /* ... */ });
app.post('/api/assign-manager-role', async (req, res) => { /* ... */ });
app.get('/api/services', async (req, res) => { /* ... */ });
app.get('/api/availability', async (req, res) => { /* ... */ });
app.post('/api/payments/checkout', async (req, res) => { /* ... */ });
app.get('/api/payments/verify/:reference', async (req, res) => { /* ... */ });
app.post('/api/bookings', async (req, res) => { /* ... */ });


// --- UPDATED: Manager-only endpoint with detailed logging ---
app.get('/api/manager/bookings', isManager, async (req, res) => {
  const { date } = req.query;
  console.log(`[Manager] Received request for bookings on date: ${date}`);
  if (!date) {
    return res.status(400).send({ error: 'Date query parameter is required.' });
  }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);

    console.log(`[Manager] Querying bookings between ${startOfRequestedDay.toISOString()} and ${endOfRequestedDay.toISOString()}`);
    const bookingsSnapshot = await db.collection('bookings')
      .where('startTime', '>=', startOfRequestedDay)
      .where('startTime', '<=', endOfRequestedDay)
      .orderBy('startTime', 'asc')
      .get();
    console.log(`[Manager] Found ${bookingsSnapshot.size} bookings.`);

    const detailedBookings = await Promise.all(bookingsSnapshot.docs.map(async (doc) => {
      const booking = doc.data();
      console.log(`[Manager] Processing booking ID: ${doc.id}`);
      
      console.log(`[Manager] Fetching user: ${booking.userId}`);
      const userDoc = await db.collection('users').doc(booking.userId).get();
      const userName = userDoc.exists ? userDoc.data().name : 'Unknown User';

      console.log(`[Manager] Fetching service: ${booking.serviceId}`);
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      const serviceName = serviceDoc.exists ? serviceDoc.data().name : 'Unknown Service';

      const sastTime = addMinutes(booking.startTime.toDate(), 120);

      return {
        id: doc.id,
        ...booking,
        userName,
        serviceName,
        startTimeSAST: format(sastTime, 'HH:mm'),
      };
    }));

    console.log("[Manager] Successfully processed all bookings. Sending response.");
    res.status(200).send(detailedBookings);
  } catch (error) {
    console.error('[Manager] CRITICAL ERROR fetching manager bookings:', error);
    res.status(500).send({ error: 'Failed to fetch bookings.' });
  }
});

app.get('/api/manager/settings', isManager, async (req, res) => {
    // ... (existing settings code)
});

app.post('/api/manager/settings/activeBays', isManager, async (req, res) => {
    // ... (existing settings update code)
});


// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});

