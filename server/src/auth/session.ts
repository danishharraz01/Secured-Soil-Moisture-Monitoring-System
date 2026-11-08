/**
 * Sessions: a random 32-byte bearer token, returned once and stored only as
 * SHA-256. HARD limit of 10 minutes from login - using the app does not
 * extend it (proposal: "logged out every 10 minutes"), so a new password +
 * OTP login is needed afterwards.
 */
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { sha256Hex, TIMING } from '@soil/shared';
import type { AppContext } from '../context.js';
import type { Role } from '../db.js';

export interface AuthUser {
  username: string;
  role: Role;
  sessionExpiresAt: Date;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export async function createSession(
  ctx: AppContext,
  username: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + TIMING.sessionMs);
  await ctx.prisma.session.create({
    data: { tokenHash: sha256Hex(token), username, createdAt: now, expiresAt },
  });
  return { token, expiresAt };
}

export async function deleteSession(ctx: AppContext, token: string): Promise<void> {
  await ctx.prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

/** Reads "Authorization: Bearer <token>" - returns undefined if absent or malformed. */
export function bearerToken(req: Request): string | undefined {
  const match = /^Bearer ([0-9a-f]+)$/i.exec(req.get('authorization') ?? '');
  const token = match?.[1]?.toLowerCase();
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

/** The authenticated user for this request (set by requireAuth). */
export function currentUser(res: Response): AuthUser {
  return res.locals.user as AuthUser;
}

type Unauthorized = { reason: 'missing' | 'invalid' | 'expired'; error: string };

const MESSAGES: Record<Unauthorized['reason'], string> = {
  missing: 'Login required',
  invalid: 'Invalid session - please log in again',
  expired: 'Session expired (10-minute limit) - please log in again',
};

/** Express middleware: 401 {error, reason} unless a valid, unexpired session token is sent. */
export function requireAuth(ctx: AppContext) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const deny = async (reason: Unauthorized['reason'], actor = 'anonymous'): Promise<void> => {
      await ctx.audit.record({
        actor,
        action: reason === 'expired' ? 'session_ended' : 'auth_rejected',
        detail: `${req.method} ${req.baseUrl}${req.path}: ${reason === 'missing' ? 'no bearer token' : reason === 'invalid' ? 'unknown or revoked token' : 'session reached its 10-minute limit'}`,
        ip: req.ip,
        msgId: 'auth',
        severity: reason === 'expired' ? 'notice' : 'warning',
      });
      res.status(401).json({ error: MESSAGES[reason], reason } satisfies Unauthorized);
    };

    const token = bearerToken(req);
    if (!token) return deny('missing');

    const session = await ctx.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!session) return deny('invalid');
    if (session.expiresAt.getTime() <= Date.now()) {
      await ctx.prisma.session
        .delete({ where: { tokenHash: session.tokenHash } })
        .catch(() => undefined);
      return deny('expired', session.username);
    }
    const user = await ctx.prisma.user.findUnique({ where: { username: session.username } });
    if (!user) return deny('invalid');

    res.locals.user = {
      username: user.username,
      role: user.role,
      sessionExpiresAt: session.expiresAt,
    } satisfies AuthUser;
    next();
  };
}

/** Express middleware: 403 (and an audit WARNING) unless the user has the role. */
export function requireRole(ctx: AppContext, role: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = currentUser(res);
    if (user.role === role) return next();
    await ctx.audit.record({
      actor: user.username,
      action: 'forbidden',
      detail: `${user.role} tried ${req.method} ${req.baseUrl}${req.path} (requires ${role})`,
      ip: req.ip,
      msgId: 'auth',
    });
    res.status(403).json({ error: `This action requires the ${role} role` });
  };
}
