import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-tg-'));

type H = (req: any, ctx: any) => Promise<any>;
const handlers = vi.hoisted(() => ({}) as Record<string, (req: any, ctx: any) => Promise<any>>);
vi.mock('@azure/functions', async (orig) => ({
  ...(await orig<typeof import('@azure/functions')>()),
  app: { http: (name: string, o: { handler: H }) => { handlers[name] = o.handler; } },
}));

import '../src/index';
import { createSessionToken, COOKIE } from '../src/auth/session';
import { billMessage, payToSummary, resetTelegramCache } from '../src/notify/telegram';
import { setStore, getStore } from '../src/store';
import { FileStore } from '../src/store/fileStore';

const ctx = { warn: () => undefined, error: () => undefined, log: () => undefined };
const SECRET = 'whsecret-0123456789';

async function call(name: string, opts: {
  method?: string; user?: string; params?: Record<string, string>; query?: Record<string, string>;
  body?: unknown; form?: FormData; ip?: string; headers?: Record<string, string>; noXrw?: boolean;
} = {}) {
  const headers = new Headers(opts.noXrw ? {} : { 'x-requested-with': 'fetch' });
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  if (opts.user) headers.set('cookie', `${COOKIE}=${await createSessionToken(opts.user)}`);
  if (opts.ip) headers.set('x-forwarded-for', opts.ip);
  const res = await handlers[name]({
    method: opts.method ?? 'GET', headers, params: opts.params ?? {}, query: new URLSearchParams(opts.query ?? {}),
    json: async () => opts.body, formData: async () => opts.form,
  }, ctx);
  return { status: res.status as number, body: res.jsonBody as any };
}

let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith('/sendMessage'))
  .map(([, init]) => JSON.parse(init.body));
const okReply = (result: unknown = true) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

function configure() {
  process.env.TELEGRAM_BOT_TOKEN = '123:testtoken';
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
}

beforeEach(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  resetTelegramCache();
  fetchMock = vi.fn(async (url: string) => okReply(String(url).endsWith('/getMe') ? { username: 'anantam_bot' } : true));
  vi.stubGlobal('fetch', fetchMock);
  setStore(new FileStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'av-tgdb-')), 'db.json')));
  const s = getStore();
  for (const [id, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['eng1', 'engineer'], ['eng2', 'engineer']]) {
    await s.put({ id, type: 'user', username: id, name: id, email: `${id}@x.com`, role, active: true });
  }
});
afterEach(() => vi.unstubAllGlobals());

async function newProject(name: string, members: string[] = []) {
  const r = await call('projectCollection', { method: 'POST', user: 'admin1', body: { name, members } });
  expect(r.status).toBe(201);
  return r.body;
}

const webhook = (text: string, chatId = 555, secret = SECRET) => call('telegramWebhook', {
  method: 'POST', noXrw: true, headers: { 'x-telegram-bot-api-secret-token': secret },
  body: { update_id: 1, message: { text, chat: { id: chatId, type: 'private' }, from: { username: 'tguser' } } },
});

async function connect(user: string, chatId: number) {
  const r = await call('telegramLink', { method: 'POST', user });
  expect(r.status).toBe(200);
  const code = new URL(r.body.url).searchParams.get('start')!;
  expect((await webhook(`/start ${code}`, chatId)).status).toBe(200);
  return code;
}

