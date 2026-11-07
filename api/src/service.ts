import crypto from 'crypto';
import { SessionUser } from './auth/session';
import { HttpError } from './http';
import { normalizeName } from './ai/categorize';
import { entityDef, EntityDef, isProjectScoped, validate, ValidationError } from './schema';
import { Doc, getStore } from './store';
import { notifyBillCreated, notifyBillUpdated } from './notify/telegram';
import { notifyBillStatusEmail } from './notify/statusEmail';
import {
  guardUserCreate, guardUserDelete, guardUserUpdate, memberOf, membershipSummary, readProjectIds, requireAProject, setUserProjects,
} from './users';

const AUDIT_TTL = 400 * 24 * 3600;
const today = () => new Date().toISOString().slice(0, 10);

export function canRead(user: SessionUser, type: string) {
  const def = entityDef(type);
  return !!def && def.read.includes(user.role);
}
export function canWrite(user: SessionUser, type: string) {
  const def = entityDef(type);
  return !!def && def.write.includes(user.role);
}

export async function audit(user: SessionUser | { username: string }, action: string, entityType: string, entityId: string, summary: string, projectId: string | null = null) {
  await getStore().put({
    id: crypto.randomUUID(), type: 'audit', at: new Date().toISOString(), by: user.username,
    action, entityType, entityId, summary: summary.slice(0, 300), projectId,
  }, AUDIT_TTL);
}

/** A changed reference must point at an existing record in the same project (no cross-project links). */
async function checkRefs(def: EntityDef, doc: Doc, prev: Doc | null) {
  for (const f of def.fields) {
    if (f.type !== 'ref' || !f.ref || !doc[f.name] || doc[f.name] === prev?.[f.name]) continue;
    const target = await getStore().get(f.ref, String(doc[f.name]));
    if (!target || (isProjectScoped(f.ref) && target.projectId !== doc.projectId)) {
      throw new ValidationError(`${f.label} not found in this project`);
    }
  }
}

/** Business rules applied before every save. Mutates and returns `doc`. */
async function beforeSave(doc: Doc, prev: Doc | null): Promise<Doc> {
  const store = getStore();
  const def = entityDef(doc.type);
  if (def) await checkRefs(def, doc, prev);
  switch (doc.type) {
    case 'bill': {
      const total = Number(doc.total ?? 0);
      // Marking "Paid" without an amount pays it in full.
      if (doc.status === 'Paid' && prev?.status !== 'Paid' && !(Number(doc.paidAmount) > 0)) doc.paidAmount = total;
      if (doc.status === 'Unpaid' && prev && prev.status !== 'Unpaid') { doc.paidAmount = 0; doc.paidDate = null; }
      const paid = Number(doc.paidAmount ?? 0);
      if (paid > 0 && !doc.paidDate) doc.paidDate = today();
      doc.status = paid <= 0 ? 'Unpaid' : paid + 0.005 >= total ? 'Paid' : 'Partially Paid';
      if (doc.vendorId) {
        const v = await store.get('vendor', String(doc.vendorId));
        if (v) {
          doc.vendorName = v.name;
          // Learn: the first reviewed category becomes the vendor's default for future bills.
          if (!v.category && doc.category && doc.needsReview === false) await store.put({ ...v, category: doc.category });
        }
      }
      break;
    }
    case 'user': {
      doc.username = String(doc.username).toLowerCase().replace(/[^a-z0-9._-]/g, '');
      if (!doc.username) throw new ValidationError('Username may only contain a-z, 0-9, . _ -');
      if (doc.active === null || doc.active === undefined) doc.active = true;
      const others = (await store.list('user')).filter((u) => u.id !== doc.id);
      if (others.some((u) => u.username === doc.username)) throw new ValidationError('Username already taken');
      if (others.some((u) => u.email === doc.email)) throw new ValidationError('Email already used by another user');
      if (prev?.role === 'admin' && (doc.role !== 'admin' || doc.active === false)
        && !others.some((u) => u.role === 'admin' && u.active !== false)) {
        throw new ValidationError('Cannot remove the last active admin');
      }
      break;
    }
    case 'flat': {
      const others = (await store.list('flat')).filter((f) => f.id !== doc.id && f.projectId === doc.projectId);
      if (others.some((f) => f.number === doc.number && (f.block ?? null) === (doc.block ?? null))) {
        throw new ValidationError('A flat with this number already exists in this block');
      }
      break;
    }
    case 'booking': {
      if (doc.status === null || doc.status === undefined) doc.status = 'Active';
      break;
    }
    case 'customerPayment': {
      if (doc.status === 'Received' && !(Number(doc.receivedAmount) > 0)) doc.receivedAmount = doc.amount;
      if (Number(doc.receivedAmount) > 0) {
        doc.receivedDate ??= today();
        if (Number(doc.receivedAmount) + 0.005 >= Number(doc.amount)) doc.status = 'Received';
      }
      doc.status ??= 'Pending';
      break;
    }
    case 'labourer':
      if (doc.active === null || doc.active === undefined) doc.active = true;
      break;
    case 'task':
      doc.status ??= 'Open';
      break;
  }
  return doc;
}

