import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-p-'));

type H = (req: any, ctx: any) => Promise<any>;
const handlers = vi.hoisted(() => ({}) as Record<string, (req: any, ctx: any) => Promise<any>>);
vi.mock('@azure/functions', async (orig) => ({
  ...(await orig<typeof import('@azure/functions')>()),
  app: { http: (name: string, o: { handler: H }) => { handlers[name] = o.handler; } },
}));

import '../src/index';
import { createSessionToken, COOKIE } from '../src/auth/session';
import { blobProjectId, isValidBlobName, newBlobName } from '../src/files/blob';
import { readGuestFields } from '../src/functions/guest';
import { DEFAULT_PROJECT_ID, ensureMigrated } from '../src/projects';
import { setStore, getStore } from '../src/store';
import { FileStore } from '../src/store/fileStore';
import { clientIp } from '../src/ratelimit';

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

const guestForm = (o: { name?: string; remarks?: string; phone?: string; file?: Buffer } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([o.file ?? PDF]), 'bill.pdf');
  fd.append('name', o.name ?? 'Raju');
  fd.append('remarks', o.remarks ?? 'Cement for slab');
  if (o.phone) fd.append('phone', o.phone);
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

describe('migration', () => {
  it('creates the default project once and backfills projectId idempotently', async () => {
    const s = getStore();
    await s.put({ id: 'b-old', type: 'bill', total: 10, category: 'Cement' });
    await ensureMigrated();
    await ensureMigrated();
    expect((await s.get('bill', 'b-old'))?.projectId).toBe(DEFAULT_PROJECT_ID);
    const projects = await s.list('project');
    expect(projects).toHaveLength(1);
    expect(projects[0].members).toEqual(['eng1', 'eng2']);
    expect(projects[0].shareEnabled).toBe(false);
  });
});

describe('project access control', () => {
  it('only admins create projects; members see only their projects; share token hidden from non-admins', async () => {
    expect((await call('projectCollection', { method: 'POST', user: 'eng1', body: { name: 'X' } })).status).toBe(403);
    const a = await newProject('Alpha', ['eng1']);
    const b = await newProject('Beta');
    expect(a.shareToken.length).toBeGreaterThanOrEqual(32);

    const adminList = (await call('projectCollection', { user: 'admin1' })).body.items.map((p: any) => p.name);
    expect(adminList).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Default project']));
    const engList = (await call('projectCollection', { user: 'eng1' })).body.items;
    expect(engList.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Alpha', 'Default project']));
    expect(engList.map((p: any) => p.name)).not.toContain('Beta');
    expect(engList.find((p: any) => p.name === 'Alpha').shareToken).toBeUndefined();
    expect((await call('projectItem', { user: 'eng1', params: { id: b.id } })).status).toBe(404);
  });

  it('scopes entity reads and writes to the selected project', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await newProject('Beta', ['eng2']);
    const mk = (user: string, project: string) => call('entityCollection', {
      method: 'POST', user, params: { type: 'vendor' }, query: { project }, body: { name: `V-${project}` },
    });
    const va = await mk('eng1', a.id);
    expect(va.status).toBe(201);
    expect(va.body.projectId).toBe(a.id);
    expect((await mk('eng1', b.id)).status).toBe(404); // not a member
    expect((await call('entityCollection', { user: 'eng1', params: { type: 'vendor' } })).status).toBe(404); // no project

    await mk('admin1', b.id);
    const listA = (await call('entityCollection', { user: 'admin1', params: { type: 'vendor' }, query: { project: a.id } })).body.items;
    expect(listA.map((v: any) => v.name)).toEqual([`V-${a.id}`]);

    // A record can't be read/updated/deleted through another project id.
    const viaB = { user: 'admin1', params: { type: 'vendor', id: va.body.id }, query: { project: b.id } };
    expect((await call('entityItem', viaB)).status).toBe(404);
    expect((await call('entityItem', { ...viaB, method: 'PUT', body: { name: 'x' } })).status).toBe(404);
    expect((await call('entityItem', { ...viaB, method: 'DELETE' })).status).toBe(404);

    // Cross-project references are rejected.
    const bill = await call('entityCollection', {
      method: 'POST', user: 'admin1', params: { type: 'bill' }, query: { project: b.id },
      body: { total: 5, category: 'Cement', vendorId: va.body.id },
    });
    expect(bill.status).toBe(400);
    expect(bill.body.error).toMatch(/not found in this project/);

    // Users stay global.
    expect((await call('entityCollection', { user: 'admin1', params: { type: 'user' } })).status).toBe(200);
  });

  it('flat numbers are unique per project, not globally', async () => {
    const a = await newProject('Alpha');
    const b = await newProject('Beta');
    const flat = (project: string) => call('entityCollection', {
      method: 'POST', user: 'admin1', params: { type: 'flat' }, query: { project }, body: { number: '101', status: 'Available' },
    });
    expect((await flat(a.id)).status).toBe(201);
    expect((await flat(b.id)).status).toBe(201);
    expect((await flat(a.id)).status).toBe(400);
  });

  it('file downloads follow the project in the blob name', async () => {
    const a = await newProject('Alpha', ['eng1']);
    const b = await newProject('Beta');
    const name = newBlobName('bills', 'x.pdf', b.id);
    expect(isValidBlobName(name)).toBe(true);
    expect(blobProjectId(name)).toBe(b.id);
    expect(blobProjectId(newBlobName('bills', 'x.pdf'))).toBeNull();
    const parts = name.split('/');
    expect((await call('fileDownload', { user: 'eng1', params: { path: parts.join('/') } })).status).toBe(404);
    const up = new FormData();
    up.append('file', new Blob([PDF]), 'a.pdf');
    const r = await call('fileUpload', { method: 'POST', user: 'eng1', query: { folder: 'bills', project: a.id }, form: up });
    expect(r.status).toBe(201);
    expect((await call('fileDownload', { user: 'eng1', params: { path: r.body.name } })).status).toBe(200);
    expect((await call('fileDownload', { user: 'eng2', params: { path: r.body.name } })).status).toBe(404);
  });

  it('reports are per project', async () => {
    const a = await newProject('Alpha');
    const b = await newProject('Beta');
    await call('entityCollection', { method: 'POST', user: 'admin1', params: { type: 'bill' }, query: { project: a.id }, body: { total: 100, category: 'Cement' } });
    await call('entityCollection', { method: 'POST', user: 'admin1', params: { type: 'bill' }, query: { project: b.id }, body: { total: 7, category: 'Cement' } });
    const d = await call('dashboard', { user: 'admin1', query: { project: a.id } });
    expect(d.body.spendByCategory).toEqual([{ name: 'Cement', value: 100 }]);
    expect((await call('dashboard', { user: 'eng1', query: { project: a.id } })).status).toBe(404);
  });
});

