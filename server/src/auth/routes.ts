/**
 * Flow 2 - login:  password -> OTP by email -> session (10 minutes).
 *
 *   POST /api/login      {username, password}  -> {otpRequired, challengeId, sentTo, expiresIn}
 *   POST /api/login/otp  {challengeId, code}    -> {token, expiresAt, user}
 *   POST /api/logout                            -> deletes the session
 *
 * - The same generic error for unknown user and wrong password, and scrypt
 *   always runs (dummy hash for unknown users) so timing reveals nothing.
 * - ONE wrong OTP invalidates the challenge: {error, restart: true} sends
 *   the app back to the login screen (flowchart: "Correct OTP? No -> login").
 * - 5 failures (password or OTP) within 5 minutes from one IP -> 429 for 5 minutes.
 */
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { randomHex, TIMING } from '@soil/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { hashPassword, verifyPassword, type PasswordHash } from '../security/password.js';
import { clip } from '../services/audit.js';
import type { LoginLimiter } from './limiter.js';
import { generateOtp, maskEmail, otpHash, otpMatches } from './otp.js';
import { bearerToken, createSession, currentUser, deleteSession, requireAuth } from './session.js';

const loginSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

const otpSchema = z
  .object({
    challengeId: z.uuid(),
    code: z.string().regex(/^\d{6}$/, 'code must be 6 digits'),
  })
  .strict();

const GENERIC_LOGIN_ERROR = 'Wrong username or password';

/** Hash of a random password, used to spend the same scrypt time for unknown usernames. */
let dummy: Promise<PasswordHash> | undefined;
const dummyHash = (): Promise<PasswordHash> => (dummy ??= hashPassword(randomHex(16)));

export function authRouter(ctx: AppContext, limiter: LoginLimiter): express.Router {
  const router = express.Router();
  const ipOf = (req: Request): string => req.ip ?? 'unknown';

  /** 429 when the IP is blocked. Returns true if the request was answered. */
  const blocked = (req: Request, res: Response): boolean => {
    const retry = limiter.retryAfter(ipOf(req));
    if (retry === 0) return false;
    res
      .status(429)
      .set('Retry-After', String(retry))
      .json({
        error: `Too many failed attempts - try again in ${Math.ceil(retry / 60)} minute(s)`,
        retryAfter: retry,
      });
    return true;
  };

  /** Counts a failure; audits the moment an IP gets blocked. */
  const failure = async (req: Request, actor: string): Promise<void> => {
    if (limiter.fail(ipOf(req))) {
      await ctx.audit.record({
        actor,
        action: 'login_blocked',
        detail: `5 failed attempts within 5 minutes - IP blocked for 5 minutes`,
        ip: req.ip,
        msgId: 'auth',
      });
    }
  };

  // ---- Step 1: username + password ------------------------------------------
  router.post('/login', async (req, res) => {
    if (blocked(req, res)) return;
    const body = loginSchema.safeParse(req.body);
    if (!body.success)
      return void res.status(400).json({ error: 'username and password are required' });
    const { username, password } = body.data;
    const actor = clip(username, 64);

    const user = await ctx.prisma.user.findUnique({ where: { username } });
    const { salt, passHash } = user ?? (await dummyHash());
    const passwordOk = await verifyPassword(password, salt, passHash); // always runs
    if (!user || !passwordOk) {
      await ctx.audit.record({
        actor,
        action: 'login_failed',
        detail: user ? 'wrong password' : 'unknown username',
        ip: req.ip,
        msgId: 'auth',
      });
      await failure(req, actor);
      return void res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    // Password correct -> OTP by email. Older pending challenges are cancelled.
    await ctx.prisma.otpChallenge.updateMany({
      where: { username, used: false },
      data: { used: true },
    });
    const challengeId = randomUUID();
    const code = generateOtp();
    await ctx.prisma.otpChallenge.create({
      data: {
        id: challengeId,
        username,
        codeHash: otpHash(ctx.keys.masterKey, challengeId, code),
        client: ipOf(req),
        expiresAt: new Date(Date.now() + TIMING.otpMs),
      },
    });
    await ctx.notifier.mailer.send(
      user.email,
      'Your Soil Monitor login code',
      [
        `Your one-time login code is: ${code}`,
        '',
        'It expires in 5 minutes and can be used once.',
        'If you did not try to log in, someone knows your password - change it.',
      ].join('\n'),
    );
    await ctx.audit.record({
      actor,
      action: 'otp_sent',
      detail: `password ok, OTP emailed to ${maskEmail(user.email)}`,
      ip: req.ip,
      msgId: 'auth',
    });
    res.json({
      otpRequired: true,
      challengeId,
      sentTo: maskEmail(user.email),
      expiresIn: TIMING.otpMs / 1000,
    });
  });

  // ---- Step 2: OTP --------------------------------------------------------------
  router.post('/login/otp', async (req, res) => {
    if (blocked(req, res)) return;
    const body = otpSchema.safeParse(req.body);
    if (!body.success)
      return void res.status(400).json({ error: 'challengeId and a 6-digit code are required' });
    const { challengeId, code } = body.data;

    const challenge = await ctx.prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    const restart = async (action: string, detail: string, error: string): Promise<void> => {
      await ctx.audit.record({
        actor: challenge?.username ?? 'anonymous',
        action,
        detail,
        ip: req.ip,
        msgId: 'auth',
      });
      await failure(req, challenge?.username ?? 'anonymous');
      res.status(401).json({ error, restart: true });
    };

    if (
      !challenge ||
      challenge.used ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.client !== ipOf(req)
    ) {
      const why = !challenge
        ? 'unknown challenge'
        : challenge.used
          ? 'code already used or cancelled'
          : challenge.expiresAt.getTime() <= Date.now()
            ? 'code expired'
            : 'code entered from a different client';
      return restart('otp_failed', why, 'This code is no longer valid - please log in again');
    }

    // Single use: mark it used BEFORE comparing, atomically (a parallel request cannot reuse it).
    const claimed = await ctx.prisma.otpChallenge.updateMany({
      where: { id: challengeId, used: false },
      data: { used: true },
    });
    if (claimed.count !== 1)
      return restart(
        'otp_failed',
        'code already used',
        'This code is no longer valid - please log in again',
      );

    if (!otpMatches(ctx.keys.masterKey, challengeId, code, challenge.codeHash)) {
      return restart(
        'otp_wrong',
        'wrong code - challenge invalidated',
        'Wrong code - please log in again',
      );
    }

    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { username: challenge.username },
    });
    const session = await createSession(ctx, user.username);
    limiter.reset(ipOf(req));
    await ctx.audit.record({
      actor: user.username,
      action: 'login_success',
      detail: `password + OTP ok, session ends ${session.expiresAt.toISOString()}`,
      ip: req.ip,
      msgId: 'auth',
    });
    res.json({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: { username: user.username, role: user.role },
    });
  });

  // ---- Logout -----------------------------------------------------------------------
  router.post('/logout', requireAuth(ctx), async (req, res) => {
    const token = bearerToken(req);
    if (token) await deleteSession(ctx, token);
    await ctx.audit.record({
      actor: currentUser(res).username,
      action: 'logout',
      detail: 'session deleted',
      ip: req.ip,
      msgId: 'auth',
    });
    res.json({ ok: true });
  });

  return router;
}
