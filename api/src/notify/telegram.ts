import crypto from 'crypto';
import { SessionUser } from '../auth/session';
import { config } from '../config';
import { canAccessProject } from '../projects';
import { ValidationError } from '../schema';
import { Doc, getStore } from '../store';

/**
 * Telegram notifications. Everything is inert until both TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET
 * are set. Per-user link + subscriptions live in a `tglink` doc (id = user id); one-time link codes in
 * `tgcode` docs (id = sha256(code), 15 min TTL).
 */
export const TG_EVENTS = [
  { key: 'payRequest', label: 'Payment requests' },
  { key: 'guestUpload', label: 'Guest bill uploads' },
  { key: 'billAdded', label: 'Bills added by team' },
  { key: 'billPaid', label: 'Bills paid / part-paid' },
  { key: 'digest', label: 'Daily digest' },
] as const;
export type TgEvent = (typeof TG_EVENTS)[number]['key'];
const EVENT_KEYS = TG_EVENTS.map((e) => e.key) as string[];
/** Admins get these for every project until they change their choices; everyone else starts with nothing. */
export const ADMIN_DEFAULT_EVENTS: TgEvent[] = ['payRequest', 'guestUpload'];
export const LINK_CODE_TTL_S = 15 * 60;
const TIMEOUT_MS = 5000;

export const telegramConfigured = () => !!config.telegramBotToken && !!config.telegramWebhookSecret;

