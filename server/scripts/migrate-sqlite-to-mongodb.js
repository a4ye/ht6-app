#!/usr/bin/env node
'use strict';

// One-time data migration from the legacy SQLite database (tomoyard.sqlite)
// into MongoDB, preserving every integer id. Sub-entity tables become the
// embedded arrays the server now expects:
//   hangout_members -> hangouts.member_ids
//   confirms        -> hangouts.confirms
//   hangout_stakes  -> hangouts.stakes
//   hangout_settlements -> hangouts.settlements
//   nfc_tokens are short-lived (10 minutes) and deliberately not migrated.
//
// better-sqlite3 is no longer a dependency of this server; install it next to
// this script only for the migration run:
//   cd server && npm install --no-save better-sqlite3
//
// Usage:
//   node scripts/migrate-sqlite-to-mongodb.js --sqlite <absolute-path> [--uri <mongodb-uri>] [--db-name <database>] [--yes]
//
// Without --yes this is a dry run: it validates and prints counts only. The
// target collections must be empty; drop them first to re-run.

const path = require('node:path');
const { MongoClient } = require('mongodb');

function loadSqlite() {
  try {
    return require('better-sqlite3');
  } catch {
    console.error(
      'better-sqlite3 is not installed. Run `npm install --no-save better-sqlite3` in server/ first.',
    );
    process.exit(1);
  }
}

function parseArguments(argv) {
  const options = { yes: false };
  const valueOptions = new Map([
    ['--sqlite', 'sqlitePath'],
    ['--uri', 'uri'],
    ['--db-name', 'dbName'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--yes') {
      options.yes = true;
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[valueOptions.get(argument)] = value;
    index += 1;
  }
  if (!options.sqlitePath || !path.isAbsolute(options.sqlitePath)) {
    throw new Error('--sqlite must be an absolute path to the legacy tomoyard.sqlite file');
  }
  options.uri = (options.uri || process.env.MONGODB_URI || '').trim();
  options.dbName = (options.dbName || process.env.MONGODB_DB_NAME || 'tomoyard').trim();
  if (!options.uri) throw new Error('A MongoDB connection string is required (--uri or MONGODB_URI)');
  return options;
}

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

function tableRows(db, table) {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    // Older databases predate some tables; treat a missing table as empty.
    return [];
  }
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (value == null) continue;
    if (seen.has(value)) throw new Error(`Duplicate ${label} in the SQLite source: refusing to migrate`);
    seen.add(value);
  }
}

