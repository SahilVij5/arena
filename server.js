const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { pool, initDB, isDBReady } = require('./db');
const adminRoutes = require('./routes/admin');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enforce JWT_SECRET in production to avoid security breaches
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
  process.exit(1); // Crash the app so it doesn't run insecurely
}
const JWT_SECRET = process.env.JWT_SECRET || 'pixelplex-secret-key-change-in-production';

// ── Razorpay instance ──
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  console.log('  Razorpay initialized');
}

// ── In-memory fallback store (for local dev without PostgreSQL) ──
const memoryUsers = [];
const memoryVideos = [];
const memoryPurchases = [];

// ── Middleware ──
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ── Serve static files ──
app.use(express.static(path.join(__dirname)));

// ── Auth Middleware ──
function authenticateToken(req, res, next) {
  const token = req.cookies.pixelplex_token || req.headers.authorization?.split(' ')[1];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    req.user = null;
    next();
  }
}

// ══════════════════════════════════════════
//  AUTH API ROUTES
// ══════════════════════════════════════════

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || username.trim().length < 3) {
      return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    }

    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);

    let user;

    if (isDBReady()) {
      // ── PostgreSQL path ──
      const existingEmail = await pool.query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
      if (existingEmail.rows.length > 0) {
        return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
      }

      const existingUsername = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [trimmedUsername]);
      if (existingUsername.rows.length > 0) {
        return res.status(400).json({ ok: false, error: 'This username is taken' });
      }

      const result = await pool.query(
        'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
        [trimmedUsername, trimmedEmail, passwordHash]
      );
      user = result.rows[0];

      // Auto-create wallet for new user
      await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [user.id]);

    } else {
      // ── In-memory fallback ──
      if (memoryUsers.find(u => u.email === trimmedEmail)) {
        return res.status(400).json({ ok: false, error: 'An account with this email already exists' });
      }
      if (memoryUsers.find(u => u.username.toLowerCase() === trimmedUsername.toLowerCase())) {
        return res.status(400).json({ ok: false, error: 'This username is taken' });
      }
      user = { id: memoryUsers.length + 1, username: trimmedUsername, email: trimmedEmail, password_hash: passwordHash, created_at: new Date().toISOString() };
      memoryUsers.push(user);
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('pixelplex_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      ok: true,
      user: { id: user.id, username: user.username, email: user.email }
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// POST /api/signin
app.post('/api/signin', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ ok: false, error: 'Please enter your credentials' });
    }

    const trimmedIdentifier = identifier.trim().toLowerCase();
    let user;

    if (isDBReady()) {
      // ── PostgreSQL path ──
      const result = await pool.query(
        'SELECT id, username, email, password_hash FROM users WHERE email = $1 OR LOWER(username) = $1',
        [trimmedIdentifier]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ ok: false, error: 'Invalid username/email or password' });
      }
      user = result.rows[0];

    } else {
      // ── In-memory fallback ──
      user = memoryUsers.find(u => u.email === trimmedIdentifier || u.username.toLowerCase() === trimmedIdentifier);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Invalid username/email or password' });
      }
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Invalid username/email or password' });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('pixelplex_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      ok: true,
      user: { id: user.id, username: user.username, email: user.email }
    });

  } catch (err) {
    console.error('Signin error:', err);
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// GET /api/me — get current authenticated user
app.get('/api/me', authenticateToken, async (req, res) => {
  if (!req.user) {
    return res.json({ ok: false, user: null });
  }
  // Fetch wallet balance from DB
  let walletBalance = 0;
  let walletBalanceRupees = 0;
  if (isDBReady()) {
    try {
      const walletResult = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.user.id]);
      if (walletResult.rows.length > 0) {
        walletBalance = walletResult.rows[0].balance;
        walletBalanceRupees = Math.round(walletBalance / 100);
      }
    } catch (e) { /* use default */ }
  }
  return res.json({
    ok: true,
    user: {
      ...req.user,
      wallet_balance: walletBalance,
      wallet_balance_rupees: walletBalanceRupees
    }
  });
});

// POST /api/signout
app.post('/api/signout', (req, res) => {
  res.clearCookie('pixelplex_token');
  return res.json({ ok: true });
});

