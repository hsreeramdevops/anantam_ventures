import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-pr-'));

type H = (req: any, ctx: any) => Promise<any>;
const handlers = vi.hoisted(() => ({}) as Record<string, (req: any, ctx: any) => Promise<any>>);
vi.mock('@azure/functions', async (orig) => ({
  ...(await orig<typeof import('@azure/functions')>()),
  app: { http: (name: string, o: { handler: H }) => { handlers[name] = o.handler; } },
}));

import '../src/index';
import { createSessionToken, COOKIE } from '../src/auth/session';
import { blobProjectId } from '../src/files/blob';
import { normalizeMobile, parseAmount, readPayRequestFields } from '../src/functions/payrequest';
import { setStore, getStore } from '../src/store';
import { FileStore } from '../src/store/fileStore';

const ctx = { warn: () => undefined, error: () => undefined, log: () => undefined };
const PDF = Buffer.from('%PDF-1.4 test bill cement');

async function call(name: string, opts: {
  method?: string; user?: string; params?: Record<string, string>; query?: Record<string, string>;
  body?: unknown; form?: FormData; ip?: string;
} = {}) {
  const headers = new Headers({ 'x-requested-with': 'fetch' });
  if (opts.user) headers.set('cookie', `${COOKIE}=${await createSessionToken(opts.user)}`);
  if (opts.ip) headers.set('x-forwarded-for', opts.ip);
  const res = await handlers[name]({
    method: opts.method ?? 'GET', headers, params: opts.params ?? {}, query: new URLSearchParams(opts.query ?? {}),
    json: async () => opts.body, formData: async () => opts.form,
  }, ctx);
  return { status: res.status as number, body: res.jsonBody as any };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('qr')]);

const payForm = (o: Record<string, string | Buffer> = {}) => {
  const fd = new FormData();
  const v: Record<string, string | Buffer> = { payee: 'Ramesh', amount: '7,000', purpose: 'Electrician pending amount', mode: 'UPI', upi: '+91 98765 43210', ...o };
  for (const [k, val] of Object.entries(v)) {
    if (Buffer.isBuffer(val)) fd.append(k, new Blob([val]), 'qr.png'); else fd.append(k, val);
  }
  return fd;
};

beforeEach(async () => {
  setStore(new FileStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'av-pdb-')), 'db.json')));
  const s = getStore();
  for (const [id, role] of [['admin1', 'admin'], ['eng1', 'engineer'], ['eng2', 'engineer']]) {
    await s.put({ id, type: 'user', username: id, name: id, email: `${id}@x.com`, role, active: true });
  }
});

async function newProject(name: string, members: string[] = []) {
  const r = await call('projectCollection', { method: 'POST', user: 'admin1', body: { name, members } });
  expect(r.status).toBe(201);
  return r.body;
}


