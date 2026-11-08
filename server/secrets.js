'use strict';
// Server-side keys. These live in a file outside the database on purpose:
// someone who steals or edits the database still doesn't have them.
// In production you'd keep them in AWS Secrets Manager / KMS instead of a file.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SECRETS_PATH = path.join(__dirname, 'secrets.json');

function load() {
  return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
}

const secrets = fs.existsSync(SECRETS_PATH) ? load() : null;

function masterKey() {
  return Buffer.from(secrets.masterKey, 'hex');
}

// AES-256-GCM: encrypts and also detects if the ciphertext was altered.
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Each reading's hash covers its own fields AND the previous hash, keyed with
// a secret. Editing, deleting or reordering any row breaks the chain, and the
// attacker can't recompute it without the chain key.
function chainHash(prevHash, fields) {
  return crypto.createHmac('sha256', secrets.chainKey).update(prevHash + '|' + JSON.stringify(fields)).digest('hex');
}

function headMac(id, hash) {
  return crypto.createHmac('sha256', secrets.chainKey).update(`head|${id}|${hash}`).digest('hex');
}

module.exports = { SECRETS_PATH, secrets, encrypt, decrypt, chainHash, headMac };