// PUT /api/profile — update user profile
app.put('/api/profile', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });

  const { username, email, currentPassword, newPassword } = req.body;

  try {
    if (isDBReady()) {
      // Get current user
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length === 0) return res.status(404).json({ ok: false, error: 'User not found' });
      const user = userResult.rows[0];

      // Build update fields
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (username && username.trim() !== user.username) {
        const trimmed = username.trim();
        if (trimmed.length < 3) return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters' });
        const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [trimmed, req.user.id]);
        if (existing.rows.length > 0) return res.status(400).json({ ok: false, error: 'This username is already taken' });
        updates.push(`username = $${paramIndex++}`);
        values.push(trimmed);
      }

      if (email && email.trim().toLowerCase() !== user.email) {
        const trimmed = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return res.status(400).json({ ok: false, error: 'Please enter a valid email' });
        const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [trimmed, req.user.id]);
        if (existing.rows.length > 0) return res.status(400).json({ ok: false, error: 'This email is already in use' });
        updates.push(`email = $${paramIndex++}`);
        values.push(trimmed);
      }

      if (newPassword) {
        if (!currentPassword) return res.status(400).json({ ok: false, error: 'Current password is required to set a new password' });
        const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
        if (!validPassword) return res.status(400).json({ ok: false, error: 'Current password is incorrect' });
        if (newPassword.length < 6) return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters' });
        const newHash = await bcrypt.hash(newPassword, 12);
        updates.push(`password_hash = $${paramIndex++}`);
        values.push(newHash);
      }

      if (updates.length === 0) return res.json({ ok: true, message: 'No changes to save' });

      values.push(req.user.id);
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);

      // Get updated user and issue new token
      const updatedResult = await pool.query('SELECT id, username, email FROM users WHERE id = $1', [req.user.id]);
      const updated = updatedResult.rows[0];

      const token = jwt.sign(
        { id: updated.id, username: updated.username, email: updated.email },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      res.cookie('pixelplex_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

      return res.json({ ok: true, message: 'Profile updated successfully', user: updated });
    } else {
      return res.status(500).json({ ok: false, error: 'Database not available' });
    }
  } catch (err) {
    console.error('Profile update error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to update profile' });
  }
});

// ══════════════════════════════════════════
//  VIDEO API ROUTES
// ══════════════════════════════════════════

// GET /api/videos — list all videos (with purchase status if authenticated)
app.get('/api/videos', authenticateToken, async (req, res) => {
  try {
    let videos, purchasedIds = [];

    if (isDBReady()) {
      const videoResult = await pool.query(
        'SELECT id, title, category, sport, price, thumbnail_url, video_url, duration, channel_name, channel_avatar, views, likes, tag, is_live, is_premium, source_type, category_id FROM videos ORDER BY id'
      );
      videos = videoResult.rows;

      if (req.user) {
        const purchaseResult = await pool.query(
          'SELECT video_id FROM purchases WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())',
          [req.user.id]
        );
        purchasedIds = purchaseResult.rows.map(r => r.video_id);
      }
    } else {
      videos = memoryVideos;
      if (req.user) {
        purchasedIds = memoryPurchases
          .filter(p => p.user_id === req.user.id)
          .map(p => p.video_id);
      }
    }

    const annotated = videos.map(v => ({
      ...v,
      price_rupees: Math.round(v.price / 100),
      purchased: purchasedIds.includes(v.id)
    }));

    return res.json({ ok: true, videos: annotated });
  } catch (err) {
    console.error('Videos list error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load videos' });
  }
});

// GET /api/videos/:id — get single video details
app.get('/api/videos/:id', authenticateToken, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ ok: false, error: 'Invalid video ID' });

    let video, purchased = false;

    if (isDBReady()) {
      const result = await pool.query('SELECT * FROM videos WHERE id = $1', [videoId]);
      if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'Video not found' });
      video = result.rows[0];

      if (req.user) {
        const pResult = await pool.query(
          'SELECT id, expires_at FROM purchases WHERE user_id = $1 AND video_id = $2 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY expires_at DESC LIMIT 1',
          [req.user.id, videoId]
        );
        purchased = pResult.rows.length > 0;
      }
    } else {
      video = memoryVideos.find(v => v.id === videoId);
      if (!video) return res.status(404).json({ ok: false, error: 'Video not found' });
      if (req.user) {
        purchased = memoryPurchases.some(p => p.user_id === req.user.id && p.video_id === videoId);
      }
    }

    return res.json({ ok: true, video: { ...video, price_rupees: Math.round(video.price / 100), purchased } });
  } catch (err) {
    console.error('Video detail error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load video' });
  }
});

