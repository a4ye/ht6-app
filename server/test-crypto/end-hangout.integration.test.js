'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-end-hangout-'));
process.env.DATA_DIR = dataDir;

class CryptoError extends Error {
  constructor(status, message, code = 'crypto_request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class CryptoUnavailableError extends CryptoError {
  constructor() {
    super(503, 'Crypto is temporarily unavailable. Please try again.', 'crypto_unavailable');
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  let markEntered;
  const entered = new Promise((resolveEntered) => { markEntered = resolveEntered; });
  return { promise, resolve, reject, entered, markEntered };
}

const state = {
  events: new Map(),
  checkinCalls: [],
  getEventCalls: [],
  settleCalls: [],
  checkinErrors: new Map(),
  checkinGates: new Map(),
};

function eventView(event) {
  return clone({ id: event.id, status: event.status, rsvps: event.rsvps });
}

const fakeCrypto = {
  CryptoError,
  CryptoUnavailableError,
  extId: (username) => `ty_${username}`,
  validIdempotencyKey: () => true,
  enabled: () => true,
  ready: async () => true,
  ensureUser: async () => {},
  createEvent: async () => ({ id: 'unused-create-event' }),
  getEvent: async (eventId) => {
    state.getEventCalls.push(eventId);
    const event = state.events.get(eventId);
    if (!event) throw new CryptoError(404, 'Event not found', 'crypto_not_found');
    return eventView(event);
  },
  rsvp: async () => {
    throw new Error('Unexpected RSVP in end-hangout test');
  },
  checkin: async (eventId, username) => {
    state.checkinCalls.push({ eventId, username });
    const key = `${eventId}:${username}`;
    const gate = state.checkinGates.get(key);
    if (gate) {
      gate.markEntered();
      await gate.promise;
    }
    const error = state.checkinErrors.get(key);
    if (error) throw error;
    const event = state.events.get(eventId);
    const rsvp = event && event.rsvps.find((entry) => entry.userId === `ty_${username}`);
    if (!rsvp) throw new CryptoError(400, 'User has not RSVP\'d', 'crypto_request_failed');
    rsvp.status = 'attended';
    return eventView(event);
  },
  settle: async (eventId) => {
    state.settleCalls.push(eventId);
    const event = state.events.get(eventId);
    if (!event) throw new CryptoError(404, 'Event not found', 'crypto_not_found');
    const behavior = event.settleBehaviors && event.settleBehaviors.shift();
    if (behavior) return behavior(event);
    event.status = 'settled';
    return clone(event.result);
  },
  getWallet: async () => ({ balanceUnits: '0', readyToCashOut: false, withdrawals: [] }),
  addFunds: async () => ({ ok: true }),
  refreshDeposits: async () => ({ ok: true, creditedUnits: '0' }),
  withdraw: async () => ({ status: 202, data: { pending: true } }),
};

const cryptoPath = require.resolve('../crypto');
require.cache[cryptoPath] = {
  id: cryptoPath,
  filename: cryptoPath,
  loaded: true,
  exports: fakeCrypto,
};

const { startTestMongo } = require('../test-helpers/mongo');
const { app, init, closeDb, store } = require('../index');
const { nextId } = require('../db');
let mongod;
let server;
let baseUrl;
const auth = new Map();

async function request(route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* assertion output uses the raw status */ }
  return { status: response.status, json };
}

async function register(username) {
  const result = await request('/auth/register', {
    method: 'POST',
    body: {
      username,
      name: username.toUpperCase(),
      birthday: '2000-01-02',
      password: 'correct horse',
      color: '#A8D8C8',
      species: 'cat',
    },
  });
  assert.equal(result.status, 200);
  auth.set(username, result.json.token);
}

async function userId(username) {
  return (await store.users.findOne({ username }))._id;
}

function settlementResult(eventId, stakeUnits, entries, forfeitPoolUnits) {
  return {
    eventId,
    status: 'settled',
    forfeitPoolUnits,
    results: entries.map(([username, status, payoutUnits]) => ({
      userId: `ty_${username}`,
      status,
      stakedUnits: stakeUnits,
      payoutUnits,
    })),
  };
}

async function makeHangout({
  members = ['alice', 'bob'],
  date = new Date(Date.now() - 60_000).toISOString(),
  photo = 'proof.jpg',
  photoBy = 'alice',
  completedAt = null,
  stakeUnits = null,
  eventId = null,
  remoteStakers = members,
  result = null,
  eventStatus = 'open',
  settleBehaviors = [],
} = {}) {
  const memberIds = [];
  for (const username of members) memberIds.push(await userId(username));
  const photoById = photoBy == null ? null : await userId(photoBy);
  const hangoutId = await nextId('hangouts');
  await store.hangouts.insertOne({
    _id: hangoutId,
    creator_id: memberIds[0],
    activity: 'ramen',
    activity_label: 'Ramen',
    date,
    place: 'Test cafe',
    bonus_mult: 1,
    bonus_reason: null,
    photo,
    photo_by: photoById,
    completed_at: completedAt,
    created_at: new Date().toISOString(),
    stake_units: stakeUnits,
    crypto_event_id: eventId,
    settled_at: null,
    member_ids: memberIds,
    confirms: [],
    stakes: [],
    settlements: [],
    nfc_tokens: [],
  });

  if (eventId) {
    state.events.set(eventId, {
      id: eventId,
      status: eventStatus,
      rsvps: remoteStakers.map((username) => ({
        userId: `ty_${username}`,
        status: eventStatus === 'settled' && result
          ? result.results.find((entry) => entry.userId === `ty_${username}`).status
          : 'staked',
        stakedUnits: stakeUnits,
      })),
      result,
      settleBehaviors: [...settleBehaviors],
    });
  }
  return hangoutId;
}

async function timestamps(hangoutId) {
  const h = await store.hangouts.findOne(
    { _id: hangoutId },
    { projection: { settled_at: 1, completed_at: 1 } },
  );
  return { settled_at: h.settled_at, completed_at: h.completed_at };
}

async function settlementRows(hangoutId) {
  const h = await store.hangouts.findOne({ _id: hangoutId });
  const users = await store.users.find({ _id: { $in: h.settlements.map((s) => s.user_id) } }).toArray();
  const usernameById = new Map(users.map((u) => [u._id, u.username]));
  return h.settlements
    .map((s) => ({ username: usernameById.get(s.user_id), status: s.status, payout_units: s.payout_units }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
}

before(async () => {
  mongod = await startTestMongo();
  await init();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const username of ['alice', 'bob', 'carol', 'dave', 'erin']) await register(username);
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  if (mongod) await mongod.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete require.cache[cryptoPath];
});

test('end requires authentication, membership, start time, and a photo', async () => {
  const futureId = await makeHangout({ date: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await request(`/hangouts/${futureId}/end`, { method: 'POST' })).status, 401);
  assert.equal((await request(`/hangouts/${futureId}/end`, {
    method: 'POST', token: auth.get('erin'),
  })).status, 404);

  const tooEarly = await request(`/hangouts/${futureId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(tooEarly.status, 400);
  assert.equal((await timestamps(futureId)).completed_at, null);

  const noPhotoId = await makeHangout({ photo: null, photoBy: null });
  const noPhoto = await request(`/hangouts/${noPhotoId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(noPhoto.status, 400);
  assert.equal((await timestamps(noPhotoId)).completed_at, null);
});

test('non-staked end is successful and already-ended retries are idempotent', async () => {
  const hangoutId = await makeHangout();
  const ended = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('bob'),
  });
  assert.equal(ended.status, 200);
  assert.ok(ended.json.hangout.completedAt);
  const firstCompletedAt = ended.json.hangout.completedAt;

  const retried = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.hangout.completedAt, firstCompletedAt);
  assert.equal((await timestamps(hangoutId)).settled_at, null);
});

test('attendance combines photo_by with both confirmation sides and check-ins are awaited', async () => {
  const eventId = 'end-attendance';
  const result = settlementResult(eventId, '300', [
    ['alice', 'attended', '400'],
    ['bob', 'attended', '400'],
    ['carol', 'attended', '400'],
    ['dave', 'flaked', '0'],
  ], '300');
  const hangoutId = await makeHangout({
    members: ['alice', 'bob', 'carol', 'dave'],
    stakeUnits: '300',
    eventId,
    result,
  });
  await store.hangouts.updateOne({ _id: hangoutId }, {
    $push: {
      confirms: {
        u1: await userId('bob'),
        u2: await userId('carol'),
        confirmed_at: new Date().toISOString(),
      },
    },
  });

  const gate = deferred();
  state.checkinGates.set(`${eventId}:bob`, gate);
  let requestFinished = false;
  const ending = request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  }).then((response) => {
    requestFinished = true;
    return response;
  });
  await gate.entered;
  assert.equal(requestFinished, false);
  assert.deepEqual(state.settleCalls.filter((id) => id === eventId), []);
  assert.equal((await timestamps(hangoutId)).completed_at, null);
  gate.resolve();

