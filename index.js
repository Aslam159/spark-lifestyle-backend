// index.js
// ----- Imports -----
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const {
  format,
  startOfDay,
  endOfDay,
  addMinutes,
  isSameDay,
  isBefore,
  startOfToday,
  startOfMonth,
  endOfMonth,
  subHours,
} = require('date-fns');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

// ----- Firebase Configuration -----
let db;
try {
  const serviceAccount = require('./serviceAccountKey.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Firebase Admin SDK initialized successfully.');
  }
  db = admin.firestore();
} catch (e) {
  console.error(
    'CRITICAL: Firebase Admin SDK initialization failed! serviceAccountKey.json may be missing or invalid.',
    e
  );
  // Attempt to continue; db will be undefined and routes will error with clear messages
}

// ----- App Configuration -----
const app = express();

// CORS: explicit headers so even error paths include them
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // Consider restricting in production
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

// Trust proxy (Render/other hosts)
app.set('trust proxy', 1);

// --- Paystack Credentials ---
const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || 'sk_test_c75e440a7b40c66a47a8ab73605ec0ac3cdbaece';
const PAYSTACK_API_URL = 'https://api.paystack.co/transaction/initialize';
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify/';

// --- SECURITY: Rate Limiters ---
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

// Apply after CORS so preflight isn’t blocked
app.use('/api/', apiLimiter);

// --- Middleware: Verify Manager ---
const isManager = async (req, res, next) => {
  try {
    const { authorization } = req.headers || {};
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token provided.' });
    }
    const idToken = authorization.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (decodedToken.role !== 'manager') {
      return res.status(403).json({ error: 'Forbidden: User is not a manager.' });
    }

    req.user = decodedToken;
    const userProfile = await db.collection('users').doc(decodedToken.uid).get();
    if (userProfile.exists && userProfile.data().managedLocationId) {
      req.user.managedLocationId = userProfile.data().managedLocationId;
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Manager not assigned to a location.' });
  } catch (error) {
    console.error('[isManager] error', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token.' });
  }
};

// ----- Health & Root -----
app.get('/', (req, res) => res.send('Welcome API!'));
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/availability/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ----- Auth -----
app.post('/auth/signup', createAccountLimiter, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });
  try {
    const { email, password, name } = req.body || {};
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    const userProfile = {
      email: userRecord.email,
      name: userRecord.displayName,
      role: 'customer',
      rewards: {},
    };
    await db.collection('users').doc(userRecord.uid).set(userProfile);
    res.status(201).json({ uid: userRecord.uid });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to sign up.' });
  }
});

// ----- Public: Locations & Services -----
app.get('/api/locations', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });
  try {
    const locationsSnapshot = await db.collection('locations').orderBy('name').get();
    const locationsList = locationsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(locationsList);
  } catch (error) {
    console.error('Error in /api/locations:', error);
    res.status(500).json({ error: 'Failed to fetch locations.' });
  }
});

app.get('/api/services', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });
  const { locationId } = req.query || {};
  if (!locationId || typeof locationId !== 'string') {
    return res.status(400).json({ error: 'Location ID is required.' });
  }
  try {
    const servicesSnapshot = await db
      .collection('locations')
      .doc(locationId)
      .collection('services')
      .where('isActive', '==', true)
      .orderBy('displayOrder')
      .get();
    const servicesList = servicesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(servicesList);
  } catch (error) {
    console.error('Error in /api/services:', error);
    res.status(500).json({ error: 'Failed to fetch services.' });
  }
});

