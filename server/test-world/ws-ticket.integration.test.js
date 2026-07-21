'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomoyard-world-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.WORLD_WS_TICKET_TTL_MS = '80';
delete process.env.CRYPTO_API_URL;
delete process.env.CRYPTO_SERVICE_TOKEN;

// Two ordinary self-hosted bearer tokens, one per seeded user. The auth
// middleware accepts any token that matches a user row, so these stand in for
// real register/login tokens without needing the crypto service.
const TOKEN_ALPHA = 'a1b2c3d4'.repeat(6);
const TOKEN_BETA = 'f0e1d2c3'.repeat(6);
const UNKNOWN_TOKEN = '0badc0de'.repeat(6);
const loggedOutput = [];
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

const { startTestMongo } = require('../test-helpers/mongo');
const { createServer, init, closeDb, store, worldTicketTtlMs } = require('../index');
const { nextId } = require('../db');
let mongod;
let server;
let httpBaseUrl;
let wsBaseUrl;
const issuedTickets = [];

function captureConsole(method) {
  console[method] = (...args) => {
    loggedOutput.push(args.map((value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }).join(' '));
  };
}

async function insertUser({ username, name, birthday, token, color, species }) {
  await store.users.insertOne({
    _id: await nextId('users'),
    username,
    name,
    birthday,
    pass_hash: 'unused',
    salt: 'unused',
    token,
    auth0_sub: null,
    acorns: 50,
    color,
    species,
    owned: [],
    equipped: [],
    interests: [],
    pos_x: null,
    pos_y: null,
    created_at: new Date().toISOString(),
  });
}

before(async () => {
  captureConsole('log');
  captureConsole('warn');
  captureConsole('error');

  mongod = await startTestMongo();
  await init();
  await insertUser({
    username: 'world_alpha', name: 'World Alpha', birthday: '2000-01-01',
    token: TOKEN_ALPHA, color: '#A8D8C8', species: 'cat',
  });
  await insertUser({
    username: 'world_beta', name: 'World Beta', birthday: '2001-02-03',
    token: TOKEN_BETA, color: '#123ABC', species: 'frog',
  });

  server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  httpBaseUrl = `http://127.0.0.1:${port}`;
  wsBaseUrl = `ws://127.0.0.1:${port}`;
});

after(async () => {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  if (mongod) await mongod.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function issueTicket(token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${httpBaseUrl}/world/ws-ticket`, {
    method: 'POST',
    headers,
  });
  const json = await response.json();
  if (json.ticket) issuedTickets.push(json.ticket);
  return { status: response.status, headers: response.headers, json };
}

function connect(pathname) {
  const ws = new WebSocket(`${wsBaseUrl}${pathname}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket handshake timed out for ${pathname}`));
    }, 2_000);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ws, ...result });
    };

    ws.once('open', () => finish({ accepted: true }));
    ws.once('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      finish({ accepted: false, status });
    });
    ws.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function connectAndReadInit(ticket) {
  const ws = new WebSocket(`${wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
  const opened = once(ws, 'open');
  const message = once(ws, 'message');
  await opened;
  const [data] = await message;
  return { ws, init: JSON.parse(data.toString()) };
}

async function closeSocket(ws) {
  if (!ws || ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close(1000, 'test complete');
  await closed;
}

async function assertRejected(pathname) {
  const result = await connect(pathname);
  assert.equal(result.accepted, false, `${pathname} must not upgrade`);
  assert.equal(result.status, 401);
}

test('ticket issuance requires a valid bearer token', async () => {
  const missing = await issueTicket();
  assert.equal(missing.status, 401);

  const unknown = await issueTicket(UNKNOWN_TOKEN);
  assert.equal(unknown.status, 401);
});

test('authenticated issuance is random, non-cacheable, and rotates abandoned tickets', async () => {
  const first = await issueTicket(TOKEN_ALPHA);
  const second = await issueTicket(TOKEN_ALPHA);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(first.json.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.json.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.json.ticket, second.json.ticket);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(second.headers.get('cache-control'), 'no-store');

  await assertRejected(`/ws?ticket=${encodeURIComponent(first.json.ticket)}`);
  const accepted = await connectAndReadInit(second.json.ticket);
  assert.equal(accepted.init.type, 'init');
  assert.equal(accepted.init.me, 'world_alpha');
  await closeSocket(accepted.ws);
});

test('a websocket ticket is accepted exactly once and a fresh reconnect ticket works', async () => {
  const first = await issueTicket(TOKEN_ALPHA);
  assert.equal(first.status, 200);
  const connected = await connectAndReadInit(first.json.ticket);
  assert.equal(connected.init.me, 'world_alpha');
  await closeSocket(connected.ws);

  await assertRejected(`/ws?ticket=${encodeURIComponent(first.json.ticket)}`);

  const reconnect = await issueTicket(TOKEN_ALPHA);
  assert.equal(reconnect.status, 200);
  assert.notEqual(reconnect.json.ticket, first.json.ticket);
  const reconnected = await connectAndReadInit(reconnect.json.ticket);
  assert.equal(reconnected.init.me, 'world_alpha');
  await closeSocket(reconnected.ws);
});

test('the websocket identity comes from the authenticated ticket issuer', async () => {
  const response = await issueTicket(TOKEN_BETA);
  assert.equal(response.status, 200);
  const connected = await connectAndReadInit(response.json.ticket);
  assert.equal(connected.init.type, 'init');
  assert.equal(connected.init.me, 'world_beta');
  assert.ok(connected.init.players.some((player) => player.username === 'world_beta'));
  await closeSocket(connected.ws);
});

test('expired and unknown tickets are rejected', async () => {
  assert.equal(worldTicketTtlMs(), 80);
  const response = await issueTicket(TOKEN_ALPHA);
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, worldTicketTtlMs() + 40));
  await assertRejected(`/ws?ticket=${encodeURIComponent(response.json.ticket)}`);
  await assertRejected('/ws?ticket=unknown-world-ticket');
});

test('missing, duplicate, and raw-token query credentials are rejected', async () => {
  await assertRejected('/ws');
  await assertRejected('/ws?ticket=');
  // A bearer token is not a ticket: the socket only accepts issued tickets.
  await assertRejected(`/ws?ticket=${TOKEN_ALPHA}`);
  await assertRejected(`/ws?ticket=${TOKEN_BETA}`);
  await assertRejected(`/ws?token=${TOKEN_ALPHA}`);
  await assertRejected('/ws?ticket=one&ticket=two');
  await assertRejected('/ws?ticket=unknown&token=also-unknown');
});

test('websocket credential material is never written to application logs', () => {
  const output = loggedOutput.join('\n');
  const credentials = [
    TOKEN_ALPHA,
    TOKEN_BETA,
    ...issuedTickets,
  ];
  for (const credential of credentials) {
    assert.equal(output.includes(credential), false, `log leaked credential ${credential.slice(0, 8)}...`);
  }
});
