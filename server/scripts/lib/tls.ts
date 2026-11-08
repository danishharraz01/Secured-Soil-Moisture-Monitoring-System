/**
 * Self-signed TLS certificate generation (ECDSA P-256 / SHA-256).
 *
 * The same certificate is used by the API server and the syslog collector and
 * is PINNED by the device and the Flutter app: they trust exactly this
 * certificate and nothing else (not even public CAs).
 *
 * Used only by `npm run setup` (and tests) - not part of the running server.
 */
// @peculiar/x509 uses tsyringe, which needs the Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import { webcrypto, X509Certificate, randomBytes } from 'node:crypto';
import os from 'node:os';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto);

export interface SanList {
  dns: string[];
  ips: string[];
}

/** Non-internal IPv4 addresses of this machine (so a phone on the same Wi-Fi can connect). */
export function lanIPv4Addresses(): string[] {
  const result = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal) result.add(a.address);
    }
  }
  return [...result].sort();
}

/**
 * Subject Alternative Names for the certificate:
 * localhost, 127.0.0.1, 10.0.2.2 (Android emulator -> host), every LAN IPv4,
 * plus anything in TLS_EXTRA_SANS (comma separated).
 */
export function defaultSans(extra = process.env.TLS_EXTRA_SANS ?? ''): SanList {
  const dns = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '10.0.2.2', ...lanIPv4Addresses()]);
  for (const entry of extra
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    (/^\d{1,3}(\.\d{1,3}){3}$/.test(entry) ? ips : dns).add(entry);
  }
  return { dns: [...dns], ips: [...ips] };
}

/** Returns the SAN entries from `wanted` that the certificate does NOT cover. */
export function missingSans(certPem: string, wanted: SanList): string[] {
  const san = new X509Certificate(certPem).subjectAltName ?? '';
  const present = new Set(san.split(',').map((s) => s.trim()));
  return [
    ...wanted.dns.filter((d) => !present.has(`DNS:${d}`)),
    ...wanted.ips.filter((ip) => !present.has(`IP Address:${ip}`)),
  ];
}

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Creates a self-signed ECDSA P-256 certificate valid for 2 years.
 * BasicConstraints CA:true is set (like `openssl req -x509`) so strict TLS
 * stacks such as Android/BoringSSL accept it as a pinned trust anchor.
 */
export async function generateTlsCertificate(
  sans: SanList,
  validDays = 730,
): Promise<{ certPem: string; keyPem: string }> {
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);

  // Positive 128-bit serial number (top bit cleared).
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;

  const notBefore = new Date(Date.now() - 60_000); // tolerate small clock differences
  const notAfter = new Date(notBefore.getTime() + validDays * 24 * 3600_000);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial.toString('hex'),
    name: 'CN=Soil Monitor Server, O=Secured Soil Moisture Monitoring System',
    notBefore,
    notAfter,
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        ...sans.dns.map((value) => ({ type: 'dns' as const, value })),
        ...sans.ips.map((value) => ({ type: 'ip' as const, value })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { certPem: cert.toString('pem') + '\n', keyPem: toPem('PRIVATE KEY', pkcs8) };
}
