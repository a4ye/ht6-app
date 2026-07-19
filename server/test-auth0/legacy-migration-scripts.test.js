'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { MongoClient } = require('mongodb');

const { startTestMongo } = require('../test-helpers/mongo');
const {
  MigrationSafetyError,
  backfillAuth0Subjects,
  exportAuth0Users,
  parseImportPayload,
} = require('../scripts/auth0-legacy-migration');

let mongod;
let client;
let databaseCounter = 0;

before(async () => {
  mongod = await startTestMongo();
  client = new MongoClient(mongod.getUri());
  await client.connect();
});

after(async () => {
  if (client) await client.close();
  if (mongod) await mongod.stop();
});

function freshDb() {
  databaseCounter += 1;
  return client.db(`legacy_migration_${databaseCounter}`);
}

function temporaryWorkspace(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-auth0-migration-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function createLegacyUsers(db, {
  duplicateUsername = false,
  invalidHashAt = null,
} = {}) {
  const users = db.collection('users');
  for (let id = 1; id <= 5; id += 1) {
    const salt = String(id).padStart(16, '0');
    const passHash = invalidHashAt === id
      ? 'not-a-scrypt-hash'
      : crypto.scryptSync(`secret-${id}`, salt, 32).toString('hex');
    const username = duplicateUsername && id === 5 ? 'legacy_1' : `legacy_${id}`;
    await users.insertOne({
      _id: id,
      username,
      name: `Legacy User ${id}`,
      pass_hash: passHash,
      salt,
      auth0_sub: null,
    });
  }
}

async function linkedSubjectCount(db) {
  return db.collection('users').countDocuments({ auth0_sub: { $type: 'string' } });
}

function assertSafetyCode(error, code) {
  return error instanceof MigrationSafetyError && error.code === code;
}

test('export writes the exact Auth0 scrypt schema without fabricating email data', async (t) => {
  const directory = temporaryWorkspace(t);
  const outputPath = path.join(directory, 'auth0-import.json');
  const db = freshDb();
  await createLegacyUsers(db);

  const dryRun = await exportAuth0Users({ db, outputPath, dryRun: true });
  assert.deepEqual(dryRun, { mode: 'dry-run', count: 5, output: outputPath });
  assert.equal(fs.existsSync(outputPath), false);

  const written = await exportAuth0Users({ db, outputPath });
  assert.deepEqual(written, { mode: 'write', count: 5, output: outputPath });
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(payload.length, 5);
  assert.deepEqual(payload[0], {
    user_id: 'tomoyard-1',
    username: 'legacy_1',
    name: 'Legacy User 1',
    custom_password_hash: {
      algorithm: 'scrypt',
      hash: {
        value: crypto.scryptSync('secret-1', '0000000000000001', 32).toString('hex'),
        encoding: 'hex',
      },
      salt: { value: '0000000000000001', encoding: 'utf8' },
      password: { encoding: 'utf8' },
      keylen: 32,
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
    },
  });
  assert.equal(payload.some((record) => Object.hasOwn(record, 'email')), false);

  assert.deepEqual(
    await exportAuth0Users({ db, outputPath, verify: true }),
    { mode: 'verify', count: 5, output: outputPath },
  );
});

test('export refuses invalid legacy formats, identity collisions, and repository output paths', async (t) => {
  const directory = temporaryWorkspace(t);
  const invalidOutput = path.join(directory, 'invalid.json');
  const invalidDb = freshDb();
  await createLegacyUsers(invalidDb, { invalidHashAt: 3 });
  await assert.rejects(
    () => exportAuth0Users({ db: invalidDb, outputPath: invalidOutput }),
    (error) => assertSafetyCode(error, 'LEGACY_HASH_INVALID'),
  );
  assert.equal(fs.existsSync(invalidOutput), false);

  const collisionOutput = path.join(directory, 'collision.json');
  const collisionDb = freshDb();
  await createLegacyUsers(collisionDb, { duplicateUsername: true });
  await assert.rejects(
    () => exportAuth0Users({ db: collisionDb, outputPath: collisionOutput }),
    (error) => assertSafetyCode(error, 'IMPORT_USERNAME_COLLISION'),
  );
  assert.equal(fs.existsSync(collisionOutput), false);

  const validDb = freshDb();
  await createLegacyUsers(validDb);
  const insideRepository = path.resolve(__dirname, 'must-not-be-written.json');
  await assert.rejects(
    () => exportAuth0Users({ db: validDb, outputPath: insideRepository }),
    (error) => assertSafetyCode(error, 'PATH_INSIDE_REPOSITORY'),
  );
  assert.equal(fs.existsSync(insideRepository), false);
});

test('the export CLI never prints usernames, salts, or hashes to stdout', async (t) => {
  const directory = temporaryWorkspace(t);
  const outputPath = path.join(directory, 'auth0-import.json');
  const db = freshDb();
  await createLegacyUsers(db);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../scripts/export-auth0-users.js'),
      '--uri',
      mongod.getUri(),
      '--db-name',
      db.databaseName,
      '--output',
      outputPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /succeeded for 5 users/);
  assert.doesNotMatch(result.stdout, /legacy_1/);
  assert.doesNotMatch(result.stdout, /0000000000000001/);
  assert.doesNotMatch(result.stdout, /[0-9a-f]{64}/);
});

