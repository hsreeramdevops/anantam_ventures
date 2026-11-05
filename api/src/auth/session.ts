import { HttpRequest } from '@azure/functions';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config';
import { Role } from '../schema';
import { getStore } from '../store';

export const COOKIE = 'av_session';
export const SESSION_HOURS = 12;

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: Role;
}

const key = () => new TextEncoder().encode(config.jwtSecret);

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuedAt().setExpirationTime(`${SESSION_HOURS}h`).sign(key());
}

export function sessionCookie(token: string | null) {
  return {
    name: COOKIE,
    value: token ?? '',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: token ? SESSION_HOURS * 3600 : 0,
  };
}

function readCookie(req: HttpRequest, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Validates the session cookie and reloads the user, so deactivation / role changes apply immediately. */
export async function currentUser(req: HttpRequest): Promise<SessionUser | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
    const u = payload.sub ? await getStore().get('user', payload.sub) : null;
    if (!u || u.active === false) return null;
    return { id: u.id, username: String(u.username), name: String(u.name), email: String(u.email), role: u.role as Role };
  } catch {
    return null;
  }
}
