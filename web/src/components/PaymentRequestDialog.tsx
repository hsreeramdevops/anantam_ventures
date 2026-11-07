import { FormEvent, useRef, useState } from 'react';
import { api } from '../api';
import { Doc } from '../types';
import PayToFields from './PayToFields';

/** Payee, amount, purpose and payment mode: the core of every payment request form. */
export function PayRequestBasics() {
  return (
    <>
      <label className="field"><span>Whom to pay *</span>
        <input name="payee" required maxLength={100} autoComplete="off" placeholder="e.g. Ramesh (electrician)" />
      </label>
      <label className="field"><span>Amount (₹) *</span>
        <input name="amount" required inputMode="decimal" pattern="[0-9,]+(\.[0-9]{1,2})?" placeholder="e.g. 25400" />
      </label>
      <label className="field"><span>Purpose / remarks</span>
        <textarea name="purpose" maxLength={1000} rows={2} placeholder="e.g. Weekly labour payment upto 31 Oct" />
      </label>
      <div className="field"><span>Mode of payment *</span></div>
      <PayToFields />
    </>
  );
}

/** "+ Payment request" on the Bills page: same form as the public /pay link, created as an Unpaid bill. */
export default function PaymentRequestDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (bill: Doc) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { onSaved(await api.post<Doc>('/api/bills/payment-request', new FormData(form.current!))); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form ref={form} className="modal narrow pay-form" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New payment request</h2>
        <p className="muted small">Creates an Unpaid bill with the payee's payment details. The category is picked automatically.</p>
        <PayRequestBasics />
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Create payment request'}</button>
        </div>
      </form>
    </div>
  );
}
