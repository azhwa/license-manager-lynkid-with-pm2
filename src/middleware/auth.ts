import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { verifyJwt } from '../utils/jwt';
import { jsonError } from '../utils/http';

export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  const authorization = c.req.header('Authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!c.env.JWT_SECRET) return jsonError(c, 500, 'JWT_SECRET is not configured');
  const claims = token ? await verifyJwt(token, c.env.JWT_SECRET) : null;
  if (!claims || claims.role !== 'admin') return jsonError(c, 401, 'Unauthorized');
  c.set('claims', claims);
  await next();
};