describe('payment request link', () => {
  it('creates an unpaid bill needing review with the payee details', async () => {
    const a = await newProject('Alpha', ['eng1']);
    expect(a.payToken).toBeUndefined();
    expect((await call('payRequestProject', { params: { token: a.shareToken } })).body).toEqual({ name: 'Alpha' });
    const r = await call('payRequestSubmit', { method: 'POST', params: { token: a.shareToken }, form: payForm({ requesterName: 'Site sup', requesterPhone: '9000000001' }), ip: '3.0.0.1' });
    expect(r.status).toBe(201);
    const bills = (await call('entityCollection', { user: 'eng1', params: { type: 'bill' }, query: { project: a.id } })).body.items;
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      projectId: a.id, status: 'Unpaid', source: 'payment-request', needsReview: true, total: 7000, vendorName: 'Ramesh', payee: 'Ramesh',
      billDate: new Date().toISOString().slice(0, 10), remarks: 'Electrician pending amount', submitterName: 'Site sup',
      payTo: { mode: 'UPI', upi: '9876543210' }, category: 'Electrical',
    });
  });

  it('one project link serves both flows; the old pay token is an alias revoked by regenerate', async () => {
    const a = await newProject('Alpha');
    const s = getStore();
    await s.put({ ...(await s.get('project', a.id))!, payToken: 'p'.repeat(32), payEnabled: true });
    for (const token of [a.shareToken, 'p'.repeat(32)]) {
      expect((await call('guestProject', { params: { token } })).status).toBe(200);
      expect((await call('payRequestProject', { params: { token } })).status).toBe(200);
    }
    await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'disable' } });
    for (const token of [a.shareToken, 'p'.repeat(32)]) {
      expect((await call('guestProject', { params: { token } })).status).toBe(404);
    }
    await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'enable' } });
    expect((await call('payRequestProject', { params: { token: 'p'.repeat(32) } })).status).toBe(200);
    const regen = await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'regenerate' } });
    expect(regen.body.shareToken).not.toBe(a.shareToken);
    for (const token of [a.shareToken, 'p'.repeat(32)]) {
      expect((await call('payRequestSubmit', { method: 'POST', params: { token }, form: payForm() })).status).toBe(404);
    }
    expect((await call('payRequestSubmit', { method: 'POST', params: { token: regen.body.shareToken }, form: payForm(), ip: '4.4.4.4' })).status).toBe(201);
    expect((await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'enable', link: 'nope' } })).status).toBe(400);
    expect((await call('projectShare', { method: 'POST', user: 'eng1', params: { id: a.id }, body: { action: 'regenerate' } })).status).toBe(403);
  });

  it('hides the pay token from non-admins', async () => {
    await newProject('Alpha', ['eng1']);
    const list = await call('projectCollection', { user: 'eng1' });
    expect(list.body.items[0].payToken).toBeUndefined();
    expect(list.body.items[0].payEnabled).toBeUndefined();
  });

  it('validates UPI, bank and QR details', () => {
    expect(normalizeMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeMobile('12345')).toBeNull();
    expect(parseAmount('25,400')).toBe(25400);
    expect(parseAmount('₹ 7000.505')).toBe(7000.51);
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(readPayRequestFields(payForm({ upi: 'Ramesh.K@okicici' })).payTo).toEqual({ mode: 'UPI', upi: 'ramesh.k@okicici' });
    expect(() => readPayRequestFields(payForm({ upi: '1231334' }))).toThrow(/mobile number or a UPI ID/);
    expect(() => readPayRequestFields(payForm({ payee: '' }))).toThrow(/to be paid is required/);
    expect(() => readPayRequestFields(payForm({ amount: '-5' }))).toThrow(/valid amount/);
    expect(() => readPayRequestFields(payForm({ mode: 'Crypto' }))).toThrow(/payment mode/);
    const bank = { mode: 'Bank', accountHolder: 'Ramesh K', accountNumber: '1234 5678 9012', ifsc: 'sbin0001234' };
    expect(readPayRequestFields(payForm(bank)).payTo).toEqual({
      mode: 'Bank', accountHolder: 'Ramesh K', accountNumber: '123456789012', ifsc: 'SBIN0001234', bankName: null,
    });
    expect(() => readPayRequestFields(payForm({ ...bank, ifsc: 'SBIN1234' }))).toThrow(/IFSC/);
    expect(() => readPayRequestFields(payForm({ ...bank, accountNumber: '12ab' }))).toThrow(/9–18 digits/);
    expect(() => readPayRequestFields(payForm({ ...bank, accountNumber2: '999999999' }))).toThrow(/do not match/);
    expect(readPayRequestFields(payForm({ mode: 'Cash' })).payTo).toEqual({ mode: 'Cash' });
  });

  it('QR mode needs a real image, stored in the project and visible only to its members', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const t = { token: a.shareToken };
    expect((await call('payRequestSubmit', { method: 'POST', params: t, form: payForm({ mode: 'QR' }), ip: '4.0.0.1' })).status).toBe(400);
    expect((await call('payRequestSubmit', { method: 'POST', params: t, form: payForm({ mode: 'QR', qr: PDF }), ip: '4.0.0.2' })).status).toBe(415);
    expect((await call('payRequestSubmit', { method: 'POST', params: t, form: payForm({ mode: 'QR', qr: PNG }), ip: '4.0.0.3' })).status).toBe(201);
    const bill = (await call('entityCollection', { user: 'eng1', params: { type: 'bill' }, query: { project: a.id } })).body.items[0];
    expect(blobProjectId(bill.payTo.qrFile)).toBe(a.id);
    expect((await call('fileDownload', { user: 'eng1', params: { path: bill.payTo.qrFile } })).status).toBe(200);
    expect((await call('fileDownload', { user: 'eng2', params: { path: bill.payTo.qrFile } })).status).toBe(404);
  });

  it('rate-limits per IP', async () => {
    const a = await newProject('Alpha');
    const post = () => call('payRequestSubmit', { method: 'POST', params: { token: a.shareToken }, form: payForm(), ip: '5.5.5.5' });
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });
});

