import { FormEvent, useRef, useState } from 'react';
import { api, fileUrl } from '../api';
import { money, today } from '../format';
import { Doc } from '../types';
import { CopyChip, HatchBar, StatusTag } from './fw';

export const PAY_MODES = ['UPI', 'Bank Transfer', 'Cash', 'Cheque', 'Card'];
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
  return (
    <div className="cp">
      <span className="lbl">{label}</span>
      <code>{value}</code>
      <CopyChip label={label} value={value} />
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

type Step = 0 | 1 | 2;

/**
 * Three-step "record payment": 01 Amount (defaults to the full balance) → 02 Mode → 03 Reference.
 * Enter advances with the defaults, so the quick path is Enter, Enter, Enter.
 */
export function RecordPayment({ bill, onSaved, onCancel, autoFocus = false }: {
  bill: Doc; onSaved: () => void; onCancel?: () => void; autoFocus?: boolean;
}) {
  const due = outstanding(bill);
  const total = Number(bill.total ?? 0);
  const p = payToOf(bill);
  const [step, setStep] = useState<Step>(0);
  const [amount, setAmount] = useState(String(due));
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState((p && DEFAULT_MODE[p.mode]) || String(bill.paymentMode ?? '') || 'UPI');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const amt = Number(amount);
  const amtOk = amt > 0 && amt <= due + 0.001;
  const partial = amtOk && amt < due - 0.001;
  const go = (n: Step) => {
    setErr('');
    setStep(n);
    setTimeout(() => formRef.current?.querySelector<HTMLElement>(n === 1 ? '.step-nav .btn.dark' : '.step-body input')?.focus(), 0);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step === 0 && !amtOk) { setErr(`Enter an amount between ₹1 and ${money(due)}.`); return; }
    if (step < 2) { go((step + 1) as Step); return; }
    if (!amtOk) { go(0); setErr(`Enter an amount between ₹1 and ${money(due)}.`); return; }
    setBusy(true); setErr('');
    try {
      await api.post(`/api/bills/${bill.id}/payment`, { amount: amt, date, mode, note: note || null });
      onSaved();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  const steps: { n: string; label: string; val: string }[] = [
    { n: '01', label: 'Amount', val: amtOk ? money(amt) : '—' },
    { n: '02', label: 'Mode', val: mode },
    { n: '03', label: 'Reference', val: note || 'optional' },
  ];
  return (
    <form ref={formRef} className="rec-form" onSubmit={submit} noValidate>
      <div className="steps" role="tablist" aria-label="Record payment steps">
        {steps.map((s, i) => (
          <button key={s.n} type="button" role="tab" aria-selected={step === i} className={step === i ? 'on' : ''} onClick={() => go(i as Step)}>
            <span className="lbl">{s.n} · {s.label}</span><span className="mono">{s.val}</span>
          </button>
        ))}
      </div>
      <div className="step-body">
        {step === 0 && (
          <>
            <label className="field"><span>Amount paid (₹)</span>
              <input type="number" min="1" step="0.01" max={due} required value={amount} inputMode="decimal" autoFocus={autoFocus}
                onChange={(e) => setAmount(e.target.value)} />
            </label>
            {total > 0 && <HatchBar total={total} paid={total - due} preview={amtOk ? amt : 0} />}
            {partial
              ? <p className="hint u">Part payment: {money(due - amt)} will stay unpaid.</p>
              : <p className="hint">Full balance {money(due)}. Change it for a part payment.</p>}
          </>
        )}
        {step === 1 && (
          <>
            <div className="mini-modes" role="group" aria-label="Payment mode">
              {PAY_MODES.map((m) => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m}</button>)}
            </div>
            <label className="field" style={{ marginTop: 12 }}><span>Paid date</span>
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <label className="field"><span>UTR / cheque no. / note</span>
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </label>
            <p className="hint">{money(amt)} · {mode} · {date}{partial ? ` · ${money(due - amt)} left` : ''}</p>
          </>
        )}
      </div>
      {err && <p className="error">{err}</p>}
      <div className="step-nav">
        {step > 0 ? <button type="button" className="btn" onClick={() => go((step - 1) as Step)}>← Back</button>
          : onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        {step < 2
          ? <button className="btn dark">Next →</button>
          : <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : partial ? `Record part payment` : 'Mark as paid ✓'}</button>}
      </div>
    </form>
  );
}

/** Payment details + the 3-step "record payment" (full or partial). */
export default function PayDialog({ bill, canRecord, onClose, onSaved, hideDetails = false }: {
  bill: Doc; canRecord: boolean; onClose: () => void; onSaved: () => void;
  /** The bill view already shows how to pay and the history; just record the payment. */
  hideDetails?: boolean;
}) {
  const due = outstanding(bill);
  const recordable = canRecord && bill.status !== 'Paid' && due > 0;
  const history = Array.isArray(bill.payments) ? bill.payments as { amount: number; date: string; mode?: string; by?: string }[] : [];

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal narrow" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{String(bill.payee ?? bill.vendorName ?? 'Bill')}</h2>
        <p className="small row wrap">
          <span className="mono">Total {money(bill.total)} · Paid {money(bill.paidAmount ?? 0)} · <b>Balance {money(due)}</b></span>
          <StatusTag status={bill.status} />
        </p>
        {!hideDetails && <PayToDetails bill={bill} />}
        {!hideDetails && history.length > 0 && (
          <ul className="list small">
            {history.map((h, i) => <li key={i}><span>{h.date} · {h.mode ?? ''} · {h.by ?? ''}</span><b>{money(h.amount)}</b></li>)}
          </ul>
        )}
        {recordable
          ? <RecordPayment bill={bill} onSaved={onSaved} onCancel={onClose} autoFocus />
          : <div className="row end"><button type="button" className="btn ghost" onClick={onClose}>Close</button></div>}
      </div>
    </div>
  );
}
