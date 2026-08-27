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

export function normalizeCustomerName(name: unknown): string | null {
  if (name === undefined || name === null || typeof name !== 'string') return null;
  const normalized = name.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 150) : null;
}

export function normalizePhone(phone: unknown): string | null {
  if (phone === undefined || phone === null || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

/** Parse ISO timestamps and SQLite CURRENT_TIMESTAMP values as UTC. */
export function parseTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const raw = value.trim();
  const sqliteUtc = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw);
  const parsed = new Date(sqliteUtc ? `${sqliteUtc[1]}T${sqliteUtc[2]}Z` : raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function zonedDateTimeToUtc(dateTime: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(dateTime);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const localGuess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond));
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(localGuess));
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const displayedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second), Number(millisecond));
    return new Date(localGuess - (displayedAsUtc - localGuess)).toISOString();
  } catch {
    return null;
  }
}

export function endOfDayInTimezone(dateOnly: string, timeZone = 'UTC'): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  return zonedDateTimeToUtc(`${dateOnly}T23:59:59.999`, timeZone) ?? `${dateOnly}T23:59:59.999Z`;
}

export function isoNow(): string { return new Date().toISOString(); }

export function daysRemaining(end: string | null, now = new Date()): number {
  if (!end) return 0;
  const parsed = parseTimestamp(end);
  return parsed ? Math.max(0, Math.ceil((parsed.getTime() - now.getTime()) / 86_400_000)) : 0;
}

export function isActive(end: string | null, status: string, now = new Date()): boolean {
  const parsed = parseTimestamp(end);
  return status === 'active' && parsed !== null && parsed.getTime() > now.getTime();
}
