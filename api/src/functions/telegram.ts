import crypto from 'crypto';
import { app, HttpRequest, InvocationContext } from '@azure/functions';
import { config } from '../config';
import { HttpError, json, readJson, route } from '../http';
import {
  botUsername, createLinkCode, ensureWebhook, handleUpdate, sendMessage, subscribedEvents, telegramConfigured, TG_EVENTS,
  unlinkUser, validateSubs, webhookRegistered,
} from '../notify/telegram';
import { ensureMigrated, listAccessibleProjects } from '../projects';
import { getStore } from '../store';

app.http('telegramStatus', {
  methods: ['GET'], authLevel: 'anonymous', route: 'telegram/status',
  handler: route(async (_req, ctx, user) => {
    const configured = telegramConfigured();
    await ensureMigrated();
    const link = await getStore().get('tglink', user!.id);
    const projects = await listAccessibleProjects(user!);
    let username: string | null = null;
    let registered = false;
    if (configured) {
      try {
        username = await botUsername();
        // Lazily register the webhook the first time an admin opens the page after the token is set.
        registered = await webhookRegistered();
        if (!registered && user!.role === 'admin') registered = !!(await ensureWebhook());
      } catch (e: any) { ctx.warn(`telegram status: ${e.message}`); }
    }
    return json({
      configured,
      botUsername: username,
      webhookRegistered: registered,
      connected: !!link?.chatId,
      telegramUsername: link?.chatId ? link.tgUsername ?? null : null,
      events: TG_EVENTS,
      projects: projects.map((p) => ({ id: p.id, name: p.name, events: subscribedEvents(link, user!.role, p.id) })),
    });
  }),
});

app.http('telegramLink', {
  methods: ['POST'], authLevel: 'anonymous', route: 'telegram/link',
  handler: route(async (_req, _ctx, user) => {
    if (!telegramConfigured()) throw new HttpError(409, 'Telegram not configured yet');
    const username = await botUsername();
    const code = await createLinkCode(user!.id);
    return json({ url: `https://t.me/${username}?start=${code}`, expiresInMinutes: 15 });
  }),
});

app.http('telegramDisconnect', {
  methods: ['POST'], authLevel: 'anonymous', route: 'telegram/disconnect',
  handler: route(async (_req, _ctx, user) => {
    const chatId = await unlinkUser(user!.id);
    if (chatId && telegramConfigured()) await sendMessage(chatId, `Disconnected from ${config.appName}.`).catch(() => undefined);
    return json({ ok: true });
  }),
});

app.http('telegramSubscriptions', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'telegram/subscriptions',
  handler: route(async (req, _ctx, user) => {
    const body = await readJson(req);
    const allowed = new Set((await listAccessibleProjects(user!)).map((p) => p.id));
    const subs = validateSubs(body.subs, allowed);
    const store = getStore();
    const prev = await store.get('tglink', user!.id);
    await store.put({ ...(prev ?? { chatId: null }), id: user!.id, type: 'tglink', subs: { ...((prev?.subs as object) ?? {}), ...subs } });
    return json({ ok: true });
  }),
});

app.http('telegramRegisterWebhook', {
  methods: ['POST'], authLevel: 'anonymous', route: 'telegram/register-webhook',
  handler: route(async (_req, _ctx, user) => {
    if (user!.role !== 'admin') throw new HttpError(403, 'Admins only');
    if (!telegramConfigured()) throw new HttpError(409, 'Telegram not configured yet');
    return json({ ok: true, ...(await ensureWebhook(true)) });
  }),
});

function secretMatches(given: string): boolean {
  const expected = config.telegramWebhookSecret;
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Called by Telegram, not the browser: authenticated by the secret header instead of a session. */
app.http('telegramWebhook', {
  methods: ['POST'], authLevel: 'anonymous', route: 'telegram/webhook',
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
    if (!telegramConfigured()) return { status: 404 };
    if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token') ?? '')) return { status: 401 };
    try {
      await handleUpdate(await req.json());
    } catch (e: any) {
      ctx.warn(`telegram webhook: ${e.message}`);
    }
    // Always 200 for authenticated calls so Telegram doesn't retry a bad update forever.
    return { status: 200, jsonBody: { ok: true } };
  },
});
