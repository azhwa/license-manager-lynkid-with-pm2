import type { Context } from 'hono';
import type { AppContext } from '../types';

export function jsonError(c: Context<AppContext>, status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500, message: string, details?: unknown) {
  return c.json({ error: message, ...(details ? { details } : {}) }, status);
}

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

export function isoNow(): string { return new Date().toISOString(); }

export function daysRemaining(end: string | null, now = new Date()): number {
  if (!end) return 0;
  return Math.max(0, Math.ceil((new Date(end).getTime() - now.getTime()) / 86_400_000));
}

export function isActive(end: string | null, status: string, now = new Date()): boolean {
  return status === 'active' && Boolean(end) && new Date(end as string).getTime() > now.getTime();
}