// ----- Public: Availability (Hardened) -----
app.get('/api/availability', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });

  const { date, locationId } = req.query || {};
  console.log('[availability] hit', req.query);

  if (!date || !locationId || typeof date !== 'string' || typeof locationId !== 'string') {
    return res.status(400).json({ error: 'Date and Location ID are required.' });
  }

  try {
    // --- Work in SAST consistently (SA has no DST) ---
    const addMinutes = (d, mins) => new Date(d.getTime() + mins * 60000);
    const pad = (n) => String(n).padStart(2, '0');

    // "Now" in SAST
    const nowSAST = addMinutes(new Date(), 120);
    const todayKeySAST = `${nowSAST.getFullYear()}-${pad(nowSAST.getMonth() + 1)}-${pad(nowSAST.getDate())}`;

    // Quick past-day check using yyyy-MM-dd string compare (safe lexicographically)
    if (date < todayKeySAST) {
      return res.status(200).json([]);
    }

    // Slot window in **SAST**
    const openingHourSAST = 8;   // 08:00
    const closingHourSAST = 16;  // 16:00 (exclusive)
    const slotInterval = 15;     // minutes

    // Build all slots as SAST "HH:mm" strings
    const allSlots = [];
    for (let minutes = openingHourSAST * 60; minutes < closingHourSAST * 60; minutes += slotInterval) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      allSlots.push(`${pad(h)}:${pad(m)}`);
    }

    // Settings (daily -> global -> default 2)
    const settingsRef = db.collection('locations').doc(locationId).collection('settings');
    const [dailySettingDoc, globalSettingsDoc] = await Promise.all([
      settingsRef.doc(date).get(),
      settingsRef.doc('global').get(),
    ]);

    let activeBays =
      (dailySettingDoc.exists && dailySettingDoc.data()?.activeBays) ??
      (globalSettingsDoc.exists && globalSettingsDoc.data()?.activeBays) ??
      2;

    // Clamp to sane minimum to avoid "all blocked" surprises
    if (!Number.isFinite(activeBays) || activeBays <= 0) activeBays = 1;

    // --- Bookings window in UTC that corresponds to the SAST date ---
    // SAST day runs from 00:00 SAST to 23:59:59.999 SAST.
    // In UTC that's SAST-2 hours.
    const startUTC = new Date(`${date}T00:00:00.000Z`);                // 00:00 UTC (which is 02:00 SAST)
    const startOfDayUTCForSAST = new Date(startUTC.getTime() - 120 * 60000); // 22:00 previous day UTC = 00:00 SAST
    const endOfDayUTCForSAST   = new Date(startOfDayUTCForSAST.getTime() + (24 * 60 * 60000) - 1);

    // Fetch bookings within the SAST day window
    const bookingsRef = db.collection('locations').doc(locationId).collection('bookings');
    const bookingsSnapshot = await bookingsRef
      .where('startTime', '>=', startOfDayUTCForSAST)
      .where('startTime', '<=', endOfDayUTCForSAST)
      .orderBy('startTime', 'asc')
      .get();

    // Preload service durations (avoid N+1)
    const serviceIds = new Set();
    for (const d of bookingsSnapshot.docs) {
      const b = d.data() || {};
      if (b?.serviceId) serviceIds.add(String(b.serviceId));
    }

    const serviceDurations = {};
    await Promise.all(
      Array.from(serviceIds).map(async (sid) => {
        try {
          const sd = await db
            .collection('locations')
            .doc(locationId)
            .collection('services')
            .doc(sid)
            .get();
          if (sd.exists) {
            const dur = Number(sd.data()?.durationInMinutes);
            serviceDurations[sid] = Number.isFinite(dur) && dur > 0 ? dur : 15;
          }
        } catch (e) {
          console.warn('[availability] failed to read service', sid, e);
        }
      })
    );

    // Tally occupied slots (convert booking startTime UTC -> SAST slot strings)
    const occupiedSlotCounts = {};
    for (const d of bookingsSnapshot.docs) {
      try {
        const b = d.data() || {};
        const ts = b?.startTime;
        const sid = String(b?.serviceId || '');
        if (!ts || typeof ts.toDate !== 'function' || !sid) {
          console.warn('[availability] skipping bad booking', d.id, { hasStartTime: !!ts, sid });
          continue;
        }
        const startUTCDate = ts.toDate();
        const startSAST = addMinutes(startUTCDate, 120);
        const duration = serviceDurations[sid] ?? 15;

        let minutes = startSAST.getHours() * 60 + startSAST.getMinutes();
        const steps = Math.max(1, Math.ceil(duration / slotInterval));
        for (let i = 0; i < steps; i++) {
          const h = Math.floor(minutes / 60);
          const m = minutes % 60;
          const slot = `${pad(h)}:${pad(m)}`;
          occupiedSlotCounts[slot] = (occupiedSlotCounts[slot] || 0) + 1;
          minutes += slotInterval;
        }
      } catch (e) {
        console.warn('[availability] failed to process booking', d.id, e);
      }
    }

    // Blocked slots for this SAST date
    const blockedSnap = await db
      .collection('locations')
      .doc(locationId)
      .collection('blockedSlots')
      .where('date', '==', date)
      .get();
    const blocked = new Set(blockedSnap.docs.map((doc) => doc.data()?.slot).filter(Boolean));

    // Compute candidates
    let availableSlots = allSlots.filter(
      (s) => ((occupiedSlotCounts[s] || 0) < activeBays) && !blocked.has(s)
    );

    // If querying "today" (in SAST), remove past times
    if (date === todayKeySAST) {
      const nowHHmm = `${pad(nowSAST.getHours())}:${pad(nowSAST.getMinutes())}`;
      availableSlots = availableSlots.filter((s) => s > nowHHmm);
    }

    console.log('[availability] result', {
      date,
      locationId,
      activeBays,
      totalSlots: allSlots.length,
      freeSlots: availableSlots.length,
    });

    return res.status(200).json(availableSlots);
  } catch (error) {
    console.error('Error in /api/availability:', error);
    return res.status(500).json({ error: 'Failed to fetch availability.' });
  }
});

