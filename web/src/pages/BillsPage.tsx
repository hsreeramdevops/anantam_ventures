import { useRef, useState } from 'react';
import { api } from '../api';
import { useEntity } from '../auth';
import { money } from '../format';
import { Doc } from '../types';
import EntityPage from './EntityPage';

interface UploadResult {
  bill: Doc;
  parseError: string | null;
  vendorMatched: boolean;
  suggestedVendor: string | null;
  vendorGstin: string | null;
}

const NEEDS_REVIEW = { label: 'Needs review', test: (d: Doc) => d.needsReview === true };

export default function BillsPage() {
  const def = useEntity('bill');
  const vendorDef = useEntity('vendor');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  async function upload(files: FileList | null, openEdit: (d: Doc) => void) {
    if (!files?.length) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      let last: UploadResult | null = null;
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        last = await api.post<UploadResult>('/api/bills/upload', fd);
      }
      setResult(last);
      setReloadKey((k) => k + 1);
      if (last && files.length === 1) openEdit(last.bill);
    } catch (x: any) { setErr(x.message); } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function addVendor() {
    if (!result?.suggestedVendor) return;
    try {
      const v = await api.create('vendor', { name: result.suggestedVendor, gstin: result.vendorGstin, category: result.bill.category, kind: 'Supplier' });
      await api.update('bill', result.bill.id, { vendorId: v.id });
      setResult({ ...result, vendorMatched: true, suggestedVendor: null });
      setReloadKey((k) => k + 1);
    } catch (x: any) { setErr(x.message); }
  }

  return (
    <>
      {def?.canWrite && (
        <div className="card upload-banner">
          <div>
            <strong>Upload bills</strong>
            <p className="muted small">PDF or photo. AI reads vendor, bill #, dates, amounts and GST, picks a category and flags the bill for your review.</p>
          </div>
          {busy && <span className="muted">Reading bill with AI…</span>}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {result && (
        <div className={`card notice ${result.parseError ? 'warn' : 'ok'}`}>
          {result.parseError
            ? <>Saved the file, but AI could not read it: {result.parseError}</>
            : <>Read <b>{String(result.bill.vendorName ?? 'unknown vendor')}</b> · {money(result.bill.total)} → <b>{String(result.bill.category)}</b>. Please review.</>}
          {result.bill.duplicateOf != null ? <div className="error small">Possible duplicate of an existing bill.</div> : null}
          {result.suggestedVendor && vendorDef?.canWrite && (
            <div><button className="btn small" onClick={addVendor}>Add “{result.suggestedVendor}” as a new vendor</button></div>
          )}
        </div>
      )}
      <EntityPage
        type="bill"
        reloadKey={reloadKey}
        defaults={{ status: 'Unpaid', category: 'Miscellaneous' }}
        quickFilter={NEEDS_REVIEW}
        badge={(d) => d.source === 'guest' && (
          <span className="pill guest" title={`Guest upload by ${String(d.submitterName ?? '')}${d.submitterPhone ? ` (${String(d.submitterPhone)})` : ''}${d.remarks ? `: ${String(d.remarks)}` : ''}`}>
            Guest: {String(d.submitterName ?? '')}
          </span>
        )}
        toolbar={(_reload, openEdit) => def?.canWrite && (
          <>
            <input ref={input} type="file" hidden multiple accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => upload(e.target.files, openEdit)} />
            <button className="btn accent" disabled={busy} onClick={() => input.current?.click()}>⬆ Upload bill (AI)</button>
          </>
        )}
        rowActions={(d, reload) => def?.canWrite && (
          <>
            {d.needsReview === true && (
              <button className="btn small" onClick={async () => { await api.update('bill', d.id, { needsReview: false }); reload(); }}>Mark reviewed</button>
            )}
            {d.status !== 'Paid' && (
              <button className="btn small ok" onClick={async () => {
                const mode = prompt('Payment mode (Cash, UPI, Bank Transfer, Cheque, Card)', 'Bank Transfer');
                if (mode === null) return;
                try { await api.update('bill', d.id, { status: 'Paid', paidAmount: d.total, paymentMode: mode || null }); reload(); }
                catch (x: any) { alert(x.message); }
              }}>Mark paid</button>
            )}
          </>
        )}
      />
    </>
  );
}
