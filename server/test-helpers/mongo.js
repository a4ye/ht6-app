'use strict';

// Boots an in-memory MongoDB for one test process and points the server's
// data layer at it. Each `node --test` file runs in its own process, so every
// test file gets a fresh, isolated database.
const { MongoMemoryServer } = require('mongodb-memory-server');

async function startTestMongo() {
  // MongoDB publishes no windows-aarch64 build; on Windows-on-ARM the x64
  // binary runs fine under emulation.
  const binary = process.platform === 'win32' && process.arch === 'arm64'
    ? { arch: 'x64' }
    : {};
  const mongod = await MongoMemoryServer.create({ binary });
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB_NAME = 'tomoyard_test';
  return mongod;
}

module.exports = { startTestMongo };
