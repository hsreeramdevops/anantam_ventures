import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fileUrl } from '../api';
import { useEntity } from '../auth';
import EntityForm from '../components/EntityForm';
import PayDialog, { CopyRow, outstanding, payToOf } from '../components/PayDialog';
import { useRefs } from '../components/useRefs';
import { fmtDate, money } from '../format';
import { Doc, FieldDef } from '../types';

const HIDDEN = new Set(['payee', 'vendorName', 'total', 'paidAmount', 'status', 'file', 'needsReview', 'remarks']);
const isImage = (name: string) => /\.(jpe?g|png|webp|gif)$/i.test(name);
const isPdf = (name: string) => /\.pdf$/i.test(name);
const pillClass = (s: unknown) => `pill ${String(s ?? '').replace(/\s/g, '-').toLowerCase()}`;

/** Prominent "how to pay" panel: big UPI / QR / bank details with copy buttons. */
function HowToPay({ bill, onEdit }: { bill: Doc; onEdit?: () => void }) {
  const [zoom, setZoom] = useState(false);
  const p = payToOf(bill);
  const payee = String(bill.payee ?? bill.vendorName ?? '');
  const due = outstanding(bill);
  if (!p) {
    return (
      <div className="howto empty">
        <p className="muted">No payment details on this bill yet.</p>
        {onEdit && <button className="btn small" onClick={onEdit}>Add how to pay</button>}
      </div>
    );
  }
  const vpa = p.mode === 'UPI' && p.upi?.includes('@') ? p.upi : null;
  const upiLink = vpa ? `upi://pay?${new URLSearchParams({ pa: vpa, pn: payee, am: String(due), cu: 'INR' })}` : null;
  return (
    <div className="howto">
      <div className="howto-mode">{p.mode === 'Bank' ? '🏦 Bank transfer' : p.mode === 'QR' ? '🔳 Scan QR code' : p.mode === 'UPI' ? '📱 UPI' : '💵 Cash'}</div>
      {p.mode === 'UPI' && p.upi && (
        <>
          <div className="howto-big">{p.upi}</div>
          <div className="row">
            <CopyRow label={vpa ? 'UPI ID' : 'UPI mobile'} value={p.upi} />
            {upiLink && <a className="btn primary" href={upiLink}>Open in UPI app</a>}
          </div>
        </>
      )}
      {p.mode === 'QR' && p.qrFile && (
        <>
          <button type="button" className="qr-zoom-btn" onClick={() => setZoom(true)} title="Tap to zoom">
            <img className="qr-big" src={fileUrl(p.qrFile)} alt={`QR code for ${payee}`} />
          </button>
          <span className="muted small">Tap the QR to enlarge it.</span>
          {zoom && (
            <div className="modal-bg qr-overlay" onClick={() => setZoom(false)}>
              <img src={fileUrl(p.qrFile)} alt={`QR code for ${payee}`} />
            </div>
          )}
        </>
      )}
      {p.mode === 'Bank' && (
        <div className="howto-bank">
          {p.accountHolder && <CopyRow label="Account holder" value={p.accountHolder} />}
          {p.accountNumber && <CopyRow label="Account number" value={p.accountNumber} />}
          {p.ifsc && <CopyRow label="IFSC" value={p.ifsc} />}
          {p.bankName && <CopyRow label="Bank" value={p.bankName} />}
        </div>
      )}
      {p.mode === 'Cash' && <p>Pay <b>{payee}</b> in cash and record it below.</p>}
      {due > 0 && <CopyRow label="Amount" value={String(due)} />}
    </div>
  );
}