describe('telegram (unconfigured)', () => {
  it('is inert: status says not configured, link refused, webhook 404, no fetches', async () => {
    const p = await newProject('Alpha');
    const st = await call('telegramStatus', { user: 'admin1' });
    expect(st.body).toMatchObject({ configured: false, connected: false, botUsername: null });
    expect(st.body.projects.find((x: any) => x.id === p.id)).toEqual({ id: p.id, name: 'Alpha', events: ['payRequest', 'guestUpload'] });
    expect((await call('telegramLink', { method: 'POST', user: 'admin1' })).status).toBe(409);
    expect((await webhook('/stop')).status).toBe(404);
    await call('entityCollection', { method: 'POST', user: 'eng1', params: { type: 'bill' }, query: { project: p.id }, body: { payee: 'Test payee', vendorName: 'X', total: 10, category: 'Miscellaneous' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('telegram linking', () => {
  beforeEach(configure);

  it('rejects webhook calls without the right secret', async () => {
    expect((await webhook('/stop', 1, 'wrong')).status).toBe(401);
    expect((await webhook('/stop', 1, '')).status).toBe(401);
  });

  it('links with a single-use code, unlinks with /stop', async () => {
    const code = await connect('eng1', 777);
    expect((await getStore().get('tglink', 'eng1'))?.chatId).toBe('777');
    expect(sent().at(-1)).toMatchObject({ chat_id: 777 });
    expect(sent().at(-1).text).toContain('Connected');
    expect((await call('telegramStatus', { user: 'eng1' })).body).toMatchObject({ configured: true, connected: true, botUsername: 'anantam_bot' });

    await webhook(`/start ${code}`, 888);
    expect(sent().at(-1).text).toContain('expired');
    expect((await getStore().get('tglink', 'eng1'))?.chatId).toBe('777');

    await webhook('/stop', 777);
    expect((await getStore().get('tglink', 'eng1'))?.chatId).toBeNull();
    expect(sent().at(-1).text).toContain('Disconnected');
  });

  it('rejects expired codes', async () => {
    const r = await call('telegramLink', { method: 'POST', user: 'eng1' });
    const code = new URL(r.body.url).searchParams.get('start')!;
    const [tgcode] = await getStore().list('tgcode');
    await getStore().put({ ...tgcode, expiresAt: Date.now() - 1 });
    await webhook(`/start ${code}`, 999);
    expect((await getStore().get('tglink', 'eng1'))?.chatId ?? null).toBeNull();
  });

  it('disconnect button unlinks', async () => {
    await connect('eng1', 777);
    expect((await call('telegramDisconnect', { method: 'POST', user: 'eng1' })).status).toBe(200);
    expect((await call('telegramStatus', { user: 'eng1' })).body.connected).toBe(false);
  });

  it('registers the webhook with the secret (admin only) and lazily on admin status load', async () => {
    expect((await call('telegramRegisterWebhook', { method: 'POST', user: 'eng1' })).status).toBe(403);
    const st = await call('telegramStatus', { user: 'admin1' });
    expect(st.body.webhookRegistered).toBe(true);
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/setWebhook'))!;
    expect(JSON.parse(init.body)).toMatchObject({ url: 'https://www.anantamventures.com/api/telegram/webhook', secret_token: SECRET });
    fetchMock.mockClear();
    await call('telegramStatus', { user: 'admin1' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/setWebhook'))).toBe(false);
    expect((await call('telegramRegisterWebhook', { method: 'POST', user: 'admin1' })).status).toBe(200);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/setWebhook'))).toBe(true);
  });

  it('only allows subscribing to accessible projects and known events', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await newProject('Beta');
    expect((await call('telegramSubscriptions', { method: 'PUT', user: 'eng1', body: { subs: { [b.id]: ['billPaid'] } } })).status).toBe(400);
    expect((await call('telegramSubscriptions', { method: 'PUT', user: 'eng1', body: { subs: { [a.id]: ['nope'] } } })).status).toBe(400);
    expect((await call('telegramSubscriptions', { method: 'PUT', user: 'eng1', body: { subs: { [a.id]: ['billPaid'] } } })).status).toBe(200);
    const st = await call('telegramStatus', { user: 'eng1' });
    expect(st.body.projects.find((x: any) => x.id === a.id)).toEqual({ id: a.id, name: 'Alpha', events: ['billPaid'] });
    expect(st.body.projects.some((x: any) => x.id === b.id)).toBe(false);
  });
});

describe('telegram notifications', () => {
  beforeEach(configure);

  it('notifies subscribers with access, skipping the actor and non-subscribers', async () => {
    const a = await newProject('Alpha', ['eng1', 'eng2']);
    await connect('admin1', 101); // admin default: payRequest + guestUpload
    await connect('admin2', 102);
    await connect('eng1', 201);
    await connect('eng2', 202); // engineers default to nothing
    await call('telegramSubscriptions', { method: 'PUT', user: 'eng1', body: { subs: { [a.id]: ['billAdded', 'billPaid'] } } });
    await call('telegramSubscriptions', { method: 'PUT', user: 'admin2', body: { subs: { [a.id]: ['billAdded'] } } });
    fetchMock.mockClear();

    const r = await call('entityCollection', { method: 'POST', user: 'eng1', params: { type: 'bill' }, query: { project: a.id }, body: { payee: 'Test payee', vendorName: 'Cement Co', total: 5000, status: 'Unpaid', category: 'Miscellaneous' } });
    expect(r.status).toBe(201);
    expect(sent().map((m) => m.chat_id)).toEqual(['102']); // eng1 is the actor; admin1 isn't subscribed to billAdded
    expect(sent()[0].text).toContain('Cement Co');
    expect(sent()[0].text).toContain('₹5,000');
    expect(sent()[0].text).toContain(`https://www.anantamventures.com/bills/${r.body.id}?project=${a.id}`);

    fetchMock.mockClear();
    await call('billPayment', { method: 'POST', user: 'admin1', params: { id: r.body.id }, query: { project: a.id }, body: { amount: 2000, mode: 'UPI' } });
    expect(sent().map((m) => m.chat_id)).toEqual(['201']);
    expect(sent()[0].text).toContain('part-paid');
    expect(sent()[0].text).toContain('balance ₹3,000');
  });

  it('does not notify users without project access', async () => {
    const a = await newProject('Alpha');
    await connect('eng1', 201);
    // Subscription saved while eng1 had access; access later removed.
    await getStore().put({ ...(await getStore().get('tglink', 'eng1'))!, subs: { [a.id]: ['billAdded'] } });
    fetchMock.mockClear();
    await call('entityCollection', { method: 'POST', user: 'admin1', params: { type: 'bill' }, query: { project: a.id }, body: { payee: 'Test payee', vendorName: 'X', total: 1, category: 'Miscellaneous' } });
    expect(sent()).toHaveLength(0);
  });

  it('payment request alerts admins and masks the account number; a Telegram failure does not break the submit', async () => {
    const a = await newProject('Alpha');
    await connect('admin1', 101);
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => { throw new Error('network down'); });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ payee: 'Ramesh', amount: '25400', purpose: 'weekly labour', mode: 'Bank', accountHolder: 'Ramesh K', accountNumber: '123456789012', ifsc: 'SBIN0001234' })) fd.append(k, v);
    const r = await call('payRequestSubmit', { method: 'POST', params: { token: a.shareToken }, form: fd, ip: '9.9.9.9' });
    expect(r.status).toBe(201);
    const msg = sent()[0];
    expect(msg.chat_id).toBe('101');
    expect(msg.text).toContain('payment request');
    expect(msg.text).toContain('₹25,400');
    expect(msg.text).toContain('••••9012');
    expect(msg.text).not.toContain('123456789012');
  });
});

describe('message helpers', () => {
  it('never exposes full bank numbers or QR images', () => {
    expect(payToSummary({ mode: 'Bank', accountNumber: '0001112223334444', ifsc: 'HDFC0000001' })).toBe('Bank a/c ••••4444 · IFSC HDFC0000001');
    expect(payToSummary({ mode: 'QR', qrFile: { name: 'x.png' } })).toBe('QR code (open the app to view)');
    expect(payToSummary({ mode: 'UPI', upi: 'a@okhdfc' })).toBe('UPI a@okhdfc');
    const t = billMessage('guestUpload', { id: 'b1', type: 'bill', projectId: 'p', vendorName: 'V', total: 10, remarks: 'r', submitterName: 'Guest G' }, 'Alpha');
    expect(t).toContain('guest bill');
    expect(t).toContain('By: Guest G');
  });
});
