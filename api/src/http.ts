import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { currentUser, SessionUser } from './auth/session';
import { ValidationError } from './schema';
import { RateLimitError } from './auth/otp';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const json = (body: unknown, status = 200, extra: Partial<HttpResponseInit> = {}): HttpResponseInit => ({
  status, jsonBody: body, headers: { 'Cache-Control': 'no-store' }, ...extra,
});

type Handler = (req: HttpRequest, ctx: InvocationContext, user: SessionUser | null) => Promise<HttpResponseInit>;

/**
 * Wraps a handler with auth + error mapping. Mutating requests must carry `X-Requested-With`,
 * which a cross-site form cannot set (CSRF defence on top of SameSite=Strict cookies).
 */
export function route(handler: Handler, opts: { auth?: boolean } = { auth: true }) {
  return async (req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.get('x-requested-with')) {
        throw new HttpError(403, 'Missing X-Requested-With header');
      }
      const user = opts.auth === false ? null : await currentUser(req);
      if (opts.auth !== false && !user) throw new HttpError(401, 'Not signed in');
      return await handler(req, ctx, user);
    } catch (e: any) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      if (e instanceof RateLimitError) return json({ error: e.message }, 429);
      ctx.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  };
}

export async function readJson(req: HttpRequest): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new HttpError(400, 'Expected a JSON object body');
}
