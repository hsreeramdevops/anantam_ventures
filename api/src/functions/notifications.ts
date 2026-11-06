import { app } from '@azure/functions';
import { config } from '../config';
import { json, readJson, route } from '../http';
import { ValidationError } from '../schema';
import { getStore } from '../store';
import { applyUnsubscribe, verifyUnsubscribeToken } from '../notify/statusEmail';

/** Logged-in user's "email me when my bills change status" preference (on unless turned off). */
app.http('billEmailPref', {
  methods: ['GET', 'PUT'], authLevel: 'anonymous', route: 'notifications/email',
  handler: route(async (req, _ctx, user) => {
    const store = getStore();
    const doc = await store.get('user', user!.id);
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (typeof body.billStatusEmails !== 'boolean') throw new ValidationError('billStatusEmails must be true or false');
      if (doc) await store.put({ ...doc, billStatusEmails: body.billStatusEmails });
      return json({ billStatusEmails: body.billStatusEmails, email: user!.email });
    }
    return json({ billStatusEmails: doc?.billStatusEmails !== false, email: user!.email });
  }),
});

const page = (status: number, msg: string) => ({
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${config.appName}</title>`
    + `<div style="font-family:Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${config.appName}</h2><p>${msg}</p></div>`,
});

/** One-click unsubscribe from bill status emails (link in every email; signed token, no login). */
app.http('unsubscribe', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'public/unsubscribe',
  handler: async (req) => {
    try {
      const t = verifyUnsubscribeToken(req.query.get('t') ?? '');
      if (!t || !(await applyUnsubscribe(t))) return page(400, 'This unsubscribe link is invalid or has expired.');
      return page(200, t.kind === 'bill'
        ? 'Done. You will not get any more emails about this bill.'
        : 'Done. You will not get bill status emails any more. You can turn them back on under Notifications in the app.');
    } catch {
      return page(500, 'Something went wrong. Please try again later.');
    }
  },
});
