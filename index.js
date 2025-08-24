// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes } = require('date-fns');
const { utcToZonedTime } = require('date-fns-tz');

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
  // ... (existing signup code)
});

app.get('/api/services', async (req, res) => {
  // --- FINAL TEST LOG ---
  console.log("Request received for /api/services"); 
  
  try {
    console.log("Attempting to fetch from Firestore...");
    const servicesSnapshot = await db.collection('services').get();
    console.log(`Firestore fetch successful. Found ${servicesSnapshot.size} services.`);
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

// ... (your other endpoints)

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});


