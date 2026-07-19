// Thin proxy from the Tomo Yard server to the Unifold treasury-custody service
// (crypto/unifold-demo/server). Keeps the Unifold secret key entirely on that
// service; this module only speaks its HTTP API, mapping a Tomo Yard username to
// the external user id `ty_<username>`.
//
// Everything is gated on CRYPTO_API_URL. When it is unset (e.g. the current
// production deploy, which has no crypto service), every function is a no-op or
// returns null, so staking simply does not appear and nothing else breaks.

const BASE = (process.env.CRYPTO_API_URL || '').replace(/\/$/, '');

function enabled() {
  return BASE !== '';
}

const extId = (username) => `ty_${username}`;

class CryptoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new CryptoError(0, `crypto service unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new CryptoError(res.status, json.error || 'crypto request failed');
  return json;
}

// Register + monthly grant. Idempotent on both sides; best-effort (callers swallow).
async function ensureUser(username) {
  if (!enabled()) return;
  await call('POST', '/users/register', { externalUserId: extId(username) });
  await call('POST', '/grant', { externalUserId: extId(username) });
}

async function getWallet(username) {
  if (!enabled()) return null;
  await ensureUser(username).catch(() => {});
  return call('GET', `/users/${extId(username)}`);
}

async function createEvent(hostUsername, title, stakeUnits, opts = {}) {
  if (!enabled()) return null;
  const { event } = await call('POST', '/events', {
    host: extId(hostUsername),
    title,
    stakeUnits,
    multiplierBps: opts.multiplierBps,
    startsAt: opts.startsAt,
  });
  return event;
}

async function rsvp(eventId, username) {
  if (!enabled()) return null;
  const { event } = await call('POST', `/events/${eventId}/rsvp`, { userId: extId(username) });
  return event;
}

async function checkin(eventId, username) {
  if (!enabled()) return null;
  const { event } = await call('POST', `/events/${eventId}/checkin`, { userId: extId(username) });
  return event;
}

async function settle(eventId) {
  if (!enabled()) return null;
  return call('POST', `/events/${eventId}/settle`);
}

async function getEvent(eventId) {
  if (!enabled()) return null;
  const { event } = await call('GET', `/events/${eventId}`);
  return event;
}

async function addFunds(username) {
  if (!enabled()) return null;
  await ensureUser(username).catch(() => {});
  return call('POST', '/add-funds', { externalUserId: extId(username) });
}

async function refreshDeposits(username) {
  if (!enabled()) return null;
  return call('POST', '/deposits/refresh', { externalUserId: extId(username) });
}

async function withdraw(username, amountUnits, destination) {
  if (!enabled()) return null;
  return call('POST', '/withdraw', { externalUserId: extId(username), amountUnits, destination });
}

module.exports = {
  enabled,
  extId,
  CryptoError,
  ensureUser,
  getWallet,
  createEvent,
  rsvp,
  checkin,
  settle,
  getEvent,
  addFunds,
  refreshDeposits,
  withdraw,
};
