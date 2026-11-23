import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Single-user access control.
 * - STUDIO_ACCESS_TOKEN set  → UI/API require the session cookie (set via /login) or `Authorization: Bearer`.
 * - not set                  → only loopback requests (127.0.0.1 / localhost) are accepted.
 * Workflow endpoints (/api/jobs/*) always require STUDIO_JOB_TOKEN (n8n → app).
 */
export const SESSION_COOKIE = 'studio_session';

export const tokenDigest = (token: string) => createHash('sha256').update(`studio:${token}`).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return LOOPBACK.has(h);
}

export interface AuthInput { host: string | null; cookie: string | undefined; authorization: string | null }

export function checkAccess({ host, cookie, authorization }: AuthInput): { ok: true } | { ok: false; reason: string } {
  const token = process.env.STUDIO_ACCESS_TOKEN;
  if (!token) {
    return isLoopbackHost(host) ? { ok: true } : { ok: false, reason: 'Ohne STUDIO_ACCESS_TOKEN nur über localhost erreichbar.' };
  }
  if (cookie && safeEqual(cookie, tokenDigest(token))) return { ok: true };
  if (authorization?.startsWith('Bearer ') && safeEqual(authorization.slice(7), token)) return { ok: true };
  return { ok: false, reason: 'Nicht angemeldet.' };
}

export function checkJobToken(authorization: string | null): { ok: true } | { ok: false; status: number; reason: string } {
  const token = process.env.STUDIO_JOB_TOKEN;
  if (!token) return { ok: false, status: 503, reason: 'STUDIO_JOB_TOKEN ist nicht konfiguriert – Workflow-Endpunkte sind deaktiviert.' };
  if (authorization?.startsWith('Bearer ') && safeEqual(authorization.slice(7), token)) return { ok: true };
  return { ok: false, status: 401, reason: 'Ungültiges Workflow-Token.' };
}

/**
 * CSRF guard for state-changing requests. Browsers send `Sec-Fetch-Site` and/or `Origin`;
 * a cross-site page (e.g. a malicious tab posting `text/plain` to 127.0.0.1) is rejected.
 * Non-browser clients (curl, tests) send neither and are governed by checkAccess alone.
 */
export function checkSameOrigin({ method, host, origin, secFetchSite }: { method: string; host: string | null; origin: string | null; secFetchSite: string | null }): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  if (origin) {
    if (origin === 'null' || !host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return true;
}
