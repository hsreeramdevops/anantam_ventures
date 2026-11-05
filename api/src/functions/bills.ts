import { app, InvocationContext } from '@azure/functions';
import { analyzeInvoice, docIntelConfigured, ParsedBill } from '../ai/docintel';
import { categorizeWithAi, normalizeName } from '../ai/categorize';
import { SessionUser } from '../auth/session';
import { newBlobName, saveFile } from '../files/blob';
import { HttpError, json, route } from '../http';
import { requireProject } from '../projects';
import { canWrite, createEntity, findVendorByName, listEntities } from '../service';
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
