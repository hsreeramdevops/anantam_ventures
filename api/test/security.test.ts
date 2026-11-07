import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-sec-'));
process.env.BOOTSTRAP_ADMIN_EMAIL = 'Owner@X.com';

type H = (req: any, ctx: any) => Promise<any>;
const handlers = vi.hoisted(() => ({}) as Record<string, (req: any, ctx: any) => Promise<any>>);
vi.mock('@azure/functions', async (orig) => ({
  ...(await orig<typeof import('@azure/functions')>()),
  app: { http: (name: string, o: { handler: H }) => { handlers[name] = o.handler; } },
}));

import '../src/index';
import { createSessionToken, COOKIE } from '../src/auth/session';
import { devOutbox } from '../src/auth/email';
import { newBlobName, saveFile } from '../src/files/blob';
import { notifyBillStatusEmail } from '../src/notify/statusEmail';
import { ENTITIES, entityDef, isProjectScoped } from '../src/schema';
import { setStore, getStore } from '../src/store';
import { FileStore } from '../src/store/fileStore';

const ctx = { warn: () => undefined, error: () => undefined, log: () => undefined };
const A = 'proj-a';
const B = 'proj-b';
const SCOPED = ENTITIES.map((e) => e.type).filter(isProjectScoped);

async function call(name: string, opts: {
  method?: string; user?: string; params?: Record<string, string>; query?: Record<string, string>;
  body?: unknown; form?: FormData; headers?: Record<string, string>;
} = {}) {
  const headers = new Headers({ 'x-requested-with': 'fetch', ...(opts.headers ?? {}) });
  if (opts.user) headers.set('cookie', `${COOKIE}=${await createSessionToken(opts.user)}`);
  const res = await handlers[name]({
    method: opts.method ?? 'GET', headers, params: opts.params ?? {}, query: new URLSearchParams(opts.query ?? {}),
    json: async () => opts.body, formData: async () => opts.form,
  }, ctx);
  return { status: res.status as number, body: res.jsonBody as any };
}
const as = (user: string, project: string) => ({ user, query: { project } });

beforeEach(async () => {
  setStore(new FileStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'av-secdb-')), 'db.json')));
  const s = getStore();
  await s.put({ id: 'projects-v1', type: 'meta' }); // skip the legacy migration (it would add everyone to a default project)
  for (const [id, role, email] of [
    ['owner', 'admin', 'owner@x.com'], ['admin2', 'admin', 'admin2@x.com'],
    ['memA', 'accountant', 'a@x.com'], ['memB', 'accountant', 'b@x.com'], ['memAB', 'engineer', 'ab@x.com'],
    ['orphan', 'viewer', 'o@x.com'],
  ]) await s.put({ id, type: 'user', username: id.toLowerCase(), name: id, email, role, active: true });
  await s.put({ id: A, type: 'project', name: 'Alpha', status: 'Active', members: ['memA', 'memAB'], shareToken: 'a'.repeat(32), shareEnabled: true });
  await s.put({ id: B, type: 'project', name: 'Beta', status: 'Active', members: ['memB', 'memAB'], shareToken: 'b'.repeat(32), shareEnabled: true });
  // One record of every project-scoped type in project B.
  for (const t of SCOPED) {
    await s.put({ id: `${t}-b`, type: t, projectId: B, name: 'Secret B', title: 'Secret B', total: 5000, status: t === 'bill' ? 'Unpaid' : null, createdBy: 'memb' });
  }
  await s.put({ id: 'bill-a', type: 'bill', projectId: A, vendorName: 'A vendor', payee: 'A vendor', total: 100, status: 'Unpaid', createdBy: 'mema' });
  await s.put({ id: 'material-a', type: 'material', projectId: A, name: 'Cement A' });
  devOutbox.length = 0;
});

