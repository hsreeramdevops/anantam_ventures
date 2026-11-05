import { app, HttpRequest } from '@azure/functions';
import { SessionUser } from '../auth/session';
import { ENTITIES, entityDef, isProjectScoped } from '../schema';
import { canRead, canWrite, createEntity, deleteEntity, getEntity, listEntities, updateEntity } from '../service';
import { requireProject } from '../projects';
import { HttpError, json, readJson, route } from '../http';

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
    if (req.method === 'POST') return json(await createEntity(user!, type, await readJson(req), {}, projectId), 201);
    const items = await listEntities(type, projectId);
    items.sort((a, b) => String(b.createdAt ?? b.at ?? '').localeCompare(String(a.createdAt ?? a.at ?? '')));
    return json({ items, canWrite: canWrite(user!, type) });
  }),
});

app.http('entityItem', {
  methods: ['GET', 'PUT', 'DELETE'], authLevel: 'anonymous', route: 'entities/{type}/{id}',
  handler: route(async (req, _ctx, user) => {
    const { type, id } = req.params;
    const projectId = await projectFor(req, user!, type);
    if (req.method === 'PUT') return json(await updateEntity(user!, type, id, await readJson(req), projectId));
    if (req.method === 'DELETE') { await deleteEntity(user!, type, id, projectId); return { status: 204 }; }
    return json(await getEntity(type, id, projectId));
  }),
});
