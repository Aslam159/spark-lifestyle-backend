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
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify/';

// --- NEW: Middleware to verify user is a manager ---
const isManager = async (req, res, next) => {
  const { authorization } = req.headers;

  if (!authorization || !authorization.startsWith('Bearer ')) {
    return res.status(401).send({ error: 'Unauthorized: No token provided.' });
  }

  const idToken = authorization.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (decodedToken.role === 'manager') {
      req.user = decodedToken; // Add user info to the request object
      return next(); // User is a manager, proceed to the endpoint
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
  // ... (existing signup code)
});

app.post('/api/assign-manager-role', async (req, res) => {
    // ... (existing assign manager role code)
});

app.get('/api/services', async (req, res) => {
  // ... (existing services code)
});

app.get('/api/availability', async (req, res) => {
  // ... (existing availability code)
});

app.post('/api/payments/checkout', async (req, res) => {
  // ... (existing payments checkout code)
});

app.get('/api/payments/verify/:reference', async (req, res) => {
  // ... (existing payments verify code)
});

app.post('/api/bookings', async (req, res) => {
  // ... (existing bookings code)
});

// --- NEW: Manager-only endpoint to get daily bookings ---
app.get('/api/manager/bookings', isManager, async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).send({ error: 'Date query parameter is required.' });
  }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);

    const bookingsSnapshot = await db.collection('bookings')
      .where('startTime', '>=', startOfRequestedDay)
      .where('startTime', '<=', endOfRequestedDay)
      .orderBy('startTime', 'asc') // Order bookings by time
      .get();

    // We need to fetch details for each booking (user name, service name)
    const detailedBookings = await Promise.all(bookingsSnapshot.docs.map(async (doc) => {
      const booking = doc.data();
      
      // Get user details
      const userDoc = await db.collection('users').doc(booking.userId).get();
      const userName = userDoc.exists ? userDoc.data().name : 'Unknown User';

      // Get service details
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      const serviceName = serviceDoc.exists ? serviceDoc.data().name : 'Unknown Service';

      // Format the start time to SAST for display
      const sastTime = addMinutes(booking.startTime.toDate(), 120);

      return {
        id: doc.id,
        ...booking,
        userName,
        serviceName,
        startTimeSAST: format(sastTime, 'HH:mm'),
      };
    }));

    res.status(200).send(detailedBookings);
  } catch (error) {
    console.error('Error fetching manager bookings:', error);
    res.status(500).send({ error: 'Failed to fetch bookings.' });
  }
});


// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});
