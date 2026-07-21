// Tomo Together server: accounts, friends, hangouts, vibe, wardrobe, leaderboard.
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { closeDb, connectDb, isDuplicateKeyError, nextId, store, withId } = require('./db');

// Marks the placeholder credentials written for accounts provisioned during the
// Auth0 era. Such a row has no real password; the first self-hosted login for
// that username sets one (claim-on-login).
const AUTH0_DISABLED_PREFIX = 'auth0-disabled:';

/** Extracts a single Bearer credential, rejecting comma/space-joined values. */
function getBearerToken(req) {
  const header = req && req.headers && req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[\t ]+([^\s,]+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

const PORT = process.env.PORT || 4000;
// DATA_DIR is overridable so hosted deploys can keep state outside the app dir
// (on Azure App Service, /home/data survives redeploys while wwwroot does not).
// It now only holds uploads, the APK, and the exported web bundle; durable
// application data lives in MongoDB (MONGODB_URI / MONGODB_DB_NAME).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SPECIES = ['cat', 'bear', 'bunny', 'frog', 'duck'];

const cryptoApi = require('./crypto');

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function sendCryptoError(res, error) {
  if (error instanceof cryptoApi.CryptoUnavailableError) {
    return res.status(503).json({ error: error.code, message: error.message });
  }
  if (error instanceof cryptoApi.CryptoError) {
    const status = [400, 403, 404, 409].includes(error.status) ? error.status :
      error.status === 503 ? 503 : 502;
    return res.status(status).json({
      error: status === 502 ? 'crypto_upstream_failed' : error.code,
      message: status === 502 ? 'Crypto service request failed. Please try again.' : error.message,
    });
  }
  console.error('[crypto] unexpected proxy failure', {
    name: error && error.name,
    status: error && error.status,
  });
  return res.status(502).json({
    error: 'crypto_upstream_failed',
    message: 'Crypto service request failed. Please try again.',
  });
}

function cryptoEventRsvp(event, username) {
  if (!event || !Array.isArray(event.rsvps)) return null;
  return event.rsvps.find((rsvp) => rsvp && rsvp.userId === cryptoApi.extId(username)) || null;
}

// Activities double as interests. Grouped by category for the picker UI; the
// original twelve ids are kept so existing weights/hangouts/interests stay valid.
const ACTIVITY_GROUPS = [
  ['Food & Drink', [
    ['ramen', 'Ramen'], ['sushi', 'Sushi'], ['tacos', 'Tacos'], ['bbq', 'BBQ'],
    ['brunch', 'Brunch'], ['coffee', 'Coffee'], ['boba', 'Bubble Tea'],
    ['dessert', 'Dessert Run'], ['cooking', 'Cooking Together'], ['baking', 'Baking'],
    ['winenight', 'Wine Night'], ['brewery', 'Brewery'],
  ]],
  ['Outdoors', [
    ['hiking', 'Hiking'], ['picnic', 'Picnic'], ['beach', 'Beach Day'],
    ['camping', 'Camping'], ['fishing', 'Fishing'], ['kayaking', 'Kayaking'],
    ['stargazing', 'Stargazing'], ['gardening', 'Gardening'], ['roadtrip', 'Road Trip'],
  ]],
  ['Active & Sports', [
    ['gym', 'Gym'], ['yoga', 'Yoga'], ['running', 'Running'], ['cycling', 'Cycling'],
    ['climbing', 'Climbing'], ['basketball', 'Basketball'], ['soccer', 'Soccer'],
    ['tennis', 'Tennis'], ['volleyball', 'Volleyball'], ['swimming', 'Swimming'],
    ['skiing', 'Skiing'], ['surfing', 'Surfing'], ['skating', 'Skating'], ['bowling', 'Bowling'],
  ]],
  ['Games & Play', [
    ['boardgames', 'Board Games'], ['videogames', 'Video Games'], ['arcade', 'Arcade'],
    ['escaperoom', 'Escape Room'], ['lasertag', 'Laser Tag'], ['minigolf', 'Mini Golf'],
    ['trivia', 'Trivia Night'], ['chess', 'Chess'], ['ttrpg', 'D&D Night'], ['karting', 'Go Karting'],
  ]],
  ['Arts & Culture', [
    ['museum', 'Museum'], ['artgallery', 'Art Gallery'], ['theater', 'Theater'],
    ['pottery', 'Pottery'], ['painting', 'Painting'], ['photography', 'Photography'],
    ['bookcafe', 'Book Cafe'], ['bookclub', 'Book Club'],
  ]],
  ['Music & Nightlife', [
    ['karaoke', 'Karaoke'], ['concert', 'Concert'], ['livemusic', 'Live Music'],
    ['dancing', 'Dancing'], ['barhopping', 'Bar Hopping'], ['comedy', 'Comedy Show'],
  ]],
  ['Chill & Social', [
    ['film', 'Movie Night'], ['anime', 'Anime Night'], ['shopping', 'Shopping'],
    ['thrifting', 'Thrifting'], ['spa', 'Spa Day'], ['cafe', 'Cafe Hangout'],
    ['volunteering', 'Volunteering'], ['petpark', 'Dog Park'],
    ['amusementpark', 'Amusement Park'], ['aquarium', 'Aquarium'],
  ]],
];
const ACTIVITIES = ACTIVITY_GROUPS.flatMap(([category, items]) =>
  items.map(([id, label]) => ({ id, label, category })));

// ---------- interests (stated activity preferences) ----------
// An interest is one of the activity ids above. It gives that activity a lift in
// every ranking (suggestions + the activity tree), on top of the learned duel
// weights, and shows on your profile.
const INTEREST_BOOST = 15;
const ACTIVITY_IDS = new Set(ACTIVITIES.map((a) => a.id));
const labelOf = (id) => (ACTIVITIES.find((a) => a.id === id) || {}).label;

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeInterests(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) if (ACTIVITY_IDS.has(x) && !out.includes(x)) out.push(x);
  return out.slice(0, 12);
}
function interestsOf(u) {
  return sanitizeInterests(safeJsonArray(u && u.interests));
}
async function interestSetOf(userId) {
  const u = await store.users.findOne({ _id: userId }, { projection: { interests: 1 } });
  return new Set(u ? interestsOf(u) : []);
}

// Bodies and query strings are attacker-controlled; anything that ends up in a
// MongoDB filter must be a plain string so `{ $gt: '' }`-style operator objects
// can never reach a query.
function asString(value) {
  return typeof value === 'string' ? value : '';
}

// Route ids are the hangouts' integer ids from the old schema.
function parseId(value) {
  return /^\d+$/.test(String(value)) ? Number(value) : null;
}

// One-time: give accounts that predate this feature a starter set of interests
// drawn from the activities they've already upvoted (falling back to popular
// picks), so their profiles and suggestions aren't blank. Guarded by app_meta so
// a user who later clears their interests on purpose stays cleared.
async function seedInterestsForExistingUsers() {
  if (await store.appMeta.findOne({ _id: 'interests_seeded' })) return;
  const DEFAULTS = ['ramen', 'boba', 'film', 'boardgames', 'karaoke'];
  const users = await store.users
    .find({ $or: [{ interests: null }, { interests: 'null' }, { interests: '[]' }, { interests: { $size: 0 } }] },
      { projection: { _id: 1 } })
    .toArray();
  for (const u of users) {
    const liked = (await store.weights
      .find({ user_id: u._id, weight: { $gt: 52 } })
      .sort({ weight: -1 })
      .limit(6)
      .toArray())
      .map((r) => r.activity)
      .filter((a) => ACTIVITY_IDS.has(a));
    const picks = [...liked];
    for (const d of DEFAULTS) { if (picks.length >= 3) break; if (!picks.includes(d)) picks.push(d); }
    await store.users.updateOne({ _id: u._id }, { $set: { interests: picks } });
  }
  await store.appMeta.updateOne({ _id: 'interests_seeded' }, { $set: { value: '1' } }, { upsert: true });
}

let initPromise = null;
// Connect to MongoDB, create indexes, and run startup seeding exactly once.
function init() {
  initPromise ??= (async () => {
    await connectDb();
    await seedInterestsForExistingUsers();
    return store;
  })();
  return initPromise;
}

const ITEMS = [
  { id: 'party_hat', name: 'Party Hat', price: 60 },
  { id: 'beanie', name: 'Beanie', price: 50 },
  { id: 'flower_crown', name: 'Flower Crown', price: 80 },
  { id: 'crown', name: 'Crown', price: 150 },
  { id: 'round_glasses', name: 'Round Glasses', price: 40 },
  { id: 'star_glasses', name: 'Star Glasses', price: 70 },
  { id: 'sunglasses', name: 'Sunglasses', price: 55 },
  { id: 'scarf', name: 'Scarf', price: 45 },
  { id: 'bowtie', name: 'Bow Tie', price: 40 },
  { id: 'wizard_hat', name: 'Wizard Hat', price: 120 },
  { id: 'cowboy_hat', name: 'Cowboy Hat', price: 90 },
  { id: 'chef_hat', name: "Chef's Puff", price: 75 },
  { id: 'halo', name: 'Halo', price: 160 },
  { id: 'cat_ears', name: 'Cat Ears', price: 65 },
  { id: 'propeller_cap', name: 'Propeller Cap', price: 85 },
  { id: 'viking_helm', name: 'Viking Helm', price: 150 },
  { id: 'monocle', name: 'Fancy Monocle', price: 95 },
  { id: 'eyepatch', name: 'Pirate Patch', price: 60 },
  { id: 'heart_glasses', name: 'Heart Shades', price: 70 },
  { id: 'ski_goggles', name: 'Ski Goggles', price: 80 },
  { id: 'bandana', name: 'Bandana', price: 40 },
  { id: 'bell_collar', name: 'Jingle Collar', price: 55 },
  { id: 'bow_ribbon', name: 'Big Bow', price: 65 },
];

// Fixed-date holidays (month, day). Bonus multiplies vibe gains.
const HOLIDAYS = [
  { month: 1, day: 1, label: 'New Year' },
  { month: 2, day: 14, label: 'Valentines' },
  { month: 7, day: 30, label: 'Friendship Day' },
  { month: 10, day: 31, label: 'Halloween' },
  { month: 12, day: 25, label: 'Christmas' },
  { month: 12, day: 31, label: 'New Years Eve' },
];

const VIBE_PER_CONFIRM = 15;
const VIBE_PER_LEVEL = 60;
const ACORNS_PER_LEVEL = 30;

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Legacy icinoxis hostnames forward to tomo-together.com. On the API host the
// redirect covers only browser-facing GETs: installed APKs still have the old
// base URL baked in, and OkHttp drops the Authorization header on cross-host
// redirects, so API routes must keep answering on the old hostname.
const API_PATHS = /^\/(auth|me|friends|hangouts|wallet|catalog|memories|suggestions|leaderboard|users|duels|shop|secret|world|activities|uploads|health)(\/|$)/;
app.use((req, res, next) => {
  if (req.hostname === 'ht6-app.icinoxis.net') {
    return res.redirect(301, 'https://app.tomo-together.com' + req.originalUrl);
  }
  if (
    req.hostname === 'ht6.icinoxis.net' &&
    (req.method === 'GET' || req.method === 'HEAD') &&
    !API_PATHS.test(req.path)
  ) {
    return res.redirect(301, 'https://tomo-together.com' + req.originalUrl);
  }
  next();
});
app.use(express.json());
// Every request waits for the one-time MongoDB initialization. After the first
// resolution this is a resolved-promise await and effectively free.
app.use((req, res, next) => {
  init().then(() => next(), next);
});
app.use('/uploads', express.static(UPLOAD_DIR));
// react-native-web clone of the app: CI exports the same src/ to static files and
// drops them in DATA_DIR/webapp; we serve them for the app.* host only.
const WEB_HOST = process.env.WEB_HOST || 'app.tomo-together.com';
const WEB_DIR = path.join(DATA_DIR, 'webapp');
const webStatic = express.static(WEB_DIR);
app.use((req, res, next) => {
  if (req.hostname !== WEB_HOST) return next();
  webStatic(req, res, () => {
    // SPA fallback: any non-file GET gets the app shell.
    const shell = path.join(WEB_DIR, 'index.html');
    if (req.method === 'GET' && fs.existsSync(shell)) return res.sendFile(shell);
    next();
  });
});
// Marketing homepage (server/public) + APK download.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/apk', (_req, res) => {
  // CI drops the freshly built APK into DATA_DIR/apk (outside wwwroot).
  const apk = path.join(DATA_DIR, 'apk', 'tomo-yard.apk');
  if (!fs.existsSync(apk)) return res.status(404).json({ error: 'APK not built yet' });
  res.download(apk, 'tomo-yard.apk');
});
// Version metadata for the in-app updater; CI writes version.json with the APK.
app.get('/apk/version', (_req, res) => {
  const f = path.join(DATA_DIR, 'apk', 'version.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No version info yet' });
  res.type('json').send(fs.readFileSync(f, 'utf8'));
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').slice(0, 8);
      cb(null, crypto.randomBytes(10).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const level = (vibe) => Math.floor(vibe / VIBE_PER_LEVEL) + 1;

async function getUser(id) {
  return withId(await store.users.findOne({ _id: id }));
}
async function getUserByUsername(username) {
  return withId(await store.users.findOne({ username: asString(username) }));
}
async function getHangout(id) {
  if (id == null) return null;
  return withId(await store.hangouts.findOne({ _id: id }));
}

function publicUser(u) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
  };
}

