const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { pool, isDBReady } = require('../db');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { isStorageReady, generateUploadKey, generatePresignedUploadUrl, uploadFile, uploadFileStream, downloadFile, downloadPartial, downloadToTempFile, deleteFile, getPublicUrl } = require('../services/storage');
const { generateThumbnailFromPath, probeVideoFile } = require('../services/thumbnail');

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'pixelplex-admin-secret-change-in-production';

// Uploads are staged on disk (not memory) so a large video never has to sit fully in RAM.
// Files land here only for the duration of the request, then get streamed to storage and deleted.
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'pixelplex-uploads');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// Best-effort sweep of anything left behind by a hard crash (e.g. the process being
// killed mid-request) that a normal try/finally cleanup can never catch.
(function sweepStaleUploads() {
  const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(UPLOAD_TMP_DIR)) {
      const filePath = path.join(UPLOAD_TMP_DIR, name);
      try {
        if (now - fs.statSync(filePath).mtimeMs > STALE_MS) fs.unlinkSync(filePath);
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
})();

// Multer config — disk storage. Filenames are always server-generated (never derived
// from the client-supplied original name) so a crafted filename can't escape the upload dir.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (req, file, cb) => {
      const rawExt = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : '';
      cb(null, `${crypto.randomUUID()}${safeExt}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }, // 3GB
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'thumbnail') {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new Error('Thumbnail must be an image'));
    } else if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
});

// Best-effort delete of any temp files multer wrote for this request, regardless of
// how the request ended (success, validation failure, or a thrown error).
function cleanupUploadedFiles(reqFiles) {
  if (!reqFiles) return;
  for (const file of Object.values(reqFiles).flat()) {
    fs.unlink(file.path, () => { /* ignore — best effort */ });
  }
}

// ── Admin Auth Middleware ──
function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Admin authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.isAdmin) {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired admin token' });
  }
}

// ══════════════════════════════════════════
//  ADMIN AUTH
// ══════════════════════════════════════════

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ isAdmin: true, username }, ADMIN_JWT_SECRET, { expiresIn: '24h' });
    return res.json({ ok: true, token });
  }

  return res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
});

// ══════════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════════

router.get('/stats', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const [videosCount, categoriesCount, usersCount, storageResult] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM videos'),
      pool.query('SELECT COUNT(*) FROM categories'),
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COALESCE(SUM(file_size), 0) as total_storage FROM videos WHERE source_type = 'storage' OR source_type = 'r2'"),
    ]);

    return res.json({
      ok: true,
      stats: {
        total_videos: parseInt(videosCount.rows[0].count),
        total_categories: parseInt(categoriesCount.rows[0].count),
        total_users: parseInt(usersCount.rows[0].count),
        total_storage_bytes: parseInt(storageResult.rows[0].total_storage),
        total_storage_mb: Math.round(parseInt(storageResult.rows[0].total_storage) / (1024 * 1024)),
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load stats' });
  }
});

// ══════════════════════════════════════════
//  CATEGORY MANAGEMENT
// ══════════════════════════════════════════

// GET all categories with video count
router.get('/categories', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const result = await pool.query(`
      SELECT c.*, COUNT(v.id) as video_count
      FROM categories c
      LEFT JOIN videos v ON v.category_id = c.id
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name ASC
    `);

    return res.json({ ok: true, categories: result.rows });
  } catch (err) {
    console.error('Admin categories error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load categories' });
  }
});

// CREATE category
router.post('/categories', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { name, icon, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ ok: false, error: 'Category name is required' });
    }

    const slug = name.trim().toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');

    // Get max sort_order
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM categories');
    const sortOrder = maxOrder.rows[0].next_order;

    const result = await pool.query(
      'INSERT INTO categories (name, slug, icon, description, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name.trim(), slug, icon || '📁', description || null, sortOrder]
    );

    return res.json({ ok: true, category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: 'A category with this name already exists' });
    }
    console.error('Admin create category error:', err);
    return res.status(500).json({ ok: false, error: 'Could not create category' });
  }
});

// UPDATE category
router.put('/categories/:id', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { id } = req.params;
    const { name, icon, description, is_active, sort_order } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      const slug = name.trim().toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
      updates.push(`name = $${paramIndex++}`, `slug = $${paramIndex++}`);
      values.push(name.trim(), slug);
    }
    if (icon !== undefined) { updates.push(`icon = $${paramIndex++}`); values.push(icon); }
    if (description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(description); }
    if (is_active !== undefined) { updates.push(`is_active = $${paramIndex++}`); values.push(is_active); }
    if (sort_order !== undefined) { updates.push(`sort_order = $${paramIndex++}`); values.push(sort_order); }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(parseInt(id));

    const result = await pool.query(
      `UPDATE categories SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Category not found' });
    }

    return res.json({ ok: true, category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ ok: false, error: 'A category with this name already exists' });
    }
    console.error('Admin update category error:', err);
    return res.status(500).json({ ok: false, error: 'Could not update category' });
  }
});

