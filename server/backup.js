'use strict';
// Encrypted cloud backup ("data gets encrypted (asymmetric) -> application stores data in cloud").
//
// The proposal said RSA-1024. 1024-bit RSA is no longer considered safe (NIST disallowed it
// after 2013), so this uses RSA-3072 with OAEP padding. RSA can only encrypt a few hundred
// bytes, so it's used the standard way (hybrid encryption):
//   1. a fresh random AES-256 key encrypts the data (AES-256-GCM)
//   2. RSA-OAEP-3072 encrypts that AES key with the backup PUBLIC key
//   3. the server signs the whole package with its Ed25519 key
// The server only has the public key, so even if the server or the cloud bucket is hacked,
// old backups can't be decrypted. The private key stays offline (offline-keys/).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLOUD = path.join(ROOT, 'cloud'); // stands in for an S3 bucket / Google Cloud Storage
const KEEP = 20;

function canonical(env) {
  const { signature, ...rest } = env;
  return Buffer.from(JSON.stringify(rest));
}

function createBackup(db, signKey) {
  const publicKey = fs.readFileSync(path.join(__dirname, 'backup-public.pem'));
  const readings = db.prepare('SELECT * FROM readings ORDER BY id').all();
  const headRow = db.prepare('SELECT value FROM meta WHERE key = \'head\'').get();
  const createdAt = new Date().toISOString();
  const plain = Buffer.from(JSON.stringify({ createdAt, head: headRow ? JSON.parse(headRow.value) : null, readings }));

  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const wrappedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey);
  dataKey.fill(0);

  const env = {
    format: 'soil-backup-v1',
    alg: { keyWrap: 'RSA-OAEP-3072-SHA256', data: 'AES-256-GCM', signature: 'Ed25519' },
    createdAt,
    records: readings.length,
    plainSha256: crypto.createHash('sha256').update(plain).digest('hex'),
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
  };
  env.signature = crypto.sign(null, canonical(env), signKey).toString('base64');

  fs.mkdirSync(CLOUD, { recursive: true });
  const name = `backup-${createdAt.replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(CLOUD, name), JSON.stringify(env, null, 2));

  // keep the newest KEEP backups
  const files = fs.readdirSync(CLOUD).filter((f) => f.startsWith('backup-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(CLOUD, f));

  return { file: `cloud/${name}`, records: readings.length, bytes: Buffer.byteLength(env.ciphertext) };
}

module.exports = { createBackup, canonical, CLOUD };