function notSignedIn(res) {
  res.setHeader('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ error: 'Not signed in' });
}

function auth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return notSignedIn(res);
  store.users.findOne({ token }).then((user) => {
    if (!user) return notSignedIn(res);
    req.user = withId(user);
    next();
  }, next);
}

async function bonusFor(dateISO, memberIds) {
  const d = new Date(dateISO);
  const hol = HOLIDAYS.find((h) => h.month === d.getMonth() + 1 && h.day === d.getDate());
  if (hol) return { mult: 2, reason: hol.label };
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const members = await store.users.find({ _id: { $in: memberIds } }).toArray();
  for (const u of members) {
    if (u.birthday.slice(5) === mmdd) {
      return { mult: 2, reason: `${u.name}'s birthday` };
    }
  }
  return { mult: 1, reason: null };
}

async function friendship(meId, otherId) {
  const [a, b] = pair(meId, otherId);
  return withId(await store.friendships.findOne({ a_id: a, b_id: b }));
}

// A short status/title for a friendship, from vibe + streak + staleness.
// TITLE_STALE_MS is intentionally low so "Need to hang out" is demoable.
const TITLE_STALE_MS = 2 * 60 * 1000; // 2 minutes
function friendTitle({ vibeLevel, streak, lastHangoutAt, friendsSince }) {
  const now = Date.now();
  const last = lastHangoutAt ? new Date(lastHangoutAt).getTime() : null;
  const since = friendsSince ? new Date(friendsSince).getTime() : now;
  const stale = last != null ? now - last > TITLE_STALE_MS : now - since > TITLE_STALE_MS;
  if (stale) return { title: 'Need to hang out', titleKind: 'stale' };
  if (streak) return { title: 'On a streak', titleKind: 'streak' };
  if (vibeLevel >= 3) return { title: 'Best friend', titleKind: 'best' };
  if (last == null) return { title: 'New friend', titleKind: 'new' };
  if (vibeLevel >= 2) return { title: 'Close friend', titleKind: 'close' };
  return { title: 'Friend', titleKind: 'friend' };
}

