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
const PAYSTACK_SECRET_KEY = 'sk_test_c75e440a7b40c66a47a8ab73605ec0ac3cdbaece';
const PAYSTACK_API_URL = 'https://api.paystack.co/transaction/initialize';

// ----- API Endpoints -----

app.get('/', (req, res) => res.send('Welcome API!'));

// ... (your existing signup, services, and availability endpoints)
app.post('/auth/signup', async (req, res) => { /* ... */ });
app.get('/api/services', async (req, res) => { /* ... */ });
app.get('/api/availability', async (req, res) => { /* ... */ });


// --- UPDATED: Payment Checkout Endpoint for Paystack ---
app.post('/api/payments/checkout', async (req, res) => {
  try {
    const { amount, email } = req.body;
    if (!amount || !email) {
      return res.status(400).send({ error: 'Amount and email are required.' });
    }

    const amountInCents = Math.round(amount * 100);

    const data = {
      email: email,
      amount: amountInCents,
      currency: 'ZAR',
    };

    const config = {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    };

    const paystackResponse = await axios.post(PAYSTACK_API_URL, data, config);

    // --- THIS IS THE FIX ---
    // Send BOTH the URL and the access_code back to the app
    res.status(200).send({
      authorization_url: paystackResponse.data.data.authorization_url,
      access_code: paystackResponse.data.data.access_code,
    });

  } catch (error) {
    console.error("Error creating Paystack transaction:", error.response?.data || error.message);
    res.status(500).send({ error: 'Failed to initialize payment.' });
  }
});


app.post('/api/bookings', async (req, res) => { /* ... your existing bookings endpoint ... */ });

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});