// GET /api/purchases — list user's purchased videos
app.get('/api/purchases', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });

  try {
    let purchases;

    if (isDBReady()) {
      const result = await pool.query(
        `SELECT p.id, p.video_id, p.payment_amount, p.payment_method, p.purchased_at, p.expires_at,
                v.title, v.category, v.sport, v.thumbnail_url, v.duration, v.channel_name
         FROM purchases p
         JOIN videos v ON v.id = p.video_id
         WHERE p.user_id = $1
         ORDER BY p.purchased_at DESC`,
        [req.user.id]
      );
      purchases = result.rows;
    } else {
      purchases = memoryPurchases
        .filter(p => p.user_id === req.user.id)
        .map(p => {
          const v = memoryVideos.find(mv => mv.id === p.video_id);
          return { ...p, title: v?.title, category: v?.category, sport: v?.sport, thumbnail_url: v?.thumbnail_url, duration: v?.duration, channel_name: v?.channel_name };
        });
    }

    return res.json({ ok: true, purchases });
  } catch (err) {
    console.error('Purchases list error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load purchases' });
  }
});

// ══════════════════════════════════════════
//  PAYMENT API ROUTES (Razorpay UPI)
// ══════════════════════════════════════════

// GET /api/payment/config — returns public key for frontend
app.get('/api/payment/config', async (req, res) => {
  return res.json({
    key_id: RAZORPAY_KEY_ID,
    currency: 'INR',
    name: 'PixelPlex',
    enabled: !!razorpay,
  });
});

// POST /api/payment/create-order — creates a Razorpay order
app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });
  if (!razorpay) return res.status(503).json({ ok: false, error: 'Payment system not configured' });

  try {
    const { video_id, amount: walletAmount } = req.body;

    if (walletAmount) {
      // Wallet top-up mode
      const order = await razorpay.orders.create({
        amount: walletAmount,
        currency: 'INR',
        receipt: `wallet_${req.user.id}_${Date.now()}`,
        notes: { user_id: String(req.user.id), type: 'wallet_deposit' }
      });
      return res.json({ ok: true, order });
    }

    if (!video_id) {
      return res.status(400).json({ ok: false, error: 'Video ID or wallet amount required' });
    }

    // Video purchase mode (via Razorpay direct)
    let video;
    if (isDBReady()) {
      const result = await pool.query('SELECT id, title, price FROM videos WHERE id = $1', [video_id]);
      if (result.rows.length === 0) return res.status(404).json({ ok: false, error: 'Video not found' });
      video = result.rows[0];
    } else {
      video = memoryVideos.find(v => v.id === video_id);
      if (!video) return res.status(404).json({ ok: false, error: 'Video not found' });
    }

    // Check for active (non-expired) purchase
    if (isDBReady()) {
      const pResult = await pool.query(
        'SELECT id FROM purchases WHERE user_id = $1 AND video_id = $2 AND (expires_at IS NULL OR expires_at > NOW())',
        [req.user.id, video_id]
      );
      if (pResult.rows.length > 0) return res.status(400).json({ ok: false, error: 'You already have active access to this video' });
    }

    const order = await razorpay.orders.create({
      amount: video.price,
      currency: 'INR',
      receipt: `video_${video_id}_${Date.now()}`,
      notes: { user_id: String(req.user.id), video_id: String(video_id), type: 'video_purchase', video_title: video.title }
    });

    return res.json({ ok: true, order });
  } catch (err) {
    console.error('Create order error:', err);
    return res.status(500).json({ ok: false, error: 'Could not create payment order' });
  }
});

