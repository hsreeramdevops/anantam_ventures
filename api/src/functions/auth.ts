import { app } from '@azure/functions';
import { requestOtp, verifyOtp } from '../auth/otp';
import { createSessionToken, sessionCookie } from '../auth/session';
import { audit } from '../service';
import { json, readJson, route } from '../http';
import { isOwner } from '../users';

app.http('authRequestOtp', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/request-otp',
  handler: route(async (req) => {
    const { identifier } = await readJson(req);
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 200) {
      return json({ error: 'Enter your username or email' }, 400);
    }
    await requestOtp(identifier);
    return json({ ok: true, message: 'If this account exists, a 6-digit code has been emailed to it.' });
  }, { auth: false }),
});

app.http('authVerifyOtp', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/verify-otp',
  handler: route(async (req) => {
    const { identifier, code } = await readJson(req);
    if (typeof identifier !== 'string' || typeof code !== 'string') return json({ error: 'Invalid request' }, 400);
    const user = await verifyOtp(identifier, code);
    if (!user) return json({ error: 'Invalid or expired code' }, 401);
    await audit({ username: String(user.username) }, 'login', 'user', user.id, `Login ${user.username}`);
    const token = await createSessionToken(user.id);
    return json({ ok: true }, 200, { cookies: [sessionCookie(token)] });
  }, { auth: false }),
});

app.http('authLogout', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/logout',
  handler: route(async () => json({ ok: true }, 200, { cookies: [sessionCookie(null)] }), { auth: false }),
});

app.http('authMe', {
  methods: ['GET'], authLevel: 'anonymous', route: 'auth/me',
  handler: route(async (_req, _ctx, user) => json({ user: { ...user!, isOwner: isOwner(user) } })),
});
