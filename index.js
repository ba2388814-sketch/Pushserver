const express     = require('express');
const admin       = require('firebase-admin');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const path        = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// HTML টেস্ট পেজ সার্ভ করার জন্য static ফোল্ডার কনফিগারেশন
app.use(express.static(path.join(__dirname, 'public')));

// ── Firebase Admin initialize ──
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function isValidAppId(appId) {
  return appId && /^[a-zA-Z0-9._\-]{3,100}$/.test(appId);
}

function tokenDocId(token) {
  return token.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
}

function devicesRef(appId) {
  return db.collection('push_tokens').doc(appId).collection('devices');
}

function appMetaRef(appId) {
  return db.collection('push_app_meta').doc(appId);
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Debug: সার্ভারে কোন credential লোড হয়েছে ──
app.get('/debug', (req, res) => {
  res.json({
    project_id:      serviceAccount.project_id,
    client_email:    serviceAccount.client_email,
    private_key_id:  serviceAccount.private_key_id,
    private_key_len: (serviceAccount.private_key || '').length
  });
});

// ── Debug: appId রেজিস্টার্ড আছে কিনা এবং কয়টা token আছে ──
app.get('/app-status', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const metaDoc  = await appMetaRef(appId).get();
    const tokenSnap = await devicesRef(appId).get();
    res.json({
      success:      true,
      appId,
      registered:   metaDoc.exists,
      registeredAt: metaDoc.exists ? metaDoc.data().registeredAt : null,
      tokenCount:   tokenSnap.size
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Register App ──
app.post('/register-app', async (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const ref = appMetaRef(appId);
    const doc = await ref.get();

    await ref.set({
      appId,
      registeredAt: doc.exists ? doc.data().registeredAt : Date.now(),
      updatedAt:    Date.now()
    }, { merge: true });

    console.log(`[${appId}] App registered/updated`);
    res.json({ success: true, message: 'app registered' });
  } catch (e) {
    console.error('Register-app error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Register Token ──
app.post('/register-token', async (req, res) => {
  const { token, appId, userAgent } = req.body;

  if (!token)               return res.status(400).json({ success: false, error: 'token required' });
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    await devicesRef(appId).doc(tokenDocId(token)).set({
      token,
      appId,
      userAgent:    userAgent || '',
      registeredAt: Date.now(),
      updatedAt:    Date.now()
    }, { merge: true });

    console.log(`[${appId}] Token registered: ${token.substring(0, 20)}...`);
    res.json({ success: true });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Get tokens by appId ──
app.get('/tokens', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const snap   = await devicesRef(appId).get();
    const tokens = snap.docs.map(d => ({
      token:        d.data().token,
      registeredAt: d.data().registeredAt,
      userAgent:    d.data().userAgent || ''
    }));
    res.json({ success: true, appId, count: tokens.length, tokens });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Send to one token ──
app.post('/send-notification', async (req, res) => {
  const { token, title, body, imageUrl } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'token required' });

  try {
    const t = title || 'Notification';
    const b = body  || '';

    const message = {
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    };

    const msgId = await admin.messaging().send(message);
    res.json({ success: true, messageId: msgId });
  } catch (e) {
    console.error('Send error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Send to ALL tokens of an appId ──
app.post('/send-all', async (req, res) => {
  const { appId, title, body, imageUrl } = req.body;
  if (!isValidAppId(appId)) return res.status(400).json({ success: false, error: 'valid appId required' });

  try {
    const snap = await devicesRef(appId).get();
    if (snap.empty) return res.json({ success: false, error: 'No tokens found for this app' });

    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    const t = title || 'Notification';
    const b = body  || '';
    const messages = tokens.map(token => ({
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    }));

    const result = await admin.messaging().sendEach(messages);
    console.log(`[${appId}] Sent: ${result.successCount} ok, ${result.failureCount} failed`);

    const batch = db.batch();
    let removed = 0;
    result.responses.forEach((r, i) => {
      if (!r.success) { batch.delete(snap.docs[i].ref); removed++; }
    });
    if (removed > 0) await batch.commit();

    res.json({
      success:      true,
      appId,
      total:        tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount
    });
  } catch (e) {
    console.error('Send-all error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Delete a token ──
app.delete('/token', async (req, res) => {
  const { appId, token } = req.query;
  if (!isValidAppId(appId) || !token) return res.status(400).json({ success: false, error: 'appId and token required' });

  try {
    await devicesRef(appId).doc(tokenDocId(token)).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Wevlo Push Server running on port ${PORT}`));
