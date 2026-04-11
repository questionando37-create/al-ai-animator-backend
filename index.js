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
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT || './firebase-service-account.json');
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
console.log('🔥 Firebase Admin iniciado');

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

// ── Jobs em memória ──
const jobs = {};

// ── Pedidos Pix pendentes ──
const pixOrders = {};

// ── Carteiras no Firestore ──
const db = admin.firestore();

async function getWallet(uid) {
  const doc = await db.collection('wallets').doc(uid).get();
  return doc.exists ? (doc.data().balance || 0) : 0;
}

async function incrementWallet(uid, amount) {
  const ref = db.collection('wallets').doc(uid);
  let newBalance = 0;
  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? (doc.data().balance || 0) : 0;
    newBalance = current + amount;
    t.set(ref, { balance: newBalance }, { merge: true });
  });
  return newBalance;
}

async function decrementWallet(uid, amount) {
  const ref = db.collection('wallets').doc(uid);
  let newBalance = 0;
  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    const current = doc.exists ? (doc.data().balance || 0) : 0;
    if (current < amount) throw new Error('Saldo insuficiente');
    newBalance = current - amount;
    t.set(ref, { balance: newBalance }, { merge: true });
  });
  return newBalance;
}

console.log('💰 Firestore para carteiras: ✅');

// ── Limpeza automática ──
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(id => {
    if (jobs[id].expires && now > jobs[id].expires) {
      delete jobs[id];
    }
  });
  Object.keys(pixOrders).forEach(id => {
    if (now - pixOrders[id].createdAt > 2 * 60 * 60 * 1000) delete pixOrders[id];
  });
}, 30 * 60 * 1000);

function scheduleImageCleanup(filePath) {
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }, 4 * 60 * 60 * 1000);
}

// ── Webhook Stripe (body RAW) ──
app.post('/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Stripe webhook error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'payment_intent.succeeded') {
      const pi    = event.data.object;
      const jobId = pi.metadata?.jobId;
      if (jobId && jobs[jobId]) {
        jobs[jobId].paid = true;
        console.log('✅ Stripe pagamento confirmado para job:', jobId);
        if (!jobs[jobId].started) {
          jobs[jobId].started = true;
          triggerGeneration(jobId);
        }
      }
    }
    res.json({ received: true });
  }
);

// ── Webhook PagBank ──
app.post('/webhook/pagbank',
  express.json(),
  async (req, res) => {
    console.log('PagBank webhook recebido:', JSON.stringify(req.body));
    const { reference_id, charges } = req.body;
    const charge = charges?.find(c => c.status === 'PAID');
    if (!charge || !reference_id) return res.status(200).json({ success: true });

    const amountPaid = charge.amount?.summary?.paid || 0;

    // ── É um depósito de carteira? ──
    if (reference_id.startsWith('dep_') && deposits[reference_id]) {
      const dep = deposits[reference_id];
      if (!dep.paid) {
        dep.paid = true;
        const newBalance = await incrementWallet(dep.uid, amountPaid);
        console.log(`💰 Depósito confirmado: ${dep.uid} +${amountPaid} centavos (total: ${newBalance})`);
      }
      return res.status(200).json({ success: true });
    }

    // ── É um pagamento de geração? ──
    const order = pixOrders[reference_id];
    if (order && jobs[order.jobId]) {
      const job = jobs[order.jobId];
      job.paid = true;
      console.log('✅ Pix PagBank confirmado para job:', order.jobId);

      // Credita troco na carteira
      const amountNeeded = order.amount || 300;
      const troco = amountPaid - amountNeeded;
      if (troco > 0 && job.userId) {
        const newBal = await incrementWallet(job.userId, troco);
        console.log(`💰 Troco creditado: ${job.userId} +${troco} centavos (total: ${newBal})`);
      }

      if (!job.started) {
        job.started = true;
        triggerGeneration(order.jobId);
      }
    }

    res.status(200).json({ success: true });
  }
);

// ── Middlewares ──
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ── ROTA 1: Upload imagem ──
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
  const baseUrl  = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
  const imageUrl = `${baseUrl}/uploads/${req.file.filename}`;
  scheduleImageCleanup(req.file.path);
  res.json({ success: true, imageUrl });
});