// DELETE category
router.delete('/categories/:id', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { id } = req.params;

    // Unlink videos from this category (set category_id to null)
    await pool.query('UPDATE videos SET category_id = NULL WHERE category_id = $1', [parseInt(id)]);

    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING *', [parseInt(id)]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Category not found' });
    }

    return res.json({ ok: true, message: 'Category deleted' });
  } catch (err) {
    console.error('Admin delete category error:', err);
    return res.status(500).json({ ok: false, error: 'Could not delete category' });
  }
});

// ══════════════════════════════════════════
//  VIDEO MANAGEMENT
// ══════════════════════════════════════════

// GET all videos (with filtering)
router.get('/videos', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { category_id, search, source_type } = req.query;
    let query = `
      SELECT v.*, c.name as category_name, c.icon as category_icon
      FROM videos v
      LEFT JOIN categories c ON v.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (category_id) {
      params.push(parseInt(category_id));
      query += ` AND v.category_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      query += ` AND v.title ILIKE $${params.length}`;
    }
    if (source_type) {
      params.push(source_type);
      query += ` AND v.source_type = $${params.length}`;
    }

    query += ' ORDER BY v.id DESC';

    const result = await pool.query(query, params);

    return res.json({ ok: true, videos: result.rows });
  } catch (err) {
    console.error('Admin videos error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load videos' });
  }
});

// ── STEP 1: Prepare Upload ──
// Returns a presigned PUT URL pointing directly at Spaces.
// The browser will upload the raw video bytes to that URL — the Node.js server
// is never in the data path, so DigitalOcean's 512 MB request limit is bypassed.
router.post('/videos/prepare-upload', adminAuth, async (req, res) => {
  try {
    if (!isStorageReady()) return res.status(503).json({ ok: false, error: 'Storage not configured' });

    const { filename, contentType, fileSize } = req.body;

    if (!filename || !contentType) {
      return res.status(400).json({ ok: false, error: 'filename and contentType are required' });
    }
    if (!contentType.startsWith('video/')) {
      return res.status(400).json({ ok: false, error: 'Only video files are allowed' });
    }

    const videoKey = generateUploadKey('videos', filename);
    const uploadUrl = await generatePresignedUploadUrl(videoKey, contentType, 3600);

    console.log(`Presigned upload URL generated for key: ${videoKey} (${Math.round((fileSize || 0) / 1024 / 1024)} MB)`);

    return res.json({ ok: true, uploadUrl, videoKey });
  } catch (err) {
    console.error('Prepare upload error:', err);
    return res.status(500).json({ ok: false, error: 'Could not generate upload URL' });
  }
});

