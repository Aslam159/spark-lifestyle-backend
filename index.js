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
app.get('/api/manager/bookings', isManager, async (req, res) => { /* ... */ });


// --- NEW: Manager-only endpoints to get and update settings ---
app.get('/api/manager/settings', isManager, async (req, res) => {
    try {
        const settingsDoc = await db.collection('settings').doc('washSettings').get();
        if (!settingsDoc.exists) {
            return res.status(404).send({ error: 'Settings not found.' });
        }
        res.status(200).send(settingsDoc.data());
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).send({ error: 'Failed to fetch settings.' });
    }
});

app.post('/api/manager/settings/activeBays', isManager, async (req, res) => {
    const { count } = req.body;
    if (typeof count !== 'number' || (count !== 1 && count !== 2)) {
        return res.status(400).send({ error: 'Invalid count. Must be 1 or 2.' });
    }
    try {
        await db.collection('settings').doc('washSettings').update({ activeBays: count });
        res.status(200).send({ message: `Active bays successfully set to ${count}.` });
    } catch (error) {
        console.error('Error updating active bays:', error);
        res.status(500).send({ error: 'Failed to update settings.' });
    }
});


// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});

