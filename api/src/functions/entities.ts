import { app, HttpRequest } from '@azure/functions';
import { SessionUser } from '../auth/session';
import { ENTITIES, entityDef, isProjectScoped } from '../schema';
import { canRead, canWrite, createEntity, deleteEntity, getEntity, listEntities, updateEntity } from '../service';
import { requireProject } from '../projects';
import { HttpError, json, readJson, route } from '../http';
import { PayTo, payToFromJson } from './payrequest';
import { blobProjectId, isValidBlobName } from '../files/blob';
import { Doc } from '../store/types';
import { visibleUsers } from '../users';

/** A file field may only point at a file uploaded into this project (or keep its current value). */
function checkFiles(type: string, body: Record<string, unknown>, projectId: string | null, prev: Doc | null = null) {
  if (!projectId) return;
  for (const f of entityDef(type)?.fields ?? []) {
    const v = body[f.name];
    if (f.type !== 'file' || v === undefined || v === null || v === '' || v === prev?.[f.name]) continue;
    if (typeof v !== 'string' || !isValidBlobName(v) || blobProjectId(v) !== projectId) {
      throw new HttpError(400, `${f.label}: upload the file to this project first`);
    }
  }
}

/** Bills carry optional payee payment details (`payTo`), validated separately from the schema fields. */
function billExtra(type: string, body: Record<string, unknown>, projectId: string | null, prev: PayTo | null = null) {
  if (type !== 'bill' || !('payTo' in body) || !projectId) return {};
  return { payTo: payToFromJson(body.payTo, projectId, prev) };
}

app.http('schema', {
  methods: ['GET'], authLevel: 'anonymous', route: 'schema',
  handler: route(async (_req, _ctx, user) => json({
    entities: ENTITIES.filter((e) => e.read.includes(user!.role)).map((e) => ({ ...e, canWrite: e.write.includes(user!.role) })),
  })),
});

/** Resolves `?project=` for scoped types (access-checked); global types (users, audit) need none. */
async function projectFor(req: HttpRequest, user: SessionUser, type: string): Promise<string | null> {
  if (!entityDef(type) || !canRead(user, type)) throw new HttpError(404, 'Unknown entity');
  return isProjectScoped(type) ? (await requireProject(req, user)).id : null;
}

app.http('entityCollection', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'entities/{type}',
  handler: route(async (req, _ctx, user) => {
    const type = req.params.type;
    const projectId = await projectFor(req, user!, type);
    if (req.method === 'POST') {
      const body = await readJson(req);
      checkFiles(type, body, projectId);
      return json(await createEntity(user!, type, body, billExtra(type, body, projectId), projectId), 201);
    }
    let items = await listEntities(type, projectId);
    if (type === 'user') items = await visibleUsers(user!, items);
    items.sort((a, b) => String(b.createdAt ?? b.at ?? '').localeCompare(String(a.createdAt ?? a.at ?? '')));
    return json({ items, canWrite: canWrite(user!, type) });
  }),
});

app.http('entityItem', {
  methods: ['GET', 'PUT', 'DELETE'], authLevel: 'anonymous', route: 'entities/{type}/{id}',
  handler: route(async (req, _ctx, user) => {
    const { type, id } = req.params;
    const projectId = await projectFor(req, user!, type);
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const hasFile = entityDef(type)!.fields.some((f) => f.type === 'file' && f.name in body);
      const prev = (type === 'bill' && 'payTo' in body) || hasFile ? await getEntity(type, id, projectId) : null;
      checkFiles(type, body, projectId, prev);
      const extra = billExtra(type, body, projectId, (prev?.payTo as PayTo | undefined) ?? null);
      return json(await updateEntity(user!, type, id, body, projectId, extra));
    }
    if (req.method === 'DELETE') { await deleteEntity(user!, type, id, projectId); return { status: 204 }; }
    const doc = await getEntity(type, id, projectId);
    if (type === 'user') {
      const [v] = await visibleUsers(user!, [doc]);
      if (!v) throw new HttpError(404, 'Not found');
      return json(v);
    }
    return json(doc);
  }),
});
