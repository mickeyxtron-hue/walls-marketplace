// =============================================================================
// Wheels & Walls — server.js   (FULL REWRITE)
// -----------------------------------------------------------------------------
// Drop this file into:  C:\Users\micke\Documents\wheels-walls.final.app\server.js
//
// What this file provides (everything in one place):
//   * Users (signup / login / OAuth shim / me / change password / delete account)
//   * Listings (CRUD with ownership checks, search, filters, pagination)
//   * Images stored on Amazon S3
//       - Direct browser upload via pre-signed PUT URLs  (/api/uploads/sign)
//       - Server-side base64 fallback (imagesBase64[])   -> auto-uploaded to S3
//       - On delete, the S3 objects are removed too
//   * Likes (server-side, syncs across all devices)
//   * Bids (with owner push notification)
//   * Saved searches (per user) + matcher that fires on every new listing
//   * Web Push notifications (VAPID) – OS-level pop-ups even when app is closed
//   * In-app notifications feed
//   * Direct messages between users
//   * Static hosting of index.html / walls.js / sw.js / manifest / icons
//   * SPA fallback (so PWA deep-links work)
//   * Health check at /api/health
//
// Required env vars (.env in the same folder):
//   MONGODB_URI=...
//   JWT_SECRET=something-long-and-random
//   CLIENT_ORIGIN=*                       (or your domain)
//   PORT=3000
//
//   # S3
//   AWS_REGION=us-east-1
//   AWS_BUCKET=your-bucket-name
//   AWS_ACCESS_KEY_ID=...
//   AWS_SECRET_ACCESS_KEY=...
//
//   # Web Push   (generate once with:  npx web-push generate-vapid-keys )
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_SUBJECT=mailto:you@example.com
//
// Install once:
//   npm install express mongoose cors bcryptjs jsonwebtoken cookie-parser \
//               dotenv web-push @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
//
// Run:
//   node server.js
// =============================================================================

'use strict';

require('dotenv').config();

const path          = require('path');
const crypto        = require('crypto');
const express       = require('express');
const mongoose      = require('mongoose');
const cors          = require('cors');
const bcrypt        = require('bcryptjs');
const jwt           = require('jsonwebtoken');
const cookieParser  = require('cookie-parser');
const webpush       = require('web-push');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT          = Number(process.env.PORT) || 3000;
const MONGODB_URI   = process.env.MONGODB_URI;
const JWT_SECRET    = process.env.JWT_SECRET || 'dev-only-change-me';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

// VAPID for push notifications
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@example.com';
const PUSH_ENABLED      = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log('[push] VAPID configured');
} else {
  console.warn('[push] VAPID keys missing — push notifications disabled.');
}

// S3
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const S3_BUCKET  = process.env.AWS_BUCKET || '';
const s3 = new S3Client({
  region: AWS_REGION,
  credentials: (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
    ? {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined,
});
if (!S3_BUCKET) console.warn('[s3] AWS_BUCKET not set — S3 uploads disabled');

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: CLIENT_ORIGIN === '*' ? true : CLIENT_ORIGIN,
  credentials: true,
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(cookieParser());

// Serve index.html, walls.js, manifest, icons, sw.js, etc.
app.use(express.static(path.join(__dirname), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    }
    if (filePath.endsWith('manifest.webmanifest') || filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  },
}));

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
mongoose.set('strictQuery', false);
if (!MONGODB_URI) {
  console.error('[db] MONGODB_URI is not set — refusing to start.');
  process.exit(1);
}
mongoose.connect(MONGODB_URI)
  .then(() => console.log('[db] connected'))
  .catch((e) => { console.error('[db] connect error', e); process.exit(1); });

// ---------------------------------------------------------------------------
// Schemas / Models
// ---------------------------------------------------------------------------
const UserSchema = new mongoose.Schema({
  email      : { type: String, unique: true, required: true, index: true, lowercase: true, trim: true },
  password   : String,
  name       : { type: String, default: '' },
  phone      : { type: String, default: '' },
  avatar     : { type: String, default: '' },
  provider   : { type: String, default: 'local' },
  language   : { type: String, default: 'en' },
  lastLoginAt: { type: Date },
  createdAt  : { type: Date, default: Date.now },
}, { versionKey: false });

