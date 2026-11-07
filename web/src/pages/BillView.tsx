import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fileUrl } from '../api';
import { useEntity } from '../auth';
import EntityForm from '../components/EntityForm';
import { CopyRow, outstanding, payToOf, RecordPayment } from '../components/PayDialog';
import { caseClass, HatchBar, ReviewCloud, StatusTag } from '../components/fw';
import { useRefs } from '../components/useRefs';
import { fmtDate, money } from '../format';
import { Doc, FieldDef } from '../types';

const HIDDEN = new Set(['payee', 'vendorName', 'total', 'paidAmount', 'status', 'file', 'needsReview', 'remarks']);
const isImage = (name: string) => /\.(jpe?g|png|webp|gif)$/i.test(name);
const isPdf = (name: string) => /\.pdf$/i.test(name);
const fileName = (f: string) => f.split('/').pop() ?? f;

const MODE_LABEL: Record<string, string> = { UPI: 'UPI', QR: 'Scan QR code', Bank: 'Bank transfer', Cash: 'Cash' };

/** How-to-pay body: big UPI / QR / bank details with stencil copy chips. */
function HowToPay({ bill, onEdit }: { bill: Doc; onEdit?: () => void }) {
  const [zoom, setZoom] = useState(false);
  const p = payToOf(bill);
  const payee = String(bill.payee ?? bill.vendorName ?? '');
  const due = outstanding(bill);
  if (!p) {
    return (
      <>
        <p className="muted">No payment details on this bill yet.</p>
        {onEdit && <button className="btn small" onClick={onEdit}>Add how to pay</button>}
      </>
    );
  }
  const vpa = p.mode === 'UPI' && p.upi?.includes('@') ? p.upi : null;
  const upiLink = vpa ? `upi://pay?${new URLSearchParams({ pa: vpa, pn: payee, am: String(due), cu: 'INR' })}` : null;
  return (
    <>
      <span className="lbl">Mode · {MODE_LABEL[p.mode] ?? p.mode}</span>
      {p.mode === 'UPI' && p.upi && (
        <>
          <div className="howto-big">{p.upi}</div>
          <CopyRow label={vpa ? 'UPI ID' : 'UPI mobile'} value={p.upi} />
        </>
      )}
      {p.mode === 'QR' && p.qrFile && (
        <>
          <button type="button" className="qr-zoom-btn" onClick={() => setZoom(true)} aria-label="Enlarge QR code">
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
          {p.accountNumber && <CopyRow label="Account no." value={p.accountNumber} />}
          {p.ifsc && <CopyRow label="IFSC" value={p.ifsc} />}
          {p.bankName && <CopyRow label="Bank" value={p.bankName} />}
        </div>
      )}
      {p.mode === 'Cash' && <p>Pay <b>{payee}</b> in cash, then record it below.</p>}
      {due > 0 && <CopyRow label="Amount" value={String(due)} />}
      {upiLink && (
        <div className="upirow">
          <a className="btn dark" href={upiLink}>Open in UPI app →</a>
          <small>Opens GPay / PhonePe / Paytm with the payee and {money(due)} filled in.</small>
        </div>
      )}
    </>
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
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setBill(await api.get<Doc>(`/api/entities/bill/${encodeURIComponent(id)}`)); setErr(''); } catch (x: any) { setErr(x.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (err && !bill) return <section><p className="crumb"><Link to="/bills">← Bills</Link></p><p className="error">{err}</p></section>;
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

  const total = Number(bill.total ?? 0);
  const paid = Number(bill.paidAmount ?? 0);
  return (
    <section className="bill-view">
      <div className="crumb">
        <Link to="/bills">← Bills</Link><span>/</span><span>{String(bill.billNumber || bill.id).slice(0, 24)}</span>
        <span className="spacer" />
        {canWrite && bill.needsReview === true && (
          <button className="btn small" onClick={async () => { await api.update('bill', bill.id, { needsReview: false }); load(); }}>Mark reviewed</button>
        )}
        {canWrite && <button className="btn small" onClick={edit}>Edit</button>}
      </div>
      {err && <p className="error">{err}</p>}

      <div className="dwrap">
        <div className="dleft">
          <div className="row wrap">
            <StatusTag status={bill.status} />
            {bill.needsReview === true && <ReviewCloud />}
            {bill.source === 'guest' && <span className="src">Guest upload</span>}
            {bill.source === 'payment-request' && <span className="src">Pay request</span>}
          </div>
          <h1 className={caseClass(payee)}>{payee}</h1>
          {bill.remarks ? <p className={`muted ${caseClass(bill.remarks)}`} style={{ margin: '6px 0 0' }}>{String(bill.remarks)}</p> : null}

          <div className="facts">
            <div><span className="lbl">Amount</span><b>{money(total)}</b></div>
            <div><span className="lbl">Paid</span><b>{money(paid)}</b></div>
            <div><span className="lbl">Balance</span><b className={due > 0 ? 'u' : ''}>{money(due)}</b></div>
            <div><span className="lbl">Due</span><b>{bill.dueDate ? fmtDate(bill.dueDate) : '—'}</b></div>
          </div>
          {total > 0 && <div style={{ marginTop: 12 }}><HatchBar total={total} paid={paid} size="big" label={paid > 0 ? `${Math.round((paid / total) * 100)}% paid` : undefined} /></div>}

          <div className="sect">
            <span className="lbl">Details</span>
            <dl className="details">
              {bill.vendorName && bill.vendorName !== bill.payee ? <><dt>Vendor (on the bill)</dt><dd>{String(bill.vendorName)}</dd></> : null}
              {details.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
              {bill.submitterName ? (
                <><dt>Submitted by</dt><dd>{String(bill.submitterName)}{bill.submitterPhone ? ` · ${String(bill.submitterPhone)}` : ''}{bill.submitterEmail ? ` · ${String(bill.submitterEmail)}` : ''}</dd></>
              ) : null}
              {bill.createdAt ? <><dt>Added</dt><dd>{new Date(String(bill.createdAt)).toLocaleString('en-IN')}{bill.createdBy && bill.source !== 'guest' ? ` by ${String(bill.createdBy)}` : ''}</dd></> : null}
            </dl>
          </div>

          <div className="sect">
            <span className="lbl">Payments</span>
            {history.length
              ? history.map((h, i) => (
                <div key={i} className="pay-hist">
                  <span className="mono">{fmtDate(h.date)}</span>
                  <span>{h.mode ?? ''}{h.note ? ` · ${h.note}` : ''}{h.by ? <span className="muted"> · {h.by}</span> : null}</span>
                  <b className="mono">{money(h.amount)}</b>
                </div>
              ))
              : <p className="muted small">{bill.status === 'Paid' ? `Paid${bill.paidDate ? ` on ${fmtDate(bill.paidDate)}` : ''}.` : 'No payments recorded yet.'}</p>}
          </div>

          <div className="sect">
            <span className="lbl">Bill file</span>
            {file ? (
              <div className="file">
                <a className={`th ${isPdf(file) ? 'pdf' : ''}`} href={fileUrl(file)} target="_blank" rel="noreferrer" aria-label="Open bill file">
                  {isImage(file) && <img src={fileUrl(file)} alt="" />}
                </a>
                <div><b>{fileName(file)}</b><small>{isPdf(file) ? 'PDF' : 'Image'} · stored privately, project members only</small></div>
                <a className="btn" href={fileUrl(file)} target="_blank" rel="noreferrer">Open original ↗</a>
              </div>
            ) : <p className="muted small">No bill file attached.</p>}
            {canWrite && (
              <p style={{ marginTop: 10 }}>
                <input ref={fileInput} type="file" hidden accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => attach(e.target.files?.[0])} />
                <button className="btn small" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Uploading…' : file ? 'Replace file' : 'Attach file'}</button>
              </p>
            )}
            {file && isImage(file) && <a href={fileUrl(file)} target="_blank" rel="noreferrer"><img className="bill-preview" src={fileUrl(file)} alt="Bill" /></a>}
            {file && isPdf(file) && <iframe className="bill-preview pdf" src={fileUrl(file)} title="Bill PDF" />}
          </div>
        </div>

        <aside className="dright">
          <div className={`howto ${unpaid ? '' : 'done'}`}>
            <div className="bar">
              <b>{unpaid ? 'How to pay' : '✓ Paid'}</b>
              <span>{unpaid ? `${money(due)} due` : bill.paidDate ? fmtDate(bill.paidDate) : money(total)}</span>
            </div>
            <div className="body">
              <div className={`payee ${caseClass(payee)}`}>{payee}</div>
              {unpaid && (
                <div className="amtbox"><span className="lbl">Pay now</span><b>{money(due)}</b></div>
              )}
              {(unpaid || payToOf(bill)) ? <HowToPay bill={bill} onEdit={canWrite && unpaid ? edit : undefined} /> : <p className="muted small">Fully paid.</p>}
            </div>
          </div>
          {unpaid && canWrite && (
            <div className="rec">
              <span className="lbl">Record payment</span>
              <RecordPayment key={`${bill.id}:${due}`} bill={bill} onSaved={load} />
            </div>
          )}
        </aside>
      </div>

      {editing && (
        <EntityForm def={def} initial={bill} refs={refs} refLabel={label}
          onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      )}
    </section>
  );
}
