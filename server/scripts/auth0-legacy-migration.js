'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const EXPECTED_LEGACY_USER_COUNT = 5;
const AUTH0_SUBJECT_PREFIX = 'auth0|tomoyard-';
const IMPORT_USER_ID_PREFIX = 'tomoyard-';
const INDEX_NAME = 'users_auth0_sub_unique';
const REPOSITORY_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));

class MigrationSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationSafetyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MigrationSafetyError(code, message);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveAbsoluteFilePath(input, label, { mustExist = false, outsideRepository = false } = {}) {
  if (typeof input !== 'string' || input.length === 0 || !path.isAbsolute(input)) {
    fail('PATH_NOT_ABSOLUTE', `${label} must be an explicit absolute path`);
  }

  const resolved = path.resolve(input);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    fail('PATH_PARENT_MISSING', `${label} parent directory must already exist`);
  }

  const realParent = fs.realpathSync(parent);
  const realCandidate = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : path.join(realParent, path.basename(resolved));

  if (outsideRepository && isPathInside(REPOSITORY_ROOT, realCandidate)) {
    fail('PATH_INSIDE_REPOSITORY', `${label} must be outside the repository`);
  }
  if (mustExist && (!fs.existsSync(realCandidate) || !fs.statSync(realCandidate).isFile())) {
    fail('PATH_MISSING', `${label} must identify an existing file`);
  }
  return realCandidate;
}

function validateLegacyRow(row, rowNumber) {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    fail('LEGACY_ID_INVALID', `Legacy row ${rowNumber} has an invalid numeric ID`);
  }
  if (typeof row.username !== 'string' || !/^[a-z0-9_]{3,20}$/.test(row.username)) {
    fail('LEGACY_USERNAME_INVALID', `Legacy row ${rowNumber} has an invalid username format`);
  }
  if (
    typeof row.name !== 'string' ||
    row.name.length < 1 ||
    row.name.length > 40 ||
    row.name.trim() !== row.name ||
    /[\u0000-\u001f\u007f]/.test(row.name)
  ) {
    fail('LEGACY_NAME_INVALID', `Legacy row ${rowNumber} has an invalid display-name format`);
  }
  if (typeof row.pass_hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.pass_hash)) {
    fail('LEGACY_HASH_INVALID', `Legacy row ${rowNumber} does not contain a 32-byte lowercase hex scrypt hash`);
  }
  // The legacy server generates an eight-byte salt and stores its hex text.
  // Auth0 must interpret that text as UTF-8, not decode it as hex bytes.
  if (typeof row.salt !== 'string' || !/^[0-9a-f]{16}$/.test(row.salt)) {
    fail('LEGACY_SALT_INVALID', `Legacy row ${rowNumber} does not contain the expected UTF-8 salt text`);
  }
}

function importRecordForRow(row) {
  return {
    user_id: `${IMPORT_USER_ID_PREFIX}${row.id}`,
    username: row.username,
    name: row.name,
    custom_password_hash: {
      algorithm: 'scrypt',
      hash: {
        value: row.pass_hash,
        encoding: 'hex',
      },
      salt: {
        value: row.salt,
        encoding: 'utf8',
      },
      password: {
        encoding: 'utf8',
      },
      keylen: 32,
      cost: 16384,
      blockSize: 8,
      parallelization: 1,
    },
  };
}

function assertNoCollisions(records) {
  const userIds = new Set();
  const usernames = new Set();
  for (const record of records) {
    if (userIds.has(record.user_id)) fail('IMPORT_USER_ID_COLLISION', 'Deterministic Auth0 user IDs collide');
    if (usernames.has(record.username)) fail('IMPORT_USERNAME_COLLISION', 'Legacy usernames collide');
    userIds.add(record.user_id);
    usernames.add(record.username);
  }
}

function legacyRowFromDocument(document) {
  return {
    id: document._id,
    username: document.username,
    name: document.name,
    pass_hash: document.pass_hash,
    salt: document.salt,
    auth0_sub: document.auth0_sub ?? null,
  };
}