// ----- Bookings -----
app.post('/api/bookings/verify-slot', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });

  const { startTime, locationId } = req.body || {};
  if (!startTime || !locationId) {
    return res.status(400).json({ error: 'Missing information for verification.' });
  }
  if (['__proto__', 'constructor', 'prototype'].includes(String(locationId))) {
    return res.status(400).json({ error: 'Invalid locationId.' });
  }

  try {
    const correctUTCTime = subHours(new Date(startTime), 2);
    const dateKey = format(correctUTCTime, 'yyyy-MM-dd');

    const settingsRef = db.collection('locations').doc(locationId).collection('settings');
    const [dailySettingDoc, globalSettingsDoc] = await Promise.all([
      settingsRef.doc(dateKey).get(),
      settingsRef.doc('global').get(),
    ]);

    const activeBays =
      (dailySettingDoc.exists && dailySettingDoc.data()?.activeBays) ??
      (globalSettingsDoc.exists && globalSettingsDoc.data()?.activeBays) ??
      2;

    const existingBookings = await db
      .collection('locations')
      .doc(locationId)
      .collection('bookings')
      .where('startTime', '==', correctUTCTime)
      .get();

    if (existingBookings.size >= activeBays) {
      return res.status(409).json({ error: 'Slot is no longer available.' });
    }

    res.status(200).json({ message: 'Slot is available.' });
  } catch (error) {
    console.error('Error in /api/bookings/verify-slot:', error);
    res.status(500).json({ error: 'Failed to verify slot availability.' });
  }
});

app.post('/api/bookings', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });

  try {
    const { userId, serviceId, startTime, locationId } = req.body || {};
    if (!userId || !serviceId || !startTime || !locationId) {
      return res.status(400).json({ error: 'Missing required booking information.' });
    }
    if (['__proto__', 'constructor', 'prototype'].includes(String(locationId))) {
      return res.status(400).json({ error: 'Invalid locationId.' });
    }

    const correctUTCTime = subHours(new Date(startTime), 2);
    const existingBookings = await db
      .collection('locations')
      .doc(locationId)
      .collection('bookings')
      .where('startTime', '==', correctUTCTime)
      .get();

    const newBooking = {
      userId,
      serviceId,
      startTime: correctUTCTime,
      status: 'paid',
      createdAt: new Date(),
      bayId: existingBookings.size + 1,
    };
    const docRef = await db.collection('locations').doc(locationId).collection('bookings').add(newBooking);

    const userRef = db.collection('users').doc(userId);
    let userDoc = await userRef.get();
    if (!userDoc.exists) {
      const userRecord = await admin.auth().getUser(userId);
      const userProfile = {
        email: userRecord.email,
        name: userRecord.displayName,
        role: 'customer',
        rewards: {},
      };
      await userRef.set(userProfile);
      userDoc = await userRef.get();
    }

    const currentRewards = userDoc.data()?.rewards || {};
    const locationRewards = currentRewards[locationId] || { loyaltyPoints: 0, freeWashes: 0 };
    const newPoints = (locationRewards.loyaltyPoints || 0) + 1;

    if (newPoints >= 10) {
      locationRewards.loyaltyPoints = 0;
      locationRewards.freeWashes = (locationRewards.freeWashes || 0) + 1;
    } else {
      locationRewards.loyaltyPoints = newPoints;
    }

    await userRef.update({ [`rewards.${locationId}`]: locationRewards });

    res.status(201).json({ message: 'Booking created successfully!', bookingId: docRef.id });
  } catch (error) {
    console.error('Error in /api/bookings:', error);
    res.status(500).json({ error: 'Failed to create booking.' });
  }
});

