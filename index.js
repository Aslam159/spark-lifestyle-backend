// index.js
// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { format, startOfDay, endOfDay, addMinutes, isSameDay, isBefore, startOfToday, startOfMonth, endOfMonth, subHours } = require('date-fns');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

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
  console.error("CRITICAL: Firebase Admin SDK initialization failed! The serviceAccountKey.json file may be missing or corrupted.", e);
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
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	standardHeaders: true,
	legacyHeaders: false,
});
const createAccountLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many accounts created from this IP, please try again after an hour',
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
            req.user = decodedToken; // Add user info to the request object
            const userProfile = await db.collection('users').doc(decodedToken.uid).get();
            if (userProfile.exists && userProfile.data().managedLocationId) {
                req.user.managedLocationId = userProfile.data().managedLocationId;
                 return next();
            } else {
                 return res.status(403).send({ error: 'Forbidden: Manager not assigned to a location.' });
            }
        } else {
            return res.status(403).send({ error: 'Forbidden: User is not a manager.' });
        }
    } catch (error) {
        return res.status(401).send({ error: 'Unauthorized: Invalid token.' });
    }
};

// ----- API Endpoints -----

// PUBLIC ROUTES
app.get('/', (req, res) => res.send('Welcome API!'));

app.post('/auth/signup', createAccountLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    const userProfile = {
      email: userRecord.email,
      name: userRecord.displayName,
      role: 'customer',
      rewards: {}, // Initialize empty rewards map
    };
    await db.collection('users').doc(userRecord.uid).set(userProfile);
    res.status(201).send({ uid: userRecord.uid });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

app.get('/api/locations', async (req, res) => {
    try {
        const locationsSnapshot = await db.collection('locations').get();
        const locationsList = locationsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).send(locationsList);
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch locations.' });
    }
});

app.get('/api/services', async (req, res) => {
    const { locationId } = req.query;
    if (!locationId) { return res.status(400).send({ error: 'Location ID is required.' }); }
    try {
        const servicesSnapshot = await db.collection('locations').doc(locationId).collection('services').where('isActive', '==', true).get();
        const servicesList = servicesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).send(servicesList);
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch services.' });
    }
});

app.get('/api/availability', async (req, res) => {
    const { date, locationId } = req.query;
    if (!date || !locationId) { return res.status(400).send({ error: 'Date and Location ID are required.' }); }
    try {
        const requestedDate = new Date(`${date}T00:00:00.000Z`);
        if (isBefore(requestedDate, startOfToday())) { return res.status(200).send([]); }

        const settingsRef = db.collection('locations').doc(locationId).collection('settings');
        const dailySettingDoc = await settingsRef.doc(date).get();
        const globalSettingsDoc = await settingsRef.doc('global').get();
        const activeBays = dailySettingDoc.exists ? dailySettingDoc.data().activeBays : (globalSettingsDoc.exists ? globalSettingsDoc.data().activeBays : 1);

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

        const bookingsSnapshot = await db.collection('locations').doc(locationId).collection('bookings').where('startTime', '>=', startOfRequestedDay).where('startTime', '<=', endOfRequestedDay).get();
        const occupiedSlotCounts = {};
        for (const doc of bookingsSnapshot.docs) {
            const booking = doc.data();
            const serviceDoc = await db.collection('locations').doc(locationId).collection('services').doc(booking.serviceId).get();
            if (!serviceDoc.exists) continue;
            const duration = serviceDoc.data().durationInMinutes;
            let slotTime = booking.startTime.toDate();
            for (let i = 0; i < Math.ceil(duration / slotInterval); i++) {
                const formattedSlot = format(addMinutes(slotTime, 120), 'HH:mm');
                occupiedSlotCounts[formattedSlot] = (occupiedSlotCounts[formattedSlot] || 0) + 1;
                slotTime = addMinutes(slotTime, slotInterval);
            }
        }
        
        const blockedSlotsSnapshot = await db.collection('locations').doc(locationId).collection('blockedSlots').where('date', '==', date).get();
        const blockedSlots = new Set(blockedSlotsSnapshot.docs.map(doc => doc.data().slot));

        let availableSlots = allSlots.filter(slot => ((occupiedSlotCounts[slot] || 0) < activeBays) && !blockedSlots.has(slot));

        if (isSameDay(requestedDate, new Date())) {
            const currentTimeSAST = format(addMinutes(new Date(), 120), 'HH:mm');
            availableSlots = availableSlots.filter(slot => slot > currentTimeSAST);
        }
        res.status(200).send(availableSlots);
    } catch (error) {
        console.error("Error fetching availability:", error);
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

app.get('/api/payments/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
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
        const { userId, serviceId, startTime, locationId } = req.body;
        if (!userId || !serviceId || !startTime || !locationId) {
            return res.status(400).send({ error: 'Missing required booking information.' });
        }
        
        const correctUTCTime = subHours(new Date(startTime), 2);
        const dateKey = format(correctUTCTime, 'yyyy-MM-dd');
        
        const settingsRef = db.collection('locations').doc(locationId).collection('settings');
        const dailySettingDoc = await settingsRef.doc(dateKey).get();
        const globalSettingsDoc = await settingsRef.doc('global').get();
        const activeBays = dailySettingDoc.exists ? dailySettingDoc.data().activeBays : (globalSettingsDoc.exists ? globalSettingsDoc.data().activeBays : 1);
        
        const existingBookings = await db.collection('locations').doc(locationId).collection('bookings').where('startTime', '==', correctUTCTime).get();
        if (existingBookings.size >= activeBays) {
            return res.status(409).send({ error: 'Sorry, this time slot was just taken. Please select another time.' });
        }
        
        const newBooking = { userId, serviceId, startTime: correctUTCTime, status: 'paid', createdAt: new Date(), bayId: (existingBookings.size + 1) };
        const docRef = await db.collection('locations').doc(locationId).collection('bookings').add(newBooking);
        
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).send({ error: 'User profile not found.' });
        }

        const currentRewards = userDoc.data().rewards || {};
        const locationRewards = currentRewards[locationId] || { loyaltyPoints: 0, freeWashes: 0 };
        const newPoints = locationRewards.loyaltyPoints + 1;

        if (newPoints >= 10) {
            locationRewards.loyaltyPoints = 0;
            locationRewards.freeWashes += 1;
        } else {
            locationRewards.loyaltyPoints = newPoints;
        }

        await userRef.update({ [`rewards.${locationId}`]: locationRewards });
        
        res.status(201).send({ message: 'Booking created successfully!', bookingId: docRef.id });
    } catch (error) {
        console.error("Error creating booking:", error);
        res.status(500).send({ error: 'Failed to create booking.' });
    }
});