export async function tgCall<T = any>(method: string, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
  // Never include the URL (it contains the bot token) in errors.
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ''}`.trim());
  return data.result as T;
}

let botCache: { token: string; username: string } | null = null;
export async function botUsername(): Promise<string | null> {
  if (!telegramConfigured()) return null;
  if (botCache?.token === config.telegramBotToken) return botCache.username;
  const me = await tgCall<{ username: string }>('getMe', {});
  botCache = { token: config.telegramBotToken, username: me.username };
  return me.username;
}
export const resetTelegramCache = () => { botCache = null; };

export const sendMessage = (chatId: string | number, text: string) =>
  tgCall('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });

const webhookUrl = () => `${config.publicUrl}/api/telegram/webhook`;
const fingerprint = () => crypto.createHash('sha256')
  .update(`${config.telegramBotToken}|${config.telegramWebhookSecret}|${webhookUrl()}`).digest('hex');

/** Registers the webhook with Telegram (with the secret header); skipped if already done for this token/secret/URL. */
export async function ensureWebhook(force = false): Promise<{ url: string; registered: boolean }> {
  if (!telegramConfigured()) throw new ValidationError('Telegram not configured yet');
  const store = getStore();
  const meta = await store.get('meta', 'tg-webhook');
  if (!force && meta?.fingerprint === fingerprint()) return { url: webhookUrl(), registered: false };
  await tgCall('setWebhook', {
    url: webhookUrl(), secret_token: config.telegramWebhookSecret, allowed_updates: ['message'], drop_pending_updates: true,
  });
  await store.put({ id: 'tg-webhook', type: 'meta', fingerprint: fingerprint(), at: new Date().toISOString() });
  return { url: webhookUrl(), registered: true };
}
export const webhookRegistered = async () => (await getStore().get('meta', 'tg-webhook'))?.fingerprint === fingerprint();

export function subscribedEvents(link: Doc | null, role: string, projectId: string): string[] {
  const subs = (link?.subs ?? {}) as Record<string, string[]>;
  if (Array.isArray(subs[projectId])) return subs[projectId];
  return role === 'admin' ? [...ADMIN_DEFAULT_EVENTS] : [];
}

export function validateSubs(input: unknown, allowedProjects: Set<string>): Record<string, string[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('subs must be an object');
  const out: Record<string, string[]> = {};
  for (const [pid, events] of Object.entries(input as Record<string, unknown>)) {
    if (!allowedProjects.has(pid)) throw new ValidationError('You cannot subscribe to that project');
    if (!Array.isArray(events) || events.some((e) => !EVENT_KEYS.includes(String(e)))) throw new ValidationError('Unknown notification type');
    out[pid] = [...new Set(events.map(String))];
  }
  return out;
}

/** One-time code for `t.me/<bot>?start=<code>`; only its hash is stored. */
export async function createLinkCode(userId: string): Promise<string> {
  const code = crypto.randomBytes(18).toString('base64url');
  const id = crypto.createHash('sha256').update(code).digest('hex');
  await getStore().put({ id, type: 'tgcode', userId, expiresAt: Date.now() + LINK_CODE_TTL_S * 1000 }, LINK_CODE_TTL_S);
  return code;
}

async function consumeLinkCode(code: string): Promise<string | null> {
  const store = getStore();
  const id = crypto.createHash('sha256').update(code).digest('hex');
  const doc = await store.get('tgcode', id);
  if (!doc) return null;
  await store.delete('tgcode', id).catch(() => undefined);
  return Number(doc.expiresAt) > Date.now() ? String(doc.userId) : null;
}

export async function unlinkUser(userId: string) {
  const store = getStore();
  const link = await store.get('tglink', userId);
  if (link?.chatId) await store.put({ ...link, chatId: null, tgUsername: null, unlinkedAt: new Date().toISOString() });
  return link?.chatId ? String(link.chatId) : null;
}

const reply = (chatId: number | string, text: string) => sendMessage(chatId, text).catch((e) => console.warn(`telegram reply failed: ${e.message}`));

/** Handles one webhook update: `/start <code>` links the chat, `/stop` unlinks it. */
export async function handleUpdate(update: any): Promise<void> {
  const msg = update?.message;
  const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  const chatId = msg?.chat?.id;
  if (!text || chatId === undefined || msg.chat.type !== 'private') return;
  const store = getStore();
  const app = config.appName;

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
  if (start) {
    if (!start[1]) { await reply(chatId, `To connect, open Notifications in the ${app} app and tap "Connect Telegram".`); return; }
    const userId = /^[A-Za-z0-9_-]{16,64}$/.test(start[1]) ? await consumeLinkCode(start[1]) : null;
    const user = userId ? await store.get('user', userId) : null;
    if (!user || user.active === false) {
      await reply(chatId, `This connect link has expired or was already used. Open Notifications in the ${app} app and tap "Connect Telegram" again.`);
      return;
    }
    // One Telegram chat belongs to one app user.
    for (const l of await store.list('tglink')) {
      if (l.id !== user.id && String(l.chatId ?? '') === String(chatId)) await store.put({ ...l, chatId: null, tgUsername: null });
    }
    const prev = await store.get('tglink', user.id);
    await store.put({
      ...(prev ?? { subs: {} }), id: user.id, type: 'tglink', chatId: String(chatId),
      tgUsername: msg.from?.username ?? null, linkedAt: new Date().toISOString(),
    });
    await reply(chatId, `✅ Connected to ${app} as ${String(user.name ?? user.username)}.\nChoose which alerts you get under Notifications in the app. Send /stop to disconnect.`);
    return;
  }
  if (/^\/stop(?:@\w+)?$/.test(text)) {
    let found = false;
    for (const l of await store.list('tglink')) {
      if (String(l.chatId ?? '') === String(chatId)) { await unlinkUser(l.id); found = true; }
    }
    await reply(chatId, found ? `Disconnected. You will no longer get ${app} alerts here.` : 'This chat is not connected.');
    return;
  }
  await reply(chatId, 'Commands: /stop to disconnect. Manage alerts under Notifications in the app.');
}

/**
 * Sends `text` to everyone subscribed to `event` for the project who can access it, except `actorId`.
 * Never throws; failures are logged. Returns the number of messages delivered.
 */
export async function notify(event: TgEvent, projectId: string, text: string, actorId: string | null): Promise<number> {
  if (!telegramConfigured()) return 0;
  try {
    const store = getStore();
    const project = await store.get('project', projectId);
    if (!project) return 0;
    const users = new Map((await store.list('user')).map((u) => [u.id, u]));
    const targets = (await store.list('tglink')).filter((l) => {
      const u = users.get(l.id);
      return l.chatId && l.id !== actorId && u && u.active !== false
        && canAccessProject({ id: u.id, role: u.role } as SessionUser, project)
        && subscribedEvents(l, String(u.role), projectId).includes(event);
    });
    const res = await Promise.allSettled(targets.map((l) => sendMessage(String(l.chatId), text)));
    res.forEach((r) => { if (r.status === 'rejected') console.warn(`telegram notify (${event}) failed: ${r.reason?.message ?? r.reason}`); });
    return res.filter((r) => r.status === 'fulfilled').length;
  } catch (e: any) {
    console.warn(`telegram notify (${event}) failed: ${e.message}`);
    return 0;
  }
}

const inr = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const clip = (v: unknown, n = 200) => { const s = String(v ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** Payee details safe for chat: never the full account number or the QR image. */
export function payToSummary(p: any): string | null {
  if (!p || typeof p !== 'object') return null;
  if (p.mode === 'UPI') return `UPI ${String(p.upi ?? '')}`.trim();
  if (p.mode === 'QR') return 'QR code (open the app to view)';
  if (p.mode === 'Bank') {
    const last4 = String(p.accountNumber ?? '').slice(-4);
    return `Bank a/c ••••${last4}${p.ifsc ? ` · IFSC ${String(p.ifsc)}` : ''}`;
  }
  if (p.mode === 'Cash') return 'Cash';
  return null;
}

export const billLink = (bill: Doc) =>
  `${config.publicUrl}/bills/${encodeURIComponent(bill.id)}?project=${encodeURIComponent(String(bill.projectId ?? ''))}`;

export function billMessage(event: TgEvent, bill: Doc, projectName: string, actorName?: string | null): string {
  const lines: string[] = [];
  if (event === 'payRequest') lines.push(`💸 New payment request · ${projectName}`, `Pay to: ${clip(bill.payee ?? bill.vendorName, 100)}`);
  else {
    lines.push(event === 'guestUpload' ? `🧾 New guest bill · ${projectName}`
      : event === 'billAdded' ? `🧾 New bill · ${projectName}`
        : `${bill.status === 'Paid' ? '✅ Bill paid' : '🟡 Bill part-paid'} · ${projectName}`);
    if (bill.payee) lines.push(`Pay to: ${clip(bill.payee, 100)}`);
    if (bill.vendorName && bill.vendorName !== bill.payee) lines.push(`Vendor: ${clip(bill.vendorName, 100)}`);
  }
  if (event === 'billPaid') {
    const balance = Math.max(0, Number(bill.total ?? 0) - Number(bill.paidAmount ?? 0));
    lines.push(`Paid: ${inr(bill.paidAmount)} of ${inr(bill.total)}${balance > 0 ? ` (balance ${inr(balance)})` : ''}`);
    if (bill.paymentMode) lines.push(`Mode: ${String(bill.paymentMode)}`);
  } else {
    lines.push(`Amount: ${inr(bill.total)}`);
    const mode = payToSummary(bill.payTo);
    if (mode) lines.push(`Mode: ${mode}`);
  }
  if (bill.remarks) lines.push(`${event === 'payRequest' ? 'Purpose' : 'Remarks'}: ${clip(bill.remarks)}`);
  if (bill.category && event !== 'billPaid') lines.push(`Category: ${String(bill.category)}`);
  const by = bill.submitterName ?? actorName;
  if (by) lines.push(`By: ${clip(by, 100)}${bill.submitterPhone && event !== 'billPaid' ? ` (${String(bill.submitterPhone)})` : ''}`);
  lines.push(billLink(bill));
  return lines.join('\n');
}

const projectName = async (id: unknown) => String((await getStore().get('project', String(id ?? '')))?.name ?? 'Project');

/** Hook for new bills: picks the event from the bill's source. */
export async function notifyBillCreated(actor: { id: string; name?: string }, bill: Doc) {
  if (!telegramConfigured() || !bill.projectId) return;
  const event: TgEvent = bill.source === 'payment-request' ? 'payRequest' : bill.source === 'guest' ? 'guestUpload' : 'billAdded';
  const actorName = actor.id === 'guest' ? null : actor.name;
  await notify(event, String(bill.projectId), billMessage(event, bill, await projectName(bill.projectId), actorName), actor.id);
}

/** Hook for bill updates: notifies when the status moves to Paid or Partially Paid (or more is paid). */
export async function notifyBillUpdated(actor: { id: string; name?: string }, prev: Doc, bill: Doc) {
  if (!telegramConfigured() || !bill.projectId) return;
  const paidNow = bill.status === 'Paid' || bill.status === 'Partially Paid';
  const changed = bill.status !== prev.status || Number(bill.paidAmount ?? 0) !== Number(prev.paidAmount ?? 0);
  if (!paidNow || !changed) return;
  await notify('billPaid', String(bill.projectId), billMessage('billPaid', bill, await projectName(bill.projectId), actor.name), actor.id);
}