app.post('/api/bookings/redeem-free-wash', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });

  const { userId, serviceId, startTime, locationId } = req.body || {};
  if (!userId || !serviceId || !startTime || !locationId) {
    return res.status(400).json({ error: 'Missing required booking information.' });
  }
  if (['__proto__', 'constructor', 'prototype'].includes(String(locationId))) {
    return res.status(400).json({ error: 'Invalid locationId.' });
  }

  try {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const hasRewards =
      userDoc.exists &&
      userDoc.data().rewards &&
      userDoc.data().rewards[locationId] &&
      userDoc.data().rewards[locationId].freeWashes >= 1;

    if (!hasRewards) {
      return res.status(403).json({ error: 'No free washes available for this location.' });
    }

    const correctUTCTime = subHours(new Date(startTime), 2);
    const newBooking = {
      userId,
      serviceId,
      startTime: correctUTCTime,
      status: 'free',
      createdAt: new Date(),
      bayId: 1,
    };
    await db.collection('locations').doc(locationId).collection('bookings').add(newBooking);
    await userRef.update({ [`rewards.${locationId}.freeWashes`]: admin.firestore.FieldValue.increment(-1) });

    res.status(201).json({ message: 'Free wash booked successfully!' });
  } catch (error) {
    console.error('Error in /api/bookings/redeem-free-wash:', error);
    res.status(500).json({ error: 'Failed to redeem free wash.' });
  }
});

// ----- Manager Routes -----
app.post('/api/assign-manager-role', isManager, async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not initialized.' });
  const { email } = req.body || {};
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role: 'manager' });
    await db.collection('users').doc(user.uid).update({ managedLocationId: req.user.managedLocationId });
    res.status(200).json({ message: `Successfully assigned manager role to ${email}` });
  } catch (error) {
    console.error('Error in /api/assign-manager-role:', error);
    res.status(500).json({ error: error.message || 'Failed to assign role.' });
  }
});

app.get('/api/manager/bookings', isManager, async (req, res) => {
  const { date } = req.query || {};
  const locationId = req.user?.managedLocationId;
  if (!date || !locationId) {
    return res.status(400).json({ error: 'Date and location are required.' });
  }
  try {
    const requestedDate = new Date(`${date}T00:00:00.000Z`);
    const startOfRequestedDay = startOfDay(requestedDate);
    const endOfRequestedDay = endOfDay(requestedDate);

    const bookingsSnapshot = await db
      .collection('locations')
      .doc(locationId)
      .collection('bookings')
      .where('startTime', '>=', startOfRequestedDay)
      .where('startTime', '<=', endOfRequestedDay)
      .orderBy('startTime', 'asc')
      .get();

    const detailedBookings = await Promise.all(
      bookingsSnapshot.docs.map(async (doc) => {
        const booking = doc.data();
        const userDoc = await db.collection('users').doc(booking.userId).get();
        const serviceDoc = await db.collection('locations').doc(locationId).collection('services').doc(booking.serviceId).get();
        return {
          id: doc.id,
          ...booking,
          userName: userDoc.exists ? userDoc.data().name : 'Unknown User',
          serviceName: serviceDoc.exists ? serviceDoc.data().name : 'Unknown Service',
          startTimeSAST: format(addMinutes(booking.startTime.toDate(), 120), 'HH:mm'),
        };
      })
    );
    res.status(200).json(detailedBookings);
  } catch (error) {
    console.error('Error in /api/manager/bookings:', error);
    res.status(500).json({ error: 'Failed to fetch manager bookings.' });
  }
});