describe('project isolation: a member of A cannot reach project B', () => {
  it('projects list / get / switcher only show own projects', async () => {
    const list = await call('projectCollection', { user: 'memA' });
    expect(list.body.items.map((p: any) => p.id)).toEqual([A]);
    expect(list.body.items[0].members).toBeUndefined();
    expect(list.body.items[0].shareToken).toBeUndefined();
    expect((await call('projectItem', { user: 'memA', params: { id: B } })).status).toBe(404);
    expect((await call('projectItem', { user: 'memA', params: { id: 'nope' } })).status).toBe(404);
    expect((await call('projectItem', { method: 'PUT', user: 'memA', params: { id: B }, body: { name: 'x' } })).status).toBe(404);
    expect((await call('projectItem', { method: 'PUT', user: 'memA', params: { id: A }, body: { members: ['memA', 'memB'] } })).status).toBe(403);
    expect((await call('projectShare', { method: 'POST', user: 'memA', params: { id: B }, body: { action: 'regenerate' } })).status).toBe(403);
    expect((await call('projectCollection', { method: 'POST', user: 'memA', body: { name: 'Mine' } })).status).toBe(403);
  });

  it.each(SCOPED)('%s: list / get / update / delete / create in B → 404', async (t) => {
    const id = `${t}-b`;
    expect((await call('entityCollection', { ...as('memA', B), params: { type: t } })).status).toBe(404);
    expect((await call('entityCollection', { ...as('memA', B), method: 'POST', params: { type: t }, body: {} })).status).toBe(404);
    // Inside their own project, a role without write access gets 403 before the lookup; either way nothing leaks.
    const denied = (p: string) => (p === B || entityDef(t)!.write.includes('accountant') ? [404] : [403, 404]);
    for (const project of [A, B]) {
      expect((await call('entityItem', { ...as('memA', project), params: { type: t, id } })).status).toBe(404);
      expect(denied(project)).toContain((await call('entityItem', { ...as('memA', project), method: 'PUT', params: { type: t, id }, body: { notes: 'x' } })).status);
      expect(denied(project)).toContain((await call('entityItem', { ...as('memA', project), method: 'DELETE', params: { type: t, id } })).status);
    }
    const listA = await call('entityCollection', { ...as('memA', A), params: { type: t } });
    expect(listA.status).toBe(200);
    expect(listA.body.items.some((d: any) => d.projectId !== A)).toBe(false);
    expect(await getStore().get(t, id)).toBeTruthy(); // nothing was deleted
  });

  it('no project / missing project param → 404', async () => {
    expect((await call('entityCollection', { user: 'memA', params: { type: 'bill' } })).status).toBe(404);
    expect((await call('entityCollection', { ...as('memA', 'proj-zzz'), params: { type: 'bill' } })).status).toBe(404);
  });

  it('projectId injection in the body is ignored', async () => {
    const c = await call('entityCollection', { ...as('memA', A), method: 'POST', params: { type: 'task' }, body: { title: 'T', status: 'Open', projectId: B } });
    expect(c.status).toBe(201);
    expect(c.body.projectId).toBe(A);
    const u = await call('entityItem', { ...as('memA', A), method: 'PUT', params: { type: 'bill', id: 'bill-a' }, body: { projectId: B, notes: 'x' } });
    expect(u.status).toBe(200);
    expect((await getStore().get('bill', 'bill-a'))!.projectId).toBe(A);
  });

  it('references to another project are rejected', async () => {
    const r = await call('entityCollection', { ...as('memA', A), method: 'POST', params: { type: 'bill' },
      body: { vendorId: 'vendor-b', payee: 'X', billDate: '2026-11-01', total: 10, category: 'Miscellaneous', status: 'Unpaid' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not found in this project/);
  });

  it('mark paid, upload/parse, payment request and file upload in B → 404', async () => {
    expect((await call('billPayment', { ...as('memA', B), method: 'POST', params: { id: 'bill-b' }, body: {} })).status).toBe(404);
    expect((await call('billPayment', { ...as('memA', A), method: 'POST', params: { id: 'bill-b' }, body: {} })).status).toBe(404);
    expect((await getStore().get('bill', 'bill-b'))!.status).toBe('Unpaid');
    const fd = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('%PDF-1.4 x')]), 'b.pdf'); return f; };
    expect((await call('billUpload', { ...as('memA', B), method: 'POST', form: fd() })).status).toBe(404);
    expect((await call('billPaymentRequest', { ...as('memA', B), method: 'POST', form: fd() })).status).toBe(404);
    expect((await call('fileUpload', { user: 'memA', method: 'POST', query: { project: B, folder: 'bills' }, form: fd() })).status).toBe(404);
  });

  it('file / QR downloads follow the project in the file name', async () => {
    const nameB = newBlobName('documents', 'qr.png', B);
    const nameA = newBlobName('documents', 'qr.png', A);
    await saveFile(nameB, Buffer.from('png'), 'image/png');
    await saveFile(nameA, Buffer.from('png'), 'image/png');
    expect((await call('fileDownload', { user: 'memA', params: { path: nameB } })).status).toBe(404);
    expect((await call('fileDownload', { user: 'memA', params: { path: nameA } })).status).toBe(200);
    expect((await call('fileDownload', { user: 'admin2', params: { path: nameB } })).status).toBe(200);
    // Legacy names (no project prefix) belong to the default project, which memA is not in.
    expect((await call('fileDownload', { user: 'memA', params: { path: newBlobName('documents', 'old.pdf') } })).status).toBe(404);
    // A bill in A cannot point its QR at a file from B.
    const r = await call('entityItem', { ...as('memA', A), method: 'PUT', params: { type: 'bill', id: 'bill-a' },
      body: { payTo: { mode: 'QR', qrFile: nameB } } });
    expect(r.status).toBe(400);
  });

  it('dashboard and reports (exports) for B → 404, and A shows only A data', async () => {
    for (const h of ['dashboard', 'stockReport', 'wagesReport']) {
      expect((await call(h, as('memA', B))).status).toBe(404);
    }
    const stock = await call('stockReport', as('memA', A));
    expect(stock.body.items.map((m: any) => m.name)).toEqual(['Cement A']);
    const dash = await call('dashboard', as('memA', A));
    expect(dash.status).toBe(200);
    expect(JSON.stringify(dash.body)).not.toContain('Secret B');
  });

  it('audit log is admin-only', async () => {
    expect((await call('entityCollection', { user: 'memA', params: { type: 'audit' } })).status).toBe(404);
    expect((await call('entityCollection', { user: 'admin2', params: { type: 'audit' } })).status).toBe(200);
  });

  it('telegram subscriptions cannot target B; status only lists A', async () => {
    const r = await call('telegramSubscriptions', { method: 'PUT', user: 'memA', body: { subs: { [B]: ['payRequest'] } } });
    expect(r.status).toBe(400);
    const st = await call('telegramStatus', { user: 'memA' });
    expect(JSON.stringify(st.body)).not.toContain(B);
  });

  it('users list only shows people who share a project (plus admins)', async () => {
    const r = await call('entityCollection', { user: 'memA', params: { type: 'user' } });
    const ids = r.body.items.map((u: any) => u.id).sort();
    expect(ids).toEqual(['admin2', 'memA', 'memAB', 'owner']);
    expect(r.body.items.every((u: any) => u.projects === undefined)).toBe(true);
    expect((await call('entityItem', { user: 'memA', params: { type: 'user', id: 'memB' } })).status).toBe(404);
    const adm = await call('entityCollection', { user: 'admin2', params: { type: 'user' } });
    expect(adm.body.items).toHaveLength(6);
    expect(adm.body.items.find((u: any) => u.id === 'memAB').projects.sort()).toEqual([A, B]);
    expect(adm.body.items.find((u: any) => u.id === 'owner').owner).toBe(true);
  });

  it('daily digest only includes projects the user can access', async () => {
    process.env.JOB_KEY = 'jobkey-0123456789';
    const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await getStore().put({ ...(await getStore().get('bill', 'bill-b'))!, dueDate: soon, vendorName: 'Beta Vendor' });
    await getStore().put({ ...(await getStore().get('bill', 'bill-a'))!, dueDate: soon });
    const r = await call('dailyDigest', { method: 'POST', headers: { 'x-job-key': 'jobkey-0123456789' } });
    expect(r.status).toBe(200);
    const mail = devOutbox.find((m) => m.to.includes('a@x.com'));
    expect(mail?.text).toContain('Alpha');
    expect(mail?.text).not.toContain('Beta');
    delete process.env.JOB_KEY;
  });

  it('status emails skip a creator who was removed from the project', async () => {
    const bill = (await getStore().get('bill', 'bill-b'))!;
    const actor = { id: 'admin2', username: 'admin2', email: 'admin2@x.com' };
    await getStore().put({ ...bill, createdBy: 'mema' }); // memA created it but is not in B
    expect(await notifyBillStatusEmail(actor, { ...bill, createdBy: 'mema' }, { ...bill, createdBy: 'mema', status: 'Paid', paidAmount: 5000 })).toBe(false);
    expect(await notifyBillStatusEmail(actor, { ...bill, createdBy: 'memb' }, { ...bill, createdBy: 'memb', status: 'Paid', paidAmount: 5000 })).toBe(true);
  });

  it('a member of both sees both; admins see everything', async () => {
    expect((await call('entityItem', { ...as('memAB', B), params: { type: 'bill', id: 'bill-b' } })).status).toBe(200);
    expect((await call('entityItem', { ...as('admin2', B), params: { type: 'bill', id: 'bill-b' } })).status).toBe(200);
    expect((await call('projectCollection', { user: 'admin2' })).body.items).toHaveLength(2);
  });

  it('a non-admin with no project sees nothing', async () => {
    expect((await call('projectCollection', { user: 'orphan' })).body.items).toEqual([]);
    expect((await call('entityCollection', { ...as('orphan', A), params: { type: 'bill' } })).status).toBe(404);
  });

  it('losing membership takes effect immediately', async () => {
    expect((await call('entityCollection', { ...as('memAB', B), params: { type: 'bill' } })).status).toBe(200);
    expect((await call('projectItem', { method: 'PUT', user: 'admin2', params: { id: B }, body: { members: ['memB'] } })).status).toBe(200);
    expect((await call('entityCollection', { ...as('memAB', B), params: { type: 'bill' } })).status).toBe(404);
  });
});