async function buildImportRecords(db) {
  const users = db.collection('users');
  const documents = await users
    .find({}, {
      projection: { _id: 1, username: 1, name: 1, pass_hash: 1, salt: 1, auth0_sub: 1 },
    })
    .sort({ _id: 1 })
    .toArray();
  if (documents.length === 0) fail('USERS_COLLECTION_MISSING', 'Database does not contain any users');
  const rows = documents.map(legacyRowFromDocument);
  const legacyRows = rows.filter((row) => row.auth0_sub === null);

  if (legacyRows.length !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'LEGACY_COUNT_MISMATCH',
      `Refusing migration: expected exactly ${EXPECTED_LEGACY_USER_COUNT} unlinked legacy users`,
    );
  }

  legacyRows.forEach(validateLegacyRow);
  const records = legacyRows.map(importRecordForRow);
  assertNoCollisions(records);

  const existingSubjects = new Set(
    rows.filter((row) => row.auth0_sub !== null).map((row) => row.auth0_sub),
  );
  for (const row of legacyRows) {
    if (existingSubjects.has(`${AUTH0_SUBJECT_PREFIX}${row.id}`)) {
      fail('AUTH0_SUBJECT_COLLISION', 'A deterministic Auth0 subject is already assigned to another user');
    }
  }
  return records;
}

function validateImportRecord(record, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('IMPORT_FORMAT_INVALID', `Import entry ${index} is not an object`);
  }
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['custom_password_hash', 'name', 'user_id', 'username'])) {
    fail('IMPORT_FIELDS_INVALID', `Import entry ${index} contains missing or unexpected fields`);
  }
  const idMatch = /^tomoyard-([1-9]\d*)$/.exec(record.user_id);
  if (!idMatch || !Number.isSafeInteger(Number(idMatch[1]))) {
    fail('IMPORT_USER_ID_INVALID', `Import entry ${index} has an invalid deterministic user ID`);
  }
  const pseudoRow = {
    id: Number(idMatch[1]),
    username: record.username,
    name: record.name,
    pass_hash: record.custom_password_hash?.hash?.value,
    salt: record.custom_password_hash?.salt?.value,
  };
  validateLegacyRow(pseudoRow, index);
  const canonical = importRecordForRow(pseudoRow);
  if (JSON.stringify(record) !== JSON.stringify(canonical)) {
    fail('IMPORT_FORMAT_INVALID', `Import entry ${index} does not match the required Auth0 scrypt format`);
  }
  return pseudoRow.id;
}

function parseImportPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail('IMPORT_JSON_INVALID', 'Auth0 import file is not valid JSON');
  }
  if (!Array.isArray(payload) || payload.length !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'IMPORT_COUNT_MISMATCH',
      `Auth0 import file must contain exactly ${EXPECTED_LEGACY_USER_COUNT} entries`,
    );
  }
  payload.forEach(validateImportRecord);
  assertNoCollisions(payload);
  return payload;
}

function readImportFile(importPath) {
  const resolved = resolveAbsoluteFilePath(importPath, 'Auth0 import file', {
    mustExist: true,
    outsideRepository: true,
  });
  return {
    path: resolved,
    records: parseImportPayload(fs.readFileSync(resolved, 'utf8')),
  };
}

/**
 * Run `operation` against the configured MongoDB database. Callers either
 * inject an already-connected `db` (tests) or provide `uri`/`dbName`
 * (defaulting to MONGODB_URI/MONGODB_DB_NAME) and get a short-lived client.
 */