// Completed hangouts both users attended: last one + count over the past 30 days.
async function hangoutStats(meId, otherId) {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rows = await store.hangouts
    .find(
      { member_ids: { $all: [meId, otherId] }, completed_at: { $ne: null } },
      { projection: { completed_at: 1 } },
    )
    .toArray();
  let last = null;
  let recent = 0;
  for (const r of rows) {
    if (last === null || r.completed_at > last) last = r.completed_at;
    if (r.completed_at > cutoff) recent += 1;
  }
  return { lastHangoutAt: last, recentHangouts: recent, streak: recent >= 3 };
}

// Next Friday 18:00 local, strictly in the future (today 18:00 if Friday before 18:00).
function nextFriday18(from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  d.setHours(18, 0, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 7);
  return d;
}

// Who actually showed up: the photo taker (present to snap it) plus anyone who
// confirmed (tapped) with someone. Everyone else is a no-show.
function attendeeIdSet(h) {
  const set = new Set();
  if (h.photo_by != null) set.add(h.photo_by);
  for (const c of h.confirms || []) { set.add(c.u1); set.add(c.u2); }
  return set;
}

async function hangoutView(h, meId) {
  const ids = h.member_ids;
  const memberDocs = await store.users.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(memberDocs.map((u) => [u._id, u]));
  const attendees = attendeeIdSet(h);
  const members = ids.map((id) => ({ ...publicUser(byId.get(id)), attended: attendees.has(id) }));
  const confirmedPairs = (h.confirms || []).map((c) => [byId.get(c.u1).username, byId.get(c.u2).username]);
  const pairsTotal = (ids.length * (ids.length - 1)) / 2;

  // staking state, entirely from the local DB (no crypto call in list views)
  let stake = null;
  if (h.stake_units) {
    const stakedIds = new Set((h.stakes || []).map((s) => s.user_id));
    const settleByUser = new Map((h.settlements || []).map((s) => [s.user_id, s]));
    stake = {
      stakeUnits: h.stake_units,
      settled: !!h.settled_at,
      poolUnits: String(BigInt(h.stake_units) * BigInt(stakedIds.size)),
      members: ids.map((id) => {
        const s = settleByUser.get(id);
        return {
          username: byId.get(id).username,
          staked: stakedIds.has(id),
          settleStatus: s ? s.status : null,
          payoutUnits: s ? s.payout_units : null,
        };
      }),
      iStaked: stakedIds.has(meId),
    };
  }

  return {
    id: h._id,
    activity: h.activity,
    activityLabel: h.activity_label,
    date: h.date,
    place: h.place,
    bonusMult: h.bonus_mult,
    bonusReason: h.bonus_reason,
    photoUrl: h.photo ? `/uploads/${h.photo}` : null,
    completedAt: h.completed_at,
    members,
    confirmedPairs,
    pairsTotal,
    mine: ids.includes(meId),
    // can be force-ended once it has started and there's a photo (proof)
    canEnd: !h.completed_at && !!h.photo && new Date(h.date).getTime() < Date.now(),
    stake,
  };
}

async function maybeComplete(hangoutId) {
  const h = await store.hangouts.findOne({ _id: hangoutId });
  if (!h || h.completed_at) return;
  const need = (h.member_ids.length * (h.member_ids.length - 1)) / 2;
  const got = (h.confirms || []).length;
  // A staked hangout is completed by /end only after the remote payout has
  // been reconciled and mirrored locally. Non-staked hangouts can retain the
  // original automatic all-pairs completion behavior.
  if (h.photo && got >= need && !h.crypto_event_id) {
    await store.hangouts.updateOne({ _id: hangoutId, completed_at: null }, { $set: { completed_at: now() } });
  }
}

// ---------- auth ----------
function isValidBirthday(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

app.post('/auth/register', asyncRoute(async (req, res) => {
  const { username, name, birthday, password, color, species, interests } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/.test(username || ''))
    return res.status(400).json({ error: 'Username must be 3-20 chars: a-z, 0-9, _' });
  if (!name || name.length < 1 || name.length > 40)
    return res.status(400).json({ error: 'Name is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday || '') || isNaN(new Date(birthday).getTime()))
    return res.status(400).json({ error: 'Birthday must be a valid date' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (await store.users.findOne({ username }))
    return res.status(409).json({ error: 'Username is taken' });
  const salt = crypto.randomBytes(8).toString('hex');
  const token = newToken();
  const doc = {
    _id: await nextId('users'),
    username,
    name,
    birthday,
    pass_hash: hash(password, salt),
    salt,
    token,
    auth0_sub: null,
    acorns: 50,
    color: color || '#A8D8C8',
    species: SPECIES.includes(species) ? species : 'cat',
    owned: [],
    equipped: [],
    interests: sanitizeInterests(interests),
    pos_x: null,
    pos_y: null,
    created_at: now(),
  };
  try {
    await store.users.insertOne(doc);
  } catch (error) {
    if (isDuplicateKeyError(error)) return res.status(409).json({ error: 'Username is taken' });
    throw error;
  }
  cryptoApi.ensureUser(username).catch(() => {}); // best-effort wallet registration
  res.json({ token, me: meView(doc) });
}));

app.post('/auth/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const pass = asString(password);
  const u = await store.users.findOne({ username: asString(username) });
  if (!u) return res.status(401).json({ error: 'Wrong username or password' });

  // Accounts provisioned during the Auth0 era carry a placeholder password and
  // no usable credential. The first self-hosted login for such a username
  // claims it: the submitted password becomes the account password and a real
  // bearer token is minted. (These are the project's own demo accounts.)
  if (typeof u.pass_hash === 'string' && u.pass_hash.startsWith(AUTH0_DISABLED_PREFIX)) {
    if (!pass || pass.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const salt = crypto.randomBytes(8).toString('hex');
    const token = newToken();
    await store.users.updateOne(
      { _id: u._id },
      { $set: { pass_hash: hash(pass, salt), salt, token, auth0_sub: null } },
    );
    cryptoApi.ensureUser(u.username).catch(() => {}); // best-effort wallet registration
    return res.json({ token, me: meView(u) });
  }

  if (hash(pass, u.salt) !== u.pass_hash)
    return res.status(401).json({ error: 'Wrong username or password' });
  cryptoApi.ensureUser(u.username).catch(() => {}); // best-effort wallet registration
  res.json({ token: u.token, me: meView(u) });
}));

function meView(u) {
  return {
    username: u.username,
    name: u.name,
    birthday: u.birthday,
    acorns: u.acorns,
    color: u.color,
    species: u.species,
    owned: safeJsonArray(u.owned),
    equipped: safeJsonArray(u.equipped),
    interests: interestsOf(u),
  };
}

app.get('/me', auth, (req, res) => res.json({ me: meView(req.user) }));

app.put('/me/interests', auth, asyncRoute(async (req, res) => {
  const interests = sanitizeInterests(req.body?.interests);
  await store.users.updateOne({ _id: req.user.id }, { $set: { interests } });
  res.json({ me: meView(await getUser(req.user.id)) });
}));

app.put('/me/avatar', auth, asyncRoute(async (req, res) => {
  const { color, equipped, species } = req.body || {};
  const owned = safeJsonArray(req.user.owned);
  const eq = Array.isArray(equipped) ? equipped.filter((i) => owned.includes(i)) : [];
  await store.users.updateOne({ _id: req.user.id }, {
    $set: {
      color: typeof color === 'string' && color ? color : req.user.color,
      equipped: eq,
      species: SPECIES.includes(species) ? species : req.user.species,
    },
  });
  res.json({ me: meView(await getUser(req.user.id)) });
}));

// ---------- catalog ----------
app.get('/catalog', (_req, res) => res.json({ activities: ACTIVITIES, items: ITEMS, holidays: HOLIDAYS }));

// ---------- users and friends ----------
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

app.get('/users/search', auth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ users: [] });
  const escaped = escapeRegex(q);
  const rows = await store.users
    .find({
      _id: { $ne: req.user.id },
      $or: [
        { username: { $regex: `^${escaped}` } },
        { name: { $regex: escaped, $options: 'i' } },
      ],
    })
    .limit(6)
    .toArray();
  res.json({ users: rows.map(publicUser) });
}));

