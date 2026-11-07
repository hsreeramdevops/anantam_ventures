import { FormEvent, useState } from 'react';
import { api, fileUrl } from '../api';
import { money, today } from '../format';
import { Doc } from '../types';

const PAY_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card'];
const DEFAULT_MODE: Record<string, string> = { UPI: 'UPI', QR: 'UPI', Bank: 'Bank Transfer', Cash: 'Cash' };

export interface PayTo {
  mode: 'UPI' | 'QR' | 'Bank' | 'Cash';
  upi?: string;
  qrFile?: string;
  accountHolder?: string;
  accountNumber?: string;
  ifsc?: string;
  bankName?: string | null;
}

export const outstanding = (d: Doc) => Math.max(0, Math.round((Number(d.total ?? 0) - Number(d.paidAmount ?? 0)) * 100) / 100);
export const payToOf = (d: Doc) => (d.payTo && typeof d.payTo === 'object' ? d.payTo as PayTo : null);

export function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <span className="muted small">{label}</span>
      <code>{value}</code>
      <button type="button" className="btn small" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { prompt(label, value); }
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** Where to send the money, as submitted on the payment request form. */
export function PayToDetails({ bill }: { bill: Doc }) {
  const p = payToOf(bill);
  if (!p) return null;
  const payee = String(bill.payee ?? bill.vendorName ?? '');
  const amt = outstanding(bill);
  const upiLink = p.mode === 'UPI' && p.upi?.includes('@')
    ? `upi://pay?${new URLSearchParams({ pa: p.upi, pn: payee, am: String(amt), cu: 'INR' })}` : null;
  return (
    <div className="pay-to">
      <div className="small"><b>Pay to {payee}</b> · {p.mode === 'Bank' ? 'Bank account' : p.mode === 'QR' ? 'QR code' : p.mode}</div>
      {amt > 0 && <CopyRow label="Amount" value={String(amt)} />}
      {p.mode === 'UPI' && p.upi && <CopyRow label={p.upi.includes('@') ? 'UPI ID' : 'UPI mobile'} value={p.upi} />}
      {upiLink && <a className="btn small" href={upiLink}>Open in UPI app</a>}
      {p.mode === 'Bank' && (
        <>
          {p.accountHolder && <CopyRow label="Account holder" value={p.accountHolder} />}
          {p.accountNumber && <CopyRow label="Account number" value={p.accountNumber} />}
          {p.ifsc && <CopyRow label="IFSC" value={p.ifsc} />}
          {p.bankName && <CopyRow label="Bank" value={p.bankName} />}
        </>
      )}
      {p.mode === 'QR' && p.qrFile && (
        <a href={fileUrl(p.qrFile)} target="_blank" rel="noreferrer" title="Open full size">
          <img className="qr-img" src={fileUrl(p.qrFile)} alt={`QR code for ${payee}`} />
        </a>
      )}
      {p.mode === 'Cash' && <div className="muted small">Pay in cash.</div>}
      {(bill.submitterName || bill.submitterPhone) ? (
        <div className="muted small">Requested by {String(bill.submitterName ?? '')}{bill.submitterPhone ? ` · ${String(bill.submitterPhone)}` : ''}</div>
      ) : null}
      {bill.remarks ? <div className="muted small">Purpose: {String(bill.remarks)}</div> : null}
    </div>
  );
}

/** Payment details + "record a payment" form (full or partial). */
export default function PayDialog({ bill, canRecord, onClose, onSaved, hideDetails = false }: {
  bill: Doc; canRecord: boolean; onClose: () => void; onSaved: () => void;
  /** The bill view already shows how to pay and the history; just record the payment. */
  hideDetails?: boolean;
}) {
  const due = outstanding(bill);
  const p = payToOf(bill);
  const [amount, setAmount] = useState(String(due));
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState((p && DEFAULT_MODE[p.mode]) || String(bill.paymentMode ?? '') || 'Bank Transfer');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const recordable = canRecord && bill.status !== 'Paid' && due > 0;
  const history = Array.isArray(bill.payments) ? bill.payments as { amount: number; date: string; mode?: string; by?: string }[] : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.post(`/api/bills/${bill.id}/payment`, { amount: Number(amount), date, mode, note: note || null });
      onSaved();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal narrow" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{String(bill.payee ?? bill.vendorName ?? 'Bill')}</h2>
        <p className="small">
          Total {money(bill.total)} · Paid {money(bill.paidAmount ?? 0)} · <b>Balance {money(due)}</b>{' '}
          <span className={`pill ${String(bill.status ?? '').replace(/\s/g, '-').toLowerCase()}`}>{String(bill.status ?? '')}</span>
        </p>
        {!hideDetails && <PayToDetails bill={bill} />}
        {!hideDetails && history.length > 0 && (
          <ul className="list small">
            {history.map((h, i) => <li key={i}><span>{h.date} · {h.mode ?? ''} · {h.by ?? ''}</span><b>{money(h.amount)}</b></li>)}
          </ul>
        )}
        {recordable && (
          <>
            <h3>Record payment</h3>
            <div className="grid2 tight">
              <label className="field"><span>Amount paid (₹) *</span>
                <input type="number" min="0.01" step="0.01" max={due} required value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              </label>
              <label className="field"><span>Paid date *</span><input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
              <label className="field"><span>Mode</span>
                <select value={mode} onChange={(e) => setMode(e.target.value)}>{PAY_MODES.map((m) => <option key={m}>{m}</option>)}</select>
              </label>
              <label className="field"><span>Reference / note</span><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="UTR, cheque #…" /></label>
            </div>
            {Number(amount) > 0 && Number(amount) < due && <p className="muted small">Partial payment: {money(due - Number(amount))} will stay unpaid.</p>}
          </>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          {recordable && <button className="btn ok" disabled={busy}>{busy ? 'Saving…' : Number(amount) < due ? 'Record partial payment' : 'Mark as paid'}</button>}
        </div>
      </form>
    </div>
  );
}