function buildDocuments(db) {
  const users = tableRows(db, 'users').map((row) => ({
    _id: row.id,
    username: row.username,
    name: row.name,
    birthday: row.birthday,
    pass_hash: row.pass_hash,
    salt: row.salt,
    token: row.token,
    auth0_sub: row.auth0_sub ?? null,
    acorns: row.acorns ?? 50,
    color: row.color ?? '#A8D8C8',
    species: row.species ?? 'cat',
    owned: safeJsonArray(row.owned),
    equipped: safeJsonArray(row.equipped),
    interests: safeJsonArray(row.interests),
    pos_x: row.pos_x ?? null,
    pos_y: row.pos_y ?? null,
    created_at: row.created_at,
  }));
  assertUnique(users.map((u) => u.username), 'username');
  assertUnique(users.map((u) => u.token), 'token');
  assertUnique(users.map((u) => u.auth0_sub), 'auth0_sub');

  const weights = tableRows(db, 'weights').map((row) => ({
    user_id: row.user_id,
    activity: row.activity,
    weight: row.weight,
  }));
  assertUnique(weights.map((w) => `${w.user_id}:${w.activity}`), 'weight (user_id, activity)');

  const friendships = tableRows(db, 'friendships').map((row) => ({
    _id: row.id,
    a_id: row.a_id,
    b_id: row.b_id,
    status: row.status,
    requested_by: row.requested_by,
    vibe: row.vibe ?? 0,
    created_at: row.created_at,
  }));
  assertUnique(friendships.map((f) => `${f.a_id}:${f.b_id}`), 'friendship pair');

  const membersByHangout = new Map();
  for (const row of tableRows(db, 'hangout_members')) {
    if (!membersByHangout.has(row.hangout_id)) membersByHangout.set(row.hangout_id, []);
    membersByHangout.get(row.hangout_id).push(row.user_id);
  }
  const confirmsByHangout = new Map();
  for (const row of tableRows(db, 'confirms')) {
    if (!confirmsByHangout.has(row.hangout_id)) confirmsByHangout.set(row.hangout_id, []);
    confirmsByHangout.get(row.hangout_id).push({
      u1: row.u1,
      u2: row.u2,
      confirmed_at: row.confirmed_at,
    });
  }
  const stakesByHangout = new Map();
  for (const row of tableRows(db, 'hangout_stakes')) {
    if (!stakesByHangout.has(row.hangout_id)) stakesByHangout.set(row.hangout_id, []);
    stakesByHangout.get(row.hangout_id).push({
      user_id: row.user_id,
      staked_at: row.staked_at,
    });
  }
  const settlementsByHangout = new Map();
  for (const row of tableRows(db, 'hangout_settlements')) {
    if (!settlementsByHangout.has(row.hangout_id)) settlementsByHangout.set(row.hangout_id, []);
    settlementsByHangout.get(row.hangout_id).push({
      user_id: row.user_id,
      status: row.status,
      payout_units: row.payout_units,
    });
  }

  const hangouts = tableRows(db, 'hangouts').map((row) => ({
    _id: row.id,
    creator_id: row.creator_id,
    activity: row.activity,
    activity_label: row.activity_label,
    date: row.date,
    place: row.place,
    bonus_mult: row.bonus_mult,
    bonus_reason: row.bonus_reason ?? null,
    photo: row.photo ?? null,
    photo_by: row.photo_by ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    stake_units: row.stake_units ?? null,
    crypto_event_id: row.crypto_event_id ?? null,
    settled_at: row.settled_at ?? null,
    member_ids: membersByHangout.get(row.id) || [],
    confirms: confirmsByHangout.get(row.id) || [],
    stakes: stakesByHangout.get(row.id) || [],
    settlements: settlementsByHangout.get(row.id) || [],
    nfc_tokens: [],
  }));

  const appMeta = tableRows(db, 'app_meta').map((row) => ({
    _id: row.key,
    value: row.value,
  }));

  const maxId = (documents) => documents.reduce((max, doc) => Math.max(max, doc._id), 0);
  const counters = [
    { _id: 'users', seq: maxId(users) },
    { _id: 'friendships', seq: maxId(friendships) },
    { _id: 'hangouts', seq: maxId(hangouts) },
  ];

  return { users, weights, friendships, hangouts, app_meta: appMeta, counters };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('See the header of this file for usage.');
    return;
  }

  const Database = loadSqlite();
  const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  let documents;
  try {
    documents = buildDocuments(sqlite);
  } finally {
    sqlite.close();
  }

  const summary = Object.fromEntries(
    Object.entries(documents).map(([name, docs]) => [name, docs.length]),
  );
  console.log('Documents to migrate:', summary);

  if (!options.yes) {
    console.log('Dry run only. Re-run with --yes to write to MongoDB.');
    return;
  }

  const client = new MongoClient(options.uri, {
    appName: 'tomo-yard-sqlite-migration',
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  try {
    const db = client.db(options.dbName);
    for (const name of Object.keys(documents)) {
      const count = await db.collection(name).countDocuments();
      if (count > 0) {
        throw new Error(
          `Target collection "${name}" already has ${count} documents; drop it first to re-run.`,
        );
      }
    }
    for (const [name, docs] of Object.entries(documents)) {
      if (docs.length > 0) await db.collection(name).insertMany(docs, { ordered: true });
    }
    // Create the server's indexes now so unique-constraint violations surface
    // here, during the migration window, rather than at first server start.
    process.env.MONGODB_URI = options.uri;
    process.env.MONGODB_DB_NAME = options.dbName;
    const { connectDb, closeDb } = require('../db');
    await connectDb();
    await closeDb();
    console.log('Migration complete. Verify with the server before deleting the SQLite file.');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (require.main === module) void main();

module.exports = { buildDocuments, parseArguments };