app.get('/friends', auth, asyncRoute(async (req, res) => {
  const me = req.user.id;
  const rows = await store.friendships.find({ $or: [{ a_id: me }, { b_id: me }] }).toArray();
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of rows) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    const u = await getUser(otherId);
    const view = {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibe: f.vibe,
      vibeLevel: level(f.vibe),
      vibeIntoLevel: f.vibe % VIBE_PER_LEVEL,
      vibePerLevel: VIBE_PER_LEVEL,
    };
    if (f.status === 'accepted') {
      const stats = await hangoutStats(me, otherId);
      const title = friendTitle({
        vibeLevel: view.vibeLevel, streak: stats.streak,
        lastHangoutAt: stats.lastHangoutAt, friendsSince: f.created_at,
      });
      friends.push({ ...view, ...stats, ...title });
    } else if (f.requested_by === me) outgoing.push(view);
    else incoming.push(view);
  }
  friends.sort((x, y) => y.vibe - x.vibe);
  res.json({ friends, incoming, outgoing });
}));

// Detailed profile for one accepted friend, including your shared history.
app.get('/friends/:username', auth, asyncRoute(async (req, res) => {
  const me = req.user.id;
  const other = await getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'No such user' });
  const f = await friendship(me, other.id);
  if (!f || f.status !== 'accepted') return res.status(403).json({ error: 'Not your friend' });

  // hangouts you two both attended
  const shared = await store.hangouts
    .find({ member_ids: { $all: [me, other.id] } })
    .sort({ date: -1 })
    .toArray();
  const completed = shared.filter((h) => h.completed_at);
  const upcoming = shared.filter((h) => !h.completed_at && new Date(h.date).getTime() >= Date.now());

  // favourite shared activities, by how often you've done them together
  const counts = {};
  for (const h of completed) counts[h.activity_label] = (counts[h.activity_label] || 0) + 1;
  const topActivities = Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label]) => label);

  const stats = await hangoutStats(me, other.id);
  res.json({
    friend: {
      ...publicUser(other),
      birthday: other.birthday.slice(5),
      vibe: f.vibe,
      vibeLevel: level(f.vibe),
      vibeIntoLevel: f.vibe % VIBE_PER_LEVEL,
      vibePerLevel: VIBE_PER_LEVEL,
      friendsSince: f.created_at,
      lastHangout: completed[0] ? completed[0].date : null,
      hangoutCount: completed.length,
      upcomingCount: upcoming.length,
      topActivities,
      interests: interestsOf(other).map(labelOf).filter(Boolean),
      recentMemories: await Promise.all(completed.slice(0, 4).map((h) => hangoutView(h, me))),
      ...friendTitle({
        vibeLevel: level(f.vibe),
        streak: stats.streak,
        lastHangoutAt: completed[0] ? completed[0].completed_at : null,
        friendsSince: f.created_at,
      }),
    },
  });
}));

app.post('/friends/request', auth, asyncRoute(async (req, res) => {
  const other = await getUserByUsername(req.body?.username);
  if (!other) return res.status(404).json({ error: 'No such username' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'That is you' });
  const existing = await friendship(req.user.id, other.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.requested_by === req.user.id)
      return res.status(409).json({ error: 'Request already sent' });
    // they already asked us: accept
    await store.friendships.updateOne({ _id: existing.id }, { $set: { status: 'accepted' } });
    return res.json({ ok: true, accepted: true });
  }
  const [a, b] = pair(req.user.id, other.id);
  await store.friendships.insertOne({
    _id: await nextId('friendships'),
    a_id: a,
    b_id: b,
    status: 'pending',
    requested_by: req.user.id,
    vibe: 0,
    created_at: now(),
  });
  res.json({ ok: true, accepted: false });
}));

app.post('/friends/accept', auth, asyncRoute(async (req, res) => {
  const other = await getUserByUsername(req.body?.username);
  if (!other) return res.status(404).json({ error: 'No such username' });
  const f = await friendship(req.user.id, other.id);
  if (!f || f.status !== 'pending' || f.requested_by === req.user.id)
    return res.status(400).json({ error: 'No pending request from them' });
  await store.friendships.updateOne({ _id: f.id }, { $set: { status: 'accepted' } });
  res.json({ ok: true });
}));

// Friend card: profile + vibe + tastes for the tap-on-friend detail view.
app.get('/friends/:username/card', auth, asyncRoute(async (req, res) => {
  const u = await getUserByUsername(req.params.username);
  const f = u && await friendship(req.user.id, u.id);
  if (!f || f.status !== 'accepted') return res.status(404).json({ error: 'Not your friend' });
  const labels = (rows) => rows
    .map((r) => ACTIVITIES.find((a) => a.id === r.activity))
    .filter(Boolean).slice(0, 3).map((a) => a.label);
  const likes = labels(await store.weights
    .find({ user_id: u.id, weight: { $gt: 52 } }).sort({ weight: -1 }).toArray());
  const dislikes = labels(await store.weights
    .find({ user_id: u.id, weight: { $lt: 48 } }).sort({ weight: 1 }).toArray());
  res.json({
    card: {
      ...publicUser(u),
      birthday: u.birthday.slice(5),
      vibeLevel: level(f.vibe),
      lastHangoutAt: (await hangoutStats(req.user.id, u.id)).lastHangoutAt,
      likes,
      dislikes,
    },
  });
}));

// ---------- activity weights and duels ----------
async function weightMapFor(userIds) {
  const rows = await store.weights.find({ user_id: { $in: userIds } }).toArray();
  return new Map(rows.map((r) => [`${r.user_id}:${r.activity}`, r.weight]));
}

// The score used to order activities for a person: their learned duel weight,
// lifted if it's one of their stated interests. This is what makes interests
// steer which hangouts get suggested.
function rankScore(weights, userId, activity, interestSet) {
  const stored = weights.get(`${userId}:${activity}`);
  const base = stored === undefined ? 50 : stored;
  return interestSet && interestSet.has(activity) ? Math.min(100, base + INTEREST_BOOST) : base;
}

app.get('/activities/ranked', auth, asyncRoute(async (req, res) => {
  const usernames = String(req.query.with || '').split(',').filter(Boolean);
  const ids = [req.user.id];
  for (const un of usernames) {
    const u = await store.users.findOne({ username: un }, { projection: { _id: 1 } });
    if (u) ids.push(u._id);
  }
  const sets = new Map();
  for (const id of ids) sets.set(id, await interestSetOf(id));
  const weights = await weightMapFor(ids);
  const ranked = ACTIVITIES.map((a) => ({
    ...a,
    combined: ids.reduce((s, id) => s + rankScore(weights, id, a.id, sets.get(id)), 0) / ids.length,
  })).sort((x, y) => y.combined - x.combined);
  res.json({ activities: ranked });
}));

app.post('/duels', auth, asyncRoute(async (req, res) => {
  const { winner, loser } = req.body || {};
  if (!ACTIVITIES.some((a) => a.id === winner) || !ACTIVITIES.some((a) => a.id === loser))
    return res.status(400).json({ error: 'Unknown activity' });
  const weights = await weightMapFor([req.user.id]);
  const w = rankScore(weights, req.user.id, winner, null);
  const l = rankScore(weights, req.user.id, loser, null);
  const expected = 1 / (1 + Math.pow(10, (l - w) / 40));
  const dw = Math.max(1, Math.round(8 * (1 - expected)));
  await store.weights.updateOne(
    { user_id: req.user.id, activity: winner },
    { $set: { weight: Math.min(100, w + dw) } },
    { upsert: true },
  );
  await store.weights.updateOne(
    { user_id: req.user.id, activity: loser },
    { $set: { weight: Math.max(0, l - dw / 2) } },
    { upsert: true },
  );
  res.json({ ok: true });
}));