describe('recording payments', () => {
  async function billIn(projectId: string, body: Record<string, unknown>) {
    const r = await call('entityCollection', { method: 'POST', user: 'admin1', params: { type: 'bill' }, query: { project: projectId }, body: { payee: 'Test payee', category: 'Cement', ...body } });
    expect(r.status).toBe(201);
    return r.body;
  }
  const pay = (user: string, project: string, id: string, body: Record<string, unknown>) =>
    call('billPayment', { method: 'POST', user, params: { id }, query: { project }, body });

  it('supports partial then full payment with history', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await billIn(a.id, { total: 1000, status: 'Unpaid' });
    const p1 = await pay('eng1', a.id, b.id, { amount: 400, date: '2026-11-01', mode: 'UPI' });
    expect(p1.body).toMatchObject({ status: 'Partially Paid', paidAmount: 400, paidDate: '2026-11-01', paymentMode: 'UPI' });
    expect((await pay('eng1', a.id, b.id, { amount: 601 })).body.error).toMatch(/more than the balance/);
    const p2 = await pay('eng1', a.id, b.id, { mode: 'Cash' });
    expect(p2.body).toMatchObject({ status: 'Paid', paidAmount: 1000, paymentMode: 'Cash' });
    expect(p2.body.payments.map((x: any) => x.amount)).toEqual([400, 600]);
    expect((await pay('eng1', a.id, b.id, { amount: 1 })).body.error).toMatch(/already fully paid/);
  });

  it('enforces project access and roles; rejects bad input', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await billIn(a.id, { total: 500, status: 'Unpaid' });
    expect((await pay('eng2', a.id, b.id, { amount: 1 })).status).toBe(404);
    await getStore().put({ id: 'v1', type: 'user', username: 'v1', name: 'v1', email: 'v@x.com', role: 'viewer', active: true });
    expect((await pay('v1', a.id, b.id, { amount: 1 })).status).toBe(403);
    expect((await pay('eng1', a.id, b.id, { amount: 0 })).status).toBe(400);
    expect((await pay('eng1', a.id, b.id, { mode: 'Barter' })).status).toBe(400);
    expect((await pay('eng1', a.id, b.id, { date: '01/11/2026' })).status).toBe(400);
    const zero = await billIn(a.id, { total: 0, status: 'Unpaid' });
    expect((await pay('eng1', a.id, zero.id, {})).body.error).toMatch(/Set the bill total/);
  });

  it('dashboard splits paid and unpaid; Paid bills count in full even without paidAmount', async () => {
    const a = await newProject('Alpha');
    await billIn(a.id, { total: 300, status: 'Paid' });
    await billIn(a.id, { total: 200, status: 'Partially Paid', paidAmount: 50 });
    await billIn(a.id, { total: 100, status: 'Unpaid' });
    const t = (await call('dashboard', { user: 'admin1', query: { project: a.id } })).body.totals;
    expect(t).toMatchObject({ paidBills: 350, unpaidBills: 250, paidCount: 1, unpaidCount: 2 });
  });
});