// ── STEP 2: Finalize Upload ──
// Called after the browser has finished uploading directly to Spaces.
// Downloads the file, validates it with ffprobe, generates a thumbnail, saves to DB.
router.post('/videos/finalize-upload', adminAuth, async (req, res) => {
  let tmpVideoPath = null;

  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });
    if (!isStorageReady()) return res.status(503).json({ ok: false, error: 'Storage not configured' });

    const { videoKey, title, category_id, price, tag, thumbnailDataUrl, filename, contentType, fileSize } = req.body;

    if (!videoKey) return res.status(400).json({ ok: false, error: 'videoKey is required' });
    if (!title || !title.trim()) return res.status(400).json({ ok: false, error: 'Video title is required' });
    if (!category_id) return res.status(400).json({ ok: false, error: 'Category is required' });

    const priceInPaise = price ? parseInt(price) : 0;
    const mimeType = contentType || 'video/mp4';
    const originalName = filename || 'video.mp4';

    // Download video from Spaces to a temp file for ffprobe + thumbnail
    console.log(`Finalizing upload: downloading ${videoKey} from Spaces for validation...`);
    tmpVideoPath = await downloadToTempFile(videoKey);

    // Validate the file is actually a decodable video
    const probe = await probeVideoFile(tmpVideoPath);
    if (!probe.isValidVideo) {
      // Delete the invalid file from Spaces to avoid orphaned storage
      console.warn(`Uploaded file ${videoKey} failed ffprobe validation — deleting from Spaces`);
      try { await deleteFile(videoKey); } catch (e) { /* ignore */ }
      return res.status(400).json({ ok: false, error: 'Uploaded file is not a valid video' });
    }
    const durationSeconds = probe.durationSeconds;
    console.log(`Validation passed. Duration: ${durationSeconds}s`);

    // Generate / upload thumbnail
    let thumbnailUrl = null;
    let thumbnailKey = null;

    if (thumbnailDataUrl && thumbnailDataUrl.startsWith('data:image/')) {
      // Client sent a base64 thumbnail captured from the video element
      const base64Data = thumbnailDataUrl.replace(/^data:image\/\w+;base64,/, '');
      const thumbBuffer = Buffer.from(base64Data, 'base64');
      thumbnailKey = generateUploadKey('thumbnails', originalName.replace(/\.[^.]+$/, '.jpg'));
      thumbnailUrl = await uploadFile(thumbBuffer, thumbnailKey, 'image/jpeg');
    } else {
      // Generate thumbnail with ffmpeg from the temp file
      const thumbBuffer = await generateThumbnailFromPath(tmpVideoPath);
      if (thumbBuffer) {
        thumbnailKey = generateUploadKey('thumbnails', originalName.replace(/\.[^.]+$/, '.jpg'));
        thumbnailUrl = await uploadFile(thumbBuffer, thumbnailKey, 'image/jpeg');
      } else {
        // SVG placeholder fallback
        const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
          <rect width="1280" height="720" fill="#1f2326"/>
          <polygon points="600,300 600,420 700,360" fill="#85c742" opacity="0.8"/>
          <text x="640" y="500" text-anchor="middle" fill="#959da5" font-family="sans-serif" font-size="24">${title.trim().substring(0, 40)}</text>
        </svg>`;
        const placeholderBuffer = Buffer.from(placeholderSvg, 'utf-8');
        thumbnailKey = generateUploadKey('thumbnails', 'placeholder.svg');
        thumbnailUrl = await uploadFile(placeholderBuffer, thumbnailKey, 'image/svg+xml');
      }
    }

    // Format duration
    let durationStr = '0:00';
    if (durationSeconds) {
      const mins = Math.floor(durationSeconds / 60);
      const secs = durationSeconds % 60;
      durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    const videoUrl = getPublicUrl(videoKey);
    const fileSizeBytes = fileSize ? parseInt(fileSize) : 0;

    // Insert into database
    const result = await pool.query(
      `INSERT INTO videos (title, category, sport, price, thumbnail_url, video_url, duration, channel_name, channel_avatar, views, likes, tag, is_live, is_premium, category_id, file_key, thumbnail_key, file_size, mime_type, duration_seconds, upload_status, source_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'completed', 'storage')
       RETURNING *`,
      [
        title.trim(),
        '',
        '',
        priceInPaise,
        thumbnailUrl || '',
        videoUrl,
        durationStr,
        '',
        '',
        '0',
        '0',
        tag || null,
        false,
        false,
        parseInt(category_id),
        videoKey,
        thumbnailKey,
        fileSizeBytes,
        mimeType,
        durationSeconds,
      ]
    );

    console.log(`Video finalized and saved to DB: id=${result.rows[0].id}`);
    return res.json({ ok: true, video: result.rows[0] });

  } catch (err) {
    console.error('Finalize upload error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Could not finalize upload' });
  } finally {
    // Always clean up the temp file
    if (tmpVideoPath) try { fs.unlinkSync(tmpVideoPath); } catch (e) { /* ignore */ }
  }
});


// UPDATE video metadata
router.put('/videos/:id', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { id } = req.params;
    const { title, tag, category_id, is_premium, price } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (title !== undefined) { updates.push(`title = $${paramIndex++}`); values.push(title.trim()); }
    if (tag !== undefined) { updates.push(`tag = $${paramIndex++}`); values.push(tag || null); }
    if (category_id !== undefined) { updates.push(`category_id = $${paramIndex++}`); values.push(parseInt(category_id)); }
    if (is_premium !== undefined) { updates.push(`is_premium = $${paramIndex++}`); values.push(is_premium); }
    if (price !== undefined) { updates.push(`price = $${paramIndex++}`); values.push(parseInt(price)); }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    values.push(parseInt(id));
    const result = await pool.query(
      `UPDATE videos SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Video not found' });
    }

    return res.json({ ok: true, video: result.rows[0] });
  } catch (err) {
    console.error('Admin update video error:', err);
    return res.status(500).json({ ok: false, error: 'Could not update video' });
  }
});

