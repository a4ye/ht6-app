'use strict';

// Integration tests for the self-hosted username/password auth that replaced
// Auth0: register, login, token-authenticated /me, and claim-on-login for
// accounts left behind by the Auth0 era.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-auth-'));
process.env.DATA_DIR = dataDir;
delete process.env.CRYPTO_API_URL;
delete process.env.CRYPTO_SERVICE_TOKEN;

// The auth routes call cryptoApi.ensureUser() best-effort (fire-and-forget with
// a swallowed rejection). Stub it so tests never touch a real crypto service.
const cryptoPath = require.resolve('../crypto');
require.cache[cryptoPath] = {
  id: cryptoPath,
  filename: cryptoPath,
  loaded: true,
  exports: {
    ensureUser: async () => {},
    enabled: () => false,
    ready: async () => false,
  },
};

const { startTestMongo } = require('../test-helpers/mongo');
const { app, init, closeDb, store } = require('../index');
const { nextId } = require('../db');

let mongod;
let server;
let baseUrl;

before(async () => {
  mongod = await startTestMongo();
  await init();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  if (mongod) await mongod.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete require.cache[cryptoPath];
});

async function request(route, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

function registerBody(overrides = {}) {
  return {
    username: 'sprout',
    name: 'Sprout',
    birthday: '2000-01-02',
    password: 'acorn secret',
    color: '#A8D8C8',
    species: 'cat',
    interests: [],
    ...overrides,
  };
}

test('register returns a token whose bearer authenticates /me', async () => {
  const created = await request('/auth/register', { method: 'POST', body: registerBody() });
  assert.equal(created.status, 200);
  assert.match(created.json.token, /^[a-f0-9]{48}$/);
  assert.equal(created.json.me.username, 'sprout');

  const me = await request('/me', { token: created.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.me.username, 'sprout');
});

test('login with the correct password returns the account token', async () => {
  await request('/auth/register', { method: 'POST', body: registerBody({ username: 'willow' }) });

  const ok = await request('/auth/login', {
    method: 'POST',
    body: { username: 'willow', password: 'acorn secret' },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^[a-f0-9]{48}$/);

  const me = await request('/me', { token: ok.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.me.username, 'willow');
});

test('login with a wrong password is rejected', async () => {
  await request('/auth/register', { method: 'POST', body: registerBody({ username: 'birch' }) });
  const bad = await request('/auth/login', {
    method: 'POST',
    body: { username: 'birch', password: 'not it' },
  });
  assert.equal(bad.status, 401);
});

test('login for an unknown username is rejected', async () => {
  const bad = await request('/auth/login', {
    method: 'POST',
    body: { username: 'nobody_here', password: 'whatever' },
  });
  assert.equal(bad.status, 401);
});

test('a duplicate username cannot register twice', async () => {
  await request('/auth/register', { method: 'POST', body: registerBody({ username: 'fern' }) });
  const dup = await request('/auth/register', { method: 'POST', body: registerBody({ username: 'fern' }) });
  assert.equal(dup.status, 409);
});

test('register validates username and password', async () => {
  const badUser = await request('/auth/register', { method: 'POST', body: registerBody({ username: 'AB' }) });
  assert.equal(badUser.status, 400);
  const shortPw = await request('/auth/register', {
    method: 'POST',
    body: registerBody({ username: 'moss', password: 'short' }),
  });
  assert.equal(shortPw.status, 400);
});

test('protected routes reject missing or garbage tokens', async () => {
  const none = await request('/me');
  assert.equal(none.status, 401);
  const garbage = await request('/me', { token: 'not-a-real-token' });
  assert.equal(garbage.status, 401);
});

test('an Auth0-era account is claimed by the first self-hosted login', async () => {
  // Seed a row shaped like an Auth0-provisioned profile: a real username but
  // placeholder credentials and an auth0_sub, exactly what provisioning wrote.
  const id = await nextId('users');
  await store.users.insertOne({
    _id: id,
    username: 'legacy_pal',
    name: 'Legacy Pal',
    birthday: '1999-09-09',
    pass_hash: `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`,
    salt: `auth0-disabled:${crypto.randomBytes(16).toString('hex')}`,
    token: `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`,
    auth0_sub: 'auth0|legacy-pal',
    acorns: 50,
    color: '#A8D8C8',
    species: 'cat',
    owned: [],
    equipped: [],
    interests: [],
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
  });

  // First login sets the password and mints a real token.
  const claim = await request('/auth/login', {
    method: 'POST',
    body: { username: 'legacy_pal', password: 'my new password' },
  });
  assert.equal(claim.status, 200);
  assert.match(claim.json.token, /^[a-f0-9]{48}$/);
  assert.equal(claim.json.me.username, 'legacy_pal');

  // The minted token authenticates, and auth0_sub is cleared on the row.
  const me = await request('/me', { token: claim.json.token });
  assert.equal(me.status, 200);
  const row = await store.users.findOne({ _id: id });
  assert.equal(row.auth0_sub, null);
  assert.equal(row.token, claim.json.token);

  // A second login now verifies normally and returns the same claimed token.
  const again = await request('/auth/login', {
    method: 'POST',
    body: { username: 'legacy_pal', password: 'my new password' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.token, claim.json.token);

  // The wrong password no longer works once the account is claimed.
  const wrong = await request('/auth/login', {
    method: 'POST',
    body: { username: 'legacy_pal', password: 'my new password!' },
  });
  assert.equal(wrong.status, 401);
});

test('claiming requires a valid (>= 6 char) password', async () => {
  const id = await nextId('users');
  await store.users.insertOne({
    _id: id,
    username: 'short_claim',
    name: 'Short Claim',
    birthday: '1999-09-09',
    pass_hash: `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`,
    salt: `auth0-disabled:${crypto.randomBytes(16).toString('hex')}`,
    token: `auth0-disabled:${crypto.randomBytes(32).toString('hex')}`,
    auth0_sub: 'auth0|short-claim',
    acorns: 50,
    color: '#A8D8C8',
    species: 'cat',
    owned: [],
    equipped: [],
    interests: [],
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
  });
  const bad = await request('/auth/login', {
    method: 'POST',
    body: { username: 'short_claim', password: 'short' },
  });
  assert.equal(bad.status, 400);
});