// ── ROTA 2: Preparar job (salva dados, retorna jobId) ──
app.post('/api/prepare-job', async (req, res) => {
  const { imageUrl, prompt, ratio, devKey } = req.body;
  if (!imageUrl || !prompt) return res.status(400).json({ success: false, error: 'imageUrl e prompt obrigatórios' });

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const isDevMode = devKey === process.env.DEV_KEY;

  // Tenta extrair userId do token se houver
  let userId = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
      userId = decoded.uid;
    } catch(e) {}
  }

  jobs[jobId] = {
    imageUrl, prompt, ratio: ratio || '16:9',
    paid:      isDevMode,
    devMode:   isDevMode,
    started:   false,
    expires:   Date.now() + (4 * 60 * 60 * 1000),
    predictions: [],
    videoUrls:   {},
    userId,
  };

  // Dev mode: já inicia geração
  if (isDevMode) {
    jobs[jobId].started = true;
    triggerGeneration(jobId);
    return res.json({ success: true, jobId, devMode: true });
  }

  res.json({ success: true, jobId, devMode: false });
});

// ── ROTA 3: Criar PaymentIntent Stripe (cartão) ──
app.post('/api/create-payment-intent', async (req, res) => {
  const { jobId } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });

  try {
    const amount = req.body.amount || 300;
    let customerId = undefined;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      try {
        const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
        customerId = await getOrCreateStripeCustomer(decoded.uid, decoded.email, decoded.name);
      } catch(e) {}
    }
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'brl',
      customer: customerId,
      setup_future_usage: customerId ? 'on_session' : undefined,
      metadata: { jobId },
      description: 'AL.AI Animator — variações de vídeo',
    });
    res.json({ success: true, clientSecret: pi.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROTA 4: Criar QR Code Pix PagBank ──
app.post('/api/create-pix', async (req, res) => {
  const { jobId } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });

  const amount = req.body.amount || 300; // centavos
  const orderRef = 'alai_' + jobId;
  const isSandbox = process.env.PAGBANK_ENV === 'sandbox';
  const baseUrl = isSandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
  const webhookUrl = `${process.env.FRONTEND_URL}/webhook/pagbank`;

  // Expira em 30 minutos
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '-03:00');

  try {
    const response = await axios.post(
      `${baseUrl}/orders`,
      {
        reference_id: orderRef,
        customer: {
          name:   'Cliente AL.AI',
          email:  process.env.PAGBANK_ENV === 'sandbox' ? 'cliente.teste@alai.app' : 'cliente@alai.app',
          tax_id: '12345678909',
          phones: [{ country: '55', area: '11', number: '999999999', type: 'MOBILE' }]
        },
        items: [{
          name:        'AL.AI Animator — variações de vídeo',
          quantity:    1,
          unit_amount: amount,
        }],
        qr_codes: [{
          amount: { value: amount },
          expiration_date: expires,
        }],
        notification_urls: [ webhookUrl ],
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PAGBANK_TOKEN}`,
          'Content-Type':  'application/json',
        }
      }
    );

    const data = response.data;
    console.log('PagBank resposta:', JSON.stringify(data));

    // Extrai QR Code da resposta
    const qrCode = data.qr_codes?.[0];
    const qrText = qrCode?.text || null;
    const qrImg  = qrCode?.links?.find(l => l.media === 'image/png')?.href || null;

    // Salva referência para webhook
    pixOrders[orderRef] = { jobId, createdAt: Date.now(), amount };

    res.json({
      success:      true,
      pixCopyPaste: qrText,
      pixQrImage:   qrImg,
      orderId:      data.id,
      orderRef,
    });

  } catch (err) {
    console.error('PagBank error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Erro ao gerar Pix.' });
  }
});

// ── ROTA 5: Status do job ──
app.get('/api/job-status/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ success: false, error: 'Job não encontrado' });

  // Se ainda não iniciou geração (aguardando pagamento)
  if (!job.started) {
    return res.json({ success: true, phase: 'waiting_payment', paid: false });
  }

  // Se iniciou mas ainda sem predictions
  if (!job.predictions || job.predictions.length === 0) {
    return res.json({ success: true, phase: 'starting', paid: true });
  }

  try {
    const results = await Promise.all(job.predictions.map(async (p) => {
      if (job.videoUrls[p.variation]) {
        return { variation: p.variation, status: 'succeeded', videoUrl: job.videoUrls[p.variation] };
      }
      const response = await axios.get(
        `https://api.replicate.com/v1/predictions/${p.predictionId}`,
        { headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` } }
      );
      const data = response.data;
      console.log(`📊 Variação ${p.variation}: status=${data.status}`);
      if (data.status === 'succeeded' && data.output) {
        job.videoUrls[p.variation] = data.output;
      }
      return {
        variation: p.variation,
        status:    data.status,
        videoUrl:  data.status === 'succeeded' ? data.output : null,
        error:     data.status === 'failed'    ? data.error  : null,
      };
    }));

    const allDone = results.every(r => r.status === 'succeeded' || r.status === 'failed');
    res.json({ success: true, phase: 'generating', paid: true, results, allDone, expires: job.expires });

  } catch (err) {
    console.error('Erro job-status:', err?.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROTA 6: Validar DEV_KEY ──
app.post('/api/validate-dev', (req, res) => {
  res.json({ valid: req.body.devKey === process.env.DEV_KEY });
});

// ── ROTA 7: Pix info (chave manual) ──
app.get('/api/pix-info', (req, res) => {
  res.json({ success: true, pixKey: process.env.PIX_KEY || '', amount: 3.00 });
});

// ── ROTA 8: Stripe publishable key ──
app.get('/api/stripe-key', (req, res) => {
  const pk = process.env.STRIPE_PUBLISHABLE_KEY || '';
  res.json({ publishableKey: pk });
});

// ── Middleware: verifica token Firebase ──
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

// ── Stripe Customers no Firestore ──
async function getOrCreateStripeCustomer(uid, email, name) {
  const doc = await db.collection('stripe_customers').doc(uid).get();
  if (doc.exists && doc.data().customerId) {
    return doc.data().customerId;
  }
  const customer = await stripe.customers.create({
    email: email || undefined,
    name:  name  || undefined,
    metadata: { uid },
  });
  await db.collection('stripe_customers').doc(uid).set({ customerId: customer.id });
  return customer.id;
}

// ── Carteiras em memória (uid -> saldo em centavos) ──

// ── ROTA 9: Perfil do usuário ──
app.get('/api/me', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const balance = await getWallet(uid);
  res.json({
    success: true,
    uid,
    email:   req.user.email,
    name:    req.user.name || req.user.email,
    photo:   req.user.picture || null,
    balance,
  });
});

// ── ROTA 10: Saldo da carteira ──
app.get('/api/wallet', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const balance = await getWallet(uid);
  res.json({ success: true, balance });
});

// ── ROTA 11: Creditar carteira após pagamento ──
app.post('/api/wallet/credit', verifyToken, async (req, res) => {
  const uid    = req.user.uid;
  const amount = parseInt(req.body.amount) || 0;
  if (amount <= 0) return res.status(400).json({ success: false, error: 'Valor inválido' });
  const balance = await incrementWallet(uid, amount);
  console.log(`💰 Carteira creditada: ${uid} +${amount} centavos (total: ${balance})`);
  res.json({ success: true, balance });
});

// ── ROTA 12: Usar saldo da carteira ──
app.post('/api/wallet/use', verifyToken, async (req, res) => {
  const uid    = req.user.uid;
  const amount = parseInt(req.body.amount) || 300;
  const { imageUrl, prompt, ratio } = req.body;
  try {
    const balance = await decrementWallet(uid, amount);
    const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    jobs[jobId] = {
      imageUrl, prompt, ratio: ratio || '16:9',
      paid: true, devMode: false, started: true,
      expires: Date.now() + (4 * 60 * 60 * 1000),
      predictions: [], videoUrls: {},
      userId: uid,
    };
    triggerGeneration(jobId);
    console.log(`💸 Carteira debitada: ${uid} -${amount} centavos (saldo: ${balance})`);
    res.json({ success: true, jobId, balance });
  } catch(err) {
    return res.status(402).json({ success: false, error: err.message });
  }
});

// ── ROTA: Criar PaymentIntent para depósito via cartão ──
app.post('/api/create-deposit-payment-intent', verifyToken, async (req, res) => {
  const amount = parseInt(req.body.amount) || 300;
  try {
    const customerId = await getOrCreateStripeCustomer(req.user.uid, req.user.email, req.user.name);
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'brl',
      customer: customerId,
      setup_future_usage: 'on_session',
      metadata: { uid: req.user.uid, type: 'deposit' },
      description: 'AL.AI Animator — recarga de carteira',
    });
    res.json({ success: true, clientSecret: pi.client_secret });
  } catch(err) {
    console.error('Stripe deposit error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROTA: Listar cartões salvos ──
app.get('/api/saved-cards', verifyToken, async (req, res) => {
  try {
    const scDoc = await db.collection('stripe_customers').doc(req.user.uid).get();
    const customerId = scDoc.exists ? scDoc.data().customerId : null;
    if (!customerId) return res.json({ success: true, cards: [] });
    const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    const cards = methods.data.map(pm => ({
      id:     pm.id,
      brand:  pm.card.brand,
      last4:  pm.card.last4,
      expiry: `${pm.card.exp_month}/${pm.card.exp_year}`,
    }));
    res.json({ success: true, cards });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ROTA: Remover cartão salvo ──
app.delete('/api/saved-cards/:pmId', verifyToken, async (req, res) => {
  try {
    await stripe.paymentMethods.detach(req.params.pmId);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Depósitos pendentes ──
const deposits = {};

// ── ROTA: Criar Pix para depósito na carteira ──
app.post('/api/create-deposit-pix', verifyToken, async (req, res) => {
  const uid    = req.user.uid;
  const amount = parseInt(req.body.amount) || 600;
  const depositId = 'dep_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const orderRef  = 'dep_' + depositId;
  const isSandbox = process.env.PAGBANK_ENV === 'sandbox';
  const baseUrl   = isSandbox ? 'https://sandbox.api.pagseguro.com' : 'https://api.pagseguro.com';
  const expires   = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('Z', '-03:00');

  try {
    const response = await axios.post(
      `${baseUrl}/orders`,
      {
        reference_id: orderRef,
        customer: { 
        name: (req.user.name || 'Cliente').replace(/[!@#$%¨*()"\\|{}\[\]<>;]/g, '').substring(0, 50) || 'Cliente', 
        email: process.env.PAGBANK_ENV === 'sandbox' ? 'comprador@sandbox.pagseguro.com.br' : 'pagamento@alai.app',
        tax_id: '12345678909', 
        phones: [{ country: '55', area: '11', number: '999999999', type: 'MOBILE' }] 
      },
        items: [{ name: 'Recarga carteira AL.AI', quantity: 1, unit_amount: amount }],
        qr_codes: [{ amount: { value: amount }, expiration_date: expires }],
        notification_urls: [`${process.env.FRONTEND_URL}/webhook/pagbank`],
      },
      { headers: { Authorization: `Bearer ${process.env.PAGBANK_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const qrCode = response.data.qr_codes?.[0];
    deposits[orderRef] = { uid, amount, paid: false, createdAt: Date.now() };

    res.json({
      success:      true,
      depositId:    orderRef,
      pixCopyPaste: qrCode?.text || null,
      pixQrImage:   qrCode?.links?.find(l => l.media === 'image/png')?.href || null,
    });

  } catch(err) {
    console.error('PagBank deposit error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'Erro ao gerar Pix.' });
  }
});

// ── ROTA: Status do depósito ──
app.get('/api/deposit-status/:depositId', verifyToken, async (req, res) => {
  const dep = deposits[req.params.depositId];
  if (!dep) return res.status(404).json({ success: false, error: 'Depósito não encontrado' });
  const balance = await getWallet(dep.uid);
  res.json({ success: true, paid: dep.paid, balance });
});

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ status: 'online', activeJobs: Object.keys(jobs).length });
});