app.get('/api/manager/bookings/summary', isManager, async (req, res) => {
  const { month, year } = req.query || {};
  const locationId = req.user?.managedLocationId;
  if (!month || !year || !locationId) {
    return res.status(400).json({ error: 'Month, year, and location are required.' });
  }
  try {
    const startDate = startOfMonth(new Date(year, month - 1, 1));
    const endDate = endOfMonth(startDate);
    const bookingsSnapshot = await db
      .collection('locations')
      .doc(locationId)
      .collection('bookings')
      .where('startTime', '>=', startDate)
      .where('startTime', '<=', endDate)
      .get();

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

    const topServices = Object.keys(serviceCounts)
      .map((serviceName) => ({ serviceName, count: serviceCounts[serviceName] }))
      .sort((a, b) => b.count - a.count);

    const topClients = Object.keys(userBookingCounts)
      .map((userName) => ({ userName, count: userBookingCounts[userName] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.status(200).json({ topServices, topClients });
  } catch (error) {
    console.error('Error in /api/manager/bookings/summary:', error);
    res.status(500).json({ error: 'Failed to fetch booking summary.' });
  }
});

app.get('/api/manager/settings', isManager, async (req, res) => {
  const { date } = req.query || {};
  const locationId = req.user?.managedLocationId;
  if (!date || !locationId) {
    return res.status(400).json({ error: 'Date and location are required.' });
  }
  try {
    const dailySettingDoc = await db.collection('locations').doc(locationId).collection('settings').doc(date).get();
    if (dailySettingDoc.exists) return res.status(200).json(dailySettingDoc.data());

    const globalSettingsDoc = await db.collection('locations').doc(locationId).collection('settings').doc('global').get();
    if (!globalSettingsDoc.exists) return res.status(200).json({ activeBays: 2 });

    res.status(200).json(globalSettingsDoc.data());
  } catch (error) {
    console.error('Error in /api/manager/settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

app.post('/api/manager/settings/activeBays', isManager, async (req, res) => {
  const { count, date } = req.body || {};
  const locationId = req.user?.managedLocationId;
  if (typeof count !== 'number' || !date || !locationId) {
    return res.status(400).json({ error: 'Invalid count, date, or location provided.' });
  }
  try {
    await db.collection('locations').doc(locationId).collection('settings').doc(date).set({ activeBays: count }, { merge: true });
    res.status(200).json({ message: `Active bays for ${date} successfully set to ${count}.` });
  } catch (error) {
    console.error('Error in /api/manager/settings/activeBays:', error);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

app.get('/api/manager/blocked-slots', isManager, async (req, res) => {
  const { date } = req.query || {};
  const locationId = req.user?.managedLocationId;
  if (!date || !locationId) {
    return res.status(400).json({ error: 'Date and location are required.' });
  }
  try {
    const snapshot = await db
      .collection('locations')
      .doc(locationId)
      .collection('blockedSlots')
      .where('date', '==', date)
      .get();
    const slots = snapshot.docs.map((doc) => doc.data().slot);
    res.status(200).json(slots);
  } catch (error) {
    console.error('Error in /api/manager/blocked-slots [GET]:', error);
    res.status(500).json({ error: 'Failed to fetch blocked slots.' });
  }
});

app.post('/api/manager/blocked-slots', isManager, async (req, res) => {
  const { date, slot } = req.body || {};
  const locationId = req.user?.managedLocationId;
  if (!date || !slot || !locationId) {
    return res.status(400).json({ error: 'Date, slot, and location are required.' });
  }
  try {
    const slotId = `${date}_${slot}`;
    const slotRef = db.collection('locations').doc(locationId).collection('blockedSlots').doc(slotId);
    const doc = await slotRef.get();
    if (doc.exists) {
      await slotRef.delete();
      res.status(200).json({ message: `Slot ${slot} on ${date} has been unblocked.` });
    } else {
      await slotRef.set({ date, slot });
      res.status(200).json({ message: `Slot ${slot} on ${date} has been blocked.` });
    }
  } catch (error) {
    console.error('Error in /api/manager/blocked-slots [POST]:', error);
    res.status(500).json({ error: 'Failed to update blocked slot.' });
  }
});

// ----- Global Error Handler -----
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ----- Process-level safety (avoid hard crashes) -----
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ----- Start Server -----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is now listening on port ${PORT}`);
});