app.post('/api/bookings/redeem-free-wash', async (req, res) => {
    const { userId, serviceId, startTime, locationId } = req.body;
    if (!userId || !serviceId || !startTime || !locationId) {
        return res.status(400).send({ error: 'Missing required booking information.' });
    }
    // Logic to check if the service is eligible for a free wash could go here
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists || !userDoc.data().rewards || !userDoc.data().rewards[locationId] || userDoc.data().rewards[locationId].freeWashes < 1) {
        return res.status(403).send({ error: 'No free washes available for this location.' });
    }

    const correctUTCTime = subHours(new Date(startTime), 2);
    // ... (Race condition check for free wash)
    
    const newBooking = { userId, serviceId, startTime: correctUTCTime, status: 'free', createdAt: new Date(), bayId: 1 }; // Simplified bay assignment
    await db.collection('locations').doc(locationId).collection('bookings').add(newBooking);
    
    await userRef.update({ [`rewards.${locationId}.freeWashes`]: admin.firestore.FieldValue.increment(-1) });

    res.status(201).send({ message: 'Free wash booked successfully!' });
});

// MANAGER ROUTES
app.get('/api/manager/bookings', isManager, async (req, res) => {
    const { date } = req.query;
    const locationId = req.user.managedLocationId;
    if (!date || !locationId) { return res.status(400).send({ error: 'Date and location are required.' }); }
    try {
        const requestedDate = new Date(`${date}T00:00:00.000Z`);
        const startOfRequestedDay = startOfDay(requestedDate);
        const endOfRequestedDay = endOfDay(requestedDate);

        const bookingsSnapshot = await db.collection('locations').doc(locationId).collection('bookings').where('startTime', '>=', startOfRequestedDay).where('startTime', '<=', endOfRequestedDay).orderBy('startTime', 'asc').get();
        
        const detailedBookings = await Promise.all(bookingsSnapshot.docs.map(async (doc) => {
            const booking = doc.data();
            const userDoc = await db.collection('users').doc(booking.userId).get();
            const serviceDoc = await db.collection('locations').doc(locationId).collection('services').doc(booking.serviceId).get();
            return {
                id: doc.id, ...booking,
                userName: userDoc.exists ? userDoc.data().name : 'Unknown User',
                serviceName: serviceDoc.exists ? serviceDoc.data().name : 'Unknown Service',
                startTimeSAST: format(addMinutes(booking.startTime.toDate(), 120), 'HH:mm'),
            };
        }));
        res.status(200).send(detailedBookings);
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch manager bookings.' });
    }
});

