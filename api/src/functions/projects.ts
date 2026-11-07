import crypto from 'crypto';
import { app } from '@azure/functions';
import { SessionUser } from '../auth/session';
import { HttpError, json, readJson, route } from '../http';
import { getAccessibleProject, listAccessibleProjects, newShareToken, publicProjectView, SHARE_FIELDS, ShareLinkKind } from '../projects';
import { PROJECT_DEF, validate, ValidationError } from '../schema';
import { audit } from '../service';
import { getStore } from '../store';

const requireAdmin = (user: SessionUser) => { if (user.role !== 'admin') throw new HttpError(403, 'Only admins can manage projects'); };

/** Members are user ids; unknown ids are rejected. `undefined` means "leave unchanged". */
async function readMembers(input: Record<string, unknown>): Promise<string[] | undefined> {
  if (!('members' in input)) return undefined;
  const raw = input.members;
  if (!Array.isArray(raw)) throw new ValidationError('members must be a list of user ids');
  const users = new Set((await getStore().list('user')).map((u) => u.id));
  const ids = [...new Set(raw.map(String))];
  if (ids.some((id) => !users.has(id))) throw new ValidationError('Unknown user in members');
  return ids;
}

app.http('projectCollection', {
  methods: ['GET', 'POST'], authLevel: 'anonymous', route: 'projects',
  handler: route(async (req, _ctx, user) => {
    if (req.method === 'GET') {
      const items = await listAccessibleProjects(user!);
      return json({ items: items.map((p) => publicProjectView(p, user!)), canManage: user!.role === 'admin', def: PROJECT_DEF });
    }
    requireAdmin(user!);
    const input = await readJson(req);
    const now = new Date().toISOString();
    const doc = await getStore().put({
      ...validate(PROJECT_DEF, { status: 'Active', ...input }), members: (await readMembers(input)) ?? [],
      shareToken: newShareToken(), shareEnabled: true,
      id: crypto.randomUUID(), type: 'project', createdAt: now, createdBy: user!.username,
    });
    await audit(user!, 'create', 'project', doc.id, `Project ${doc.name}`, doc.id);
    return json(doc, 201);
  }),
});

app.http('projectItem', {
  methods: ['GET', 'PUT'], authLevel: 'anonymous', route: 'projects/{id}',
  handler: route(async (req, _ctx, user) => {
    const prev = await getAccessibleProject(user!, req.params.id);
    if (req.method === 'GET') return json(publicProjectView(prev, user!));
    requireAdmin(user!);
    const input = await readJson(req);
    const members = await readMembers(input);
    const doc = await getStore().put({
      ...prev, ...validate(PROJECT_DEF, input, true), ...(members ? { members } : {}),
      updatedAt: new Date().toISOString(), updatedBy: user!.username,
    });
    await audit(user!, 'update', 'project', doc.id, `Project ${doc.name}`, doc.id);
    return json(doc);
  }),
});

/**
 * Public link management: `regenerate` (old link dies immediately), `disable`, `enable`.
 * `link` = `upload` (default) is the single project share link; it also revokes / disables / re-enables the
 * legacy payment-request alias. `link` = `pay` still manages that alias alone (older clients).
 */
app.http('projectShare', {
  methods: ['POST'], authLevel: 'anonymous', route: 'projects/{id}/share',
  handler: route(async (req, _ctx, user) => {
    requireAdmin(user!);
    const prev = await getAccessibleProject(user!, req.params.id);
    const body = await readJson(req);
    const action = body.action;
    const link = String(body.link ?? 'upload') as ShareLinkKind;
    if (!Object.hasOwn(SHARE_FIELDS, link)) throw new HttpError(400, 'link must be upload or pay');
    const f = SHARE_FIELDS[link];
    // The single "Project share link" (upload) also governs the legacy payment-request alias.
    const unified = link === 'upload';
    const patch: Record<string, unknown> = unified
      ? action === 'regenerate' ? { shareToken: newShareToken(), shareEnabled: true, payToken: null, payEnabled: false }
        : action === 'disable' ? { shareEnabled: false, payEnabled: false }
          : action === 'enable' && prev.shareToken ? { shareEnabled: true, payEnabled: !!prev.payToken } : {}
      :
      action === 'regenerate' ? { [f.token]: newShareToken(), [f.enabled]: true }
        : action === 'disable' ? { [f.enabled]: false }
          : action === 'enable' && prev[f.token] ? { [f.enabled]: true } : {};
    if (!Object.keys(patch).length) throw new HttpError(400, 'action must be regenerate, disable or enable');
    const doc = await getStore().put({ ...prev, ...patch, updatedAt: new Date().toISOString(), updatedBy: user!.username });
    await audit(user!, 'update', 'project', doc.id, `Project ${doc.name}: ${link === 'pay' ? 'payment request' : 'guest upload'} link ${action}d`, doc.id);
    return json(doc);
  }),
});
