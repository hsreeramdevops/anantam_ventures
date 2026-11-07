import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useEntity } from '../auth';
import { money } from '../format';
import { Doc } from '../types';
import PayDialog, { outstanding, payToOf } from '../components/PayDialog';
import PaymentRequestDialog from '../components/PaymentRequestDialog';
import { caseClass, Dim, HatchBar, ReviewCloud } from '../components/fw';
import EntityPage from './EntityPage';

interface UploadResult {
  bill: Doc;
  parseError: string | null;
  vendorMatched: boolean;
  suggestedVendor: string | null;
  vendorGstin: string | null;
}

const NEEDS_REVIEW = { label: 'Needs review', test: (d: Doc) => d.needsReview === true };
// Unpaid includes Partially Paid: anything with a balance still to pay.
const TABS = [
  { key: 'unpaid', label: 'Unpaid', test: (d: Doc) => d.status !== 'Paid' },
  { key: 'paid', label: 'Paid', test: (d: Doc) => d.status === 'Paid' },
  { key: 'all', label: 'All', test: () => true },
];
const sum = (items: Doc[], f: (d: Doc) => number) => items.reduce((s, d) => s + f(d), 0);
const tabSummary = (items: Doc[], key: string) => key === 'unpaid'
  ? `${items.length} · ${money(sum(items, outstanding))} due`
  : `${items.length} · ${money(sum(items, (d) => Number(d.total ?? 0)))}`;
const ORDER = ['billNumber', 'payee', 'category', 'billDate', 'dueDate', 'status', 'total'];
const HIDE = ['needsReview'];
const payeeOf = (d: Doc) => String(d.payee || d.vendorName || '—');

function Hero({ items, tab }: { items: Doc[]; tab?: string }) {
  const total = sum(items, (d) => Number(d.total ?? 0));
  const due = sum(items, outstanding);
  const paid = total - due;
  const partial = items.filter((d) => d.status === 'Partially Paid').length;
  const showDue = tab !== 'paid';
  return (
    <div className="figure">
      <div>
        <span className="lbl">{showDue ? 'Outstanding' : 'Paid out'} · {items.length} bill{items.length === 1 ? '' : 's'}</span>
        <div className={`big ${showDue && due > 0 ? 'u' : ''}`}>{money(showDue ? due : total)}</div>
        {showDue && partial > 0 && <span className="muted small">{partial} part-paid · {money(paid)} already paid</span>}
      </div>
      {total > 0 && (
        <div className="split">
          <Dim>{money(total)} billed</Dim>
          <HatchBar total={total} paid={paid} size="big" />
          <div className="legend">
            <span><i className="sw paid" />Paid {money(paid)}</span>
            <span><i className="sw due" />Balance {money(due)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BillsPage() {
  const def = useEntity('bill');
  const vendorDef = useEntity('vendor');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [err, setErr] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [paying, setPaying] = useState<Doc | null>(null);
  const [requesting, setRequesting] = useState(false);
  const nav = useNavigate();
  const [search] = useSearchParams();
  const openId = search.get('open');
  // Older alert links (?open=<id>) go to the bill's own page.
  useEffect(() => { if (openId) nav(`/bills/${encodeURIComponent(openId)}`, { replace: true }); }, [openId, nav]);

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

  const open = (d: Doc) => nav(`/bills/${encodeURIComponent(d.id)}`);
  return (
    <>
      {busy && <div className="notice">Reading bill with AI… vendor, bill #, dates, amounts and GST.</div>}
      {err && <p className="error">{err}</p>}
      {result && (
        <div className={`notice ${result.parseError ? 'warn' : 'ok'}`}>
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
        sheet="Bills"
        reloadKey={reloadKey}
        defaults={{ status: 'Unpaid', category: 'Miscellaneous' }}
        quickFilter={NEEDS_REVIEW}
        tabs={TABS}
        tabSummary={tabSummary}
        hero={(items, tab) => <Hero items={items} tab={tab} />}
        newClass=""
        order={ORDER}
        hideCols={HIDE}
        onOpen={open}
        rowClass={(d) => (d.needsReview === true ? 'cloud' : '')}
        footer={(rows) => (
          <div className="sum">
            <span className="row"><span className="lbl">Total</span><Dim>{rows.length} rows</Dim><b>{money(sum(rows, (d) => Number(d.total ?? 0)))}</b></span>
            <span className="row"><span className="lbl">Balance</span><Dim>to pay</Dim><b className="u">{money(sum(rows, outstanding))}</b></span>
          </div>
        )}
        cellRender={(f, d) => {
          if (f.name === 'billNumber') return <span className="mono">{String(d.billNumber || '—')}</span>;
          if (f.name === 'payee') {
            const sub = String(d.remarks || d.category || '');
            return (
              <span className="who">
                <b className={caseClass(payeeOf(d))}>{payeeOf(d)}</b>
                <span className="meta">
                  {d.source === 'guest' && <span className="src" title={`Guest upload by ${String(d.submitterName ?? '')}${d.submitterPhone ? ` (${String(d.submitterPhone)})` : ''}`}>Guest · {String(d.submitterName ?? '')}</span>}
                  {d.source === 'payment-request' && <span className="src" title={d.submitterName ? `Requested by ${String(d.submitterName)}` : 'Payment request'}>Pay request</span>}
                  {d.needsReview === true && <ReviewCloud />}
                  {sub && <span className={`small muted ${caseClass(sub)}`}>{sub}</span>}
                </span>
              </span>
            );
          }
          if (f.name === 'total') {
            const total = Number(d.total ?? 0);
            const due = outstanding(d);
            if (d.status === 'Partially Paid') return (
              <span className="amt"><b>{money(due)}</b><span className="small muted">of {money(total)}</span><HatchBar total={total} paid={total - due} size="mini" /></span>
            );
            return <span className="amt"><b>{money(total)}</b></span>;
          }
          return undefined;
        }}
        toolbar={(_reload, openEdit) => def?.canWrite && (
          <>
            <input ref={input} type="file" hidden multiple accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => upload(e.target.files, openEdit)} />
            <button className="btn primary" onClick={() => setRequesting(true)}>+ Payment request</button>
            <button className="btn" disabled={busy} onClick={() => input.current?.click()} title="PDF or photo. AI reads vendor, bill #, dates, amounts and GST and flags the bill for review.">⬆ Upload bill (AI)</button>
          </>
        )}
        rowActions={(d, reload) => (
          <>
            <button className="btn small go" onClick={() => open(d)}>View →</button>
            {def?.canWrite && d.needsReview === true && (
              <button className="btn small" onClick={async () => { await api.update('bill', d.id, { needsReview: false }); reload(); }}>Mark reviewed</button>
            )}
            {def?.canWrite && d.status !== 'Paid' && Number(d.total ?? 0) > 0 && (
              <button className="btn small" onClick={() => setPaying(d)}>{payToOf(d) ? 'Pay' : 'Mark paid'}</button>
            )}
          </>
        )}
      />
      {requesting && (
        <PaymentRequestDialog onClose={() => setRequesting(false)}
          onSaved={() => { setRequesting(false); setReloadKey((k) => k + 1); }} />
      )}
      {paying && (
        <PayDialog bill={paying} canRecord={!!def?.canWrite} onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); setReloadKey((k) => k + 1); }} />
      )}
    </>
  );
}