// ---------- suggestions ----------
// One concrete plan: most-neglected friend + the pair's best activity, next Friday 18:00.
app.get('/suggestions', auth, asyncRoute(async (req, res) => {
  const me = req.user.id;
  const fr = await store.friendships
    .find({ $or: [{ a_id: me }, { b_id: me }], status: 'accepted' })
    .toArray();
  let best = null;
  for (const f of fr) {
    const otherId = f.a_id === me ? f.b_id : f.a_id;
    // don't re-suggest a pair that already has a hangout in the works
    const open = await store.hangouts.countDocuments({
      member_ids: { $all: [me, otherId] },
      completed_at: null,
    });
    if (open > 0) continue;
    const { lastHangoutAt } = await hangoutStats(me, otherId);
    const t = lastHangoutAt ? new Date(lastHangoutAt).getTime() : -Infinity;
    if (!best || t < best.t || (t === best.t && f.vibe > best.vibe))
      best = { otherId, t, vibe: f.vibe, lastHangoutAt };
  }
  if (!best) return res.json({ suggestion: null });
  const u = await getUser(best.otherId);
  const meSet = await interestSetOf(me);
  const uSet = await interestSetOf(u.id);
  const weights = await weightMapFor([me, u.id]);
  const top = ACTIVITIES.map((a) => ({
    ...a,
    combined: rankScore(weights, me, a.id, meSet) + rankScore(weights, u.id, a.id, uSet),
  })).sort((x, y) => y.combined - x.combined)[0];
  const stale = !best.lastHangoutAt || best.t < Date.now() - 14 * 24 * 3600 * 1000;
  res.json({
    suggestion: {
      friend: publicUser(u),
      activity: { id: top.id, label: top.label },
      date: nextFriday18().toISOString(),
      reason: stale ? 'stale' : 'vibe',
    },
  });
}));

// ---------- hangouts ----------
app.post('/hangouts', auth, asyncRoute(async (req, res) => {
  const { activity, date, place, friendUsernames, stakeUnits } = req.body || {};
  const act = ACTIVITIES.find((a) => a.id === activity);
  if (!act) return res.status(400).json({ error: 'Pick an activity' });
  if (!date || isNaN(new Date(date).getTime()))
    return res.status(400).json({ error: 'Pick a date' });
  const others = [];
  for (const un of friendUsernames || []) {
    const u = await getUserByUsername(un);
    if (!u) return res.status(404).json({ error: `No such user: ${un}` });
    const f = await friendship(req.user.id, u.id);
    if (!f || f.status !== 'accepted')
      return res.status(400).json({ error: `${u.name} is not your friend yet` });
    others.push(u);
  }
  if (others.length < 1) return res.status(400).json({ error: 'Invite at least one friend' });
  const ids = [req.user.id, ...others.map((u) => u.id)];
  const bonus = await bonusFor(date, ids);

  // A requested stake is never silently downgraded. Create the remote event,
  // but let the host use the same explicit, retryable Stake action as everyone
  // else. That avoids debiting real money before the local hangout is durable.
  let cryptoEventId = null;
  let stake = null;
  const wantStake = stakeUnits !== undefined;
  if (wantStake) {
    if (typeof stakeUnits !== 'string' || !/^[1-9]\d*$/.test(stakeUnits) || stakeUnits.length > 34) {
      return res.status(400).json({
        error: 'invalid_stake',
        message: 'Stake must be a positive integer amount in USDC base units.',
      });
    }
    try {
      await cryptoApi.ensureUser(req.user.username);
      // Cashable USDC is backed only by real deposits + redistributed stakes,
      // so the stake multiplier is always 1x. The holiday/birthday bonus.mult
      // applies to acorns/vibe only (see the vibeGain path on confirm).
      const bps = 10000;
      const ev = await cryptoApi.createEvent(req.user.username, act.label, stakeUnits, { multiplierBps: bps, startsAt: date });
      if (!ev || typeof ev.id !== 'string' || ev.id.length < 1) {
        throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
      }
      cryptoEventId = ev.id;
      stake = stakeUnits;
    } catch (e) {
      return sendCryptoError(res, e);
    }
  }

  const hid = await nextId('hangouts');
  await store.hangouts.insertOne({
    _id: hid,
    creator_id: req.user.id,
    activity: act.id,
    activity_label: act.label,
    date,
    place: place || 'Somewhere',
    bonus_mult: bonus.mult,
    bonus_reason: bonus.reason,
    photo: null,
    photo_by: null,
    completed_at: null,
    created_at: now(),
    stake_units: stake,
    crypto_event_id: cryptoEventId,
    settled_at: null,
    member_ids: ids,
    confirms: [],
    stakes: [],
    settlements: [],
    nfc_tokens: [],
  });
  res.json({ hangout: await hangoutView(await getHangout(hid), req.user.id) });
}));

// A member stakes into an existing staked hangout ("put your deposit in").
app.post('/hangouts/:id/stake', auth, asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!h.crypto_event_id) return res.status(400).json({ error: 'This hangout has no stake' });
  if (h.settled_at) return res.status(409).json({ error: 'crypto_conflict', message: 'Already settled' });
  const already = (h.stakes || []).some((s) => s.user_id === req.user.id);
  if (already) {
    return res.json({ hangout: await hangoutView(h, req.user.id) });
  }
  try {
    await cryptoApi.ensureUser(req.user.username);
    let remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
    if (!remoteEvent || remoteEvent.id !== h.crypto_event_id || !Array.isArray(remoteEvent.rsvps)) {
      throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid event.', 'crypto_upstream_invalid');
    }
    if (remoteEvent.status === 'settled') {
      throw new cryptoApi.CryptoError(409, 'Already settled', 'crypto_conflict');
    }
    if (!cryptoEventRsvp(remoteEvent, req.user.username)) {
      try {
        remoteEvent = await cryptoApi.rsvp(h.crypto_event_id, req.user.username);
      } catch (error) {
        // A concurrent or response-lost RSVP may have succeeded. Re-read once
        // and accept only a durable matching RSVP.
        remoteEvent = await cryptoApi.getEvent(h.crypto_event_id);
        if (!cryptoEventRsvp(remoteEvent, req.user.username)) throw error;
      }
    }
    const rsvp = cryptoEventRsvp(remoteEvent, req.user.username);
    if (!rsvp || !['staked', 'attended'].includes(rsvp.status) || rsvp.stakedUnits !== h.stake_units) {
      throw new cryptoApi.CryptoError(502, 'Crypto service returned an invalid RSVP.', 'crypto_upstream_invalid');
    }
  } catch (e) {
    return sendCryptoError(res, e);
  }
  await store.hangouts.updateOne(
    { _id: h.id, 'stakes.user_id': { $ne: req.user.id } },
    { $push: { stakes: { user_id: req.user.id, staked_at: now() } } },
  );
  res.json({ hangout: await hangoutView(await getHangout(h.id), req.user.id) });
}));

function invalidCryptoUpstream(message = 'Crypto service returned an invalid settlement.') {
  return new cryptoApi.CryptoError(502, message, 'crypto_upstream_invalid');
}

function validCryptoInteger(value) {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 34;
}

async function finishHangoutLocally(hangoutId) {
  await store.hangouts.updateOne(
    { _id: hangoutId, completed_at: null },
    { $set: { completed_at: now() } },
  );
}

