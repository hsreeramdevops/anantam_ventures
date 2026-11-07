import { SessionUser } from './auth/session';
import { config } from './config';
import { HttpError } from './http';
import { Role, ValidationError } from './schema';
import { Doc, getStore } from './store';

/** Role given to users created by admins other than the owner (least privilege; only the owner changes roles). */
export const DEFAULT_ROLE: Role = 'viewer';

/** The owner is the BOOTSTRAP_ADMIN_EMAIL account: the only one who may change roles. */
export const isOwnerEmail = (email: unknown) =>
  !!config.bootstrapAdminEmail && String(email ?? '').trim().toLowerCase() === config.bootstrapAdminEmail;
export const isOwner = (user: { email?: unknown } | null | undefined) => !!user && isOwnerEmail(user.email);

/** Ids of the projects a user is a member of. */
export const memberOf = (userId: string, projects: Doc[]) =>
  projects.filter((p) => Array.isArray(p.members) && (p.members as unknown[]).includes(userId)).map((p) => p.id);

/** `projects` from a user form: undefined = leave unchanged; otherwise a de-duplicated list of existing project ids. */
export async function readProjectIds(input: Record<string, unknown>): Promise<string[] | undefined> {
  if (!('projects' in input)) return undefined;
  const raw = input.projects;
  if (!Array.isArray(raw)) throw new ValidationError('projects must be a list of project ids');
  const known = new Set((await getStore().list('project')).map((p) => p.id));
  const ids = [...new Set(raw.map(String))];
  if (ids.some((id) => !known.has(id))) throw new ValidationError('Unknown project');
  return ids;
}

/** Role / owner rules for creating a user. Returns the input with the default role filled in for non-owners. */
export function guardUserCreate(actor: SessionUser, input: Record<string, unknown>): Record<string, unknown> {
  if (isOwner(actor)) return input;
  if (input.role === undefined || input.role === null || input.role === '') input = { ...input, role: DEFAULT_ROLE };
  if (input.role !== DEFAULT_ROLE) throw new HttpError(403, 'Only the owner can set user roles');
  if (isOwnerEmail(input.email)) throw new HttpError(403, 'Only the owner can create the owner account');
  return input;
}

/** Role / owner rules for editing `prev` into `doc`. */
export function guardUserUpdate(actor: SessionUser, input: Record<string, unknown>, prev: Doc, doc: Doc) {
  const owner = isOwner(actor);
  if (isOwnerEmail(prev.email)) {
    if (!owner) throw new HttpError(403, 'Only the owner can edit the owner account');
    if (String(doc.email ?? '').toLowerCase() !== String(prev.email ?? '').toLowerCase()) {
      throw new ValidationError("The owner's email comes from the BOOTSTRAP_ADMIN_EMAIL setting and cannot be changed here");
    }
    if (doc.role !== 'admin') throw new ValidationError('The owner must stay an admin');
    if (doc.active === false) throw new ValidationError('The owner cannot be deactivated');
  }
  if ('role' in input && doc.role !== prev.role && !owner) throw new HttpError(403, 'Only the owner can change user roles');
  if (!owner && isOwnerEmail(doc.email)) throw new HttpError(403, 'Only the owner can use the owner email');
}

export function guardUserDelete(prev: Doc) {
  if (isOwnerEmail(prev.email)) throw new HttpError(403, 'The owner account cannot be deleted');
}

/** Every non-admin needs at least one project. */
export function requireAProject(doc: Doc, projectIds: string[]) {
  if (doc.role !== 'admin' && !projectIds.length) {
    throw new ValidationError('Select at least one project for this user (only admins can work without one)');
  }
}

/**
 * Makes `userId` a member of exactly `ids` (many-to-many through project.members).
 * Returns the names added/removed for the audit log.
 */
export async function setUserProjects(userId: string, ids: string[], by: string) {
  const store = getStore();
  const want = new Set(ids);
  const added: string[] = [];
  const removed: string[] = [];
  const now = new Date().toISOString();
  for (const p of await store.list('project')) {
    const members = Array.isArray(p.members) ? (p.members as string[]) : [];
    const has = members.includes(userId);
    if (want.has(p.id) === has) continue;
    // Re-read so concurrent membership edits on the same project are not lost.
    const fresh = (await store.get('project', p.id)) ?? p;
    const cur = Array.isArray(fresh.members) ? (fresh.members as string[]) : [];
    const next = want.has(p.id) ? [...new Set([...cur, userId])] : cur.filter((m) => m !== userId);
    await store.put({ ...fresh, members: next, updatedAt: now, updatedBy: by });
    (want.has(p.id) ? added : removed).push(String(p.name ?? p.id));
  }
  return { added, removed };
}

export const membershipSummary = (who: string, c: { added: string[]; removed: string[] }) =>
  `Projects for ${who}: ${[...c.added.map((n) => `+${n}`), ...c.removed.map((n) => `−${n}`)].join(', ')}`;

/**
 * Users a person may see: admins see everyone; others see themselves, admins and anyone sharing a project.
 * Admins additionally get each user's `projects`; everyone gets the `owner` flag.
 */
export async function visibleUsers(actor: SessionUser, users: Doc[]): Promise<Doc[]> {
  const projects = await getStore().list('project');
  const admin = actor.role === 'admin';
  const mine = new Set(memberOf(actor.id, projects));
  return users
    .filter((u) => admin || u.id === actor.id || u.role === 'admin' || memberOf(u.id, projects).some((id) => mine.has(id)))
    .map((u) => ({ ...u, owner: isOwnerEmail(u.email), ...(admin ? { projects: memberOf(u.id, projects) } : {}) }));
}
