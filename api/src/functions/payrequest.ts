import { app, HttpRequest } from '@azure/functions';
import { categorizeWithAi } from '../ai/categorize';
import { SessionUser } from '../auth/session';
import { MAX_UPLOAD_BYTES } from '../config';
import { isValidBlobName, newBlobName, saveFile, sniffType } from '../files/blob';
import { HttpError, json, route } from '../http';
import { findProjectByPublicToken, requireProject } from '../projects';
import { clientIp, hitRateLimit } from '../ratelimit';
import { optionalEmail, ValidationError } from '../schema';
import { canWrite, createEntity, findVendorByName } from '../service';
import { GUEST_LIMITS } from './guest';

/**
 * Public "Raise a payment request" link (/pay/<token>): anyone with the link can ask for a payment to a
 * payee. It lands as an Unpaid bill needing review, carrying the payee's UPI / QR / bank details.
 */
export const PAY_REQUEST_MODES = ['UPI', 'QR', 'Bank', 'Cash'] as const;
export type PayRequestMode = (typeof PAY_REQUEST_MODES)[number];
const QR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const NOT_FOUND = 'This payment request link is invalid or has been disabled.';
const MAX_AMOUNT = 10_000_000;

export interface PayTo {
  mode: PayRequestMode;
  upi?: string;
  qrFile?: string;
  accountHolder?: string;
  accountNumber?: string;
  ifsc?: string;
  bankName?: string | null;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** 10-digit Indian mobile (optional +91/91/0 prefix, spaces/dashes ignored) → bare 10 digits. */
export function normalizeMobile(v: string): string | null {
  const d = v.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
export const isUpiId = (v: string) => /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(v);
export const isIfsc = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v);
export const isAccountNumber = (v: string) => /^\d{9,18}$/.test(v);

/** Parses "25,400", "₹ 7000.50" etc. */
export function parseAmount(v: string): number | null {
  const n = Number(v.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Validates payee payment details (UPI / QR / bank / cash) read through `get` (form field or JSON key).
 * The QR image itself is handled by the caller.
 */
export function parsePayTo(get: (name: string) => string, mode: string): PayTo {
  if (!PAY_REQUEST_MODES.includes(mode as PayRequestMode)) throw new ValidationError('Choose a payment mode');
  const payTo: PayTo = { mode: mode as PayRequestMode };
  if (mode === 'UPI') {
    const raw = get('upi');
    const mobile = normalizeMobile(raw);
    if (mobile) payTo.upi = mobile;
    else if (isUpiId(raw)) payTo.upi = raw.toLowerCase();
    else throw new ValidationError('Enter a 10-digit mobile number or a UPI ID like name@bank');
  } else if (mode === 'Bank') {
    const accountHolder = get('accountHolder');
    const accountNumber = get('accountNumber').replace(/[\s-]/g, '');
    const ifsc = get('ifsc').replace(/\s/g, '').toUpperCase();
    const bankName = get('bankName');
    if (!accountHolder || accountHolder.length > 100) throw new ValidationError('Account holder name is required');
    if (!isAccountNumber(accountNumber)) throw new ValidationError('Account number must be 9–18 digits');
    if (get('accountNumber2') && get('accountNumber2').replace(/[\s-]/g, '') !== accountNumber) {
      throw new ValidationError('Account numbers do not match');
    }
    if (!isIfsc(ifsc)) throw new ValidationError('IFSC looks invalid (e.g. SBIN0001234)');
    if (bankName.length > 100) throw new ValidationError('Bank name is too long');
    Object.assign(payTo, { accountHolder, accountNumber, ifsc, bankName: bankName || null });
  }
  return payTo;
}

/**
 * Pay details sent as JSON on a bill create/update (`payTo`): null/empty mode clears them. A QR must be an
 * image already uploaded to this project's documents folder; editing other fields keeps the existing QR.
 */
export function payToFromJson(raw: unknown, projectId: string, prev: PayTo | null = null): PayTo | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Invalid payment details');
  const o = raw as Record<string, unknown>;
  const get = (k: string) => (typeof o[k] === 'string' || typeof o[k] === 'number' ? String(o[k]).trim() : '');
  const mode = get('mode');
  if (!mode) return null;
  const payTo = parsePayTo(get, mode);
  if (mode === 'QR') {
    const qrFile = get('qrFile') || prev?.qrFile || '';
    if (!qrFile) throw new ValidationError('Upload the QR code image');
    if (!isValidBlobName(qrFile) || !qrFile.startsWith(`p/${projectId}/documents/`) || !/\.(jpe?g|png|webp)$/i.test(qrFile)) {
      if (qrFile !== prev?.qrFile) throw new ValidationError('QR code must be a JPEG, PNG or WEBP image uploaded to this project');
    }
    payTo.qrFile = qrFile;
  }
  return payTo;
}

/** Validates the text fields of the public form (the QR image is checked separately). */
export function readPayRequestFields(form: FormData) {
  const payee = field(form, 'payee');
  const purpose = field(form, 'purpose');
  const requesterName = field(form, 'requesterName');
  const requesterPhone = field(form, 'requesterPhone');
  const mode = field(form, 'mode') as PayRequestMode;
  if (!payee) throw new ValidationError('Name of the person to be paid is required');
  if (payee.length > 100) throw new ValidationError('Payee name is too long');
  const amount = parseAmount(field(form, 'amount'));
  if (amount === null) throw new ValidationError('Enter a valid amount in ₹');
  if (purpose.length > 1000) throw new ValidationError('Purpose is too long (max 1000 characters)');
  if (requesterName.length > 100) throw new ValidationError('Your name is too long');
  if (requesterPhone && !/^[0-9+()\s-]{6,20}$/.test(requesterPhone)) throw new ValidationError('Your phone number looks invalid');

  const payTo = parsePayTo((k) => field(form, k), mode);
  const requesterEmail = optionalEmail(field(form, 'requesterEmail'));
  return { payee, amount, purpose, requesterName: requesterName || null, requesterPhone: requesterPhone || null, requesterEmail, payTo };
}

/** QR image: JPEG/PNG/WEBP by magic bytes, same size limit as bill uploads. */
async function readQr(form: FormData): Promise<{ data: Buffer; type: string; name: string }> {
  const file = form.get('qr');
  if (!file || typeof file === 'string') throw new ValidationError('Upload the QR code image');
  const data = Buffer.from(await (file as Blob).arrayBuffer());
  if (!data.length) throw new ValidationError('Upload the QR code image');
  if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large (max 10 MB)');
  const type = sniffType(data);
  if (!type || !QR_TYPES.includes(type)) throw new HttpError(415, 'QR code must be a JPEG, PNG or WEBP image');
  return { data, type, name: (file as File).name || 'qr.png' };
}

async function readPayRequestForm(req: HttpRequest): Promise<FormData> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, 'File too large (max 10 MB)');
  const form = await req.formData().catch(() => null);
  if (!form) throw new HttpError(400, 'Invalid form');
  return form;
}