// Reconcile the authoritative RSVP set, replay all local attendance proof, and
// validate the full payout before publishing it to local views. When `complete`
// is true, settlement and completion become visible in the same atomic
// single-document update.
async function settleStakeAndMirror(h, attendeeIds, { complete = false } = {}) {
  const current = await getHangout(h.id ?? h._id);
  if (!current) throw invalidCryptoUpstream('Hangout disappeared during settlement.');
  if (!current.crypto_event_id) {
    if (complete) await finishHangoutLocally(current.id);
    return getHangout(current.id);
  }
  if (current.settled_at) {
    if (complete) await finishHangoutLocally(current.id);
    return getHangout(current.id);
  }

  // Only known members with this hangout's exact stake may enter the local
  // mirror. This also repairs response-lost RSVPs before attendance is replayed.
  const remoteEvent = await cryptoApi.getEvent(current.crypto_event_id);
  if (
    !remoteEvent ||
    remoteEvent.id !== current.crypto_event_id ||
    !['open', 'settled'].includes(remoteEvent.status) ||
    !Array.isArray(remoteEvent.rsvps) ||
    (remoteEvent.stakeUnits != null && remoteEvent.stakeUnits !== current.stake_units)
  ) {
    throw invalidCryptoUpstream('Crypto service returned an invalid event.');
  }
  // Events are always created at 1x: bonus_mult boosts acorns/vibe only, never
  // cashable USDC, so the payout bonus term below is always zero.
  const expectedMultiplierBps = 10_000;
  if (remoteEvent.multiplierBps != null && remoteEvent.multiplierBps !== expectedMultiplierBps) {
    throw invalidCryptoUpstream('Crypto event multiplier does not match this hangout.');
  }
  const memberDocs = await store.users.find({ _id: { $in: current.member_ids } }).toArray();
  const usersById = new Map(memberDocs.map((u) => [u._id, withId(u)]));
  const members = new Map(memberDocs.map((u) => [cryptoApi.extId(u.username), withId(u)]));
  const seenRemote = new Set();
  const remoteStakes = [];
  for (const rsvp of remoteEvent.rsvps) {
    const user = rsvp && members.get(rsvp.userId);
    if (
      !user ||
      seenRemote.has(rsvp.userId) ||
      rsvp.stakedUnits !== current.stake_units ||
      !['staked', 'attended', 'flaked', 'refunded'].includes(rsvp.status)
    ) {
      throw invalidCryptoUpstream('Crypto event does not match this hangout.');
    }
    seenRemote.add(rsvp.userId);
    remoteStakes.push(user.id);
  }
  // Mirror the durable remote RSVP set: drop local stakes that are not durable
  // remotely, then add missing remote stakes idempotently (a retry repairs any
  // partial progress).
  await store.hangouts.updateOne(
    { _id: current.id },
    { $pull: { stakes: { user_id: { $nin: remoteStakes } } } },
  );
  for (const userId of remoteStakes) {
    await store.hangouts.updateOne(
      { _id: current.id, 'stakes.user_id': { $ne: userId } },
      { $push: { stakes: { user_id: userId, staked_at: now() } } },
    );
  }

  const mirrored = await getHangout(current.id);
  const localStakes = [...(mirrored.stakes || [])]
    .sort((a, b) => a.user_id - b.user_id)
    .map((s) => ({ user_id: s.user_id, username: usersById.get(s.user_id).username }));
  if (remoteEvent.status !== 'settled') {
    // Both a photo taker and either side of an NFC confirmation count as present.
    // A failed check-in aborts settlement; it is never swallowed as a no-show.
    for (const staker of localStakes) {
      if (attendeeIds.has(staker.user_id)) {
        await cryptoApi.checkin(current.crypto_event_id, staker.username);
      }
    }
  }
  const result = await cryptoApi.settle(current.crypto_event_id);

  const expected = new Map(localStakes.map((row) => [cryptoApi.extId(row.username), row]));
  const attendingStakers = new Set(
    localStakes.filter((row) => attendeeIds.has(row.user_id)).map((row) => row.user_id),
  );
  const stakeUnits = BigInt(current.stake_units);
  const attendeeCount = BigInt(attendingStakers.size);
  const flakerCount = BigInt(localStakes.length - attendingStakers.size);
  const expectedForfeit = attendeeCount === 0n ? 0n : stakeUnits * flakerCount;
  const forfeitShare = attendeeCount === 0n ? 0n : expectedForfeit / attendeeCount;
  const forfeitRemainder = attendeeCount === 0n ? 0n : expectedForfeit % attendeeCount;
  const expectedPayouts = new Map();
  let attendeeIndex = 0n;
  for (const rsvp of remoteEvent.rsvps) {
    const local = members.get(rsvp.userId);
    if (!local) throw invalidCryptoUpstream();
    if (attendeeCount === 0n) {
      expectedPayouts.set(rsvp.userId, current.stake_units);
    } else if (!attendingStakers.has(local.id)) {
      expectedPayouts.set(rsvp.userId, '0');
    } else {
      const basePayout = stakeUnits + forfeitShare + (attendeeIndex < forfeitRemainder ? 1n : 0n);
      const bonus = (basePayout * BigInt(expectedMultiplierBps - 10_000)) / 10_000n;
      expectedPayouts.set(rsvp.userId, String(basePayout + bonus));
      attendeeIndex += 1n;
    }
  }
  const seen = new Set();
  const validated = [];
  if (
    !result ||
    result.eventId !== current.crypto_event_id ||
    result.status !== 'settled' ||
    !validCryptoInteger(result.forfeitPoolUnits) ||
    !Array.isArray(result.results) ||
    result.results.length !== expected.size
  ) {
    throw invalidCryptoUpstream();
  }
  for (const entry of result.results) {
    const local = entry && expected.get(entry.userId);
    const expectedStatus = local && attendingStakers.has(local.user_id)
      ? 'attended'
      : attendingStakers.size === 0 ? 'refunded' : 'flaked';
    if (
      !local ||
      seen.has(entry.userId) ||
      entry.status !== expectedStatus ||
      entry.stakedUnits !== current.stake_units ||
      !validCryptoInteger(entry.payoutUnits) ||
      entry.payoutUnits !== expectedPayouts.get(entry.userId)
    ) {
      throw invalidCryptoUpstream();
    }
    seen.add(entry.userId);
    validated.push({
      user_id: local.user_id,
      status: entry.status,
      payout_units: entry.payoutUnits,
    });
  }
  if (BigInt(result.forfeitPoolUnits) !== expectedForfeit) {
    throw invalidCryptoUpstream();
  }

  // One atomic document update publishes the settlement (and completion, when
  // requested) or nothing at all — the SQLite transaction's equivalent.
  const timestamp = now();
  const publish = {
    settlements: { $literal: validated },
    settled_at: { $ifNull: ['$settled_at', timestamp] },
  };
  if (complete) publish.completed_at = { $ifNull: ['$completed_at', timestamp] };
  await store.hangouts.updateOne({ _id: current.id }, [{ $set: publish }]);
  return getHangout(current.id);
}

app.get('/hangouts', auth, asyncRoute(async (req, res) => {
  const rows = await store.hangouts
    .find({ member_ids: req.user.id })
    .sort({ date: -1 })
    .toArray();
  const hangouts = [];
  for (const h of rows) hangouts.push(await hangoutView(h, req.user.id));
  res.json({ hangouts });
}));

app.get('/hangouts/:id', auth, asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  res.json({ hangout: await hangoutView(h, req.user.id) });
}));

app.post('/hangouts/:id/photo', auth, upload.single('photo'), asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (!req.file) return res.status(400).json({ error: 'No photo attached' });
  await store.hangouts.updateOne(
    { _id: h.id },
    { $set: { photo: req.file.filename, photo_by: req.user.id } },
  );
  await maybeComplete(h.id);
  res.json({ hangout: await hangoutView(await getHangout(h.id), req.user.id) });
}));

