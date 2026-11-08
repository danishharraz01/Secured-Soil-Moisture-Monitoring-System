/**
 * One-time passwords sent by email (Flow 2, step 2).
 *
 *  - 6 digits from crypto.randomInt (uniform, no modulo bias)
 *  - only HMAC(masterKey, challengeId|code) is stored, so a database leak
 *    does not reveal pending codes
 *  - valid for 5 minutes, single use; ONE wrong guess invalidates it
 */
import { randomInt } from 'node:crypto';
import { constantTimeEqual, hmacSha256Hex } from '@soil/shared';

export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function otpHash(masterKey: Buffer, challengeId: string, code: string): string {
  return hmacSha256Hex(masterKey, `otp v1|${challengeId}|${code}`);
}

export function otpMatches(
  masterKey: Buffer,
  challengeId: string,
  code: string,
  stored: string,
): boolean {
  return constantTimeEqual(otpHash(masterKey, challengeId, code), stored);
}

/** "aaddmiin@mailsac.com" -> "a****@mailsac.com" (shown on the OTP screen). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '****';
  return `${email[0]}****${email.slice(at)}`;
}
