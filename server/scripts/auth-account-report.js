#!/usr/bin/env node
'use strict';

// Read-only report on the state of self-hosted accounts after the Auth0 removal.
// It never writes: it counts password accounts vs. Auth0-era rows that still
// carry a placeholder credential and must be claimed on first sign-in.
//
// Usage:
//   MONGODB_URI=... MONGODB_DB_NAME=tomoyard node scripts/auth-account-report.js
//
// Defaults to mongodb://127.0.0.1:27017 / tomoyard when the vars are unset.

const { connectDb, closeDb, store } = require('../db');

const AUTH0_DISABLED_PREFIX = 'auth0-disabled:';

async function main() {
  await connectDb();
  try {
    const total = await store.users.countDocuments();

    // Unclaimed Auth0-era rows: placeholder password written by provisioning.
    const unclaimed = await store.users.countDocuments({
      pass_hash: { $regex: `^${AUTH0_DISABLED_PREFIX}` },
    });

    // Rows still linked to an Auth0 subject (claim-on-login clears this field).
    const stillLinked = await store.users.countDocuments({
      auth0_sub: { $type: 'string' },
    });

    const password = total - unclaimed;

    console.log('Self-hosted account report');
    console.log('---------------------------');
    console.log(`Total users:                 ${total}`);
    console.log(`Password accounts (usable):  ${password}`);
    console.log(`Unclaimed Auth0-era rows:    ${unclaimed}`);
    console.log(`Rows still holding auth0_sub: ${stillLinked}`);
    if (unclaimed > 0) {
      console.log('');
      console.log(`${unclaimed} account(s) will set a password on their first sign-in.`);
    }
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error('Report failed:', error && error.message);
  process.exit(1);
});