// End the hangout with whoever showed up, even if some pairs never tapped.
// Requires the hangout to have started and a photo (proof). Attendees are the
// photo taker + anyone who confirmed; no-shows are the rest. Settles the pool
// (checking attendees in first) so no-shows' stakes go to the friends who came.
app.post('/hangouts/:id/end', auth, asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  if (h.completed_at) return res.json({ hangout: await hangoutView(h, req.user.id) });
  if (new Date(h.date).getTime() > Date.now())
    return res.status(400).json({ error: 'Cannot end before the hangout starts' });
  if (!h.photo) return res.status(400).json({ error: 'Take the photo first, then end it' });

  const attendees = attendeeIdSet(h);
  try {
    const ended = await settleStakeAndMirror(h, attendees, { complete: true });
    return res.json({ hangout: await hangoutView(ended, req.user.id) });
  } catch (error) {
    return sendCryptoError(res, error);
  }
}));

// NFC: the "show" phone fetches a short-lived token, encodes it over HCE.
app.get('/hangouts/:id/nfc-token', auth, asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  const token = crypto.randomBytes(6).toString('hex');
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const replaced = await store.hangouts.updateOne(
    { _id: h.id, 'nfc_tokens.user_id': req.user.id },
    { $set: { 'nfc_tokens.$.token': token, 'nfc_tokens.$.expires_at': expiresAt } },
  );
  if (replaced.matchedCount === 0) {
    await store.hangouts.updateOne(
      { _id: h.id, 'nfc_tokens.user_id': { $ne: req.user.id } },
      { $push: { nfc_tokens: { user_id: req.user.id, token, expires_at: expiresAt } } },
    );
  }
  res.json({ payload: `TY1|${h.id}|${req.user.username}|${token}` });
}));

// The "scan" phone posts what it read.
app.post('/hangouts/:id/confirm', auth, asyncRoute(async (req, res) => {
  const h = await getHangout(parseId(req.params.id));
  if (!h || !h.member_ids.includes(req.user.id))
    return res.status(404).json({ error: 'Hangout not found' });
  const { username, token } = req.body || {};
  const other = await getUserByUsername(username);
  if (!other || !h.member_ids.includes(other.id))
    return res.status(400).json({ error: 'That person is not in this hangout' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'Cannot confirm with yourself' });
  const [u1, u2] = pair(req.user.id, other.id);
  const already = (h.confirms || []).some((c) => c.u1 === u1 && c.u2 === u2);
  if (!already) {
    const t = (h.nfc_tokens || []).find((entry) => entry.user_id === other.id);
    if (!t || t.token !== token || t.expires_at < Date.now())
      return res.status(400).json({ error: 'Tap not valid, try again' });
  }
  let vibeGain = 0;
  let acornGain = 0;
  if (!already) {
    const inserted = await store.hangouts.updateOne(
      { _id: h.id, confirms: { $not: { $elemMatch: { u1, u2 } } } },
      { $push: { confirms: { u1, u2, confirmed_at: now() } } },
    );
    if (inserted.matchedCount === 1) {
      const f = await friendship(u1, u2);
      if (f) {
        vibeGain = Math.round(VIBE_PER_CONFIRM * h.bonus_mult);
        const before = level(f.vibe);
        const after = level(f.vibe + vibeGain);
        await store.friendships.updateOne({ _id: f.id }, { $inc: { vibe: vibeGain } });
        if (after > before) {
          acornGain = ACORNS_PER_LEVEL * (after - before);
          await store.users.updateMany({ _id: { $in: [u1, u2] } }, { $inc: { acorns: acornGain } });
        }
      }
      await maybeComplete(h.id);
    }
  }
  // Retry attendance sync even when this confirmation already existed (for
  // example, because a previous crypto response was lost). A failed check-in
  // never erases local proof; settlement replays it as a hard safety boundary.
  if (h.crypto_event_id) {
    const fresh = await getHangout(h.id);
    const stakedIds = new Set((fresh.stakes || []).map((s) => s.user_id));
    const checkins = [];
    for (const [uid, uname] of [[req.user.id, req.user.username], [other.id, other.username]]) {
      if (stakedIds.has(uid)) checkins.push(cryptoApi.checkin(h.crypto_event_id, uname));
    }
    try {
      await Promise.all(checkins);
    } catch (error) {
      return sendCryptoError(res, error);
    }
  }
  res.json({
    hangout: await hangoutView(await getHangout(h.id), req.user.id),
    vibeGain,
    acornGain,
    bonusReason: h.bonus_reason,
  });
}));

// ---------- memory book ----------
app.get('/memories', auth, asyncRoute(async (req, res) => {
  const rows = await store.hangouts
    .find({ member_ids: req.user.id, completed_at: { $ne: null } })
    .sort({ date: -1 })
    .toArray();
  const memories = [];
  for (const h of rows) memories.push(await hangoutView(h, req.user.id));
  res.json({ memories });
}));

// ---------- leaderboard ----------
app.get('/leaderboard', auth, asyncRoute(async (req, res) => {
  const me = req.user.id;
  const fr = await store.friendships
    .find({ $or: [{ a_id: me }, { b_id: me }], status: 'accepted' })
    .toArray();
  const ids = [me, ...fr.map((f) => (f.a_id === me ? f.b_id : f.a_id))];
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const rows = [];
  for (const id of ids) {
    const u = await getUser(id);
    const count = await store.hangouts.countDocuments({
      member_ids: id,
      completed_at: { $ne: null },
      date: { $gte: monthStart.toISOString() },
    });
    rows.push({ ...publicUser(u), count, isMe: id === me });
  }
  rows.sort((x, y) => y.count - x.count);
  res.json({ leaderboard: rows, month: monthStart.toISOString().slice(0, 7) });
}));

// ---------- wardrobe ----------
app.post('/shop/buy', auth, asyncRoute(async (req, res) => {
  const item = ITEMS.find((i) => i.id === req.body?.itemId);
  if (!item) return res.status(404).json({ error: 'No such item' });
  const owned = safeJsonArray(req.user.owned);
  if (owned.includes(item.id)) return res.status(409).json({ error: 'Already owned' });
  if (req.user.acorns < item.price) return res.status(400).json({ error: 'Not enough acorns' });
  await store.users.updateOne(
    { _id: req.user.id, owned: { $ne: item.id }, acorns: { $gte: item.price } },
    { $inc: { acorns: -item.price }, $push: { owned: item.id } },
  );
  res.json({ me: meView(await getUser(req.user.id)) });
}));

// Easter egg: tapping the Leaderboard title rains acorns. Sshh.
app.post('/secret/acorns', auth, asyncRoute(async (req, res) => {
  await store.users.updateOne({ _id: req.user.id }, { $inc: { acorns: 10 } });
  res.json({ me: meView(await getUser(req.user.id)) });
}));