// POST /api/payment/verify — verifies payment signature and activates account or records purchase
app.post('/api/payment/verify', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });
  if (!razorpay) return res.status(503).json({ ok: false, error: 'Payment system not configured' });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, video_id } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ ok: false, error: 'Missing payment details' });
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ ok: false, error: 'Payment verification failed' });
  }

  try {
    if (video_id) {
      // ── VIDEO PURCHASE verification ──
      let video;
      if (isDBReady()) {
        const vResult = await pool.query('SELECT id, price FROM videos WHERE id = $1', [video_id]);
        if (vResult.rows.length === 0) return res.status(404).json({ ok: false, error: 'Video not found' });
        video = vResult.rows[0];

        // 7-day access window
        await pool.query(
          `INSERT INTO purchases (user_id, video_id, payment_id, order_id, payment_amount, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')`,
          [req.user.id, video_id, razorpay_payment_id, razorpay_order_id, video.price]
        );
      } else {
        video = memoryVideos.find(v => v.id === video_id);
        if (!video) return res.status(404).json({ ok: false, error: 'Video not found' });

        memoryPurchases.push({
          id: memoryPurchases.length + 1,
          user_id: req.user.id,
          video_id: video_id,
          payment_id: razorpay_payment_id,
          order_id: razorpay_order_id,
          payment_amount: video.price,
          purchased_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        });
      }

      return res.json({ ok: true, message: 'Video purchased! You have 7 days of access.', type: 'video_purchase', video_id });

    } else {
      return res.status(400).json({ ok: false, error: 'Video ID required' });
    }
  } catch (err) {
    console.error('Payment verify DB error:', err);
    return res.status(500).json({ ok: false, error: 'Server error while processing payment' });
  }
});

// ══════════════════════════════════════════
//  WALLET API ROUTES
// ══════════════════════════════════════════

// GET /api/wallet/balance — get user's wallet balance
app.get('/api/wallet/balance', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });

  try {
    if (isDBReady()) {
      // Get or create wallet
      let walletResult = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
      if (walletResult.rows.length === 0) {
        // Auto-create wallet if doesn't exist
        walletResult = await pool.query(
          'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) RETURNING *',
          [req.user.id]
        );
      }

      const balance = walletResult.rows[0].balance;

      // Get transaction stats
      const stats = await pool.query(`
        SELECT
          SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE 0 END) as total_deposits,
          SUM(CASE WHEN type = 'PURCHASE' THEN ABS(amount) ELSE 0 END) as total_spent,
          COUNT(*) as transaction_count
        FROM wallet_transactions WHERE user_id = $1
      `, [req.user.id]);

      return res.json({
        ok: true,
        balance,
        balance_rupees: Math.round(balance / 100),
        total_deposits: stats.rows[0].total_deposits || 0,
        total_spent: stats.rows[0].total_spent || 0,
        transaction_count: parseInt(stats.rows[0].transaction_count) || 0
      });
    } else {
      // In-memory fallback
      return res.json({
        ok: true,
        balance: 0,
        balance_rupees: 0,
        total_deposits: 0,
        total_spent: 0,
        transaction_count: 0
      });
    }
  } catch (err) {
    console.error('Wallet balance error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load wallet balance' });
  }
});

// POST /api/wallet/add-money/create-order — create Razorpay order for wallet deposit
app.post('/api/wallet/add-money/create-order', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });
  if (!razorpay) return res.status(503).json({ ok: false, error: 'Payment system not configured' });

  try {
    const { amount } = req.body; // amount in paise

    // Validate amount (min ₹10 = 1000 paise, max ₹10,000 = 1000000 paise)
    if (!amount || amount < 1000 || amount > 1000000) {
      return res.status(400).json({ ok: false, error: 'Amount must be between ₹10 and ₹10,000' });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `wallet_deposit_${req.user.id}_${Date.now()}`,
      notes: {
        user_id: String(req.user.id),
        username: req.user.username,
        email: req.user.email,
        type: 'wallet_deposit'
      }
    });

    return res.json({ ok: true, order });
  } catch (err) {
    console.error('Wallet create order error:', err);
    return res.status(500).json({ ok: false, error: 'Could not create payment order' });
  }
});

// POST /api/wallet/add-money/verify — verify payment and credit wallet
app.post('/api/wallet/add-money/verify', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });
  if (!razorpay) return res.status(503).json({ ok: false, error: 'Payment system not configured' });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ ok: false, error: 'Missing payment details' });
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ ok: false, error: 'Payment verification failed' });
  }

  try {
    if (isDBReady()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Get wallet with row lock (prevent race conditions)
        const walletResult = await client.query(
          'SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE',
          [req.user.id]
        );

        if (walletResult.rows.length === 0) {
          throw new Error('Wallet not found');
        }

        const wallet = walletResult.rows[0];
        const balanceBefore = wallet.balance;
        const balanceAfter = balanceBefore + amount;

        // Update wallet balance
        await client.query(
          'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2',
          [balanceAfter, wallet.id]
        );

        // Create transaction record
        const txResult = await client.query(
          `INSERT INTO wallet_transactions
            (user_id, wallet_id, type, amount, balance_before, balance_after, payment_id, order_id, description, status)
           VALUES ($1, $2, 'DEPOSIT', $3, $4, $5, $6, $7, $8, 'completed')
           RETURNING id`,
          [
            req.user.id,
            wallet.id,
            amount,
            balanceBefore,
            balanceAfter,
            razorpay_payment_id,
            razorpay_order_id,
            `Wallet deposit of ₹${Math.round(amount / 100)}`
          ]
        );

        await client.query('COMMIT');

        return res.json({
          ok: true,
          message: `₹${Math.round(amount / 100)} added to wallet`,
          new_balance: balanceAfter,
          new_balance_rupees: Math.round(balanceAfter / 100),
          transaction_id: txResult.rows[0].id
        });

      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback (not supported)
      return res.status(503).json({ ok: false, error: 'Wallet system requires database connection' });
    }
  } catch (err) {
    console.error('Wallet verify error:', err);
    return res.status(500).json({ ok: false, error: 'Server error while processing payment' });
  }
});