// DELETE video
router.delete('/videos/:id', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { id } = req.params;

    // Get video to find R2 keys
    const videoResult = await pool.query('SELECT * FROM videos WHERE id = $1', [parseInt(id)]);
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Video not found' });
    }

    const video = videoResult.rows[0];

    // Delete from R2 if it's an R2-hosted video
    if ((video.source_type === 'storage' || video.source_type === 'r2') && isStorageReady()) {
      try {
        if (video.file_key) await deleteFile(video.file_key);
        if (video.thumbnail_key) await deleteFile(video.thumbnail_key);
      } catch (storageErr) {
        console.error('Storage delete error (continuing):', storageErr.message);
      }
    }

    // Delete purchase records first (foreign key constraint)
    await pool.query('DELETE FROM purchases WHERE video_id = $1', [parseInt(id)]);

    // Delete from database
    await pool.query('DELETE FROM videos WHERE id = $1', [parseInt(id)]);

    return res.json({ ok: true, message: 'Video deleted' });
  } catch (err) {
    console.error('Admin delete video error:', err);
    return res.status(500).json({ ok: false, error: 'Could not delete video' });
  }
});

// ══════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════

router.get('/users', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.created_at,
             COALESCE(w.balance, 0) as wallet_balance,
             COUNT(p.id) as total_purchases
      FROM users u
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN purchases p ON p.user_id = u.id
      GROUP BY u.id, u.username, u.email, u.created_at, w.balance
      ORDER BY u.created_at DESC
    `);

    return res.json({ ok: true, users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load users' });
  }
});

// ══════════════════════════════════════════
//  TRANSACTIONS
// ══════════════════════════════════════════

router.get('/transactions', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const { type } = req.query;

    // Get video purchases
    let purchases = [];
    if (!type || type === 'purchases') {
      const purchaseResult = await pool.query(`
        SELECT p.id, p.payment_id, p.order_id, p.payment_amount, p.payment_method,
               p.purchased_at, u.username, u.email, v.title as video_title
        FROM purchases p
        JOIN users u ON u.id = p.user_id
        JOIN videos v ON v.id = p.video_id
        ORDER BY p.purchased_at DESC
      `);
      purchases = purchaseResult.rows;
    }

    // Get wallet transactions
    let walletTxns = [];
    if (!type || type === 'wallet') {
      const walletResult = await pool.query(`
        SELECT wt.id, wt.type, wt.amount, wt.balance_before, wt.balance_after,
               wt.payment_id, wt.description, wt.status, wt.created_at,
               u.username, u.email
        FROM wallet_transactions wt
        JOIN users u ON u.id = wt.user_id
        ORDER BY wt.created_at DESC
      `);
      walletTxns = walletResult.rows;
    }

    return res.json({ ok: true, purchases, wallet_transactions: walletTxns });
  } catch (err) {
    console.error('Admin transactions error:', err);
    return res.status(500).json({ ok: false, error: 'Could not load transactions' });
  }
});

// ══════════════════════════════════════════
//  ADMIN WALLET CREDIT
// ══════════════════════════════════════════

// POST /api/admin/users/:id/add-balance — credit a user's wallet
router.post('/users/:id/add-balance', adminAuth, async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });

    const userId = parseInt(req.params.id);
    const { amount } = req.body; // amount in paise

    if (!amount || amount < 100 || amount > 10000000) {
      return res.status(400).json({ ok: false, error: 'Amount must be between ₹1 and ₹1,00,000' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify user exists
      const userResult = await client.query('SELECT id, username FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'User not found' });
      }

      // Get or create wallet with row lock
      let walletResult = await client.query(
        'SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (walletResult.rows.length === 0) {
        walletResult = await client.query(
          'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) RETURNING id, balance',
          [userId]
        );
      }

      const wallet = walletResult.rows[0];
      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore + parseInt(amount);

      // Update wallet balance
      await client.query(
        'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2',
        [balanceAfter, wallet.id]
      );

      // Create transaction record
      await client.query(
        `INSERT INTO wallet_transactions
          (user_id, wallet_id, type, amount, balance_before, balance_after, description, status)
         VALUES ($1, $2, 'DEPOSIT', $3, $4, $5, $6, 'completed')`,
        [
          userId,
          wallet.id,
          parseInt(amount),
          balanceBefore,
          balanceAfter,
          `Admin credit of ₹${Math.round(amount / 100)} by ${req.admin.username}`
        ]
      );

      await client.query('COMMIT');

      return res.json({
        ok: true,
        message: `₹${Math.round(amount / 100)} added to ${userResult.rows[0].username}'s wallet`,
        new_balance: balanceAfter,
        new_balance_rupees: Math.round(balanceAfter / 100)
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Admin add balance error:', err);
    return res.status(500).json({ ok: false, error: 'Could not add balance' });
  }
});