// ---------- wallet (USDC via Unifold treasury) ----------
app.get('/wallet', auth, asyncRoute(async (req, res) => {
  if (!(await cryptoApi.ready())) return res.json({ enabled: false });
  try {
    const w = await cryptoApi.getWallet(req.user.username);
    res.json({
      enabled: true,
      balanceUnits: w.balanceUnits,
      readyToCashOut: w.readyToCashOut,
      cashoutThresholdUnits: w.cashoutThresholdUnits,
      withdrawals: w.withdrawals,
    });
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/add-funds', auth, asyncRoute(async (req, res) => {
  try {
    const r = await cryptoApi.addFunds(req.user.username);
    res.json(r);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/refresh', auth, asyncRoute(async (req, res) => {
  try {
    const r = await cryptoApi.refreshDeposits(req.user.username);
    res.json(r);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.post('/wallet/withdraw', auth, asyncRoute(async (req, res) => {
  const { amountUnits, destination } = req.body || {};
  const keys = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index] && req.rawHeaders[index].toLowerCase() === 'idempotency-key') {
      keys.push(req.rawHeaders[index + 1] || '');
    }
  }
  if (keys.length !== 1 || !cryptoApi.validIdempotencyKey(keys[0])) {
    return res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Exactly one valid Idempotency-Key header is required (8-128 characters).',
    });
  }
  try {
    const result = await cryptoApi.withdraw(req.user.username, amountUnits, destination, keys[0]);
    return res.status(result.status).json(result.data);
  } catch (e) {
    return sendCryptoError(res, e);
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true, name: 'tomo-yard' }));

// ---------- walkable world (WebSocket) ----------
// A shared map at /ws. Clients send {type:'move',x,y}; the server broadcasts
// everyone's live position and persists each player's spot so their character
// stays where they left it after logout.
const WORLD_W = 2400;
const WORLD_H = 1800;
const AVATAR_R = 40; // keep spawns/positions inside the fence
const DEFAULT_WORLD_TICKET_TTL_MS = 45_000;
const worldTickets = new Map(); // random ticket -> { userId, expiresAt }
const attachedWorldServers = new WeakMap();

function worldTicketTtlMs(env = process.env) {
  // Production is deliberately fixed inside the required 30-60 second window.
  // Tests may shorten it to make expiry coverage deterministic and fast.
  if (env.NODE_ENV !== 'test') return DEFAULT_WORLD_TICKET_TTL_MS;
  const override = Number(env.WORLD_WS_TICKET_TTL_MS);
  return Number.isInteger(override) && override > 0 && override <= 60_000
    ? override
    : DEFAULT_WORLD_TICKET_TTL_MS;
}

function pruneWorldTickets(timestamp = Date.now()) {
  for (const [ticket, entry] of worldTickets) {
    if (!entry || entry.expiresAt <= timestamp) worldTickets.delete(ticket);
  }
}

app.post('/world/ws-ticket', auth, (req, res) => {
  pruneWorldTickets();
  // Keep at most one live ticket per identity. Issuing a replacement also
  // prevents an abandoned ticket from remaining useful until its expiry.
  for (const [existingTicket, entry] of worldTickets) {
    if (entry.userId === req.user.id) worldTickets.delete(existingTicket);
  }
  const ticket = crypto.randomBytes(32).toString('base64url');
  worldTickets.set(ticket, {
    userId: req.user.id,
    expiresAt: Date.now() + worldTicketTtlMs(),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ticket });
});

function clampPos(v, max) {
  const number = Number(v);
  if (!Number.isFinite(number)) return null;
  return Math.max(AVATAR_R, Math.min(max - AVATAR_R, number));
}
function spawnPoint() {
  return {
    x: WORLD_W / 2 + (Math.random() * 2 - 1) * 300,
    y: WORLD_H / 2 + (Math.random() * 2 - 1) * 220,
  };
}

function worldPlayer(u, online) {
  return {
    username: u.username,
    name: u.name,
    color: u.color,
    species: u.species,
    equipped: safeJsonArray(u.equipped),
    x: u.pos_x,
    y: u.pos_y,
    online,
  };
}

function broadcastWorld(live, obj, exceptUsername) {
  const msg = JSON.stringify(obj);
  for (const [uname, c] of live) {
    if (uname === exceptUsername) continue;
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}

function rejectWorldUpgrade(socket) {
  // Keep the handshake response deliberately generic and never log the URL,
  // ticket, Authorization header, or any other credential-shaped input.
  if (socket.destroyed) return;
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

function consumeWorldTicket(ticket, timestamp = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length === 0) return null;
  const entry = worldTickets.get(ticket);
  if (!entry) return null;
  // Delete before checking expiry or touching the database. Every recognized
  // ticket gets exactly one connection attempt, including an expired one.
  worldTickets.delete(ticket);
  if (entry.expiresAt <= timestamp) return null;
  return entry;
}

function attachWorldServer(server) {
  if (!server || typeof server.on !== 'function') {
    throw new TypeError('An HTTP server is required');
  }
  const alreadyAttached = attachedWorldServers.get(server);
  if (alreadyAttached) return alreadyAttached;

  const live = new Map(); // username -> { ws, x, y }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  attachedWorldServers.set(server, wss);

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      return rejectWorldUpgrade(socket);
    }
    if (url.pathname !== '/ws') return rejectWorldUpgrade(socket);
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'ticket' || url.searchParams.getAll('ticket').length !== 1) {
      return rejectWorldUpgrade(socket);
    }
    const entry = consumeWorldTicket(url.searchParams.get('ticket'));
    if (!entry) return rejectWorldUpgrade(socket);
    getUser(entry.userId).then((user) => {
      if (!user) return rejectWorldUpgrade(socket);
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, user);
      });
    }, () => rejectWorldUpgrade(socket));
  });

  wss.on('connection', (ws, _req, user) => {
    ws.on('error', () => {});

    // Position is saved, or a fresh spawn is persisted immediately.
    let x = user.pos_x;
    let y = user.pos_y;
    let spawnPersisted = Promise.resolve();
    if (x == null || y == null) {
      const spawn = spawnPoint();
      x = spawn.x;
      y = spawn.y;
      spawnPersisted = store.users.updateOne({ _id: user.id }, { $set: { pos_x: x, pos_y: y } });
      user.pos_x = x;
      user.pos_y = y;
    }
    const previous = live.get(user.username);
    live.set(user.username, { ws, x, y });
    if (previous && previous.ws !== ws && previous.ws.readyState < 2) {
      previous.ws.close(4002, 'replaced');
    }

    // Send initial state: every player who has ever entered the world. A fresh
    // spawn must be durable first so this player appears in their own snapshot.
    spawnPersisted
      .then(() => store.users.find({ pos_x: { $ne: null } }).toArray())
      .then((all) => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'init',
          world: { w: WORLD_W, h: WORLD_H },
          me: user.username,
          players: all.map((candidate) => worldPlayer(candidate, live.has(candidate.username))),
        }));
      })
      .catch(() => ws.close(1011, 'init failed'));
    broadcastWorld(live, { type: 'join', player: worldPlayer(user, true) }, user.username);

    let lastPersist = 0;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || msg.type !== 'move') return;
      const nx = clampPos(msg.x, WORLD_W);
      const ny = clampPos(msg.y, WORLD_H);
      if (nx == null || ny == null) return;
      const c = live.get(user.username);
      if (!c || c.ws !== ws) return;
      c.x = nx;
      c.y = ny;
      broadcastWorld(live, { type: 'pos', username: user.username, x: nx, y: ny }, user.username);
      const timestamp = Date.now();
      if (timestamp - lastPersist > 1500) {
        lastPersist = timestamp;
        store.users.updateOne({ _id: user.id }, { $set: { pos_x: nx, pos_y: ny } }).catch(() => {});
      }
    });

    ws.on('close', () => {
      const c = live.get(user.username);
      if (!c || c.ws !== ws) return;
      store.users.updateOne({ _id: user.id }, { $set: { pos_x: c.x, pos_y: c.y } }).catch(() => {});
      live.delete(user.username);
      broadcastWorld(live, { type: 'offline', username: user.username });
    });
  });

  return wss;
}

function createServer() {
  const server = http.createServer(app);
  attachWorldServer(server);
  return server;
}

// Keep error responses stable and non-sensitive, preserving a Bearer challenge
// on 401 so clients can prompt for sign-in.
app.use((error, _req, res, _next) => {
  const status = Number(error && (error.statusCode || error.status));
  if (status === 401 || status === 403) {
    if (error.headers && typeof error.headers === 'object') res.set(error.headers);
    else if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(status).json({
      error: error.code || (status === 401 ? 'invalid_token' : 'forbidden'),
      message: status === 401 ? 'Authentication required' : 'Access forbidden',
    });
  }

  console.error(error);
  return res.status(500).json({ error: 'server_error', message: 'Internal server error' });
});

if (require.main === module) {
  init().then(() => {
    const server = createServer();
    server.listen(PORT, () => console.log(`Tomo Together server on :${PORT} (+ /ws world)`));
  }).catch((error) => {
    // Never print the connection string; the message is enough to diagnose.
    console.error('MongoDB initialization failed:', error && error.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  init,
  closeDb,
  store,
  attachWorldServer,
  createServer,
  worldTicketTtlMs,
};