// POST /api/wallet/purchase-video — purchase video using wallet balance
app.post('/api/wallet/purchase-video', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });

  const { video_id } = req.body;
  if (!video_id) return res.status(400).json({ ok: false, error: 'Video ID required' });

  try {
    if (isDBReady()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Get video details
        const videoResult = await client.query('SELECT id, title, price FROM videos WHERE id = $1', [video_id]);
        if (videoResult.rows.length === 0) {
          throw new Error('Video not found');
        }
        const video = videoResult.rows[0];

        // Check for active (non-expired) purchase
        const purchaseCheck = await client.query(
          'SELECT id FROM purchases WHERE user_id = $1 AND video_id = $2 AND (expires_at IS NULL OR expires_at > NOW())',
          [req.user.id, video_id]
        );
        if (purchaseCheck.rows.length > 0) {
          throw new Error('You already have active access to this video');
        }

        // Get wallet with row lock
        const walletResult = await client.query(
          'SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE',
          [req.user.id]
        );
        if (walletResult.rows.length === 0) {
          throw new Error('Wallet not found');
        }

        const wallet = walletResult.rows[0];
        const balanceBefore = wallet.balance;

        // Check sufficient balance
        if (balanceBefore < video.price) {
          throw new Error('Insufficient wallet balance');
        }

        const balanceAfter = balanceBefore - video.price;

        // Update wallet balance
        await client.query(
          'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2',
          [balanceAfter, wallet.id]
        );

        // Create wallet transaction record
        const txResult = await client.query(
          `INSERT INTO wallet_transactions
            (user_id, wallet_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status)
           VALUES ($1, $2, 'PURCHASE', $3, $4, $5, 'video_purchase', $6, $7, 'completed')
           RETURNING id`,
          [
            req.user.id,
            wallet.id,
            -video.price, // negative for purchase
            balanceBefore,
            balanceAfter,
            video_id,
            `Purchased: ${video.title}`
          ]
        );

        // Create purchase record with 7-day expiry
        const purchaseResult = await client.query(
          `INSERT INTO purchases
            (user_id, video_id, payment_id, order_id, payment_amount, payment_method, wallet_transaction_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'wallet', $6, NOW() + INTERVAL '7 days')
           RETURNING id, expires_at`,
          [
            req.user.id,
            video_id,
            `wallet_tx_${txResult.rows[0].id}`,
            `wallet_purchase_${Date.now()}`,
            video.price,
            txResult.rows[0].id
          ]
        );

        await client.query('COMMIT');

        return res.json({
          ok: true,
          message: 'Video purchased! You have 7 days of access.',
          remaining_balance: balanceAfter,
          remaining_balance_rupees: Math.round(balanceAfter / 100),
          video_id,
          purchase_id: purchaseResult.rows[0].id,
          transaction_id: txResult.rows[0].id,
          expires_at: purchaseResult.rows[0].expires_at
        });

      } catch (err) {
        await client.query('ROLLBACK');
        if (err.message === 'Insufficient wallet balance') {
          return res.status(400).json({ ok: false, error: 'Insufficient wallet balance' });
        }
        if (err.message === 'You already have active access to this video') {
          return res.status(400).json({ ok: false, error: 'You already have active access to this video' });
        }
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback (not supported)
      return res.status(503).json({ ok: false, error: 'Wallet system requires database connection' });
    }
  } catch (err) {
    console.error('Wallet purchase error:', err);
    return res.status(500).json({ ok: false, error: 'Could not complete purchase' });
  }
});

