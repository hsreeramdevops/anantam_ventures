import crypto from 'crypto';
import { HttpRequest } from '@azure/functions';
import { SessionUser } from './auth/session';
import { HttpError } from './http';
import { ENTITIES, GLOBAL_TYPES } from './schema';
import { Doc, getStore, Store } from './store';

export const DEFAULT_PROJECT_ID = 'default';
const MIGRATION_ID = 'projects-v1';

/** ≥128-bit unguessable token for the public guest-upload link. */
export const newShareToken = () => crypto.randomBytes(24).toString('base64url');

const migrated = new WeakSet<Store>();

/**
 * One-time, idempotent move to multi-project: creates the "Default project" (fixed id, so concurrent
 * workers converge on one doc), adds every existing non-admin user as a member and backfills `projectId`.
 */
export async function ensureMigrated(): Promise<void> {
  const store = getStore();
  if (migrated.has(store)) return;
  if (await store.get('meta', MIGRATION_ID)) { migrated.add(store); return; }

  const now = new Date().toISOString();
  let def = await store.get('project', DEFAULT_PROJECT_ID);
  if (!def) {
    const users = await store.list('user');
    def = await store.put({
      id: DEFAULT_PROJECT_ID, type: 'project', name: 'Default project', location: null, status: 'Active',
      startDate: null, notes: 'Created automatically for data that existed before multi-project support.',
      members: users.filter((u) => u.role !== 'admin').map((u) => u.id),
      shareToken: newShareToken(), shareEnabled: false, createdAt: now, createdBy: 'migration',
    });
  }
  for (const e of ENTITIES) {
    if (GLOBAL_TYPES.includes(e.type)) continue;
    for (const d of await store.list(e.type)) {
      if (d.projectId) continue;
      // Re-read right before writing so a concurrent edit (another worker already migrated) isn't overwritten.
      const fresh = await store.get(e.type, d.id);
      if (fresh && !fresh.projectId) await store.put({ ...fresh, projectId: DEFAULT_PROJECT_ID });
    }
  }
  await store.put({ id: MIGRATION_ID, type: 'meta', at: now });
  migrated.add(store);
}

export function canAccessProject(user: SessionUser, project: Doc): boolean {
  if (user.role === 'admin') return true;
  return Array.isArray(project.members) && (project.members as unknown[]).includes(user.id);
}

export async function listAccessibleProjects(user: SessionUser): Promise<Doc[]> {
  await ensureMigrated();
  const all = await getStore().list('project');
  return all.filter((p) => canAccessProject(user, p))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/** Loads a project the user may access; unknown and forbidden look identical (404). */
export async function getAccessibleProject(user: SessionUser, id: string | null | undefined): Promise<Doc> {
  await ensureMigrated();
  const p = id ? await getStore().get('project', id) : null;
  if (!p || !canAccessProject(user, p)) throw new HttpError(404, 'Project not found');
  return p;
}

/** Project from the `?project=` query string, access-checked. */
export const requireProject = (req: HttpRequest, user: SessionUser) =>
  getAccessibleProject(user, req.query.get('project'));

/** Strips admin-only fields (share token, members) for non-admins. */
export function publicProjectView(p: Doc, user: SessionUser): Doc {
  if (user.role === 'admin') return p;
  const { shareToken: _t, shareEnabled: _e, members: _m, ...rest } = p;
  return rest as Doc;
}

/** Constant-time lookup of an enabled project by its share token. */
export async function findProjectByShareToken(token: string): Promise<Doc | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  await ensureMigrated();
  const want = Buffer.from(token);
  let found: Doc | null = null;
  for (const p of await getStore().list('project')) {
    const have = Buffer.from(String(p.shareToken ?? ''));
    if (have.length === want.length && crypto.timingSafeEqual(have, want) && p.shareEnabled === true) found = p;
  }
  return found;
}
