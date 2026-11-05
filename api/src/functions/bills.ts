import { app, InvocationContext } from '@azure/functions';
import { analyzeInvoice, docIntelConfigured, ParsedBill } from '../ai/docintel';
import { categorizeWithAi, normalizeName } from '../ai/categorize';
import { SessionUser } from '../auth/session';
import { newBlobName, saveFile } from '../files/blob';
import { HttpError, json, readJson, route } from '../http';
import { requireProject } from '../projects';
import { PAY_MODES, ValidationError } from '../schema';
import { canWrite, createEntity, findVendorByName, getEntity, listEntities, updateEntity } from '../service';
import { readUpload, Upload } from './files';

/**
 * Store file → AI-extract fields → categorise → create a bill flagged for review in `projectId`.
 * Parsing failures never lose the upload: the bill is still created for manual entry.
 * Shared by staff uploads and public guest uploads.
 */
export async function processBillUpload(
  ctx: InvocationContext, actor: SessionUser, projectId: string, upload: Upload,
  input: Record<string, unknown> = {}, extra: Record<string, unknown> = {},
) {
  const { data, type, name } = upload;
  const blobName = newBlobName('bills', name, projectId);
  await saveFile(blobName, data, type);

  let parsed: ParsedBill = { itemsText: '' };
  let parseError: string | null = null;
  if (docIntelConfigured()) {
    try { parsed = await analyzeInvoice(data); } catch (e: any) { parseError = e.message; ctx.warn(`bill parse failed: ${e.message}`); }
  } else {
    parseError = 'AI parsing is not configured; enter details manually.';
  }

  const vendor = parsed.vendorName ? await findVendorByName(parsed.vendorName, projectId) : null;
  const { category, phase } = await categorizeWithAi(parsed.itemsText || name, (vendor?.category as string) ?? null);

  let duplicateOf: string | null = null;
  if (parsed.billNumber && parsed.vendorName) {
    const key = normalizeName(parsed.vendorName);
    const dup = (await listEntities('bill', projectId)).find((b) =>
      String(b.billNumber ?? '').trim() === parsed.billNumber && normalizeName(String(b.vendorName ?? '')) === key);
    duplicateOf = dup?.id ?? null;
  }

  const bill = await createEntity(actor, 'bill', {
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? parsed.vendorName ?? null,
    billNumber: parsed.billNumber ?? null,
    billDate: parsed.billDate ?? null,
    dueDate: parsed.dueDate ?? null,
    subtotal: parsed.subtotal ?? null,
    tax: parsed.tax ?? null,
    total: parsed.total ?? 0,
    category,
    phase: phase ?? null,
    status: 'Unpaid',
    file: blobName,
    needsReview: true,
    notes: duplicateOf ? 'Possible duplicate of an existing bill with the same vendor and bill number.' : null,
    ...input,
  }, { source: 'staff', aiParsed: !parseError, duplicateOf, ...extra }, projectId);

  return { bill, parseError, vendor, parsed };
}

app.http('billUpload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bills/upload',
  handler: route(async (req, ctx, user) => {
    if (!canWrite(user!, 'bill')) throw new HttpError(403, 'Not allowed');
    const project = await requireProject(req, user!);
    const { bill, parseError, vendor, parsed } = await processBillUpload(ctx, user!, project.id, await readUpload(req));
    return json({ bill, parseError, vendorMatched: !!vendor, suggestedVendor: !vendor ? parsed.vendorName ?? null : null, vendorGstin: parsed.vendorGstin ?? null }, 201);
  }),
});

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Records a (possibly partial) payment against a bill: adds to `paidAmount`, sets status to Paid once the
 * total is covered (else Partially Paid) and appends to the bill's `payments` history.
 */
export function applyPayment(bill: Record<string, unknown>, input: Record<string, unknown>, by: string) {
  const total = Number(bill.total ?? 0);
  const paidSoFar = Number(bill.paidAmount ?? 0);
  const outstanding = r2(total - paidSoFar);
  if (!(total > 0)) throw new ValidationError('Set the bill total before recording a payment');
  if (bill.status === 'Paid' || outstanding <= 0) throw new ValidationError('This bill is already fully paid');
  const amount = input.amount === undefined || input.amount === null || input.amount === '' ? outstanding : r2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Amount must be more than 0');
  if (amount > outstanding + 0.005) throw new ValidationError(`Amount is more than the balance due (${outstanding})`);
  const date = String(input.date ?? '') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('Paid date must be YYYY-MM-DD');
  const mode = input.mode ? String(input.mode) : null;
  if (mode && !(PAY_MODES as readonly string[]).includes(mode)) throw new ValidationError('Invalid payment mode');
  const note = input.note ? String(input.note).slice(0, 300) : null;
  const paidAmount = r2(paidSoFar + amount);
  const history = Array.isArray(bill.payments) ? bill.payments : [];
  return {
    changes: { paidAmount, paidDate: date, paymentMode: mode, status: paidAmount >= total - 0.005 ? 'Paid' : 'Partially Paid' },
    extra: { payments: [...history, { amount, date, mode, note, by, at: new Date().toISOString() }] },
  };
}

app.http('billPayment', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bills/{id}/payment',
  handler: route(async (req, _ctx, user) => {
    if (!canWrite(user!, 'bill')) throw new HttpError(403, 'Not allowed');
    const project = await requireProject(req, user!);
    const bill = await getEntity('bill', req.params.id ?? '', project.id);
    const { changes, extra } = applyPayment(bill, await readJson(req), user!.username);
    return json(await updateEntity(user!, 'bill', bill.id, changes, project.id, extra));
  }),
});
