require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const axios    = require('axios');
const multer   = require('multer');
const fs       = require('fs');
const Stripe   = require('stripe');
const { fal }  = require('@fal-ai/client');
const admin    = require('firebase-admin');

// ── Firebase Admin ──
let serviceAccount;
const secretPath = '/etc/secrets/firebase-service-account.json';
if (fs.existsSync(secretPath)) {
  serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  console.log('🔑 Firebase: usando Secret File do Render');
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\n/g, '\n');
  }
  console.log(' Firebase: usando variável de ambiente');
} else {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT || './firebase-service-account.json');
  console.log('🔑 Firebase: usando arquivo local');
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
console.log(' Firebase Admin iniciado');

const FAL_KEY = process.env.FAL_KEY;
fal.config({ credentials: FAL_KEY });

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT   = process.env.PORT || 3000;

// ── Pasta de uploads ──
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer ──
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname) || '.jpg';
    const name = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2) + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── Estado em memória ─
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
let wallets = {};
try { if (fs.existsSync(WALLETS_FILE)) wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch(e) { wallets = {}; }
function saveWallets() { try { fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2)); } catch(e) {} }

const jobs = {};
const pixOrders = {};
const deposits = {}; // ✅ MOVIDO PARA CÁ (antes de ser usado)

// ── Firestore ──
const db = admin.firestore();

async function getWallet(uid) {
  try {
    const doc = await db.collection('wallets').doc(uid).get();
    return doc.exists ? (doc.data().balance || 0) : 0;
  } catch(e) { return wallets[uid] || 0; }
}
async function incrementWallet(uid, amount) {
  try {
    const ref = db.collection('wallets').doc(uid);
    let newBalance = 0;
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const current = doc.exists ? (doc.data().balance || 0) : 0;
      newBalance = current + amount;
      t.set(ref, { balance: newBalance }, { merge: true });
    });
    wallets[uid] = newBalance;
    return newBalance;
  } catch(e) { wallets[uid] = (wallets[uid] || 0) + amount; saveWallets(); return wallets[uid]; }
}
async function decrementWallet(uid, amount) {
  try {
    const ref = db.collection('wallets').doc(uid);
    let newBalance = 0;
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const current = doc.exists ? (doc.data().balance || 0) : 0;
      if (current < amount) throw new Error('Saldo insuficiente');
      newBalance = current - amount;
      t.set(ref, { balance: newBalance }, { merge: true });
    });
    wallets[uid] = newBalance;
    return newBalance;
  } catch(e) {
    if (e.message === 'Saldo insuficiente') throw e;
    if ((wallets[uid] || 0) < amount) throw new Error('Saldo insuficiente');
    wallets[uid] = (wallets[uid] || 0) - amount; saveWallets(); return wallets[uid];
  }
}

let stripeCustomers = {};
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(id => { if (jobs[id].expires && now > jobs[id].expires) delete jobs[id]; });
  Object.keys(pixOrders).forEach(id => { if (now - pixOrders[id].createdAt > 2 * 60 * 60 * 1000) delete pixOrders[id]; });
  Object.keys(deposits).forEach(id => { if (now - deposits[id].createdAt > 2 * 60 * 60 * 1000) delete deposits[id]; });
}, 30 * 60 * 1000);

function scheduleImageCleanup(filePath) {
  setTimeout(() => { if (fs.existsSync(filePath)) fs.unlink(filePath, () => {}); }, 4 * 60 * 60 * 1000);
}

// ── Webhooks ──
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === 'payment_intent.succeeded') {
    const jobId = event.data.object.metadata?.jobId;
    if (jobId && jobs[jobId]) { jobs[jobId].paid = true; if (!jobs[jobId].started) { jobs[jobId].started = true; triggerGeneration(jobId); } }
  }
  res.json({ received: true });
});

