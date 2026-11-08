// Talks to the server. Every call goes over HTTPS with the session token in the
// Authorization header. A 401 from the server logs the user out of the app.

export type Role = 'admin' | 'viewer';

export type Session = {
  serverUrl: string;
  token: string;
  username: string;
  role: Role;
};

export type OtpChallenge = { serverUrl: string; challengeId: string; sentTo: string; username: string };

export type Reading = {
  id: number;
  device_id: string;
  ts: number;
  moisture: number;
  pump_on: number;
  water_ml: number;
};

export type DeviceConfig = { id: string; low: number; high: number };

export type IntegrityResult = { ok: boolean; checked: number; brokenAt?: number; reason?: string };

export type AuditEntry = { id: number; at: number; actor: string; action: string; detail: string | null; ip: string | null };

export type Alert = { id: number; at: number; sim_time: number | null; type: 'sprinkler_on' | 'motion' | 'tamper'; level: 'info' | 'warning' | 'critical'; message: string };

export class ApiError extends Error {
  constructor(message: string, public status: number, public restart = false) {
    super(message);
  }
}

const TIMEOUT_MS = 10_000;

// Only allow https:// so the password and token are never sent in plain text.
export function normaliseServerUrl(input: string): string {
  const url = input.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+(:\d+)?$/i.test(url)) {
    throw new Error('Server URL must start with https:// (for example https://192.168.0.10:8443)');
  }
  return url;
}

type CallInit = RequestInit & { token?: string; poll?: boolean };

async function call<T>(serverUrl: string, path: string, init: CallInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client': 'mobile',
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  // Background refreshes don't count as activity, so the 10-minute idle logout still works.
  if (init.poll) headers['X-Activity'] = 'poll';
  try {
    const res = await fetch(serverUrl + path, { method: init.method, body: init.body, headers, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data as { error?: string; restart?: boolean };
      throw new ApiError(d.error || `Request failed (${res.status})`, res.status, !!d.restart);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw new ApiError('Server did not respond. Check the URL and your Wi-Fi.', 0);
    throw new ApiError('Could not reach the server securely. Check the URL and that the certificate is trusted.', 0);
  } finally {
    clearTimeout(timer);
  }
}

// Step 1: password. The server emails a 6-digit code.
export async function startLogin(serverUrl: string, username: string, password: string): Promise<OtpChallenge> {
  const url = normaliseServerUrl(serverUrl);
  const r = await call<{ challengeId: string; sentTo: string }>(url, '/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return { serverUrl: url, challengeId: r.challengeId, sentTo: r.sentTo, username };
}

// Step 2: the code from the email.
export async function verifyOtp(ch: OtpChallenge, code: string): Promise<Session> {
  const r = await call<{ username: string; role: Role; token: string }>(ch.serverUrl, '/api/login/otp', {
    method: 'POST',
    body: JSON.stringify({ challengeId: ch.challengeId, code }),
  });
  if (!/^[a-f0-9]{64}$/.test(r.token)) throw new ApiError('Unexpected login response', 0);
  return { serverUrl: ch.serverUrl, token: r.token, username: r.username, role: r.role };
}

export function client(session: Session, onUnauthorized: (message: string) => void) {
  const authed = async <T,>(path: string, init: CallInit = {}): Promise<T> => {
    try {
      return await call<T>(session.serverUrl, path, { ...init, token: session.token });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized(e.message);
      throw e;
    }
  };
  return {
    readings: (limit = 150) => authed<{ readings: Reading[]; totals: { n: number; water: number } }>(`/api/readings?limit=${limit}`, { poll: true }),
    config: () => authed<DeviceConfig[]>('/api/config', { poll: true }),
    alerts: (since = 0) => authed<{ alerts: Alert[]; lastMotionAt: number | null }>(`/api/alerts?since=${since}`, { poll: true }),
    audit: () => authed<AuditEntry[]>('/api/audit', { poll: true }),
    setConfig: (deviceId: string, low: number, high: number) =>
      authed<{ ok: true }>('/api/config', { method: 'PUT', body: JSON.stringify({ deviceId, low, high }) }),
    verify: () => authed<IntegrityResult>('/api/verify'),
    backup: () => authed<{ file: string; records: number }>('/api/backup', { method: 'POST' }),
    logout: () => authed<{ ok: true }>('/api/logout', { method: 'POST' }),
  };
}

export type Client = ReturnType<typeof client>;
