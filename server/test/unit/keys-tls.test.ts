import { randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  decryptDeviceSecret,
  encryptDeviceSecret,
  generateEd25519Pem,
  generateRsa3072Pem,
} from '../../src/security/keys.js';
import { generateTlsCertificate, missingSans } from '../../scripts/lib/tls.js';

describe('device secret encryption at rest', () => {
  const masterKey = randomBytes(32);
  const secret = randomBytes(32);

  it('round-trips and never contains the plaintext secret', () => {
    const enc = encryptDeviceSecret(masterKey, 'celery-node-01', secret);
    expect(enc).not.toContain(secret.toString('base64'));
    expect(decryptDeviceSecret(masterKey, 'celery-node-01', enc).equals(secret)).toBe(true);
  });

  it('cannot be copied to another device row (AAD binds the device ID)', () => {
    const enc = encryptDeviceSecret(masterKey, 'celery-node-01', secret);
    expect(() => decryptDeviceSecret(masterKey, 'celery-node-02', enc)).toThrow();
  });

  it('fails with a different master key', () => {
    const enc = encryptDeviceSecret(masterKey, 'celery-node-01', secret);
    expect(() => decryptDeviceSecret(randomBytes(32), 'celery-node-01', enc)).toThrow();
  });
});

describe('key generation', () => {
  it('Ed25519 key pair signs and verifies', () => {
    const { privatePem, publicPem } = generateEd25519Pem();
    const sig = sign(null, Buffer.from('thresholds 24.5/32'), privatePem);
    expect(verify(null, Buffer.from('thresholds 24.5/32'), publicPem, sig)).toBe(true);
    expect(verify(null, Buffer.from('thresholds 10/50'), publicPem, sig)).toBe(false);
  });

  it('RSA key pair is 3072 bits', () => {
    const { publicPem } = generateRsa3072Pem();
    expect(publicPem).toContain('BEGIN PUBLIC KEY');
    // 3072-bit SPKI DER is 422 bytes
    const der = Buffer.from(publicPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    expect(der.length).toBe(422);
  });
});

describe('self-signed TLS certificate + pinning', () => {
  const sans = { dns: ['localhost'], ips: ['127.0.0.1', '10.0.2.2'] };

  it('is ECDSA P-256 with the requested SANs', async () => {
    const { certPem } = await generateTlsCertificate(sans);
    const cert = new X509Certificate(certPem);
    expect(cert.publicKey.asymmetricKeyType).toBe('ec');
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(missingSans(certPem, sans)).toEqual([]);
    expect(missingSans(certPem, { dns: [], ips: ['192.168.9.9'] })).toEqual(['192.168.9.9']);
  });

  it('a client that pins the cert connects; one that pins another cert is refused', async () => {
    const { certPem, keyPem } = await generateTlsCertificate(sans);
    const other = await generateTlsCertificate(sans);

    const server = tls.createServer({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' }, (s) =>
      s.end('ok'),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const connect = (ca: string, servername: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port, ca, servername }, () =>
          resolve(socket.getProtocol() ?? ''),
        );
        socket.on('error', reject);
      });

    try {
      await expect(connect(certPem, 'localhost')).resolves.toMatch(/^TLSv1\.[23]$/);
      // Wrong pinned certificate -> rejected (rejectUnauthorized stays true).
      await expect(connect(other.certPem, 'localhost')).rejects.toThrow();
      // Hostname not in the SAN list -> rejected.
      await expect(connect(certPem, 'evil.example')).rejects.toThrow(/altnames|Hostname/i);
    } finally {
      server.close();
    }
  });
});
