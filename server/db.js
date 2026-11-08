'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = path.join(__dirname, '..', 'data', 'soil.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  secret_enc  TEXT NOT NULL,          -- device key, encrypted with the server master key
  low         REAL NOT NULL,          -- start watering below this %
  high        REAL NOT NULL,          -- stop watering at this %
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,       -- simulated garden time
  moisture    REAL NOT NULL,
  pump_on     INTEGER NOT NULL,
  water_ml    REAL NOT NULL,
  received_at INTEGER NOT NULL,
  prev_hash   TEXT NOT NULL,          -- tamper-evident hash chain
  hash        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  device_id TEXT NOT NULL,
  nonce     TEXT NOT NULL,
  seen_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE TABLE IF NOT EXISTS users (
  username  TEXT PRIMARY KEY,
  salt      TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  email     TEXT NOT NULL,          -- where login OTP codes are sent
  phone     TEXT                    -- where motion SMS alerts are sent (admin)
);
CREATE TABLE IF NOT EXISTS otp_challenges (
  id         TEXT PRIMARY KEY,       -- random, given to the client after the password step
  username   TEXT NOT NULL,
  code_hash  TEXT NOT NULL,          -- the 6-digit code is never stored in plain text
  client     TEXT NOT NULL,          -- 'web' or 'mobile'
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alerts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  sim_time INTEGER,
  type     TEXT NOT NULL,            -- sprinkler_on | motion | tamper
  level    TEXT NOT NULL,            -- info | warning | critical
  message  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,       -- for the 10-minute inactivity logout
  expires_at INTEGER NOT NULL        -- absolute limit (8 hours)
);
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip     TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open, DB_PATH };
