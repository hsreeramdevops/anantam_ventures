import { app, HttpRequest } from '@azure/functions';
import { SessionUser } from '../auth/session';
import { HttpError, json, route } from '../http';
import crypto from 'crypto';
import { findProjectByPublicToken } from '../projects';
import { clientIp, hitRateLimit } from '../ratelimit';
import { optionalEmail, ValidationError } from '../schema';
import { getStore } from '../store';
import { createBillFromRead, ReadBill, storeAndReadBill } from './bills';
import { readUpload } from './files';

/**
 * Public guest bill submission via a project's share link (/u/<token>). No login; guests can only
 * see the project name and submit. Every bad or disabled token gets the same 404.
 * Two steps so the guest can confirm whom to pay: `read` stores + AI-reads the file into a short-lived
 * draft (the only step that costs Document Intelligence pages), then the submit turns the draft into a bill.
 */
export const GUEST_LIMITS = {
  ipUploads: { max: 5, windowMs: 10 * 60 * 1000 },
  tokenUploads: { max: 20, windowMs: 60 * 60 * 1000 },
  ipLookups: { max: 60, windowMs: 10 * 60 * 1000 },
};

const NOT_FOUND = 'This link is invalid or has been disabled.';
const DRAFT_TTL_S = 6 * 3600;

async function projectForToken(req: HttpRequest) {
  const p = await findProjectByPublicToken(req.params.token ?? '');
  if (!p) throw new HttpError(404, NOT_FOUND);
  return p;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export function readGuestFields(form: FormData) {
  const payee = field(form, 'payee');
  if (!payee) throw new ValidationError('Whom to pay is required');
  if (payee.length > 100) throw new ValidationError('Whom to pay is too long');
  const submitterName = field(form, 'name');
  const submitterPhone = field(form, 'phone');
  const remarks = field(form, 'remarks');
  if (!submitterName) throw new ValidationError('Your name is required');
  if (submitterName.length > 100) throw new ValidationError('Name is too long');
  if (!remarks) throw new ValidationError('Remarks are required');
  if (remarks.length > 1000) throw new ValidationError('Remarks are too long (max 1000 characters)');
  if (submitterPhone && !/^[0-9+()\s-]{6,20}$/.test(submitterPhone)) throw new ValidationError('Phone number looks invalid');
  const submitterEmail = optionalEmail(field(form, 'email'));
  return { payee, submitterName, submitterPhone: submitterPhone || null, submitterEmail, remarks };
}

app.http('guestProject', {
  methods: ['GET'], authLevel: 'anonymous', route: 'public/projects/{token}',
  handler: route(async (req) => {
    await hitRateLimit(`guest-lookup-ip:${clientIp(req)}`, GUEST_LIMITS.ipLookups.max, GUEST_LIMITS.ipLookups.windowMs);
    const p = await projectForToken(req);
    return json({ name: p.name });
  }, { auth: false }),
});

async function ipUploadLimit(req: HttpRequest) {
  const { ipUploads } = GUEST_LIMITS;
  await hitRateLimit(`guest-ip:${clientIp(req)}`, ipUploads.max, ipUploads.windowMs,
    'Too many uploads from your network. Please try again in a few minutes.');
}

async function tokenUploadLimit(project: { id: string; shareToken?: unknown }) {
  const { tokenUploads } = GUEST_LIMITS;
  // Keyed on the token too, so regenerating the link also resets its limit.
  await hitRateLimit(`guest-token:${project.id}:${String(project.shareToken)}`, tokenUploads.max, tokenUploads.windowMs,
    'This link has received too many uploads. Please try again later.');
}

/** Step 1: store + AI-read the bill; returns what was read so the guest can confirm whom to pay. */
app.http('guestRead', {
  methods: ['POST'], authLevel: 'anonymous', route: 'public/upload/{token}/read',
  handler: route(async (req, ctx) => {
    // IP limit first: bad tokens still count against the IP (slows guessing).
    await ipUploadLimit(req);
    const project = await projectForToken(req);
    await tokenUploadLimit(project);
    const read = await storeAndReadBill(ctx, project.id, await readUpload(req));
    const draftId = crypto.randomBytes(24).toString('base64url');
    await getStore().put({ id: draftId, type: 'guestdraft', projectId: project.id, ...read, createdAt: new Date().toISOString() }, DRAFT_TTL_S);
    const p = read.parsed;
    return json({
      draft: draftId, read: !read.parseError,
      vendorName: p.vendorName ?? null, total: p.total ?? null, billDate: p.billDate ?? null, billNumber: p.billNumber ?? null,
    }, 201);
  }, { auth: false }),
});

/** Step 2 (`draft` from step 1), or the older one-step form with the `file` itself. */
app.http('guestUpload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'public/upload/{token}',
  handler: route(async (req, ctx) => {
    const form = await req.formData().catch(() => null);
    const draftId = form?.get('draft');
    const useDraft = typeof draftId === 'string' && !!draftId;
    // The file was already counted (and paid for) by the read step; a draft submit only counts as a lookup.
    if (useDraft) await hitRateLimit(`guest-lookup-ip:${clientIp(req)}`, GUEST_LIMITS.ipLookups.max, GUEST_LIMITS.ipLookups.windowMs);
    else await ipUploadLimit(req);
    const project = await projectForToken(req);
    if (!form) throw new HttpError(400, 'Invalid form');
    let read: ReadBill;
    let draftKey: string | null = null;
    if (useDraft) {
      const d = /^[A-Za-z0-9_-]{32}$/.test(draftId) ? await getStore().get('guestdraft', draftId) : null;
      const fresh = d && Date.now() - Date.parse(String(d.createdAt)) < DRAFT_TTL_S * 1000;
      if (!d || !fresh || d.projectId !== project.id) throw new HttpError(400, 'Your upload expired. Please choose the bill file again.');
      readGuestFields(form);
      read = { blobName: String(d.blobName), parsed: d.parsed as ReadBill['parsed'], parseError: (d.parseError as string) ?? null };
      draftKey = draftId;
    } else {
      await tokenUploadLimit(project);
      const upload = await readUpload(req, form);
      readGuestFields(form);
      read = await storeAndReadBill(ctx, project.id, upload);
    }
    const fields = readGuestFields(form);
    const actor: SessionUser = {
      id: 'guest', username: `guest:${fields.submitterName}`.slice(0, 120), name: fields.submitterName, email: '', role: 'engineer',
    };
    const { bill } = await createBillFromRead(actor, project.id, read, { remarks: fields.remarks, payee: fields.payee },
      { source: 'guest', submitterName: fields.submitterName, submitterPhone: fields.submitterPhone, submitterEmail: fields.submitterEmail });
    if (draftKey) await getStore().delete('guestdraft', draftKey);
    return json({ ok: true, project: project.name, total: bill.total ?? null, payee: bill.payee }, 201);
  }, { auth: false }),
});
