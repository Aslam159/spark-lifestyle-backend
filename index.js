// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes } = require('date-fns');

// ----- Firebase Configuration -----
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ----- App Configuration -----
const app = express();
app.use(cors());
app.use(express.json());
const PORT = 3001;

// ----- API Endpoints -----
// ... (your existing endpoints for signup and services)
app.get('/', (req, res) => res.send('Welcome API!'));
app.post('/auth/signup', async (req, res) => { /* ... existing code ... */ });
app.get('/api/services', async (req, res) => { /* ... existing code ... */ });

// A simple test endpoint that does not talk to the database
app.get('/api/test', (req, res) => {
  console.log('Test endpoint was called successfully!');
  res.status(200).send({ message: 'Hello from the test endpoint!' });
});

// --- FINAL SIMPLIFIED: Get Availability Endpoint ---
app.get('/api/availability', async (req, res) => {
  const { date } = req.query; // e.g., "2025-08-25"
  if (!date) {
    return res.status(400).send({ error: 'Date query parameter is required.' });
  }

  try {
    // THIS IS THE KEY FIX: Force the date to be interpreted in the server's local timezone
    const requestedDate = new Date(`${date}T00:00:00`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);

    console.log('Querying for bookings between:', startOfRequestedDay, 'and', endOfRequestedDay);

    // --- Business Logic ---
    const openingTime = { hour: 8, minute: 0 };
    const closingTime = { hour: 16, minute: 0 };
    const slotInterval = 15;

    // 1. Generate all possible slots
    const allSlots = [];
    let currentTime = new Date(startOfRequestedDay);
    currentTime.setHours(openingTime.hour, openingTime.minute);
    const closingDateTime = new Date(startOfRequestedDay);
    closingDateTime.setHours(closingTime.hour, closingTime.minute);

    while (currentTime < closingDateTime) {
      allSlots.push(format(currentTime, 'HH:mm'));
      currentTime = addMinutes(currentTime, slotInterval);
    }
    
    // 2. Fetch all bookings
    const bookingsSnapshot = await db.collection('bookings')
      .where('startTime', '>=', startOfRequestedDay)
      .where('startTime', '<=', endOfRequestedDay)
      .get();

    console.log('Firestore query found bookings:', bookingsSnapshot.size);

    // 3. Determine occupied slots
    const occupiedSlots = new Set();
    for (const doc of bookingsSnapshot.docs) {
      console.log('Processing booking:', doc.id, doc.data());
      
      const booking = doc.data();
      const bookingStartTime = booking.startTime.toDate();
      
      const serviceDoc = await db.collection('services').doc(booking.serviceId).get();
      if (!serviceDoc.exists) continue;
      const duration = serviceDoc.data().durationInMinutes;
      
      const numberOfSlotsToOccupy = Math.ceil(duration / slotInterval);

      let slotTime = new Date(bookingStartTime);
      for (let i = 0; i < numberOfSlotsToOccupy; i++) {
        occupiedSlots.add(format(slotTime, 'HH:mm'));
        slotTime = addMinutes(slotTime, slotInterval);
      }
    }

    // 4. Filter to find available slots
    const availableSlots = allSlots.filter(slot => !occupiedSlots.has(slot));

    res.status(200).send(availableSlots);
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).send({ error: 'Failed to fetch availability.' });
  }
});


// --- NEW: Create a Booking Endpoint ---
app.post('/api/bookings', async (req, res) => {
  try {
    // In the real app, we'll get the user's ID from a secure token.
    // For now, we'll get it from the request body for easy testing.
    const { userId, serviceId, startTime } = req.body;

    if (!userId || !serviceId || !startTime) {
      return res.status(400).send({ error: 'Missing required booking information.' });
    }

    // Create a new booking object to save in the database
    const newBooking = {
      userId: userId,
      serviceId: serviceId,
      startTime: new Date(startTime), // Convert the string back to a Date object
      status: 'booked', // We can add other statuses later (e.g., 'completed', 'cancelled')
      createdAt: new Date(),
    };

    // Add the new document to the 'bookings' collection
    const docRef = await db.collection('bookings').add(newBooking);

    // Send back a success message with the new booking's ID
    res.status(201).send({
      message: 'Booking created successfully!',
      bookingId: docRef.id,
    });

  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send({ error: 'Failed to create booking.' });
  }
});

// --- NEW: Create a Booking Endpoint ---
app.post('/api/bookings', async (req, res) => {
  try {
    // In the real app, we'll get the user's ID from a secure token.
    // For now, we'll get it from the request body for easy testing.
    const { userId, serviceId, startTime } = req.body;

    if (!userId || !serviceId || !startTime) {
      return res.status(400).send({ error: 'Missing required booking information.' });
    }

    // Create a new booking object to save in the database
    const newBooking = {
      userId: userId,
      serviceId: serviceId,
      startTime: new Date(startTime), // Convert the string back to a Date object
      status: 'booked', // We can add other statuses later (e.g., 'completed', 'cancelled')
      createdAt: new Date(),
    };

    // Add the new document to the 'bookings' collection
    const docRef = await db.collection('bookings').add(newBooking);

    // Send back a success message with the new booking's ID
    res.status(201).send({
      message: 'Booking created successfully!',
      bookingId: docRef.id,
    });

  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).send({ error: 'Failed to create booking.' });
  }
});


// ----- Start Server -----
app.listen(PORT, () => {
  console.log(`Server is running successfully on http://localhost:${PORT}`);
});