describe('team payment requests and pay details on any bill', () => {
  const teamReq = (user: string, project: string, form: FormData) =>
    call('billPaymentRequest', { method: 'POST', user, query: { project }, form });

  it('members raise a payment request from the Bills page: Unpaid, no review flag, they are the creator', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const r = await teamReq('eng1', a.id, payForm({ mode: 'Bank', accountHolder: 'Ramesh K', accountNumber: '123456789012', ifsc: 'SBIN0001234' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      projectId: a.id, status: 'Unpaid', source: 'payment-request', needsReview: false, createdBy: 'eng1', total: 7000, payee: 'Ramesh',
      category: 'Electrical', payTo: { mode: 'Bank', accountNumber: '123456789012', ifsc: 'SBIN0001234' },
    });
    expect(r.body.submitterName).toBeUndefined();
    const qr = await teamReq('eng1', a.id, payForm({ mode: 'QR', qr: PNG }));
    expect(blobProjectId(qr.body.payTo.qrFile)).toBe(a.id);
    expect((await teamReq('eng1', a.id, payForm({ upi: 'bad' }))).status).toBe(400);
    expect((await teamReq('eng2', a.id, payForm())).status).toBe(404);
    await getStore().put({ id: 'v1', type: 'user', username: 'v1', name: 'v1', email: 'v@x.com', role: 'viewer', active: true });
    expect((await teamReq('v1', a.id, payForm())).status).toBe(403);
  });

  it('new and existing bills accept, validate, keep and clear payment details', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await newProject('Beta', ['eng1']);
    const create = (body: Record<string, unknown>, project = a.id) =>
      call('entityCollection', { method: 'POST', user: 'eng1', params: { type: 'bill' }, query: { project }, body: { payee: 'Test payee', category: 'Cement', total: 900, status: 'Unpaid', ...body } });
    const update = (id: string, body: Record<string, unknown>) =>
      call('entityItem', { method: 'PUT', user: 'eng1', params: { type: 'bill', id }, query: { project: a.id }, body });

    const plain = await create({});
    expect(plain.body.payTo).toBeUndefined();
    const upi = await create({ payTo: { mode: 'UPI', upi: 'Vendor@OKSBI' } });
    expect(upi.body.payTo).toEqual({ mode: 'UPI', upi: 'vendor@oksbi' });
    expect((await create({ payTo: { mode: 'Bank', accountHolder: 'X', accountNumber: '12', ifsc: 'SBIN0001234' } })).body.error).toMatch(/9–18 digits/);
    expect((await create({ payTo: { mode: 'UPI', upi: '123' } })).status).toBe(400);

    // An existing (e.g. imported) unpaid bill gets details added later; other edits leave them alone.
    const added = await update(plain.body.id, { payTo: { mode: 'Bank', accountHolder: 'Shop', accountNumber: '9876543210', accountNumber2: '9876543210', ifsc: 'hdfc0000123', bankName: 'HDFC' } });
    expect(added.body.payTo).toEqual({ mode: 'Bank', accountHolder: 'Shop', accountNumber: '9876543210', ifsc: 'HDFC0000123', bankName: 'HDFC' });
    expect((await update(plain.body.id, { notes: 'x' })).body.payTo.mode).toBe('Bank');

    // QR: must be an image uploaded to this project; kept when the form doesn't send a new one.
    const fd = new FormData(); fd.append('file', new Blob([PNG]), 'qr.png');
    const up = await call('fileUpload', { method: 'POST', user: 'eng1', query: { folder: 'documents', project: a.id }, form: fd });
    const fdB = new FormData(); fdB.append('file', new Blob([PNG]), 'qr.png');
    const upB = await call('fileUpload', { method: 'POST', user: 'eng1', query: { folder: 'documents', project: b.id }, form: fdB });
    expect((await update(plain.body.id, { payTo: { mode: 'QR' } })).body.error).toMatch(/Upload the QR/);
    expect((await update(plain.body.id, { payTo: { mode: 'QR', qrFile: upB.body.name } })).status).toBe(400);
    expect((await update(plain.body.id, { payTo: { mode: 'QR', qrFile: '../etc/passwd' } })).status).toBe(400);
    expect((await update(plain.body.id, { payTo: { mode: 'QR', qrFile: up.body.name } })).body.payTo).toEqual({ mode: 'QR', qrFile: up.body.name });
    expect((await update(plain.body.id, { payTo: { mode: 'QR' } })).body.payTo.qrFile).toBe(up.body.name);

    expect((await update(plain.body.id, { payTo: null })).body.payTo).toBeNull();
    expect((await update(plain.body.id, { payTo: 'junk' })).status).toBe(400);
  });

  it('existing payment-request QR stays valid when the bill is edited', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const r = await teamReq('eng1', a.id, payForm({ mode: 'QR', qr: PNG }));
    const e = await call('entityItem', { method: 'PUT', user: 'eng1', params: { type: 'bill', id: r.body.id }, query: { project: a.id }, body: { payTo: { mode: 'QR', qrFile: r.body.payTo.qrFile } } });
    expect(e.status).toBe(200);
  });
});