  const ended = await ending;
  assert.equal(ended.status, 200);
  assert.deepEqual(
    state.checkinCalls.filter((call) => call.eventId === eventId).map((call) => call.username),
    ['alice', 'bob', 'carol'],
  );
  assert.deepEqual(await settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '400' },
    { username: 'bob', status: 'attended', payout_units: '400' },
    { username: 'carol', status: 'attended', payout_units: '400' },
    { username: 'dave', status: 'flaked', payout_units: '0' },
  ]);
  assert.ok((await timestamps(hangoutId)).settled_at);
  assert.ok((await timestamps(hangoutId)).completed_at);
});

test('check-in and invalid remote settlement failures publish no completion state', async () => {
  const checkinEventId = 'end-checkin-failure';
  const checkinResult = settlementResult(checkinEventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const checkinHangoutId = await makeHangout({
    stakeUnits: '100', eventId: checkinEventId, result: checkinResult,
  });
  state.checkinErrors.set(
    `${checkinEventId}:alice`,
    new CryptoError(502, 'Check-in response was lost', 'crypto_upstream_failed'),
  );

  const checkinFailure = await request(`/hangouts/${checkinHangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(checkinFailure.status, 502);
  assert.deepEqual(state.settleCalls.filter((id) => id === checkinEventId), []);
  assert.deepEqual(await timestamps(checkinHangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(await settlementRows(checkinHangoutId), []);

  const invalidEventId = 'end-invalid-settlement';
  const hangoutId = await makeHangout({
    stakeUnits: '100',
    eventId: invalidEventId,
    result: settlementResult('wrong-event', '100', [
      ['alice', 'attended', '200'],
      ['bob', 'flaked', '0'],
    ], '100'),
  });
  await store.hangouts.updateOne({ _id: hangoutId }, {
    $push: { settlements: { user_id: await userId('bob'), status: 'refunded', payout_units: '77' } },
  });

  const invalid = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(invalid.status, 502);
  assert.deepEqual(await timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(await settlementRows(hangoutId), [
    { username: 'bob', status: 'refunded', payout_units: '77' },
  ]);
});

test('local mirror failure publishes nothing and reconciles a remote-settled retry', async () => {
  const eventId = 'end-local-failure';
  const result = settlementResult(eventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const hangoutId = await makeHangout({ stakeUnits: '100', eventId, result });
  await store.hangouts.updateOne({ _id: hangoutId }, {
    $push: { settlements: { user_id: await userId('bob'), status: 'refunded', payout_units: '91' } },
  });
  // The settlement publish is a single aggregation-pipeline update; forcing it
  // to fail is the Mongo equivalent of the old SQLite BEFORE INSERT trigger.
  // Settlement + timestamps live in one document, so a failed publish changes
  // nothing at all.
  const failPublish = async (filter, update, options) => {
    if (Array.isArray(update) && filter._id === hangoutId) {
      throw new Error('forced local mirror failure');
    }
    return store.hangouts.constructor.prototype.updateOne.call(store.hangouts, filter, update, options);
  };
  store.hangouts.updateOne = failPublish;

  const failed = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(failed.status, 502);
  assert.deepEqual(await timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(await settlementRows(hangoutId), [
    { username: 'bob', status: 'refunded', payout_units: '91' },
  ]);
  assert.equal(state.events.get(eventId).status, 'settled');
  const checkinsBeforeRetry = state.checkinCalls.filter((call) => call.eventId === eventId).length;

  delete store.hangouts.updateOne; // restore the real prototype method
  const reconciled = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('bob'),
  });
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.json.hangout.stake.settled, true);
  assert.ok((await timestamps(hangoutId)).settled_at);
  assert.ok((await timestamps(hangoutId)).completed_at);
  assert.equal(
    state.checkinCalls.filter((call) => call.eventId === eventId).length,
    checkinsBeforeRetry,
    'a settled remote event must not receive another check-in',
  );
  assert.deepEqual(await settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '200' },
    { username: 'bob', status: 'flaked', payout_units: '0' },
  ]);

  const remoteCallsBeforeCompletedRetry = state.settleCalls.filter((id) => id === eventId).length;
  const alreadyEnded = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(alreadyEnded.status, 200);
  assert.equal(
    state.settleCalls.filter((id) => id === eventId).length,
    remoteCallsBeforeCompletedRetry,
  );
});

test('a lost settlement response is safe to reconcile on retry', async () => {
  const eventId = 'end-lost-response';
  const result = settlementResult(eventId, '100', [
    ['alice', 'attended', '200'],
    ['bob', 'flaked', '0'],
  ], '100');
  const loseFirstResponse = async (event) => {
    event.status = 'settled';
    throw new CryptoError(502, 'Settlement response was lost', 'crypto_upstream_failed');
  };
  const hangoutId = await makeHangout({
    stakeUnits: '100', eventId, result, settleBehaviors: [loseFirstResponse],
  });

  const lost = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(lost.status, 502);
  assert.deepEqual(await timestamps(hangoutId), { settled_at: null, completed_at: null });
  assert.deepEqual(await settlementRows(hangoutId), []);
  const firstCheckins = state.checkinCalls.filter((call) => call.eventId === eventId).length;

  const retry = await request(`/hangouts/${hangoutId}/end`, {
    method: 'POST', token: auth.get('alice'),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.hangout.stake.settled, true);
  assert.equal(
    state.checkinCalls.filter((call) => call.eventId === eventId).length,
    firstCheckins,
  );
  assert.deepEqual(await settlementRows(hangoutId), [
    { username: 'alice', status: 'attended', payout_units: '200' },
    { username: 'bob', status: 'flaked', payout_units: '0' },
  ]);
});
