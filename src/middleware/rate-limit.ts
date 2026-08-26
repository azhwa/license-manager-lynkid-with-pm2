import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { jsonError } from '../utils/http';
import { sha256Hex } from '../utils/signature';

type RateLimitOptions = { scope: string; maxRequests: number; windowSeconds: number; useKv?: boolean };
const fallbackBuckets = new Map<string, { startedAt: number; count: number }>();

function clientIp(c: Parameters<MiddlewareHandler<AppContext>>[0]): string {
  return c.req.header('CF-Connecting-IP') || 'unknown';
}

export function createRateLimit(options: RateLimitOptions): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const identity = await sha256Hex(`${options.scope}:${clientIp(c)}`);
    const key = `rate-limit:${options.scope}:${identity}`;

    if (options.useKv !== false && c.env.KV_CACHE) {
      try {
        const count = Number(await c.env.KV_CACHE.get(key)) || 0;
        if (count >= options.maxRequests) return jsonError(c, 429, 'Too many requests. Try again later.');
        await c.env.KV_CACHE.put(key, String(count + 1), { expirationTtl: options.windowSeconds });
        await next();
        return;
      } catch {
        // KV is an optimization. Continue with the local fallback if it is unavailable or over quota.
      }
    }

    const now = Date.now();
    const bucket = fallbackBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= options.windowSeconds * 1000) fallbackBuckets.set(key, { startedAt: now, count: 1 });
    else if (bucket.count >= options.maxRequests) return jsonError(c, 429, 'Too many requests. Try again later.');
    else bucket.count += 1;
    if (fallbackBuckets.size > 10_000) fallbackBuckets.clear();
    await next();
  };
}

export const checkRateLimit = createRateLimit({ scope: 'license-check', maxRequests: 20, windowSeconds: 60, useKv: false });
