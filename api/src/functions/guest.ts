import { app, HttpRequest } from '@azure/functions';
import { SessionUser } from '../auth/session';
import { HttpError, json, route } from '../http';
import { findProjectByShareToken } from '../projects';
import { clientIp, hitRateLimit } from '../ratelimit';
import { optionalEmail, ValidationError } from '../schema';
import { processBillUpload } from './bills';
import { readUpload } from './files';

/**
 * Public guest bill submission via a project's share link (/u/<token>). No login; guests can only
 * see the project name and submit. Every bad or disabled token gets the same 404.
 */
export const GUEST_LIMITS = {
  ipUploads: { max: 5, windowMs: 10 * 60 * 1000 },
  tokenUploads: { max: 20, windowMs: 60 * 60 * 1000 },
  ipLookups: { max: 60, windowMs: 10 * 60 * 1000 },
};

const NOT_FOUND = 'This upload link is invalid or has been disabled.';

async function projectForToken(req: HttpRequest) {
  const p = await findProjectByShareToken(req.params.token ?? '');
  if (!p) throw new HttpError(404, NOT_FOUND);
  return p;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export function readGuestFields(form: FormData) {
  const submitterName = field(form, 'name');
  const submitterPhone = field(form, 'phone');
  const remarks = field(form, 'remarks');
  if (!submitterName) throw new ValidationError('Your name is required');
  if (submitterName.length > 100) throw new ValidationError('Name is too long');
  if (!remarks) throw new ValidationError('Remarks are required');
  if (remarks.length > 1000) throw new ValidationError('Remarks are too long (max 1000 characters)');
  if (submitterPhone && !/^[0-9+()\s-]{6,20}$/.test(submitterPhone)) throw new ValidationError('Phone number looks invalid');
  const submitterEmail = optionalEmail(field(form, 'email'));
  return { submitterName, submitterPhone: submitterPhone || null, submitterEmail, remarks };
}

app.http('guestProject', {
  methods: ['GET'], authLevel: 'anonymous', route: 'public/projects/{token}',
  handler: route(async (req) => {
    await hitRateLimit(`guest-lookup-ip:${clientIp(req)}`, GUEST_LIMITS.ipLookups.max, GUEST_LIMITS.ipLookups.windowMs);
    const p = await projectForToken(req);
    return json({ name: p.name });
  }, { auth: false }),
});

app.http('guestUpload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'public/upload/{token}',
  handler: route(async (req, ctx) => {
    const { ipUploads, tokenUploads } = GUEST_LIMITS;
    await hitRateLimit(`guest-ip:${clientIp(req)}`, ipUploads.max, ipUploads.windowMs,
      'Too many uploads from your network. Please try again in a few minutes.');
    const project = await projectForToken(req);
    // Keyed on the token too, so regenerating the link also resets its limit.
    await hitRateLimit(`guest-token:${project.id}:${project.shareToken}`, tokenUploads.max, tokenUploads.windowMs,
      'This link has received too many uploads. Please try again later.');

    const upload = await readUpload(req);
    const fields = readGuestFields(upload.form);
    const actor: SessionUser = {
      id: 'guest', username: `guest:${fields.submitterName}`.slice(0, 120), name: fields.submitterName, email: '', role: 'engineer',
    };
    await processBillUpload(ctx, actor, project.id, upload, { remarks: fields.remarks },
      { source: 'guest', submitterName: fields.submitterName, submitterPhone: fields.submitterPhone, submitterEmail: fields.submitterEmail });
    return json({ ok: true, project: project.name }, 201);
  }, { auth: false }),
});