/** After-save side effects (e.g. booking a flat flips its status). */
async function afterSave(doc: Doc, prev: Doc | null, user: SessionUser) {
  if (doc.type === 'bill') {
    // Telegram alerts never throw and time out quickly, so they cannot break the save.
    if (prev) {
      await Promise.all([notifyBillUpdated(user, prev, doc), notifyBillStatusEmail(user, prev, doc)]);
    } else await notifyBillCreated(user, doc);
  }
  if (doc.type === 'booking' && doc.flatId) {
    const store = getStore();
    const flat = await store.get('flat', String(doc.flatId));
    if (!flat) return;
    const status = doc.status === 'Cancelled' ? 'Available' : doc.status === 'Registered' ? 'Sold' : 'Booked';
    if (flat.status !== status) {
      await store.put({ ...flat, status, updatedAt: new Date().toISOString(), updatedBy: user.username });
      await audit(user, 'update', 'flat', flat.id, `Flat ${flat.number} → ${status} (booking ${doc.customerName})`, (doc.projectId as string) ?? null);
    }
    if (prev?.flatId && prev.flatId !== doc.flatId) {
      const old = await store.get('flat', String(prev.flatId));
      if (old && old.status === 'Booked') await store.put({ ...old, status: 'Available' });
    }
  }
}

/** Scoped types must be accessed through their project; a mismatch looks like "not found". */
function scopeCheck(type: string, doc: Doc | null, projectId: string | null): Doc {
  if (!doc) throw new HttpError(404, 'Not found');
  if (isProjectScoped(type) && doc.projectId !== projectId) throw new HttpError(404, 'Not found');
  return doc;
}

export async function createEntity(user: SessionUser, type: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, projectId: string | null = null) {
  const def = entityDef(type);
  if (!def || !canWrite(user, type)) throw new HttpError(403, 'Not allowed');
  if (isProjectScoped(type) && !projectId) throw new HttpError(400, 'Select a project first');
  const isUser = type === 'user';
  if (isUser) input = guardUserCreate(user, input);
  const userProjects = isUser ? (await readProjectIds(input)) ?? [] : [];
  const now = new Date().toISOString();
  let doc: Doc = {
    ...validate(def, input), ...extra, id: crypto.randomUUID(), type, createdAt: now, createdBy: user.username,
    ...(isProjectScoped(type) ? { projectId } : {}),
  };
  doc = await beforeSave(doc, null);
  if (isUser) requireAProject(doc, userProjects);
  await getStore().put(doc);
  await afterSave(doc, null, user);
  await audit(user, 'create', type, doc.id, `${def.label} ${String(doc[def.titleField] ?? doc.id)}${isUser ? ` (role ${doc.role})` : ''}`, projectId);
  if (isUser && userProjects.length) {
    const c = await setUserProjects(doc.id, userProjects, user.username);
    await audit(user, 'membership', 'user', doc.id, membershipSummary(String(doc.username), c));
  }
  return doc;
}