const ListingSchema = new mongoose.Schema({
  ownerId    : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  type       : { type: String, index: true },           // e.g. "car", "house", "rental"
  category   : { type: String, index: true },
  title      : { type: String, default: '' },
  description: { type: String, default: '' },
  price      : { type: Number, default: 0, index: true },
  currency   : { type: String, default: 'USD' },
  location   : { type: String, default: '', index: true },
  lat        : Number,
  lng        : Number,
  images     : [String],                                // S3 URLs
  features   : [String],                                // bullet list
  fields     : { type: mongoose.Schema.Types.Mixed, default: {} }, // every other form field
  likedBy    : [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
  bids       : [{
    userId   : { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    amount   : Number,
    createdAt: { type: Date, default: Date.now },
  }],
  views      : { type: Number, default: 0 },
  status     : { type: String, default: 'active', index: true },   // active | sold | hidden
  createdAt  : { type: Date, default: Date.now, index: true },
  updatedAt  : { type: Date, default: Date.now },
}, { versionKey: false });

const SavedSearchSchema = new mongoose.Schema({
  userId   : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  name     : { type: String, default: '' },
  query    : { type: String, default: '' },
  filters  : { type: mongoose.Schema.Types.Mixed, default: {} },
  notify   : { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

const PushSubscriptionSchema = new mongoose.Schema({
  userId   : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  endpoint : { type: String, unique: true, required: true },
  keys     : { p256dh: String, auth: String },
  userAgent: String,
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });

const NotificationSchema = new mongoose.Schema({
  userId   : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  type     : String,
  title    : String,
  body     : String,
  data     : { type: mongoose.Schema.Types.Mixed, default: {} },
  read     : { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

const MessageSchema = new mongoose.Schema({
  fromId   : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  toId     : { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' },
  text     : String,
  read     : { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

const User             = mongoose.model('User',             UserSchema);
const Listing          = mongoose.model('Listing',          ListingSchema);
const SavedSearch      = mongoose.model('SavedSearch',      SavedSearchSchema);
const PushSubscription = mongoose.model('PushSubscription', PushSubscriptionSchema);
const Notification     = mongoose.model('Notification',     NotificationSchema);
const Message          = mongoose.model('Message',          MessageSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const token  = bearer || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}

function authOptional(req, _res, next) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;
  const token  = bearer || req.cookies?.token;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ }
  }
  next();
}

function toNumberPrice(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function tryParseJson(s, fallback) {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function publicUser(u) {
  if (!u) return null;
  const o = u.toObject ? u.toObject() : u;
  return {
    id      : o._id?.toString?.() || o.id,
    email   : o.email,
    name    : o.name || '',
    phone   : o.phone || '',
    avatar  : o.avatar || '',
    provider: o.provider || 'local',
    language: o.language || 'en',
  };
}

function publicListing(doc, viewerId) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id         : o._id?.toString?.() || o.id,
    ownerId    : o.ownerId?.toString?.() || o.ownerId,
    type       : o.type,
    category   : o.category,
    title      : o.title,
    description: o.description,
    price      : o.price,
    priceText  : String(o.price ?? ''),
    currency   : o.currency,
    location   : o.location,
    lat        : o.lat,
    lng        : o.lng,
    images     : Array.isArray(o.images)   ? o.images   : [],
    features   : Array.isArray(o.features) ? o.features : [],
    fields     : o.fields || {},
    likeCount  : Array.isArray(o.likedBy) ? o.likedBy.length : 0,
    likedByMe  : viewerId ? (o.likedBy || []).some(id => id.toString() === viewerId) : false,
    bids       : (o.bids || []).map(b => ({
      userId   : b.userId?.toString?.(),
      amount   : b.amount,
      createdAt: b.createdAt,
    })),
    views      : o.views || 0,
    status     : o.status,
    createdAt  : o.createdAt,
    updatedAt  : o.updatedAt,
  };
}

function s3PublicUrl(key) {
  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

function s3KeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  // matches both virtual-hosted and path-style URLs
  const m = url.match(/amazonaws\.com\/(?:[^/]+\/)?(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function uploadBase64ToS3(base64String, userId) {
  if (!S3_BUCKET) throw new Error('S3 not configured');
  const matches = base64String.match(/^data:image\/([A-Za-z0-9+\-.]+);base64,(.+)$/);
  if (!matches) throw new Error('invalid base64 image');
  const ext    = matches[1].split('/').pop() || 'png';
  const buffer = Buffer.from(matches[2], 'base64');
  const key    = `listings/${userId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: `image/${ext}`,
  }));
  return s3PublicUrl(key);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok        : true,
    time      : new Date().toISOString(),
    db        : mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    push      : PUSH_ENABLED,
    s3        : Boolean(S3_BUCKET),
    region    : AWS_REGION,
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ error: 'email already registered' });
    const hash = await bcrypt.hash(String(password), 10);
    const user = await User.create({
      email   : String(email).toLowerCase(),
      password: hash,
      name    : name  || '',
      phone   : phone || '',
      lastLoginAt: new Date(),
    });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email: String(email || '').toLowerCase() });
    if (!user || !user.password) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(String(password || ''), user.password);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/oauth', async (req, res) => {
  try {
    const { provider, email, name, avatar } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    let user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      user = await User.create({
        email   : String(email).toLowerCase(),
        name    : name   || '',
        avatar  : avatar || '',
        provider: provider || 'oauth',
      });
    }
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  const u = await User.findById(req.user.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({ user: publicUser(u) });
});

app.put('/api/auth/me', authRequired, async (req, res) => {
  try {
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'not found' });
    const { name, phone, avatar, language } = req.body || {};
    if (name     !== undefined) u.name     = name;
    if (phone    !== undefined) u.phone    = phone;
    if (avatar   !== undefined) u.avatar   = avatar;
    if (language !== undefined) u.language = language;
    await u.save();
    res.json({ user: publicUser(u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: 'newPassword required' });
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'not found' });
    if (u.password) {
      const ok = await bcrypt.compare(String(currentPassword || ''), u.password);
      if (!ok) return res.status(401).json({ error: 'current password incorrect' });
    }
    u.password = await bcrypt.hash(String(newPassword), 10);
    await u.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/auth/me', authRequired, async (req, res) => {
  try {
    const uid = req.user.id;
    // cascade
    await Promise.all([
      Listing.deleteMany({ ownerId: uid }),
      SavedSearch.deleteMany({ userId: uid }),
      PushSubscription.deleteMany({ userId: uid }),
      Notification.deleteMany({ userId: uid }),
      Message.deleteMany({ $or: [{ fromId: uid }, { toId: uid }] }),
      User.deleteOne({ _id: uid }),
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------
app.get('/api/listings', authOptional, async (req, res) => {
  try {
    const {
      type, category, q, mine, ownerId,
      minPrice, maxPrice, location,
      sort = 'new',
      limit = 100, skip = 0,
    } = req.query;

    const where = { status: { $ne: 'hidden' } };
    if (type)     where.type     = type;
    if (category) where.category = category;
    if (location) where.location = { $regex: String(location), $options: 'i' };
    if (minPrice != null && minPrice !== '') where.price = { ...(where.price || {}), $gte: Number(minPrice) };
    if (maxPrice != null && maxPrice !== '') where.price = { ...(where.price || {}), $lte: Number(maxPrice) };
    if (q) {
      where.$or = [
        { title:       { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { location:    { $regex: q, $options: 'i' } },
      ];
    }
    if (mine === '1' && req.user) where.ownerId = req.user.id;
    else if (ownerId) where.ownerId = ownerId;

    const sortMap = {
      new      : { createdAt: -1 },
      old      : { createdAt:  1 },
      priceAsc : { price:      1 },
      priceDesc: { price:     -1 },
      popular  : { views:     -1 },
    };

    const docs = await Listing.find(where)
      .sort(sortMap[sort] || sortMap.new)
      .skip(Number(skip) || 0)
      .limit(Math.min(Number(limit) || 100, 500));
    res.json(docs.map(d => publicListing(d, req.user?.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/listings/:id', authOptional, async (req, res) => {
  try {
    const d = await Listing.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true },
    );
    if (!d) return res.status(404).json({ error: 'not found' });
    res.json(publicListing(d, req.user?.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/listings', authRequired, async (req, res) => {
  try {
    const body = req.body || {};
    let images = [];

    // 1) S3 URLs from a pre-signed upload
    if (Array.isArray(body.images))         images = body.images.filter(Boolean);
    else if (typeof body.images === 'string') images = tryParseJson(body.images, []) || [];

    // 2) base64 fallback — convert to S3
    if (Array.isArray(body.imagesBase64)) {
      for (const b64 of body.imagesBase64) {
        try { images.push(await uploadBase64ToS3(b64, req.user.id)); }
        catch (err) { console.warn('[s3] base64 upload failed:', err.message); }
      }
    }

    // Everything else goes into "fields"
    const known = new Set([
      'type','category','title','description','price','currency','location',
      'lat','lng','images','imagesBase64','features','status',
    ]);
    const extras = {};
    for (const k of Object.keys(body)) if (!known.has(k)) extras[k] = body[k];

    const features = Array.isArray(body.features)
      ? body.features
      : tryParseJson(body.features, []) || [];

    const doc = await Listing.create({
      ownerId    : req.user.id,
      type       : body.type,
      category   : body.category,
      title      : body.title,
      description: body.description,
      price      : toNumberPrice(body.price),
      currency   : body.currency || 'USD',
      location   : body.location,
      lat        : body.lat ? Number(body.lat) : undefined,
      lng        : body.lng ? Number(body.lng) : undefined,
      images,
      features,
      fields     : extras,
      status     : body.status || 'active',
    });

    // fire-and-forget: match saved searches & push
    matchAndNotify(doc).catch(e => console.error('[matcher]', e));

    res.json(publicListing(doc, req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/listings/:id', authRequired, async (req, res) => {
  try {
    const doc = await Listing.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (doc.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const b = req.body || {};

    // simple scalar / array updates
    const updatable = ['type','category','title','description','currency','location','features','status'];
    for (const k of updatable) if (k in b) doc[k] = b[k];

    // images: support both array and JSON-string
    if ('images' in b) {
      doc.images = Array.isArray(b.images) ? b.images : (tryParseJson(b.images, []) || []);
    }
    // additional base64 uploads on edit
    if (Array.isArray(b.imagesBase64) && b.imagesBase64.length) {
      for (const b64 of b.imagesBase64) {
        try { doc.images.push(await uploadBase64ToS3(b64, req.user.id)); }
        catch (err) { console.warn('[s3] base64 upload failed:', err.message); }
      }
    }

    if ('price' in b) doc.price = toNumberPrice(b.price);
    if ('lat'   in b) doc.lat   = Number(b.lat);
    if ('lng'   in b) doc.lng   = Number(b.lng);
    if (b.fields && typeof b.fields === 'object') {
      doc.fields = { ...(doc.fields || {}), ...b.fields };
    }
    doc.updatedAt = new Date();
    await doc.save();
    res.json(publicListing(doc, req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/listings/:id', authRequired, async (req, res) => {
  try {
    const doc = await Listing.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (doc.ownerId.toString() !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    // Best-effort delete of S3 images
    if (S3_BUCKET) {
      for (const url of (doc.images || [])) {
        const key = s3KeyFromUrl(url);
        if (!key) continue;
        try { await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })); }
        catch (e) { console.warn('[s3] delete failed', key, e.message); }
      }
    }
    await doc.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------
app.post('/api/listings/:id/like', authRequired, async (req, res) => {
  try {
    const uid = req.user.id;
    const doc = await Listing.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    const idx = (doc.likedBy || []).findIndex(x => x.toString() === uid);
    if (idx >= 0) doc.likedBy.splice(idx, 1);
    else          doc.likedBy.push(uid);
    await doc.save();
    res.json({ liked: idx < 0, likeCount: doc.likedBy.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me/likes', authRequired, async (req, res) => {
  try {
    const docs = await Listing.find({ likedBy: req.user.id }).sort({ createdAt: -1 });
    res.json(docs.map(d => publicListing(d, req.user.id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------
app.post('/api/listings/:id/bid', authRequired, async (req, res) => {
  try {
    const amount = toNumberPrice(req.body?.amount);
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const doc = await Listing.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    doc.bids.push({ userId: req.user.id, amount });
    await doc.save();

    // Notify owner
    await Notification.create({
      userId: doc.ownerId,
      type  : 'bid',
      title : 'New bid on your listing',
      body  : `${doc.title || 'Your listing'}: ${doc.currency || ''}${amount}`,
      data  : { listingId: doc._id.toString(), amount },
    });
    await pushToUser(doc.ownerId, {
      title: 'New bid on your listing',
      body : `${doc.title || 'Your listing'}: ${doc.currency || ''}${amount}`,
      data : { listingId: doc._id.toString(), type: 'bid' },
    });

    res.json(publicListing(doc, req.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Saved searches
// ---------------------------------------------------------------------------
app.get('/api/saved-searches', authRequired, async (req, res) => {
  const list = await SavedSearch.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
  res.json(list.map(s => ({ ...s, id: s._id })));
});

app.post('/api/saved-searches', authRequired, async (req, res) => {
  try {
    const { name, query, filters, notify } = req.body || {};
    const doc = await SavedSearch.create({
      userId : req.user.id,
      name   : name || query || 'Saved search',
      query  : query || '',
      filters: filters || {},
      notify : notify !== false,
    });
    res.json({ ...doc.toObject(), id: doc._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/saved-searches/:id', authRequired, async (req, res) => {
  try {
    const doc = await SavedSearch.findOne({ _id: req.params.id, userId: req.user.id });
    if (!doc) return res.status(404).json({ error: 'not found' });
    const { name, query, filters, notify } = req.body || {};
    if (name    !== undefined) doc.name    = name;
    if (query   !== undefined) doc.query   = query;
    if (filters !== undefined) doc.filters = filters;
    if (notify  !== undefined) doc.notify  = !!notify;
    await doc.save();
    res.json({ ...doc.toObject(), id: doc._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/saved-searches/:id', authRequired, async (req, res) => {
  const r = await SavedSearch.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: r.deletedCount > 0 });
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------
app.get('/api/push/public-key', (_req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY, enabled: PUSH_ENABLED });
});

app.post('/api/push/subscribe', authRequired, async (req, res) => {
  try {
    const sub = req.body?.subscription || req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'subscription required' });
    await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      {
        userId   : req.user.id,
        endpoint : sub.endpoint,
        keys     : sub.keys || {},
        userAgent: req.headers['user-agent'] || '',
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/unsubscribe', authRequired, async (req, res) => {
  const endpoint = req.body?.endpoint || req.query?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  await PushSubscription.deleteOne({ endpoint, userId: req.user.id });
  res.json({ ok: true });
});

app.post('/api/push/test', authRequired, async (req, res) => {
  await pushToUser(req.user.id, {
    title: 'Wheels & Walls',
    body : req.body?.body || 'Test notification — push is working!',
    data : { type: 'test' },
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// In-app notifications
// ---------------------------------------------------------------------------
app.get('/api/notifications', authRequired, async (req, res) => {
  const list = await Notification.find({ userId: req.user.id })
    .sort({ createdAt: -1 }).limit(200).lean();
  res.json(list.map(n => ({ ...n, id: n._id })));
});

app.post('/api/notifications/:id/read', authRequired, async (req, res) => {
  await Notification.updateOne(
    { _id: req.params.id, userId: req.user.id },
    { $set: { read: true } }
  );
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', authRequired, async (req, res) => {
  await Notification.updateMany({ userId: req.user.id }, { $set: { read: true } });
  res.json({ ok: true });
});

app.delete('/api/notifications/:id', authRequired, async (req, res) => {
  await Notification.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------
app.get('/api/messages', authRequired, async (req, res) => {
  const { withUserId, listingId } = req.query;
  const where = { $or: [{ fromId: req.user.id }, { toId: req.user.id }] };
  if (withUserId) {
    where.$or = [
      { fromId: req.user.id, toId: withUserId },
      { fromId: withUserId,  toId: req.user.id },
    ];
  }
  if (listingId) where.listingId = listingId;
  const list = await Message.find(where).sort({ createdAt: -1 }).limit(500).lean();
  res.json(list.map(m => ({ ...m, id: m._id })));
});

app.post('/api/messages', authRequired, async (req, res) => {
  try {
    const { toId, listingId, text } = req.body || {};
    if (!toId || !text) return res.status(400).json({ error: 'toId + text required' });
    const m = await Message.create({ fromId: req.user.id, toId, listingId, text });

    await Notification.create({
      userId: toId,
      type  : 'message',
      title : 'New message',
      body  : String(text).slice(0, 120),
      data  : { fromId: req.user.id, listingId },
    });
    await pushToUser(toId, {
      title: 'New message',
      body : String(text).slice(0, 120),
      data : { type: 'message', listingId, fromId: req.user.id },
    });

    res.json({ ...m.toObject(), id: m._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// S3 pre-signed upload URL (for client-side direct uploads)
// ---------------------------------------------------------------------------
app.post('/api/uploads/sign', authRequired, async (req, res) => {
  try {
    if (!S3_BUCKET) return res.status(500).json({ error: 'S3 not configured' });
    const { filename = 'upload.bin', contentType = 'application/octet-stream' } = req.body || {};
    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key  = `listings/${req.user.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`;
    const cmd  = new PutObjectCommand({
      Bucket: S3_BUCKET, Key: key, ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
    res.json({
      uploadUrl,
      publicUrl: s3PublicUrl(key),
      key,
      method   : 'PUT',
      headers  : { 'Content-Type': contentType },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Saved-search matcher + push helpers
// ---------------------------------------------------------------------------
function listingMatchesSearch(listing, search) {
  const f = search.filters || {};
  const q = (search.query || '').trim().toLowerCase();
  if (f.type     && listing.type     !== f.type)     return false;
  if (f.category && listing.category !== f.category) return false;
  if (f.minPrice != null && f.minPrice !== '' && listing.price < Number(f.minPrice)) return false;
  if (f.maxPrice != null && f.maxPrice !== '' && listing.price > Number(f.maxPrice)) return false;
  if (f.location && !(listing.location || '').toLowerCase().includes(String(f.location).toLowerCase())) return false;
  if (q) {
    const hay = `${listing.title || ''} ${listing.description || ''} ${listing.location || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

async function matchAndNotify(listing) {
  const searches = await SavedSearch.find({
    notify: true,
    userId: { $ne: listing.ownerId },
  }).lean();

  for (const s of searches) {
    if (!listingMatchesSearch(listing, s)) continue;
    await Notification.create({
      userId: s.userId,
      type  : 'saved_search_match',
      title : 'New match for your saved search',
      body  : listing.title || 'A new listing matches your saved search',
      data  : {
        listingId    : listing._id.toString(),
        savedSearchId: s._id.toString(),
      },
    });
    await pushToUser(s.userId, {
      title: 'New match: ' + (s.name || s.query || 'saved search'),
      body : listing.title || '',
      data : {
        listingId    : listing._id.toString(),
        savedSearchId: s._id.toString(),
        type         : 'saved_search_match',
      },
    });
  }
}

async function pushToUser(userId, payload) {
  if (!PUSH_ENABLED) return;
  const subs = await PushSubscription.find({ userId });
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        JSON.stringify(payload)
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await PushSubscription.deleteOne({ _id: s._id }).catch(() => {});
      } else {
        console.warn('[push] send failed', err.statusCode, err.body || err.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SPA fallback (MUST be after all /api routes)
// ---------------------------------------------------------------------------
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