describe('roles: only the owner changes them', () => {
  it('/auth/me reports the owner (from BOOTSTRAP_ADMIN_EMAIL, case-insensitive)', async () => {
    expect((await call('authMe', { user: 'owner' })).body.user.isOwner).toBe(true);
    expect((await call('authMe', { user: 'admin2' })).body.user.isOwner).toBe(false);
  });

  it('a non-owner admin cannot change roles, but can edit other fields', async () => {
    const r = await call('entityItem', { user: 'admin2', method: 'PUT', params: { type: 'user', id: 'memA' }, body: { role: 'admin' } });
    expect(r.status).toBe(403);
    expect((await getStore().get('user', 'memA'))!.role).toBe('accountant');
    const ok = await call('entityItem', { user: 'admin2', method: 'PUT', params: { type: 'user', id: 'memA' }, body: { name: 'Mem A', role: 'accountant' } });
    expect(ok.status).toBe(200);
    expect((await call('entityItem', { user: 'memA', method: 'PUT', params: { type: 'user', id: 'memA' }, body: { role: 'admin' } })).status).toBe(403);
  });

  it('a non-owner admin can only create users with the default role', async () => {
    const base = { username: 'new1', name: 'New', email: 'new1@x.com', projects: [A] };
    expect((await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' }, body: { ...base, role: 'admin' } })).status).toBe(403);
    expect((await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' }, body: { ...base, role: 'accountant' } })).status).toBe(403);
    const r = await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' }, body: base });
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('viewer');
    expect((await getStore().get('project', A))!.members).toContain(r.body.id);
  });

  it('the owner can change roles; it is audited', async () => {
    const r = await call('entityItem', { user: 'owner', method: 'PUT', params: { type: 'user', id: 'memA' }, body: { role: 'admin' } });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('admin');
    const audits = await getStore().list('audit');
    expect(audits.some((a) => a.action === 'role' && /accountant → admin/.test(String(a.summary)) && a.by === 'owner')).toBe(true);
    const c = await call('entityCollection', { user: 'owner', method: 'POST', params: { type: 'user' }, body: { username: 'boss2', name: 'B2', email: 'b2@x.com', role: 'admin' } });
    expect(c.status).toBe(201);
  });

  it('nobody can demote, deactivate, delete or take over the owner', async () => {
    const put = (user: string, body: unknown) => call('entityItem', { user, method: 'PUT', params: { type: 'user', id: 'owner' }, body });
    expect((await put('admin2', { name: 'Hacked' })).status).toBe(403);
    expect((await put('admin2', { email: 'evil@x.com' })).status).toBe(403);
    expect((await put('admin2', { active: false })).status).toBe(403);
    expect((await call('entityItem', { user: 'admin2', method: 'DELETE', params: { type: 'user', id: 'owner' } })).status).toBe(403);
    expect((await put('owner', { role: 'viewer', projects: [A] })).status).toBe(400);
    expect((await put('owner', { active: false })).status).toBe(400);
    expect((await put('owner', { email: 'other@x.com' })).status).toBe(400);
    expect((await call('entityItem', { user: 'owner', method: 'DELETE', params: { type: 'user', id: 'owner' } })).status).toBe(403);
    expect((await put('owner', { name: 'The Owner' })).status).toBe(200);
    const o = (await getStore().get('user', 'owner'))!;
    expect(o).toMatchObject({ role: 'admin', active: true, email: 'owner@x.com', name: 'The Owner' });
  });

  it('a non-owner admin cannot give anyone the owner email', async () => {
    await getStore().delete('user', 'owner');
    expect((await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' },
      body: { username: 'fake', name: 'F', email: 'owner@x.com', projects: [A] } })).status).toBe(403);
    expect((await call('entityItem', { user: 'admin2', method: 'PUT', params: { type: 'user', id: 'memA' }, body: { email: 'OWNER@x.com' } })).status).toBe(403);
  });
});

describe('membership: users ⇄ projects, every non-admin has one', () => {
  it('creating a non-admin requires at least one project', async () => {
    const r = await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' }, body: { username: 'np', name: 'NP', email: 'np@x.com' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least one project/);
    expect((await call('entityCollection', { user: 'admin2', method: 'POST', params: { type: 'user' },
      body: { username: 'np', name: 'NP', email: 'np@x.com', projects: ['nope'] } })).status).toBe(400);
    expect((await getStore().list('user')).some((u) => u.username === 'np')).toBe(false);
  });

  it('admins (other than the owner) can move users between projects; last project is protected; audited', async () => {
    const put = (body: unknown) => call('entityItem', { user: 'admin2', method: 'PUT', params: { type: 'user', id: 'memA' }, body });
    expect((await put({ projects: [] })).status).toBe(400);
    expect((await put({ projects: [A, B] })).status).toBe(200);
    expect((await getStore().get('project', B))!.members).toContain('memA');
    expect((await put({ projects: [B] })).status).toBe(200);
    expect((await getStore().get('project', A))!.members).not.toContain('memA');
    const audits = await getStore().list('audit');
    expect(audits.some((a) => a.action === 'membership' && /−Alpha/.test(String(a.summary)))).toBe(true);
  });

  it('project member edits cannot strand a non-admin without a project', async () => {
    const r = await call('projectItem', { method: 'PUT', user: 'admin2', params: { id: A }, body: { members: ['memAB'] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/memA would be left without any project/);
    // memAB is still in B, so removing them from A is fine.
    expect((await call('projectItem', { method: 'PUT', user: 'admin2', params: { id: A }, body: { members: ['memA'] } })).status).toBe(200);
    expect((await getStore().list('audit')).some((a) => a.action === 'membership' && a.entityType === 'project')).toBe(true);
  });

  it('demoting an admin requires a project; deleting a user removes memberships', async () => {
    const put = (body: unknown) => call('entityItem', { user: 'owner', method: 'PUT', params: { type: 'user', id: 'admin2' }, body });
    expect((await put({ role: 'viewer' })).status).toBe(400);
    expect((await put({ role: 'viewer', projects: [A] })).status).toBe(200);
    expect((await call('entityItem', { user: 'owner', method: 'DELETE', params: { type: 'user', id: 'memAB' } })).status).toBe(204);
    for (const p of [A, B]) expect((await getStore().get('project', p))!.members).not.toContain('memAB');
  });

  it('legacy users without a project can still be edited without touching projects', async () => {
    expect((await call('entityItem', { user: 'admin2', method: 'PUT', params: { type: 'user', id: 'orphan' }, body: { name: 'Orphan' } })).status).toBe(200);
  });
});

