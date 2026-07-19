'use strict';

// MongoDB data layer for the Tomo Together server.
//
// Application ids stay small integers (allocated from the `counters`
// collection) so API payloads, the NFC payload format (TY1|<hangoutId>|...)
// and the friendships' a_id < b_id ordering keep the exact semantics of the
// previous SQLite schema. Sub-entities that used to be their own tables
// (hangout_members, confirms, hangout_stakes, hangout_settlements,
// nfc_tokens) are embedded in the hangout document, which makes the writes
// that previously needed a SQLite transaction single-document atomic updates.

const { MongoClient } = require('mongodb');

const DEFAULT_URI = 'mongodb://127.0.0.1:27017';
const DEFAULT_DB_NAME = 'tomoyard';

const store = {
  client: null,
  db: null,
  users: null,
  weights: null,
  friendships: null,
  hangouts: null,
  appMeta: null,
  counters: null,
};

let connectPromise = null;

async function ensureIndexes(s) {
  await Promise.all([
    s.users.createIndexes([
      { key: { username: 1 }, name: 'users_username_unique', unique: true },
      { key: { token: 1 }, name: 'users_token_unique', unique: true },
      {
        key: { auth0_sub: 1 },
        name: 'users_auth0_sub_unique',
        unique: true,
        // Mirrors SQLite's `WHERE auth0_sub IS NOT NULL` partial index:
        // legacy rows keep auth0_sub null and do not participate.
        partialFilterExpression: { auth0_sub: { $exists: true, $type: 'string' } },
      },
    ]),
    s.weights.createIndexes([
      { key: { user_id: 1, activity: 1 }, name: 'weights_user_activity_unique', unique: true },
    ]),
    s.friendships.createIndexes([
      { key: { a_id: 1, b_id: 1 }, name: 'friendships_pair_unique', unique: true },
      { key: { b_id: 1 }, name: 'friendships_b_id' },
    ]),
    s.hangouts.createIndexes([
      { key: { member_ids: 1 }, name: 'hangouts_member_ids' },
    ]),
  ]);
}

function connectDb(env = process.env) {
  connectPromise ??= (async () => {
    const uri = (env.MONGODB_URI || '').trim() || DEFAULT_URI;
    const dbName = (env.MONGODB_DB_NAME || '').trim() || DEFAULT_DB_NAME;
    const client = new MongoClient(uri, {
      appName: 'tomo-yard-server',
      retryWrites: true,
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    store.client = client;
    store.db = client.db(dbName);
    store.users = store.db.collection('users');
    store.weights = store.db.collection('weights');
    store.friendships = store.db.collection('friendships');
    store.hangouts = store.db.collection('hangouts');
    store.appMeta = store.db.collection('app_meta');
    store.counters = store.db.collection('counters');
    await ensureIndexes(store);
    return store;
  })();
  return connectPromise;
}

async function closeDb() {
  if (store.client) await store.client.close();
  connectPromise = null;
  store.client = null;
  store.db = null;
}

/** Allocate the next integer id for `users`, `friendships`, or `hangouts`. */
async function nextId(name) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const doc = await store.counters.findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
      return doc.seq;
    } catch (error) {
      // Two concurrent first-ever allocations can race the upsert; one loses
      // with a duplicate key and simply retries against the now-existing doc.
      if (attempt === 0 && isDuplicateKeyError(error)) continue;
      throw error;
    }
  }
}

/** Expose the Mongo _id under the `id` name the rest of the app uses. */
function withId(doc) {
  return doc == null ? doc : { ...doc, id: doc._id };
}

function isDuplicateKeyError(error) {
  if (!error || typeof error !== 'object') return false;
  return error.code === 11000 ||
    (typeof error.message === 'string' && error.message.includes('E11000'));
}

module.exports = {
  DEFAULT_DB_NAME,
  closeDb,
  connectDb,
  isDuplicateKeyError,
  nextId,
  store,
  withId,
};
