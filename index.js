// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes, isSameDay, isBefore, startOfToday } = require('date-fns');
const axios = require('axios'); // Import axios

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

// --- Peach Payments Credentials (Use your Test credentials here) ---
// IMPORTANT: In production, these should be stored securely as environment variables.
const PEACH_PAYMENTS_ENTITY_ID = 'YOUR_PEACH_PAYMENTS_ENTITY_ID';
const PEACH_PAYMENTS_SECRET_TOKEN = 'YOUR_PEACH_PAYMENTS_SECRET_TOKEN';
const PEACH_PAYMENTS_API_URL = 'https://test.oppwa.com/v1/checkouts';


// ----- API Endpoints -----

app.get('/', (req, res) => res.send('Welcome API!'));

// ... (your existing signup, services, and availability endpoints)
app.post('/auth/signup', async (req, res) => { /* ... */ });
app.get('/api/services', async (req, res) => { /* ... */ });
app.get('/api/availability', async (req, res) => { /* ... */ });


// --- NEW: Payment Checkout Endpoint ---
app.post('/api/payments/checkout', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || !currency) {
      return res.status(400).send({ error: 'Amount and currency are required.' });
    }

    const transactionId = `txn_${Date.now()}`;

    // Data to send to Peach Payments
    const data = new URLSearchParams({
      'entityId': PEACH_PAYMENTS_ENTITY_ID,
      'amount': amount.toFixed(2),
      'currency': currency,
      'paymentType': 'DB',
      'merchantTransactionId': transactionId,
    }).toString();

    const config = {
      headers: {
        'Authorization': `Bearer ${PEACH_PAYMENTS_SECRET_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    // Make the request to Peach Payments
    const peachResponse = await axios.post(PEACH_PAYMENTS_API_URL, data, config);

    // Send the checkoutId back to the app
    res.status(200).send({ checkoutId: peachResponse.data.id });

  } catch (error) {
    console.error("Error creating Peach Payments checkout:", error.response?.data || error.message);
    res.status(500).send({ error: 'Failed to initialize payment.' });
  }
});


app.post('/api/bookings', async (req, res) => { /* ... your existing bookings endpoint ... */ });

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});