/** Read-only bill page (/bills/:id): pay panel, details, payments, the attached bill file. */
export default function BillView() {
  const { id = '' } = useParams();
  const def = useEntity('bill');
  const { refs, label, reload: reloadRefs } = useRefs(def);
  const [bill, setBill] = useState<Doc | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setBill(await api.get<Doc>(`/api/entities/bill/${encodeURIComponent(id)}`)); setErr(''); } catch (x: any) { setErr(x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (err) return <section><p><Link to="/bills">← Bills</Link></p><p className="error">{err}</p></section>;
  if (!bill || !def) return <p className="muted">Loading…</p>;

  const canWrite = !!def.canWrite;
  const due = outstanding(bill);
  const unpaid = bill.status !== 'Paid' && Number(bill.total ?? 0) > 0;
  const payee = String(bill.payee ?? bill.vendorName ?? 'Bill');
  const history = Array.isArray(bill.payments) ? bill.payments as { amount: number; date: string; mode?: string; by?: string; note?: string }[] : [];
  const file = typeof bill.file === 'string' && bill.file ? bill.file : null;
  const edit = () => { reloadRefs(); setEditing(true); };

  const show = (f: FieldDef): string => {
    const v = bill[f.name];
    if (v === null || v === undefined || v === '') return '';
    if (f.type === 'money') return money(v);
    if (f.type === 'date') return fmtDate(v);
    if (f.type === 'boolean') return v ? 'Yes' : '';
    if (f.type === 'ref') return label(f.ref!, v);
    return String(v);
  };
  const details = def.fields.filter((f) => !HIDDEN.has(f.name) && f.type !== 'file').map((f) => [f.label, show(f)] as const).filter(([, v]) => v);

  const attach = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr('');
    try {
      const up = await api.upload('bills', f);
      await api.update('bill', bill.id, { file: up.name });
      await load();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };

  return (
    <section className="bill-view">
      <p><Link to="/bills">← Bills</Link></p>
      <div className="row bill-view-head">
        <div>
          <h1>{payee}</h1>
          <div className="row">
            <span className={pillClass(bill.status)}>{String(bill.status ?? '')}</span>
            {bill.needsReview === true && <span className="pill unpaid">Needs review</span>}
            {bill.source === 'guest' && <span className="pill guest">Guest upload</span>}
            {bill.source === 'payment-request' && <span className="pill payreq">Pay request</span>}
          </div>
        </div>
        <span className="spacer" />
        {canWrite && <button className="btn" onClick={edit}>Edit</button>}
        {canWrite && bill.needsReview === true && (
          <button className="btn" onClick={async () => { await api.update('bill', bill.id, { needsReview: false }); load(); }}>Mark reviewed</button>
        )}
      </div>

      <div className="card amounts">
        <div><span className="muted small">Amount</span><b>{money(bill.total)}</b></div>
        <div><span className="muted small">Paid</span><b>{money(bill.paidAmount ?? 0)}</b></div>
        <div><span className="muted small">Balance</span><b className={due > 0 ? 'due' : ''}>{money(due)}</b></div>
      </div>

      {unpaid && (
        <div className="card pay-panel">
          <h2>How to pay {payee}</h2>
          <HowToPay bill={bill} onEdit={canWrite ? edit : undefined} />
          {canWrite && (
            <button className="btn ok big block" onClick={() => setPaying(true)}>
              ✓ Mark as paid {due > 0 ? `(${money(due)})` : ''}
            </button>
          )}
        </div>
      )}

      <div className="card">
        <h2>Details</h2>
        <dl className="details">
          {bill.vendorName && bill.vendorName !== bill.payee ? <><dt>Vendor (on the bill)</dt><dd>{String(bill.vendorName)}</dd></> : null}
          {details.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
          {bill.remarks ? <><dt>Purpose / remarks</dt><dd>{String(bill.remarks)}</dd></> : null}
          {bill.submitterName ? (
            <><dt>Submitted by</dt><dd>{String(bill.submitterName)}{bill.submitterPhone ? ` · ${String(bill.submitterPhone)}` : ''}{bill.submitterEmail ? ` · ${String(bill.submitterEmail)}` : ''}</dd></>
          ) : null}
          {bill.createdAt ? <><dt>Added</dt><dd>{new Date(String(bill.createdAt)).toLocaleString('en-IN')}{bill.createdBy && bill.source !== 'guest' ? ` by ${String(bill.createdBy)}` : ''}</dd></> : null}
          {!unpaid && payToOf(bill) ? <><dt>How it is paid</dt><dd><HowToPay bill={bill} /></dd></> : null}
        </dl>
      </div>

      <div className="card">
        <h2>Payments</h2>
        {history.length
          ? <ul className="list small">{history.map((h, i) => (
            <li key={i}><span>{fmtDate(h.date)} · {h.mode ?? ''}{h.note ? ` · ${h.note}` : ''}{h.by ? ` · ${h.by}` : ''}</span><b>{money(h.amount)}</b></li>
          ))}</ul>
          : <p className="muted small">{bill.status === 'Paid' ? `Paid${bill.paidDate ? ` on ${fmtDate(bill.paidDate)}` : ''}.` : 'No payments recorded yet.'}</p>}
      </div>

      <div className="card">
        <div className="row">
          <h2>Bill file</h2>
          <span className="spacer" />
          {file && <a className="btn primary" href={fileUrl(file)} target="_blank" rel="noreferrer">Open original</a>}
          {canWrite && (
            <>
              <input ref={fileInput} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => attach(e.target.files?.[0])} />
              <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Uploading…' : file ? 'Replace file' : 'Attach file'}</button>
            </>
          )}
        </div>
        {!file && <p className="muted small">No bill file attached.</p>}
        {file && isImage(file) && <a href={fileUrl(file)} target="_blank" rel="noreferrer"><img className="bill-preview" src={fileUrl(file)} alt="Bill" /></a>}
        {file && isPdf(file) && <iframe className="bill-preview pdf" src={fileUrl(file)} title="Bill PDF" />}
      </div>

      {editing && (
        <EntityForm def={def} initial={bill} refs={refs} refLabel={label}
          onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      )}
      {paying && (
        <PayDialog bill={bill} canRecord={canWrite} hideDetails onClose={() => setPaying(false)}
          onSaved={() => { setPaying(false); load(); }} />
      )}
    </section>
  );
}