describe('guest upload link', () => {
  it('creates a guest bill needing review in the right project', async () => {
    const a = await newProject('Alpha');
    const info = await call('guestProject', { params: { token: a.shareToken }, ip: '1.1.1.1' });
    expect(info.body).toEqual({ name: 'Alpha' });
    const r = await call('guestUpload', { method: 'POST', params: { token: a.shareToken }, form: guestForm({ phone: '+91 98765 43210' }), ip: '1.1.1.1' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ ok: true, project: 'Alpha' });
    const bills = await getStore().list('bill');
    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      projectId: a.id, needsReview: true, source: 'guest', submitterName: 'Raju', submitterPhone: '+91 98765 43210',
      remarks: 'Cement for slab', category: 'Miscellaneous',
    });
    expect(blobProjectId(String(bills[0].file))).toBe(a.id);
  });

  it('regenerate kills the old token immediately; disable gives the same 404 as a bad token', async () => {
    const a = await newProject('Alpha');
    const old = a.shareToken;
    expect((await call('projectShare', { method: 'POST', user: 'eng1', params: { id: a.id }, body: { action: 'regenerate' } })).status).toBe(403);
    const regen = await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'regenerate' } });
    expect(regen.body.shareToken).not.toBe(old);
    const bad = await call('guestProject', { params: { token: old } });
    expect(bad.status).toBe(404);
    expect((await call('guestProject', { params: { token: regen.body.shareToken } })).status).toBe(200);
    await call('projectShare', { method: 'POST', user: 'admin1', params: { id: a.id }, body: { action: 'disable' } });
    const disabled = await call('guestProject', { params: { token: regen.body.shareToken } });
    expect(disabled).toEqual(bad);
    expect((await call('guestUpload', { method: 'POST', params: { token: regen.body.shareToken }, form: guestForm() })).status).toBe(404);
    expect((await call('guestProject', { params: { token: 'short' } })).status).toBe(404);
  });

  it('validates the form and file type', async () => {
    const a = await newProject('Alpha');
    const t = { token: a.shareToken };
    const post = (form: FormData, ip: string) => call('guestUpload', { method: 'POST', params: t, form, ip });
    expect((await post(guestForm({ remarks: ' ' }), '2.0.0.1')).body.error).toMatch(/Remarks are required/);
    expect((await post(guestForm({ name: '' }), '2.0.0.2')).body.error).toMatch(/name is required/);
    expect((await post(guestForm({ phone: 'call me' }), '2.0.0.3')).status).toBe(400);
    expect((await post(guestForm({ file: Buffer.from('MZ not a pdf') }), '2.0.0.4')).status).toBe(415);
    expect(() => readGuestFields(guestForm({ remarks: 'x'.repeat(1001) }))).toThrow(/too long/);
    expect(await getStore().list('bill')).toHaveLength(0);
  });

  it('rate-limits per IP and per token', async () => {
    const a = await newProject('Alpha');
    const post = (ip: string) => call('guestUpload', { method: 'POST', params: { token: a.shareToken }, form: guestForm(), ip });
    for (let i = 0; i < 5; i++) expect((await post('9.9.9.9')).status).toBe(201);
    expect((await post('9.9.9.9')).status).toBe(429);
    // Bad tokens still count against the IP (slows guessing).
    expect((await call('guestUpload', { method: 'POST', params: { token: 'x'.repeat(32) }, form: guestForm(), ip: '9.9.9.9' })).status).toBe(429);
    for (let i = 0; i < 15; i++) expect((await post(`10.0.0.${i}`)).status).toBe(201);
    expect((await post('10.0.1.1')).status).toBe(429); // 21st upload for the token within the hour
  });

  it('rate limit holds under a parallel burst', async () => {
    const { hitRateLimit } = await import('../src/ratelimit');
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => hitRateLimit('burst', 5, 60_000)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(5);
  });

  it('extracts client IPs', () => {
    const req = (h: Record<string, string>) => ({ headers: new Headers(h) }) as any;
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4:5555, 10.0.0.1' }))).toBe('1.2.3.4');
    expect(clientIp(req({ 'x-azure-clientip': '5.6.7.8', 'x-forwarded-for': '1.2.3.4' }))).toBe('5.6.7.8');
    expect(clientIp(req({}))).toBe('unknown');
  });
});