// ── Função: dispara geração no Replicate ──
async function triggerGeneration(jobId) {
  const job = jobs[jobId];
  if (!job) return;

  try {
    console.log('🎬 Enviando para Replicate, imagem:', job.imageUrl);
    const predictions = await Promise.all([1, 2, 3].map(async (i) => {
      const response = await axios.post(
        'https://api.replicate.com/v1/models/minimax/video-01-live/predictions',
        {
          input: {
            prompt: job.prompt,
            first_frame_image: job.imageUrl,
          }
        },
        {
          headers: {
            Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Prefer': 'wait'
          }
        }
      );
      console.log(`✅ Variação ${i} enviada:`, response.data.id, '| status:', response.data.status);
      return { predictionId: response.data.id, variation: i };
    }));

    jobs[jobId].predictions = predictions;
    console.log('🎬 Geração iniciada no Replicate para job:', jobId);

  } catch (err) {
    console.error('Erro Replicate:', err.response?.data || err.message);
    jobs[jobId].error = 'Erro ao iniciar geração no Replicate';
  }
}

// ── Fallback SPA ──
app.use((req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/webhook') && req.path !== '/health') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor AL.AI rodando em http://localhost:${PORT}`);
  console.log(`🔑 Dev Key: ${process.env.DEV_KEY ? '✅ configurada' : '❌ NÃO configurada!'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅' : '❌'}`);
  console.log(`💚 InfinitePay handle: ${process.env.INFINITEPAY_HANDLE || '❌ não configurado'}`);
  console.log(`🤖 fal.ai: ${process.env.FAL_KEY ? '✅' : '❌ NÃO configurado!'}`);
  console.log(`🏦 PagBank: ${process.env.PAGBANK_TOKEN ? '✅' : '❌ NÃO configurado!'}`);
  console.log(`🌐 URL pública: ${process.env.FRONTEND_URL}`);
});