/** Saves the QR (if any), categorises and creates the Unpaid payment-request bill. */
async function createPaymentRequestBill(
  actor: SessionUser, projectId: string, f: ReturnType<typeof readPayRequestFields>, form: FormData,
  needsReview: boolean, extra: Record<string, unknown> = {},
) {
  if (f.payTo.mode === 'QR') {
    const qr = await readQr(form);
    const name = newBlobName('documents', `qr-${qr.name}`, projectId);
    await saveFile(name, qr.data, qr.type);
    f.payTo.qrFile = name;
  }
  const vendor = await findVendorByName(f.payee, projectId);
  const { category, phase } = await categorizeWithAi(`${f.purpose} ${f.payee}`.trim(), (vendor?.category as string) ?? null);
  return createEntity(actor, 'bill', {
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? f.payee,
    billDate: new Date().toISOString().slice(0, 10),
    total: f.amount,
    category,
    phase: phase ?? null,
    status: 'Unpaid',
    needsReview,
    remarks: f.purpose || null,
    payee: f.payee,
  }, { source: 'payment-request', payTo: f.payTo, ...extra }, projectId);
}

async function projectForToken(req: HttpRequest) {
  const p = await findProjectByPublicToken(req.params.token ?? '');
  if (!p) throw new HttpError(404, NOT_FOUND);
  return p;
}

app.http('payRequestProject', {
  methods: ['GET'], authLevel: 'anonymous', route: 'public/pay/{token}',
  handler: route(async (req) => {
    await hitRateLimit(`pay-lookup-ip:${clientIp(req)}`, GUEST_LIMITS.ipLookups.max, GUEST_LIMITS.ipLookups.windowMs);
    const p = await projectForToken(req);
    return json({ name: p.name });
  }, { auth: false }),
});

app.http('payRequestSubmit', {
  methods: ['POST'], authLevel: 'anonymous', route: 'public/pay/{token}',
  handler: route(async (req) => {
    const { ipUploads, tokenUploads } = GUEST_LIMITS;
    await hitRateLimit(`pay-ip:${clientIp(req)}`, ipUploads.max, ipUploads.windowMs,
      'Too many requests from your network. Please try again in a few minutes.');
    const project = await projectForToken(req);
    await hitRateLimit(`pay-token:${project.id}:${req.params.token}`, tokenUploads.max, tokenUploads.windowMs,
      'This link has received too many requests. Please try again later.');

    const form = await readPayRequestForm(req);
    const f = readPayRequestFields(form);
    const who = f.requesterName ?? f.payee;
    const actor: SessionUser = {
      id: 'guest', username: `guest:${who}`.slice(0, 120), name: who, email: '', role: 'engineer',
    };
    await createPaymentRequestBill(actor, project.id, f, form, true, {
      submitterName: f.requesterName, submitterPhone: f.requesterPhone, submitterEmail: f.requesterEmail,
    });
    return json({ ok: true, project: project.name }, 201);
  }, { auth: false }),
});

/** Team members raise a payment request from the Bills page: same form, no review flag, they are the creator. */
app.http('billPaymentRequest', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bills/payment-request',
  handler: route(async (req, _ctx, user) => {
    if (!canWrite(user!, 'bill')) throw new HttpError(403, 'Not allowed');
    const project = await requireProject(req, user!);
    const form = await readPayRequestForm(req);
    const f = readPayRequestFields(form);
    return json(await createPaymentRequestBill(user!, project.id, f, form, false), 201);
  }),
});
