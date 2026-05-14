// seedadmins.js - Admin seeder for Wheels & Walls
// Aligned with server.js User schema (passwordHash, isAdmin, isBlocked).
// Usage:
//   node seedadmins.js                 -> create admins if missing
//   node seedadmins.js --update        -> update password/fields for existing
//   node seedadmins.js --force         -> delete + recreate
//   node seedadmins.js --only-mickey   -> only mickeyxtron@gmail.com

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/wheels-walls';
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10', 10);

const argv = process.argv.slice(2);
const FLAG_UPDATE = argv.includes('--update');
const FLAG_FORCE = argv.includes('--force');
const FLAG_ONLY_MICKEY = argv.includes('--only-mickey');

const MAIN_ADMIN = {
  name: 'Admin Xtron',
  email: 'mickeyxtron@gmail.com',
  password: process.env.MAIN_ADMIN_PASSWORD || 'admin123',
  phone: '+263000000000',
  phoneCode: '+263',
};

const ADDITIONAL_ADMINS = [
  {
    name: 'Site Administrator',
    email: 'admin@wheels-walls.app',
    password: process.env.ADMIN_PASSWORD || 'takuTK',
    phone: '+263111111111',
    phoneCode: '+263',
  },
];

const adminsToCreate = FLAG_ONLY_MICKEY ? [MAIN_ADMIN] : [MAIN_ADMIN, ...ADDITIONAL_ADMINS];

// MUST match server.js field names exactly
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, default: null },
  phone: String,
  phoneCode: { type: String, default: '+263' },
  phoneAlt: String,
  phoneAltCode: { type: String, default: '+263' },
  profilePicture: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false, index: true },
  isBlocked: { type: Boolean, default: false },
  googleId: { type: String, default: null },
  facebookId: { type: String, default: null },
  oauthProvider: { type: String, default: null },
  lastLogin: Date,
  loginCount: { type: Number, default: 0 },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);

async function hashPassword(p) {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  return bcrypt.hash(p, salt);
}

async function seedOne(admin) {
  const email = admin.email.toLowerCase().trim();
  console.log(`\n📝 ${email}`);

  const existing = await User.findOne({ email });

  if (existing) {
    if (FLAG_FORCE) {
      console.log('   🔨 force: deleting');
      await User.deleteOne({ _id: existing._id });
    } else if (FLAG_UPDATE) {
      existing.name = admin.name || existing.name;
      existing.phone = admin.phone || existing.phone;
      existing.phoneCode = admin.phoneCode || existing.phoneCode;
      existing.isAdmin = true;
      existing.isBlocked = false;
      if (admin.password) existing.passwordHash = await hashPassword(admin.password);
      await existing.save();
      console.log('   🔄 updated');
      return { action: 'updated' };
    } else {
      console.log('   ⏭️  skipped (use --update or --force)');
      return { action: 'skipped' };
    }
  }

  const passwordHash = await hashPassword(admin.password);
  await User.create({
    name: admin.name,
    email,
    passwordHash,
    phone: admin.phone || '',
    phoneCode: admin.phoneCode || '+263',
    isAdmin: true,
    isBlocked: false,
  });
  console.log(`   ✅ created (password: ${admin.password})`);
  return { action: 'created' };
}

async function main() {
  console.log('🔗 Connecting to', MONGO_URI);
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
  console.log('✅ Mongo connected');

  const results = [];
  for (const a of adminsToCreate) results.push(await seedOne(a));

  const stats = results.reduce((acc, r) => (acc[r.action] = (acc[r.action] || 0) + 1, acc), {});
  console.log('\n📊 Summary:', stats);

  const admins = await User.find({ isAdmin: true })
    .select('name email isAdmin isBlocked lastLogin createdAt').lean();
  console.log(`\n👑 ${admins.length} admin(s) in DB`);
  admins.forEach((a, i) => console.log(`  ${i + 1}. ${a.email}  blocked=${a.isBlocked}`));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error('❌', e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

process.on('SIGINT', async () => { await mongoose.disconnect().catch(() => {}); process.exit(0); });