// REGENERATE thumbnail — accepts client-uploaded thumbnail or falls back to ffmpeg
router.post('/videos/:id/regenerate-thumbnail', adminAuth, upload.single('thumbnail'), async (req, res) => {
  try {
    if (!isDBReady()) return res.status(503).json({ ok: false, error: 'Database not available' });
    if (!isStorageReady()) return res.status(503).json({ ok: false, error: 'Storage not configured' });

    const { id } = req.params;
    const videoResult = await pool.query('SELECT * FROM videos WHERE id = $1', [parseInt(id)]);
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Video not found' });
    }

    const video = videoResult.rows[0];
    let thumbBuffer = null;

    // Prefer client-sent thumbnail
    if (req.file) {
      thumbBuffer = fs.readFileSync(req.file.path);
    } else if (video.file_key) {
      // Stream video from R2 to temp file, run ffmpeg
      let tmpPath = null;
      try {
        tmpPath = await downloadToTempFile(video.file_key);
        thumbBuffer = await generateThumbnailFromPath(tmpPath);
      } finally {
        if (tmpPath) try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      }
    }

    // Fallback: download from video_url if file_key missing or ffmpeg failed
    if (!thumbBuffer && video.video_url) {
      let tmpPath = null;
      try {
        const https = require('https');
        const http = require('http');
        const os = require('os');
        const path = require('path');
        const crypto = require('crypto');
        tmpPath = path.join(os.tmpdir(), `dl_${crypto.randomUUID()}.mp4`);
        const mod = video.video_url.startsWith('https') ? https : http;

        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tmpPath);
          mod.get(video.video_url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              // Follow redirect
              mod.get(response.headers.location, (res2) => {
                res2.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
              }).on('error', reject);
            } else {
              response.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }
          }).on('error', reject);
        }).on('error', reject);

        thumbBuffer = await generateThumbnailFromPath(tmpPath);
      } catch (e) {
        console.error('URL download fallback failed:', e.message);
      } finally {
        if (tmpPath) try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      }
    }

    if (!thumbBuffer) {
      return res.status(500).json({ ok: false, error: 'Thumbnail generation failed — no file_key and URL download failed' });
    }

    // Delete old thumbnail from R2 if exists
    if (video.thumbnail_key) {
      try { await deleteFile(video.thumbnail_key); } catch (e) { /* ignore */ }
    }

    // Upload new thumbnail
    const thumbnailKey = generateUploadKey('thumbnails', `video-${id}.jpg`);
    const thumbnailUrl = await uploadFile(thumbBuffer, thumbnailKey, 'image/jpeg');

    // Update database
    await pool.query(
      'UPDATE videos SET thumbnail_url = $1, thumbnail_key = $2 WHERE id = $3',
      [thumbnailUrl, thumbnailKey, parseInt(id)]
    );

    return res.json({ ok: true, thumbnail_url: thumbnailUrl });
  } catch (err) {
    console.error('Admin regenerate thumbnail error:', err);
    return res.status(500).json({ ok: false, error: 'Could not regenerate thumbnail' });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => { /* ignore — best effort */ });
  }
});