app.get('/api/manager/bookings/summary', isManager, async (req, res) => {
    const { month, year } = req.query;
    const locationId = req.user.managedLocationId;
    if (!month || !year || !locationId) { return res.status(400).send({ error: 'Month, year, and location are required.' }); }
    try {
        const startDate = startOfMonth(new Date(year, month - 1, 1));
        const endDate = endOfMonth(startDate);
        const bookingsSnapshot = await db.collection('locations').doc(locationId).collection('bookings').where('startTime', '>=', startDate).where('startTime', '<=', endDate).get();
        const serviceCounts = {};
        const userBookingCounts = {};

        for (const doc of bookingsSnapshot.docs) {
            const booking = doc.data();
            const serviceDoc = await db.collection('locations').doc(locationId).collection('services').doc(booking.serviceId).get();
            if (serviceDoc.exists) {
                const serviceName = serviceDoc.data().name;
                serviceCounts[serviceName] = (serviceCounts[serviceName] || 0) + 1;
            }
            const userDoc = await db.collection('users').doc(booking.userId).get();
            if (userDoc.exists) {
                const userName = userDoc.data().name;
                userBookingCounts[userName] = (userBookingCounts[userName] || 0) + 1;
            }
        }

        const topServices = Object.keys(serviceCounts).map(serviceName => ({ serviceName, count: serviceCounts[serviceName] })).sort((a, b) => b.count - a.count);
        const topClients = Object.keys(userBookingCounts).map(userName => ({ userName, count: userBookingCounts[userName] })).sort((a, b) => b.count - a.count).slice(0, 5);
        
        res.status(200).send({ topServices, topClients });
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch booking summary.' });
    }
});

app.get('/api/manager/settings', isManager, async (req, res) => {
    const { date } = req.query;
    const locationId = req.user.managedLocationId;
    if (!date || !locationId) { return res.status(400).send({ error: 'Date and location are required.' }); }
    try {
        const dailySettingDoc = await db.collection('locations').doc(locationId).collection('settings').doc(date).get();
        if (dailySettingDoc.exists) { return res.status(200).send(dailySettingDoc.data()); }
        
        const globalSettingsDoc = await db.collection('locations').doc(locationId).collection('settings').doc('global').get();
        if (!globalSettingsDoc.exists) { return res.status(200).send({ activeBays: 1 }); } // Default to 1 if no global is set
        res.status(200).send(globalSettingsDoc.data());
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch settings.' });
    }
});

app.post('/api/manager/settings/activeBays', isManager, async (req, res) => {
    const { count, date } = req.body;
    const locationId = req.user.managedLocationId;
    if (typeof count !== 'number' || !date || !locationId) {
        return res.status(400).send({ error: 'Invalid count, date, or location provided.' });
    }
    try {
        await db.collection('locations').doc(locationId).collection('settings').doc(date).set({ activeBays: count }, { merge: true });
        res.status(200).send({ message: `Active bays for ${date} successfully set to ${count}.` });
    } catch (error) {
        res.status(500).send({ error: 'Failed to update settings.' });
    }
});

app.get('/api/manager/blocked-slots', isManager, async (req, res) => {
    const { date } = req.query;
    const locationId = req.user.managedLocationId;
    if (!date || !locationId) { return res.status(400).send({ error: 'Date and location are required.' }); }
    try {
        const snapshot = await db.collection('locations').doc(locationId).collection('blockedSlots').where('date', '==', date).get();
        const slots = snapshot.docs.map(doc => doc.data().slot);
        res.status(200).send(slots);
    } catch (error) {
        res.status(500).send({ error: 'Failed to fetch blocked slots.' });
    }
});

app.post('/api/manager/blocked-slots', isManager, async (req, res) => {
    const { date, slot } = req.body;
    const locationId = req.user.managedLocationId;
    if (!date || !slot || !locationId) { return res.status(400).send({ error: 'Date, slot, and location are required.' }); }
    try {
        const slotId = `${date}_${slot}`;
        const slotRef = db.collection('locations').doc(locationId).collection('blockedSlots').doc(slotId);
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

