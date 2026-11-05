import { config } from '../config';

/** Fields we extract from a bill. Every field may be missing. */
export interface ParsedBill {
  vendorName?: string;
  vendorGstin?: string;
  billNumber?: string;
  billDate?: string;
  dueDate?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  itemsText: string;
}

const API_VERSION = '2024-11-30';
export const docIntelConfigured = () => !!(config.docIntelEndpoint && config.docIntelKey);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls the prebuilt-invoice model. On F0 (free) tier only the first 2 pages are analysed, which is fine for bills. */
export async function analyzeInvoice(data: Buffer, timeoutMs = 30_000): Promise<ParsedBill> {
  const url = `${config.docIntelEndpoint}/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=${API_VERSION}`;
  const headers = { 'Ocp-Apim-Subscription-Key': config.docIntelKey, 'Content-Type': 'application/json' };
  const start = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ base64Source: data.toString('base64') }) });
  if (start.status !== 202) throw new Error(`Document Intelligence returned ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const opUrl = start.headers.get('operation-location');
  if (!opUrl) throw new Error('Document Intelligence did not return operation-location');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    const res = await fetch(opUrl, { headers: { 'Ocp-Apim-Subscription-Key': config.docIntelKey } });
    const body: any = await res.json();
    if (body.status === 'succeeded') return mapInvoice(body.analyzeResult);
    if (body.status === 'failed') throw new Error(`Analysis failed: ${JSON.stringify(body.error ?? {}).slice(0, 300)}`);
  }
  throw new Error('Document Intelligence timed out');
}

const text = (f: any): string | undefined => {
  const v = f?.valueString ?? f?.content;
  return typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : undefined;
};
const amount = (f: any): number | undefined => {
  const v = f?.valueCurrency?.amount ?? f?.valueNumber;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  const n = Number(String(f?.content ?? '').replace(/[^0-9.]/g, ''));
  return f?.content && Number.isFinite(n) && n > 0 ? n : undefined;
};
const date = (f: any): string | undefined =>
  typeof f?.valueDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.valueDate) ? f.valueDate.slice(0, 10) : undefined;

export function mapInvoice(result: any): ParsedBill {
  const f = result?.documents?.[0]?.fields ?? {};
  const items: string[] = (f.Items?.valueArray ?? [])
    .map((it: any) => text(it?.valueObject?.Description) ?? text(it))
    .filter(Boolean);
  const total = amount(f.InvoiceTotal) ?? amount(f.AmountDue);
  const subtotal = amount(f.SubTotal);
  let tax = amount(f.TotalTax);
  if (tax === undefined && total !== undefined && subtotal !== undefined && total >= subtotal) {
    tax = Math.round((total - subtotal) * 100) / 100;
  }
  return {
    vendorName: text(f.VendorName),
    vendorGstin: text(f.VendorTaxId),
    billNumber: text(f.InvoiceId),
    billDate: date(f.InvoiceDate),
    dueDate: date(f.DueDate),
    subtotal,
    tax,
    total,
    itemsText: [text(f.VendorName), ...items, String(result?.content ?? '').slice(0, 2000)].filter(Boolean).join('\n'),
  };
}
