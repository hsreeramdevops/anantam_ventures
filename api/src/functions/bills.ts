import { app } from '@azure/functions';
import { analyzeInvoice, docIntelConfigured, ParsedBill } from '../ai/docintel';
import { categorizeWithAi, normalizeName } from '../ai/categorize';
import { newBlobName, saveFile } from '../files/blob';
import { HttpError, json, route } from '../http';
import { canWrite, createEntity, findVendorByName } from '../service';
import { getStore } from '../store';
import { readUpload } from './files';

/**
 * Upload a bill → store file → AI-extract fields → categorise → create a bill flagged for review.
 * Parsing failures never lose the upload: the bill is still created for manual entry.
 */
app.http('billUpload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bills/upload',
  handler: route(async (req, ctx, user) => {
    if (!canWrite(user!, 'bill')) throw new HttpError(403, 'Not allowed');
    const { data, type, name } = await readUpload(req);
    const blobName = newBlobName('bills', name);
    await saveFile(blobName, data, type);

    let parsed: ParsedBill = { itemsText: '' };
    let parseError: string | null = null;
    if (docIntelConfigured()) {
      try { parsed = await analyzeInvoice(data); } catch (e: any) { parseError = e.message; ctx.warn(`bill parse failed: ${e.message}`); }
    } else {
      parseError = 'AI parsing is not configured; enter details manually.';
    }

    const vendor = parsed.vendorName ? await findVendorByName(parsed.vendorName) : null;
    const { category, phase } = await categorizeWithAi(parsed.itemsText || name, (vendor?.category as string) ?? null);

    let duplicateOf: string | null = null;
    if (parsed.billNumber && parsed.vendorName) {
      const key = normalizeName(parsed.vendorName);
      const dup = (await getStore().list('bill')).find((b) =>
        String(b.billNumber ?? '').trim() === parsed.billNumber && normalizeName(String(b.vendorName ?? '')) === key);
      duplicateOf = dup?.id ?? null;
    }

    const bill = await createEntity(user!, 'bill', {
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
    }, { aiParsed: !parseError, duplicateOf });

    return json({ bill, parseError, vendorMatched: !!vendor, suggestedVendor: !vendor ? parsed.vendorName ?? null : null, vendorGstin: parsed.vendorGstin ?? null }, 201);
  }),
});