async function withDatabase(options, operation) {
  if (options.db) return operation(options.db);
  const uri = (options.uri || process.env.MONGODB_URI || '').trim();
  const dbName = (options.dbName || process.env.MONGODB_DB_NAME || '').trim();
  if (!uri) fail('MONGODB_URI_MISSING', 'A MongoDB connection string is required (--uri or MONGODB_URI)');
  if (!dbName) fail('MONGODB_DB_NAME_MISSING', 'A MongoDB database name is required (--db-name or MONGODB_DB_NAME)');
  const client = new MongoClient(uri, {
    appName: 'tomo-yard-auth0-migration',
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  try {
    return await operation(client.db(dbName));
  } finally {
    await client.close();
  }
}

function renderImportPayload(records) {
  const text = `${JSON.stringify(records, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 500 * 1024) {
    fail('IMPORT_FILE_TOO_LARGE', 'Auth0 import file would exceed the 500KB bulk-import limit');
  }
  return text;
}

function writePrivateFileAtomic(destination, contents) {
  if (fs.existsSync(destination)) fail('OUTPUT_EXISTS', 'Output path already exists; refusing to overwrite it');
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

async function exportAuth0Users({ db, uri, dbName, outputPath, dryRun = false, verify = false }) {
  if (dryRun && verify) fail('MODE_CONFLICT', 'Dry-run and verification modes are mutually exclusive');
  const output = resolveAbsoluteFilePath(outputPath, 'Auth0 import output', {
    outsideRepository: true,
  });
  const records = await withDatabase({ db, uri, dbName }, buildImportRecords);
  const expected = renderImportPayload(records);

  if (verify) {
    if (!fs.existsSync(output) || !fs.statSync(output).isFile()) {
      fail('OUTPUT_MISSING', 'Auth0 import output does not exist for verification');
    }
    const actualRecords = parseImportPayload(fs.readFileSync(output, 'utf8'));
    if (JSON.stringify(actualRecords) !== JSON.stringify(records)) {
      fail('OUTPUT_VERIFICATION_FAILED', 'Auth0 import output does not exactly match the database');
    }
    return { mode: 'verify', count: records.length, output };
  }

  if (!dryRun) writePrivateFileAtomic(output, expected);
  return { mode: dryRun ? 'dry-run' : 'write', count: records.length, output };
}

async function targetRowsForImport(db, records, { requireUnlinked }) {
  const users = db.collection('users');
  const rows = [];

  for (let index = 0; index < records.length; index += 1) {
    const id = validateImportRecord(records[index], index);
    const document = await users.findOne({ _id: id });
    if (!document) fail('BACKFILL_USER_MISSING', `Imported legacy user ${index} is missing from MongoDB`);
    const row = legacyRowFromDocument(document);
    validateLegacyRow(row, index);
    if (JSON.stringify(importRecordForRow(row)) !== JSON.stringify(records[index])) {
      fail('BACKFILL_SOURCE_MISMATCH', `Imported legacy user ${index} no longer matches MongoDB`);
    }
    if (requireUnlinked && row.auth0_sub !== null) {
      fail('BACKFILL_ALREADY_LINKED', `Imported legacy user ${index} already has an Auth0 subject`);
    }
    rows.push(row);
  }

  const ids = new Set(rows.map((row) => row.id));
  const usernames = new Set(rows.map((row) => row.username));
  if (ids.size !== EXPECTED_LEGACY_USER_COUNT || usernames.size !== EXPECTED_LEGACY_USER_COUNT) {
    fail('BACKFILL_COLLISION', 'Imported legacy users contain an ID or username collision');
  }

  const duplicate = await users.aggregate([
    { $match: { auth0_sub: { $type: 'string' } } },
    { $group: { _id: '$auth0_sub', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).toArray();
  if (duplicate.length > 0) fail('AUTH0_SUBJECT_COLLISION', 'MongoDB already contains duplicate Auth0 subjects');

  const desired = new Set(rows.map((row) => `${AUTH0_SUBJECT_PREFIX}${row.id}`));
  const existing = await users
    .find({ auth0_sub: { $type: 'string' } }, { projection: { _id: 1, auth0_sub: 1 } })
    .toArray();
  if (existing.some((row) => desired.has(row.auth0_sub) && !ids.has(row._id))) {
    fail('AUTH0_SUBJECT_COLLISION', 'A deterministic Auth0 subject is assigned to another MongoDB user');
  }
  return rows;
}

async function inspectAuth0Index(db) {
  let indexes;
  try {
    indexes = await db.collection('users').indexes();
  } catch {
    // listIndexes fails when the collection does not exist yet.
    return { exists: false, valid: false };
  }
  const entry = indexes.find((index) => index.name === INDEX_NAME);
  if (!entry) return { exists: false, valid: false };
  const filter = entry.partialFilterExpression;
  const valid =
    entry.unique === true &&
    JSON.stringify(entry.key) === JSON.stringify({ auth0_sub: 1 }) &&
    !!filter &&
    JSON.stringify(Object.keys(filter)) === JSON.stringify(['auth0_sub']);
  return { exists: true, valid };
}

async function ensureAuth0Index(db) {
  const before = await inspectAuth0Index(db);
  if (before.exists && !before.valid) {
    fail('AUTH0_INDEX_INVALID', `Existing ${INDEX_NAME} index does not have the required definition`);
  }
  if (!before.exists) {
    await db.collection('users').createIndex(
      { auth0_sub: 1 },
      {
        name: INDEX_NAME,
        unique: true,
        partialFilterExpression: { auth0_sub: { $exists: true, $type: 'string' } },
      },
    );
  }
  if (!(await inspectAuth0Index(db)).valid) {
    fail('AUTH0_INDEX_INVALID', 'Failed to create the Auth0 unique partial index');
  }
}

async function verifyBackfillInDatabase(db, records) {
  if (!(await inspectAuth0Index(db)).valid) {
    fail('AUTH0_INDEX_INVALID', 'Auth0 unique partial index is missing or invalid');
  }
  const users = db.collection('users');
  const desiredIds = records.map((record, index) => validateImportRecord(record, index));
  for (const id of desiredIds) {
    const row = await users.findOne({ _id: id }, { projection: { auth0_sub: 1 } });
    if (!row || row.auth0_sub !== `${AUTH0_SUBJECT_PREFIX}${id}`) {
      fail('BACKFILL_VERIFICATION_FAILED', 'A migrated MongoDB user has the wrong Auth0 subject');
    }
  }
  const duplicate = await users.aggregate([
    { $match: { auth0_sub: { $type: 'string' } } },
    { $group: { _id: '$auth0_sub', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]).toArray();
  if (duplicate.length > 0) fail('AUTH0_SUBJECT_COLLISION', 'MongoDB contains duplicate Auth0 subjects');
  return desiredIds.length;
}

function validateImportConfirmation({ importJobId, confirmedSuccessCount, confirmImportCompleted }) {
  if (confirmImportCompleted !== true) {
    fail('IMPORT_NOT_CONFIRMED', 'Apply mode requires --confirm-import-completed');
  }
  if (typeof importJobId !== 'string' || !/^job_[A-Za-z0-9_-]{3,200}$/.test(importJobId)) {
    fail('IMPORT_JOB_ID_INVALID', 'Apply mode requires a valid Auth0 import job ID');
  }
  if (confirmedSuccessCount !== EXPECTED_LEGACY_USER_COUNT) {
    fail(
      'IMPORT_SUCCESS_COUNT_MISMATCH',
      `Confirmed Auth0 import success count must be exactly ${EXPECTED_LEGACY_USER_COUNT}`,
    );
  }
}

/**
 * Snapshot the five target user documents to a private JSON file before the
 * backfill touches them. The MongoDB replacement for the old online SQLite
 * backup: enough to restore auth0_sub by hand if anything goes wrong.
 */
async function createBackup(db, rows, backupPath) {
  if (fs.existsSync(backupPath)) fail('BACKUP_EXISTS', 'Backup path already exists; refusing to overwrite it');
  const documents = await db.collection('users')
    .find({ _id: { $in: rows.map((row) => row.id) } })
    .sort({ _id: 1 })
    .toArray();
  if (documents.length !== rows.length) {
    fail('BACKUP_VERIFICATION_FAILED', 'Backup could not read every target user');
  }
  writePrivateFileAtomic(backupPath, `${JSON.stringify({ collection: 'users', documents }, null, 2)}\n`);

  const readBack = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(readBack.documents) || readBack.documents.length !== rows.length) {
    fail('BACKUP_VERIFICATION_FAILED', 'MongoDB backup failed integrity verification');
  }
}

async function applyBackfill(db, {
  records,
  backupPath,
  importJobId,
  confirmedSuccessCount,
  confirmImportCompleted,
}) {
  validateImportConfirmation({ importJobId, confirmedSuccessCount, confirmImportCompleted });
  const resolvedBackup = resolveAbsoluteFilePath(backupPath, 'MongoDB backup', {
    outsideRepository: true,
  });

  const rows = await targetRowsForImport(db, records, { requireUnlinked: true });
  await createBackup(db, rows, resolvedBackup);
  await ensureAuth0Index(db);

  // MongoDB standalone deployments have no multi-document transaction, so each
  // update is conditional on the row still being unlinked, and any mid-flight
  // failure rolls the already-linked subjects back before rethrowing. The
  // backup file above covers the pathological rollback-also-failed case.
  const users = db.collection('users');
  const linked = [];
  try {
    for (const row of rows) {
      const subject = `${AUTH0_SUBJECT_PREFIX}${row.id}`;
      const result = await users.updateOne(
        { _id: row.id, auth0_sub: null },
        { $set: { auth0_sub: subject } },
      );
      if (result.modifiedCount !== 1) {
        fail('BACKFILL_UPDATE_FAILED', 'A migrated MongoDB user was not updated exactly once');
      }
      linked.push(row.id);
    }
    if (linked.length !== EXPECTED_LEGACY_USER_COUNT) {
      fail('BACKFILL_COUNT_MISMATCH', 'MongoDB backfill updated an unexpected number of users');
    }
    await verifyBackfillInDatabase(db, records);
    return { count: linked.length, backup: resolvedBackup, importJobId };
  } catch (error) {
    for (const id of linked) {
      try {
        await users.updateOne(
          { _id: id, auth0_sub: `${AUTH0_SUBJECT_PREFIX}${id}` },
          { $set: { auth0_sub: null } },
        );
      } catch {
        // Preserve the original migration error; the backup file still allows
        // a manual restore of this row.
      }
    }
    throw error;
  }
}

async function backfillAuth0Subjects({
  db,
  uri,
  dbName,
  importPath,
  backupPath,
  importJobId,
  confirmedSuccessCount,
  confirmImportCompleted = false,
  dryRun = false,
  verify = false,
}) {
  if (dryRun && verify) fail('MODE_CONFLICT', 'Dry-run and verification modes are mutually exclusive');
  const { records } = readImportFile(importPath);
  return withDatabase({ db, uri, dbName }, async (database) => {
    if (verify) {
      return { mode: 'verify', count: await verifyBackfillInDatabase(database, records) };
    }
    if (dryRun) {
      const rows = await targetRowsForImport(database, records, { requireUnlinked: true });
      const index = await inspectAuth0Index(database);
      if (index.exists && !index.valid) {
        fail('AUTH0_INDEX_INVALID', `Existing ${INDEX_NAME} index does not have the required definition`);
      }
      return { mode: 'dry-run', count: rows.length };
    }
    const applied = await applyBackfill(database, {
      records,
      backupPath,
      importJobId,
      confirmedSuccessCount,
      confirmImportCompleted,
    });
    return { mode: 'apply', ...applied };
  });
}

module.exports = {
  AUTH0_SUBJECT_PREFIX,
  EXPECTED_LEGACY_USER_COUNT,
  MigrationSafetyError,
  backfillAuth0Subjects,
  buildImportRecords,
  exportAuth0Users,
  parseImportPayload,
  validateImportConfirmation,
};