app.post('/webhook/pagbank', express.json(), async (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(200).json({ success: true });
  const { reference_id, charges } = req.body;
  const charge = charges?.find(c => c.status === 'PAID');
  if (!charge || !reference_id) return res.status(200).json({ success: true });
  const amountPaid = charge.amount?.summary?.paid || 0;

  if (reference_id.startsWith('dep_') && deposits[reference_id]) {
    const dep = deposits[reference_id];
    if (!dep.paid) {
      dep.paid = true;
      const newBalance = await incrementWallet(dep.uid, amountPaid);
      try { await db.collection('wallet_history').add({ uid: dep.uid, amount: amountPaid, type: 'deposit', method: 'pix', date: new Date().toISOString(), balance: newBalance }); } catch(e) {}
    }
    return res.status(200).json({ success: true });
  }

  const order = pixOrders[reference_id];
  if (order && jobs[order.jobId]) {
    const job = jobs[order.jobId];
    job.paid = true;
    const troco = amountPaid - (order.amount || 300);
    if (troco > 0 && job.userId) await incrementWallet(job.userId, troco);
    if (!job.started) { job.started = true; triggerGeneration(order.jobId); }
  }
  res.status(200).json({ success: true });
});

// ── Middlewares ──
app.use(cors());
app.use((req, res, next) => { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups'); res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none'); next(); });
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── Rotas ──
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
  const imageUrl = `${process.env.FRONTEND_URL || `http://localhost:${PORT}`}/uploads/${req.file.filename}`;
  scheduleImageCleanup(req.file.path);
  res.json({ success: true, imageUrl });
});

app.post('/api/prepare-job', async (req, res) => {
  const { imageUrl, prompt, ratio, devKey } = req.body;
  if (!imageUrl || !prompt) return res.status(400).json({ success: false, error: 'imageUrl e prompt obrigatórios' });
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const isDevMode = devKey === process.env.DEV_KEY;
  let userId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) { try { const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]); userId = decoded.uid; } catch(e) {} }
  jobs[jobId] = { imageUrl, prompt, ratio: ratio || '16:9', paid: isDevMode, devMode: isDevMode, started: false, expires: Date.now() + (4 * 60 * 60 * 1000), predictions: [], videoUrls: {}, userId };
  if (isDevMode) { jobs[jobId].started = true; triggerGeneration(jobId); return res.json({ success: true, jobId, devMode: true }); }
  res.json({ success: true, jobId, devMode: false });
});

app.post('/api/create-payment-intent', async (req, res) => {
  const { jobId } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });
  try {
    const amount = req.body.amount || 300;
    let customerId = undefined;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) { try { const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]); customerId = await getOrCreateStripeCustomer(decoded.uid, decoded.email, decoded.name); } catch(e) {} }
    const pi = await stripe.paymentIntents.create({ amount, currency: 'brl', customer: customerId, setup_future_usage: customerId ? 'on_session' : undefined, metadata: { jobId }, description: 'AL.AI Animator — variações de vídeo' });
    res.json({ success: true, clientSecret: pi.client_secret });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/create-pix', async (req, res) => {
  const { jobId } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });
  const amount = req.body.amount || 300;
  const orderRef = 'alai_' + jobId;
  const baseUrl = process.env.PAGBANK_ENV === 'sandbox' ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '-03:00');
  try {
    const response = await axios.post(`${baseUrl}/orders`, { reference_id: orderRef, customer: { name: 'Cliente AL.AI', email: process.env.PAGBANK_ENV === 'sandbox' ? 'cliente.teste@alai.app' : 'cliente@alai.app', tax_id: '12345678909', phones: [{ country: '55', area: '11', number: '999999999', type: 'MOBILE' }] }, items: [{ name: 'AL.AI Animator — variações de vídeo', quantity: 1, unit_amount: amount }], qr_codes: [{ amount: { value: amount }, expiration_date: expires }], notification_urls: [`${process.env.FRONTEND_URL}/webhook/pagbank`] }, { headers: { 'Authorization': `Bearer ${process.env.PAGBANK_TOKEN}`, 'Content-Type': 'application/json' } });
    const qrCode = response.data.qr_codes?.[0];
    pixOrders[orderRef] = { jobId, createdAt: Date.now(), amount };
    res.json({ success: true, pixCopyPaste: qrCode?.text, pixQrImage: qrCode?.links?.find(l => l.media === 'image/png')?.href, orderId: response.data.id, orderRef });
  } catch (err) { res.status(500).json({ success: false, error: 'Erro ao gerar Pix.' }); }
});