// GET /api/wallet/transactions — get user's wallet transaction history
app.get('/api/wallet/transactions', authenticateToken, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Please sign in first' });

  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const typeFilter = req.query.type; // 'DEPOSIT', 'PURCHASE', or undefined

    if (isDBReady()) {
      let query = `
        SELECT
          wt.id, wt.type, wt.amount, wt.balance_after, wt.description,
          wt.payment_id, wt.order_id, wt.reference_type, wt.reference_id,
          wt.created_at,
          v.title as video_title, v.thumbnail_url as video_thumbnail
        FROM wallet_transactions wt
        LEFT JOIN videos v ON wt.reference_type = 'video_purchase' AND wt.reference_id = v.id
        WHERE wt.user_id = $1
      `;
      const params = [req.user.id];

      if (typeFilter && ['DEPOSIT', 'PURCHASE', 'REFUND'].includes(typeFilter)) {
        query += ` AND wt.type = $${params.length + 1}`;
        params.push(typeFilter);
      }

      query += ` ORDER BY wt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Get total count
      const countQuery = typeFilter
        ? 'SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1 AND type = $2'
        : 'SELECT COUNT(*) FROM wallet_transactions WHERE user_id = $1';
      const countParams = typeFilter ? [req.user.id, typeFilter] : [req.user.id];
      const countResult = await pool.query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0].count);

      const transactions = result.rows.map(tx => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        amount_rupees: Math.round(tx.amount / 100),
        balance_after: tx.balance_after,
        balance_after_rupees: Math.round(tx.balance_after / 100),
        description: tx.description,
        payment_id: tx.payment_id,
        reference_type: tx.reference_type,
        reference_id: tx.reference_id,
        video_title: tx.video_title,
        video_thumbnail: tx.video_thumbnail,
        created_at: tx.created_at
      }));

      return res.json({
        ok: true,
        transactions,
        total_count: totalCount,
        has_more: offset + limit < totalCount
      });
    } else {
      // In-memory fallback (not supported)
      return res.json({
        ok: true,
        transactions: [],
        total_count: 0,
        has_more: false
      });
    }
  } catch (err) {
    console.error('Wallet transactions error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load transactions' });
  }
});

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════
app.use('/api/admin', adminRoutes);

// Serve admin panel (separate from main site — not in public/)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// ══════════════════════════════════════════
//  PUBLIC CATEGORY/VIDEO API
// ══════════════════════════════════════════

// GET /api/categories — list active categories with their videos
app.get('/api/categories', async (req, res) => {
  try {
    if (!isDBReady()) {
      return res.json({ ok: true, categories: [] });
    }

    const catResult = await pool.query(`
      SELECT id, name, slug, icon, description, sort_order
      FROM categories
      WHERE is_active = true
      ORDER BY sort_order ASC, name ASC
    `);

    const categories = [];
    for (const cat of catResult.rows) {
      const videoResult = await pool.query(`
        SELECT id, title, category, sport, price, thumbnail_url, video_url, duration,
               channel_name, channel_avatar, views, likes, tag, is_live, is_premium,
               source_type, file_key
        FROM videos
        WHERE category_id = $1 AND (upload_status = 'completed' OR upload_status IS NULL)
        ORDER BY id DESC
      `, [cat.id]);

      categories.push({
        ...cat,
        videos: videoResult.rows.map(v => ({
          ...v,
          price_rupees: Math.round(v.price / 100),
        })),
      });
    }

    return res.json({ ok: true, categories });
  } catch (err) {
    console.error('Categories API error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load categories' });
  }
});

// ── Root redirect ──
app.get('/', (req, res) => {
  res.redirect('/public/index.html');
});

// ── Catch-all: serve index.html for unmatched routes ──
app.get('/public/*', (req, res) => {
  const filePath = path.join(__dirname, req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
  });
});

// ── Start server ──
async function start() {
  await initDB();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  PixelPlex server running at http://localhost:${PORT}`);
    console.log(`  Open http://localhost:${PORT}/public/index.html`);
    if (!isDBReady()) {
      console.log(`  Warning: Running without database — using in-memory auth (data resets on restart)`);
      console.log(`  Set DATABASE_URL in .env to connect to PostgreSQL\n`);
    } else {
      console.log(`  PostgreSQL connected\n`);
    }
  });

  server.keepAliveTimeout = 65000;
}

start();