export async function updateEntity(
  user: SessionUser, type: string, id: string, input: Record<string, unknown>, projectId: string | null = null,
  extra: Record<string, unknown> = {},
) {
  const def = entityDef(type);
  if (!def || !canWrite(user, type)) throw new HttpError(403, 'Not allowed');
  const store = getStore();
  const prev = scopeCheck(type, await store.get(type, id), projectId);
  const changes = validate(def, input, true);
  let doc: Doc = { ...prev, ...changes, ...extra, id, type, updatedAt: new Date().toISOString(), updatedBy: user.username };
  doc = await beforeSave(doc, prev);
  const isUser = type === 'user';
  let userProjects: string[] | undefined;
  if (isUser) {
    guardUserUpdate(user, input, prev, doc);
    userProjects = await readProjectIds(input);
    // Enforce "at least one project" when projects are edited or an admin loses admin; untouched legacy users stay as they are.
    if (userProjects !== undefined || (prev.role === 'admin' && doc.role !== 'admin')) {
      requireAProject(doc, userProjects ?? memberOf(id, await store.list('project')));
    }
  }
  await store.put(doc);
  await afterSave(doc, prev, user);
  const changed = Object.keys(changes).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(doc[k]));
  await audit(user, 'update', type, id, `${def.label} ${String(doc[def.titleField] ?? id)}: ${changed.join(', ') || 'no changes'}`, projectId);
  if (isUser && prev.role !== doc.role) await audit(user, 'role', 'user', id, `Role of ${doc.username}: ${prev.role} → ${doc.role}`);
  if (isUser && userProjects) {
    const c = await setUserProjects(id, userProjects, user.username);
    if (c.added.length || c.removed.length) await audit(user, 'membership', 'user', id, membershipSummary(String(doc.username), c));
  }
  return doc;
}

export async function getEntity(type: string, id: string, projectId: string | null = null) {
  return scopeCheck(type, await getStore().get(type, id), projectId);
}

export async function listEntities(type: string, projectId: string | null = null) {
  const items = await getStore().list(type);
  return isProjectScoped(type) ? items.filter((d) => d.projectId === projectId) : items;
}

export async function deleteEntity(user: SessionUser, type: string, id: string, projectId: string | null = null) {
  const def = entityDef(type);
  if (!def || !canWrite(user, type)) throw new HttpError(403, 'Not allowed');
  const store = getStore();
  const prev = scopeCheck(type, await store.get(type, id), projectId);
  if (type === 'user') guardUserDelete(prev);
  if (type === 'user' && prev.id === user.id) throw new HttpError(400, 'You cannot delete yourself');
  if (type === 'user' && prev.role === 'admin') {
    const admins = (await store.list('user')).filter((u) => u.role === 'admin' && u.active !== false && u.id !== id);
    if (!admins.length) throw new HttpError(400, 'Cannot delete the last admin');
  }
  await store.delete(type, id);
  if (type === 'user') {
    const c = await setUserProjects(id, [], user.username);
    if (c.removed.length) await audit(user, 'membership', 'user', id, membershipSummary(String(prev.username), c));
  }
  if (type === 'booking' && prev.flatId && prev.status !== 'Cancelled') {
    const flat = await store.get('flat', String(prev.flatId));
    if (flat && flat.status === 'Booked') await store.put({ ...flat, status: 'Available' });
  }
  await audit(user, 'delete', type, id, `${def.label} ${String(prev[def.titleField] ?? id)}`, projectId);
}

export async function findVendorByName(name: string, projectId: string): Promise<Doc | null> {
  const key = normalizeName(name);
  if (!key) return null;
  const vendors = await listEntities('vendor', projectId);
  return vendors.find((v) => normalizeName(String(v.name ?? '')) === key) ?? null;
}