test('import-file verification refuses extra fields and altered password parameters', () => {
  const canonical = Array.from({ length: 5 }, (_, offset) => {
    const id = offset + 1;
    const salt = String(id).padStart(16, '0');
    return {
      user_id: `tomoyard-${id}`,
      username: `legacy_${id}`,
      name: `Legacy User ${id}`,
      custom_password_hash: {
        algorithm: 'scrypt',
        hash: {
          value: crypto.scryptSync(`secret-${id}`, salt, 32).toString('hex'),
          encoding: 'hex',
        },
        salt: { value: salt, encoding: 'utf8' },
        password: { encoding: 'utf8' },
        keylen: 32,
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
      },
    };
  });

  const withEmail = structuredClone(canonical);
  withEmail[0].email = 'fabricated@example.test';
  assert.throws(
    () => parseImportPayload(JSON.stringify(withEmail)),
    (error) => assertSafetyCode(error, 'IMPORT_FIELDS_INVALID'),
  );

  const wrongCost = structuredClone(canonical);
  wrongCost[0].custom_password_hash.cost = 4096;
  assert.throws(
    () => parseImportPayload(JSON.stringify(wrongCost)),
    (error) => assertSafetyCode(error, 'IMPORT_FORMAT_INVALID'),
  );
});

test('backfill dry-run is read-only; apply backs up then links exactly five users', async (t) => {
  const directory = temporaryWorkspace(t);
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'legacy-before-auth0.json');
  const db = freshDb();
  await createLegacyUsers(db);
  await exportAuth0Users({ db, outputPath: importPath });

  assert.deepEqual(
    await backfillAuth0Subjects({ db, importPath, dryRun: true }),
    { mode: 'dry-run', count: 5 },
  );
  assert.equal(await linkedSubjectCount(db), 0);
  assert.equal(fs.existsSync(backupPath), false);

  await assert.rejects(
    () => backfillAuth0Subjects({
      db,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 4,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'IMPORT_SUCCESS_COUNT_MISMATCH'),
  );
  assert.equal(await linkedSubjectCount(db), 0);
  assert.equal(fs.existsSync(backupPath), false);

  const result = await backfillAuth0Subjects({
    db,
    importPath,
    backupPath,
    importJobId: 'job_completed123',
    confirmedSuccessCount: 5,
    confirmImportCompleted: true,
  });
  assert.equal(result.mode, 'apply');
  assert.equal(result.count, 5);
  assert.equal(result.backup, backupPath);
  assert.equal(fs.existsSync(backupPath), true);

  const linked = await db.collection('users')
    .find({}, { projection: { auth0_sub: 1 } })
    .sort({ _id: 1 })
    .toArray();
  assert.deepEqual(
    linked.map((row) => ({ id: row._id, auth0_sub: row.auth0_sub })),
    Array.from({ length: 5 }, (_, offset) => ({
      id: offset + 1,
      auth0_sub: `auth0|tomoyard-${offset + 1}`,
    })),
  );
  const index = (await db.collection('users').indexes())
    .find((entry) => entry.name === 'users_auth0_sub_unique');
  assert.equal(index.unique, true);
  assert.ok(index.partialFilterExpression);

  // The backup snapshots the pre-link documents.
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.collection, 'users');
  assert.equal(backup.documents.length, 5);
  assert.ok(backup.documents.every((document) => document.auth0_sub === null));

  assert.deepEqual(
    await backfillAuth0Subjects({ db, importPath, verify: true }),
    { mode: 'verify', count: 5 },
  );
});

test('backfill refuses a pre-linked target before creating a backup', async (t) => {
  const directory = temporaryWorkspace(t);
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'should-not-exist.json');
  const db = freshDb();
  await createLegacyUsers(db);
  await exportAuth0Users({ db, outputPath: importPath });
  await db.collection('users').updateOne(
    { _id: 1 },
    { $set: { auth0_sub: 'auth0|some-other-subject' } },
  );

  await assert.rejects(
    () => backfillAuth0Subjects({
      db,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 5,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'BACKFILL_ALREADY_LINKED'),
  );
  assert.equal(fs.existsSync(backupPath), false);
});

test('backfill links no users when the named index is unsafe', async (t) => {
  const directory = temporaryWorkspace(t);
  const importPath = path.join(directory, 'auth0-import.json');
  const backupPath = path.join(directory, 'pre-attempt.json');
  const db = freshDb();
  await createLegacyUsers(db);
  await exportAuth0Users({ db, outputPath: importPath });
  // Same name, but neither unique nor partial: must never be trusted.
  await db.collection('users').createIndex({ auth0_sub: 1 }, { name: 'users_auth0_sub_unique' });

  await assert.rejects(
    () => backfillAuth0Subjects({
      db,
      importPath,
      backupPath,
      importJobId: 'job_completed123',
      confirmedSuccessCount: 5,
      confirmImportCompleted: true,
    }),
    (error) => assertSafetyCode(error, 'AUTH0_INDEX_INVALID'),
  );
  // The backup is written before the index inspection, mirroring the old
  // backup-then-transaction ordering; no user may have been linked.
  assert.equal(fs.existsSync(backupPath), true);
  assert.equal(await linkedSubjectCount(db), 0);

  const index = (await db.collection('users').indexes())
    .find((entry) => entry.name === 'users_auth0_sub_unique');
  assert.notEqual(index.unique, true);
  assert.equal(index.partialFilterExpression, undefined);
});