app.get('/api/job-status/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });
  if (!job.started) return res.json({ success: true, phase: 'waiting_payment', paid: false });
  if (!job.predictions?.length) return res.json({ success: true, phase: 'starting', paid: true });
  try {
    const results = await Promise.all(job.predictions.map(async (p) => {
      if (job.videoUrls[p.variation]) return { variation: p.variation, status: 'succeeded', videoUrl: job.videoUrls[p.variation] };
      const { data } = await axios.get(`https://api.replicate.com/v1/predictions/${p.predictionId}`, { headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` } });
      if (data.status === 'succeeded' && data.output) job.videoUrls[p.variation] = data.output;
      return { variation: p.variation, status: data.status, videoUrl: data.status === 'succeeded' ? data.output : null, error: data.status === 'failed' ? data.error : null };
    }));
    res.json({ success: true, phase: 'generating', paid: true, results, allDone: results.every(r => r.status === 'succeeded' || r.status === 'failed'), expires: job.expires });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/validate-dev', (req, res) => res.json({ valid: req.body.devKey === process.env.DEV_KEY }));
app.get('/api/pix-info', (req, res) => res.json({ success: true, pixKey: process.env.PIX_KEY || '', amount: 3.00 }));
app.get('/api/stripe-key', (req, res) => res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' }));

async function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'Não autenticado' });
  try { req.user = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]); next(); } catch (err) { res.status(401).json({ success: false, error: 'Token inválido' }); }
}

async function getOrCreateStripeCustomer(uid, email, name) {
  try { const doc = await db.collection('stripe_customers').doc(uid).get(); if (doc.exists && doc.data().customerId) return doc.data().customerId; } catch(e) { if (stripeCustomers[uid]) return stripeCustomers[uid]; }
  const customer = await stripe.customers.create({ email: email || undefined, name: name || undefined, metadata: { uid } });
  try { await db.collection('stripe_customers').doc(uid).set({ customerId: customer.id }); } catch(e) { stripeCustomers[uid] = customer.id; }
  return customer.id;
}

app.get('/api/me', verifyToken, async (req, res) => res.json({ success: true, uid: req.user.uid, email: req.user.email, name: req.user.name || req.user.email, photo: req.user.picture || null, balance: await getWallet(req.user.uid) }));
app.get('/api/wallet', verifyToken, async (req, res) => res.json({ success: true, balance: await getWallet(req.user.uid) }));
app.post('/api/wallet/credit', verifyToken, async (req, res) => {
  const { amount = 0, method = 'card' } = req.body;
  if (amount <= 0) return res.status(400).json({ success: false, error: 'Valor inválido' });
  const balance = await incrementWallet(req.user.uid, amount);
  try { await db.collection('wallet_history').add({ uid: req.user.uid, amount, type: 'deposit', method, date: new Date().toISOString(), balance }); } catch(e) {}
  res.json({ success: true, balance });
});
app.post('/api/wallet/use', verifyToken, async (req, res) => {
  const { amount = 300, imageUrl, prompt, ratio } = req.body;
  try {
    const balance = await decrementWallet(req.user.uid, amount);
    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    jobs[jobId] = { imageUrl, prompt, ratio: ratio || '16:9', paid: true, devMode: false, started: true, expires: Date.now() + (4 * 60 * 60 * 1000), predictions: [], videoUrls: {}, userId: req.user.uid };
    triggerGeneration(jobId);
    res.json({ success: true, jobId, balance });
  } catch(err) { res.status(402).json({ success: false, error: err.message }); }
});
app.post('/api/create-deposit-payment-intent', verifyToken, async (req, res) => {
  try { const customerId = await getOrCreateStripeCustomer(req.user.uid, req.user.email, req.user.name); const pi = await stripe.paymentIntents.create({ amount: parseInt(req.body.amount) || 300, currency: 'brl', customer: customerId, setup_future_usage: 'on_session', metadata: { uid: req.user.uid, type: 'deposit' }, description: 'AL.AI Animator — recarga de carteira' }); res.json({ success: true, clientSecret: pi.client_secret }); } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get('/api/saved-cards', verifyToken, async (req, res) => {
  try {
    let customerId = null; try { const doc = await db.collection('stripe_customers').doc(req.user.uid).get(); customerId = doc.exists ? doc.data().customerId : null; } catch(e) { customerId = stripeCustomers[req.user.uid] || null; }
    if (!customerId) return res.json({ success: true, cards: [] });
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    res.json({ success: true, cards: methods.data.map(pm => ({ id: pm.id, brand: pm.card.brand, last4: pm.card.last4, expiry: `${pm.card.exp_month}/${pm.card.exp_year}` })) });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
app.delete('/api/saved-cards/:pmId', verifyToken, async (req, res) => { try { await stripe.paymentMethods.detach(req.params.pmId); res.json({ success: true }); } catch(err) { res.status(500).json({ success: false, error: err.message }); } });
app.post('/api/create-deposit-pix', verifyToken, async (req, res) => {
  const amount = parseInt(req.body.amount) || 600;
  const orderRef = 'dep_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const baseUrl = process.env.PAGBANK_ENV === 'sandbox' ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '-03:00');
  try {
    const { data } = await axios.post(`${baseUrl}/orders`, { reference_id: orderRef, customer: { name: (req.user.name || 'Cliente').replace(/[!@#$%¨*()"\|{}[\]<>;]/g, '').substring(0, 50) || 'Cliente', email: process.env.PAGBANK_ENV === 'sandbox' ? 'comprador@sandbox.pagseguro.com.br' : 'pagamento@alai.app', tax_id: '12345678909', phones: [{ country: '55', area: '11', number: '999999999', type: 'MOBILE' }] }, items: [{ name: 'Recarga carteira AL.AI', quantity: 1, unit_amount: amount }], qr_codes: [{ amount: { value: amount }, expiration_date: expires }], notification_urls: [`${process.env.FRONTEND_URL}/webhook/pagbank`] }, { headers: { 'Authorization': `Bearer ${process.env.PAGBANK_TOKEN}`, 'Content-Type': 'application/json' } });
    const qrCode = data.qr_codes?.[0];
    deposits[orderRef] = { uid: req.user.uid, amount, paid: false, createdAt: Date.now() };
    res.json({ success: true, depositId: orderRef, pixCopyPaste: qrCode?.text, pixQrImage: qrCode?.links?.find(l => l.media === 'image/png')?.href });
  } catch(err) { res.status(500).json({ success: false, error: 'Erro ao gerar Pix.' }); }
});
app.get('/api/deposit-status/:depositId', verifyToken, async (req, res) => {
  const dep = deposits[req.params.depositId];
  if (!dep) return res.status(404).json({ success: false, error: 'Depósito não encontrado' });
  res.json({ success: true, paid: dep.paid, balance: await getWallet(dep.uid) });
});
app.get('/api/wallet/history', verifyToken, async (req, res) => {
  try { const snap = await db.collection('wallet_history').where('uid', '==', req.user.uid).orderBy('date', 'desc').limit(20).get(); res.json({ success: true, history: snap.docs.map(d => d.data()) }); } catch(e) { res.json({ success: true, history: [] }); }
});
app.get('/health', (req, res) => res.json({ status: 'online', activeJobs: Object.keys(jobs).length }));

async function triggerGeneration(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  try {
    const predictions = await Promise.all([1, 2, 3].map(async (i) => {
      const { data } = await axios.post('https://api.replicate.com/v1/models/minimax/video-01-live/predictions', { input: { prompt: job.prompt, first_frame_image: job.imageUrl } }, { headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json', 'Prefer': 'wait' } });
      return { predictionId: data.id, variation: i };
    }));
    job.predictions = predictions;
  } catch (err) { job.error = 'Erro ao iniciar geração no Replicate'; }
}

app.use((req, res) => { if (!req.path.startsWith('/api') && !req.path.startsWith('/webhook') && req.path !== '/health') res.sendFile(path.join(__dirname, 'public', 'index.html')); else res.status(404).json({ error: 'Not Found' }); });

// ✅ CORREÇÃO: Removido espaço entre = e >
app.listen(PORT, () => {
  console.log(`✅ Servidor AL.AI rodando em http://localhost:${PORT}`);
  console.log(`🔑 Dev Key: ${process.env.DEV_KEY ? '✅' : '❌'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`🤖 fal.ai: ${process.env.FAL_KEY ? '✅' : '❌'}`);
  console.log(`🏦 PagBank: ${process.env.PAGBANK_TOKEN ? '✅' : '❌'}`);
});