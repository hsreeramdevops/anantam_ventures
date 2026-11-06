import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-se-'));

type H = (req: any, ctx: any) => Promise<any>;
const handlers = vi.hoisted(() => ({}) as Record<string, (req: any, ctx: any) => Promise<any>>);
vi.mock('@azure/functions', async (orig) => ({
  ...(await orig<typeof import('@azure/functions')>()),
  app: { http: (name: string, o: { handler: H }) => { handlers[name] = o.handler; } },
}));

import '../src/index';
import { createSessionToken, COOKIE } from '../src/auth/session';
import { devOutbox } from '../src/auth/email';
import { MAX_EMAILS_PER_BILL, unsubscribeToken, verifyUnsubscribeToken } from '../src/notify/statusEmail';
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


beforeEach(async () => {
  devOutbox.length = 0;
  setStore(new FileStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'av-sedb-')), 'db.json')));
  const s = getStore();
  for (const [id, role] of [['admin1', 'admin'], ['acct1', 'accountant'], ['eng1', 'engineer']]) {
    await s.put({ id, type: 'user', username: id, name: id, email: `${id}@x.com`, role, active: true });
  }
});

async function newProject(name: string, members: string[] = []) {
  const r = await call('projectCollection', { method: 'POST', user: 'admin1', body: { name, members } });
  expect(r.status).toBe(201);
  return r.body;
}

const pay = (user: string, project: string, id: string, body: Record<string, unknown>) =>
  call('billPayment', { method: 'POST', user, params: { id }, query: { project }, body });
const mails = (to: string) => devOutbox.filter((m) => m.to.includes(to));

const seen = new Set<string>();
async function payRequest(project: any, extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ payee: 'Ramesh', amount: '25400', purpose: 'weekly labour', mode: 'Bank',
    accountHolder: 'Ramesh K', accountNumber: '123456789012', ifsc: 'SBIN0001234', ...extra })) fd.append(k, v);
  const r = await call('payRequestSubmit', { method: 'POST', params: { token: project.payToken }, form: fd, ip: `7.7.7.${Math.floor(Math.random() * 250)}` });
  expect(r.status).toBe(201);
  const bills = (await call('entityCollection', { user: 'admin1', params: { type: 'bill' }, query: { project: project.id } })).body.items;
  const fresh = bills.find((b: any) => !seen.has(b.id));
  seen.add(fresh.id);
  return fresh;
}

