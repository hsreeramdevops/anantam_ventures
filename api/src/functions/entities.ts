import { app } from '@azure/functions';
import { ENTITIES, entityDef } from '../schema';
import { canRead, canWrite, createEntity, deleteEntity, updateEntity } from '../service';
import { getStore } from '../store';
import { HttpError, json, readJson, route } from '../http';

app.http('schema', {
  methods: ['GET'], authLevel: 'anonymous', route: 'schema',
  handler: route(async (_req, _ctx, user) => json({
    entities: ENTITIES.filter((e) => e.read.includes(user!.role)).map((e) => ({ ...e, canWrite: e.write.includes(user!.role) })),
  })),
});

app.http('entityCollection', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'entities/{type}',
  handler: route(async (req, _ctx, user) => {
    const type = req.params.type;
    if (!entityDef(type) || !canRead(user!, type)) throw new HttpError(404, 'Unknown entity');
    if (req.method === 'POST') return json(await createEntity(user!, type, await readJson(req)), 201);
    const items = await getStore().list(type);
    items.sort((a, b) => String(b.createdAt ?? b.at ?? '').localeCompare(String(a.createdAt ?? a.at ?? '')));
    return json({ items, canWrite: canWrite(user!, type) });
  }),
});

app.http('entityItem', {
  methods: ['GET', 'PUT', 'DELETE'], authLevel: 'anonymous', route: 'entities/{type}/{id}',
  handler: route(async (req, _ctx, user) => {
    const { type, id } = req.params;
    if (!entityDef(type) || !canRead(user!, type)) throw new HttpError(404, 'Unknown entity');
    if (req.method === 'PUT') return json(await updateEntity(user!, type, id, await readJson(req)));
    if (req.method === 'DELETE') { await deleteEntity(user!, type, id); return { status: 204 }; }
    const doc = await getStore().get(type, id);
    if (!doc) throw new HttpError(404, 'Not found');
    return json(doc);
  }),
});