// Catches multer errors on the regenerate-thumbnail route (oversized/invalid file) so they
// come back as JSON, and cleans up any temp file multer wrote before the error occurred.
router.use('/videos/:id/regenerate-thumbnail', (err, req, res, next) => {
  if (req.file) fs.unlink(req.file.path, () => { /* ignore */ });
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ ok: false, error: 'File is too large' });
  }
  return res.status(400).json({ ok: false, error: err.message || 'Upload failed' });
});

// Proxy first 5MB of video for thumbnail generation (same-origin to avoid CORS canvas tainting)
// Uses query token since <video> elements can't send Authorization headers
router.get('/videos/:id/proxy', (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  adminAuth(req, res, next);
}, async (req, res) => {
  try {
    if (!isStorageReady()) return res.status(503).json({ ok: false, error: 'Storage not configured' });

    const { id } = req.params;
    const videoResult = await pool.query('SELECT file_key, video_url, mime_type FROM videos WHERE id = $1', [parseInt(id)]);
    if (videoResult.rows.length === 0) return res.status(404).json({ ok: false, error: 'Video not found' });

    const video = videoResult.rows[0];

    // Download first 15MB — enough for browser to seek to ~10s and decode a frame
    const chunkSize = 15 * 1024 * 1024;
    let partialBuffer;
    if (video.file_key) {
      partialBuffer = await downloadPartial(video.file_key, chunkSize);
    } else if (video.video_url) {
      // Download first 15MB from public URL using range request
      const https = require('https');
      const http = require('http');
      const mod = video.video_url.startsWith('https') ? https : http;
      const rangeEnd = chunkSize - 1;
      partialBuffer = await new Promise((resolve, reject) => {
        mod.get(video.video_url, { headers: { 'Range': `bytes=0-${rangeEnd}` } }, (response) => {
          const chunks = [];
          response.on('data', c => chunks.push(c));
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
        }).on('error', reject);
      });
    } else {
      return res.status(400).json({ ok: false, error: 'No video file' });
    }

    res.set('Content-Type', video.mime_type || 'video/mp4');
    res.set('Content-Length', partialBuffer.length);
    res.end(partialBuffer);
  } catch (err) {
    console.error('Video proxy error:', err);
    res.status(500).json({ ok: false, error: 'Could not proxy video' });
  }
});

module.exports = router;
