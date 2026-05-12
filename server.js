const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();

const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Global Error Handlers
process.on('uncaughtException', (err) => {
  console.error('🛑 UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🛑 UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Firebase Admin SDK Initialization
let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    try {
      serviceAccount = require("./serviceAccountKey.json");
    } catch (requireError) {
      console.warn("⚠️ Warning: serviceAccountKey.json not found and FIREBASE_SERVICE_ACCOUNT env var is missing.");
      serviceAccount = { project_id: "MISSING" }; // Placeholder to trigger the next error block
    }
  }

  if (serviceAccount.project_id === "YOUR_PROJECT_ID" || serviceAccount.project_id === "MISSING") {
    throw new Error("FIREBASE_CONFIG_MISSING: Please provide FIREBASE_SERVICE_ACCOUNT env var or serviceAccountKey.json file.");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin initialized successfully.");
} catch (error) {
  console.error("\x1b[31m%s\x1b[0m", "--- FIREBASE INITIALIZATION ERROR ---");
  console.error("\x1b[33m%s\x1b[0m", error.message);
  console.error("Backend will run but database features will fail until FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json is provided.");
}

let db = null;
if (admin.apps.length > 0) {
  db = admin.firestore();
}

// --- ENDPOINTS ---

// 1. Record Attendance (Duplicate prevention logic)
app.post('/api/attendance/record', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized. Please provide Service Account Key." });
  const { employee_id, date } = req.body;

  const today = new Date().toISOString().split('T')[0];
  if (date > today) return res.status(400).json({ error: "Cannot record attendance for future dates." });
  const docId = `${employee_id}_${date}`;
  const docRef = db.collection('attendance').doc(docId);

  try {
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      await docRef.set({
        employee_id,
        name: req.body.name || "Unknown",
        date,
        status: 'present',
        isPaid: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(201).json({ success: true, message: "Attendance recorded" });
    }
    res.status(200).json({ success: true, message: "Attendance already exists" });
  } catch (error) {
    console.error("Attendance Record Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Quick Add Staff
app.post('/api/employees/quick-add', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized. Please provide Service Account Key." });
  const { name, phone, date, base_wage } = req.body;

  if (date) {
    const today = new Date().toISOString().split('T')[0];
    if (date > today) return res.status(400).json({ error: "Cannot record attendance for future dates." });
  }

  try {
    // Save employee
    const empRef = await db.collection('employees').add({
      name,
      phone,
      base_wage: base_wage || 240,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Immediate record work if date is provided
    if (date) {
      const docId = `${empRef.id}_${date}`;
      await db.collection('attendance').doc(docId).set({
        employee_id: empRef.id,
        name,
        date,
        status: 'present',
        isPaid: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.status(201).json({ success: true, employee_id: empRef.id });
  } catch (error) {
    console.error("Quick Add Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2.5 Search Employees
app.get('/api/employees/search', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized." });
  const { q } = req.query;
  if (!q) return res.status(200).json({ success: true, data: [] });

  try {
    const snapshot = await db.collection('employees')
      .orderBy('name')
      .startAt(q)
      .endAt(q + '\uf8ff')
      .limit(5)
      .get();

    const results = [];
    snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Get Unpaid Records
app.get('/api/attendance/unpaid/:employeeId', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized. Please provide Service Account Key." });
  const { employeeId } = req.params;
  try {
    const snapshot = await db.collection('attendance')
      .where('employee_id', '==', employeeId)
      .where('status', '==', 'unpaid')
      .get();

    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    res.status(200).json({ success: true, data: records });
  } catch (error) {
    console.error("Get Unpaid Records Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Bulk Payment Settle
app.post('/api/attendance/settle', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized. Please provide Service Account Key." });
  const { recordIds } = req.body;
  if (!recordIds || !Array.isArray(recordIds) || recordIds.length === 0) {
    return res.status(400).json({ error: "No records provided for settlement." });
  }
  const batch = db.batch();

  try {
    recordIds.forEach(id => {
      const docRef = db.collection('attendance').doc(id);
      batch.update(docRef, { isPaid: true, paidAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Settle Payment Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Delete Attendance
app.delete('/api/attendance/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized." });
  const { id } = req.params;
  try {
    await db.collection('attendance').doc(id).delete();
    res.status(200).json({ success: true, message: "Attendance record deleted" });
  } catch (error) {
    console.error("Delete Attendance Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Change Admin Password
app.post('/api/auth/change-password', async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database not initialized." });
  const { oldPassword, newPassword } = req.body;

  try {
    const adminRef = db.collection('settings').doc('admin');
    const doc = await adminRef.get();

    // Default password if none exists in DB yet
    const currentPassword = doc.exists ? doc.data().password : 'admin';

    console.log(`[AUTH] Password Change Attempt: Received Old: "${oldPassword}", Current in DB: "${currentPassword}"`);

    if (currentPassword !== oldPassword) {
      console.warn(`[AUTH] Password mismatch for change-password request.`);
      return res.status(400).json({
        success: false,
        error: "Incorrect Old Password",
        message: "The old password you entered is incorrect.",
        payload: {}
      });
    }

    await adminRef.set({ password: newPassword }, { merge: true });
    console.log(`[AUTH] Password updated successfully in Firestore.`);
    res.status(200).json({
      success: true,
      message: "Password updated successfully!",
      payload: { updated: true }
    });
  } catch (error) {
    console.error("Change Password Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`----------------------------------------`);
  console.log(`🚀 Backend Server running on port ${PORT}`);
  console.log(`🟢 Ready to handle requests`);
  console.log(`----------------------------------------`);
});

// Detect server-level errors (like port conflicts)
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`🛑 ERROR: Port ${PORT} is already in use!`);
    console.error(`👉 Suggestion: Run 'taskkill /F /IM node.exe' to clear old processes.`);
  } else {
    console.error('🛑 SERVER ERROR:', err);
  }
  process.exit(1);
});

// Diagnostic: Log why the process is closing
process.on('exit', (code) => {
  console.log(`\n⚠️ PROCESS EXIT DETECTED: Code ${code}`);
  if (code === 0) {
    console.log('💡 This was a "clean" exit. This usually means something in the code called process.exit() or the script finished.');
  }
});