describe('bill status emails', () => {
  it('emails a payment requester on each status change, masked, without an app link', async () => {
    const a = await newProject('Alpha');
    const bill = await payRequest(a, { requesterEmail: ' Req@Example.com ', requesterName: 'Site sup' });
    expect(bill.submitterEmail).toBe('req@example.com');
    expect(devOutbox).toHaveLength(0); // creation is not a status change

    await pay('admin1', a.id, bill.id, { amount: 5400, mode: 'UPI', note: 'UTR 998877' });
    let m = mails('req@example.com');
    expect(m).toHaveLength(1);
    expect(m[0].subject).toBe('Payment update: ₹25,400 to Ramesh is now Partially Paid');
    expect(m[0].text).toContain('Project: Alpha');
    expect(m[0].text).toContain('Balance: ₹20,000');
    expect(m[0].text).toContain('Reference / UTR: UTR 998877');
    expect(m[0].text).toContain('••••9012');
    expect(m[0].text).not.toContain('123456789012');
    expect(m[0].html).not.toContain('123456789012');
    expect(m[0].text).not.toContain('/bills?');
    expect(m[0].text).toContain('/api/public/unsubscribe?t=');

    await pay('admin1', a.id, bill.id, {});
    m = mails('req@example.com');
    expect(m).toHaveLength(2);
    expect(m[1].subject).toContain('is now Paid');

    // Reversal via edit is a status change too; a non-status edit is not.
    await call('entityItem', { method: 'PUT', user: 'admin1', params: { type: 'bill', id: bill.id }, query: { project: a.id }, body: { status: 'Unpaid' } });
    await call('entityItem', { method: 'PUT', user: 'admin1', params: { type: 'bill', id: bill.id }, query: { project: a.id }, body: { notes: 'x' } });
    expect(mails('req@example.com')).toHaveLength(3);
  });

  it('rejects a malformed requester email and sends nothing without one', async () => {
    const a = await newProject('Alpha');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ payee: 'R', amount: '10', mode: 'Cash', requesterEmail: 'not-an-email' })) fd.append(k, v);
    expect((await call('payRequestSubmit', { method: 'POST', params: { token: a.payToken }, form: fd, ip: '8.8.8.1' })).status).toBe(400);
    const bill = await payRequest(a);
    await pay('admin1', a.id, bill.id, {});
    expect(devOutbox).toHaveLength(0);
  });

  it('emails the team member who created the bill (with a link), never the person who changed it, honours opt-out', async () => {
    const a = await newProject('Alpha', ['acct1']);
    const r = await call('entityCollection', { method: 'POST', user: 'acct1', params: { type: 'bill' }, query: { project: a.id },
      body: { vendorName: 'Cement Co', total: 1000, category: 'Miscellaneous', status: 'Unpaid' } });
    expect(r.status).toBe(201);
    await pay('acct1', a.id, r.body.id, { amount: 100 }); // own change
    expect(devOutbox).toHaveLength(0);
    await pay('admin1', a.id, r.body.id, { amount: 100 }); // still Partially Paid: no status change, no email
    expect(devOutbox).toHaveLength(0);
    await call('entityItem', { method: 'PUT', user: 'admin1', params: { type: 'bill', id: r.body.id }, query: { project: a.id }, body: { status: 'Unpaid' } });
    const m = mails('acct1@x.com');
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain(`/bills?tab=all&project=${a.id}&open=${r.body.id}`);

    expect((await call('billEmailPref', { user: 'acct1' })).body.billStatusEmails).toBe(true);
    expect((await call('billEmailPref', { method: 'PUT', user: 'acct1', body: { billStatusEmails: false } })).body.billStatusEmails).toBe(false);
    await pay('admin1', a.id, r.body.id, {});
    expect(mails('acct1@x.com')).toHaveLength(1);
    expect((await call('billEmailPref', { user: 'acct1' })).body.billStatusEmails).toBe(false);
  });

  it('one-click unsubscribe uses a signed token and stops further emails for that bill', async () => {
    const a = await newProject('Alpha');
    const bill = await payRequest(a, { requesterEmail: 'req@example.com' });
    await pay('admin1', a.id, bill.id, { amount: 100 });
    const url = new URL(mails('req@example.com')[0].text.match(/https:\/\/\S+unsubscribe\?t=\S+/)![0]);
    const t = url.searchParams.get('t')!;
    expect(verifyUnsubscribeToken(t)).toEqual({ kind: 'bill', id: bill.id });
    expect(verifyUnsubscribeToken(t.slice(0, -2) + 'xx')).toBeNull();
    const forged = unsubscribeToken({ kind: 'bill', id: bill.id }).split('.')[0] + '.AAAA';
    const bad = await handlers.unsubscribe({ query: new URLSearchParams({ t: forged }), headers: new Headers() }, ctx);
    expect(bad.status).toBe(400);
    const ok = await handlers.unsubscribe({ query: new URLSearchParams({ t }), headers: new Headers() }, ctx);
    expect(ok.status).toBe(200);
    await pay('admin1', a.id, bill.id, {});
    expect(mails('req@example.com')).toHaveLength(1);
  });

  it('caps emails per bill', async () => {
    const a = await newProject('Alpha');
    const bill = await payRequest(a, { requesterEmail: 'req@example.com' });
    await getStore().put({ id: bill.id, type: 'billmail', count: MAX_EMAILS_PER_BILL });
    await pay('admin1', a.id, bill.id, {});
    expect(devOutbox).toHaveLength(0);
  });

  it('rate-limits per address', async () => {
    const a = await newProject('Alpha');
    let n = 0;
    for (let i = 0; i < 6; i++) {
      const bill = await payRequest(a, { requesterEmail: 'busy@example.com' });
      await pay('admin1', a.id, bill.id, { amount: 1 });
      await pay('admin1', a.id, bill.id, {});
      n += 2;
    }
    expect(n).toBe(12);
    expect(mails('busy@example.com')).toHaveLength(10);
  });

  it('guest upload stores the optional email', async () => {
    const a = await newProject('Alpha');
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 x')]), 'b.pdf');
    for (const [k, v] of Object.entries({ name: 'Guest', remarks: 'cement', email: 'g@example.com' })) fd.append(k, v);
    expect((await call('guestUpload', { method: 'POST', params: { token: a.shareToken }, form: fd, ip: '6.6.6.6' })).status).toBe(201);
    const [b] = (await call('entityCollection', { user: 'admin1', params: { type: 'bill' }, query: { project: a.id } })).body.items;
    expect(b.submitterEmail).toBe('g@example.com');
  });
});
