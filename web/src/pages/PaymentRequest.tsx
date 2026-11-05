import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';

type Mode = 'UPI' | 'QR' | 'Bank' | 'Cash';
const MODES: { value: Mode; label: string }[] = [
  { value: 'UPI', label: 'UPI / GPay' },
  { value: 'QR', label: 'QR code' },
  { value: 'Bank', label: 'Bank account' },
  { value: 'Cash', label: 'Cash' },
];

/** Public page behind a project's "Raise a payment request" link: no login, mobile-first. */
export default function PaymentRequest() {
  const { token = '' } = useParams();
  const [project, setProject] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'sent'>('loading');
  const [mode, setMode] = useState<Mode>('UPI');
  const [sent, setSent] = useState<{ payee: string; amount: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    api.get<{ name: string }>(`/api/public/pay/${encodeURIComponent(token)}`)
      .then((r) => { setProject(r.name); setState('ready'); })
      .catch(() => setState('missing'));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const fd = new FormData(form.current!);
    try {
      await api.post(`/api/public/pay/${encodeURIComponent(token)}`, fd);
      setSent({ payee: String(fd.get('payee') ?? ''), amount: String(fd.get('amount') ?? '') });
      setState('sent');
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="card login guest">
        <h1>🏗️ Anantam Ventures</h1>
        {state === 'loading' && <p className="muted">Loading…</p>}
        {state === 'missing' && <p className="error">This payment request link is invalid or has been disabled. Please ask for a new link.</p>}
        {state === 'sent' && (
          <>
            <h2>Request sent ✅</h2>
            <p>Payment request of <b>₹{sent?.amount}</b> to <b>{sent?.payee}</b> was sent to <b>{project}</b>. The team will review and pay it.</p>
            <button className="btn" onClick={() => { form.current?.reset(); setMode('UPI'); setState('ready'); }}>Raise another request</button>
          </>
        )}
        {state === 'ready' && (
          <form ref={form} onSubmit={submit} className="pay-form">
            <p>Raise a payment request for <b>{project}</b></p>
            <label className="field"><span>Name of the person to be paid *</span>
              <input name="payee" required maxLength={100} autoComplete="off" placeholder="e.g. Ramesh (electrician)" />
            </label>
            <label className="field"><span>Amount (₹) *</span>
              <input name="amount" required inputMode="decimal" pattern="[0-9,]+(\.[0-9]{1,2})?" placeholder="e.g. 25400" />
            </label>
            <label className="field"><span>Purpose / remarks</span>
              <textarea name="purpose" maxLength={1000} rows={2} placeholder="e.g. Weekly labour payment upto 31 Oct" />
            </label>

            <div className="field"><span>Mode of payment *</span></div>
            <div className="mode-choice" role="radiogroup">
              {MODES.map((m) => (
                <label key={m.value}>
                  <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
                  {m.label}
                </label>
              ))}
            </div>
            {mode === 'UPI' && (
              <label className="field"><span>UPI mobile number or UPI ID *</span>
                <input name="upi" required maxLength={100} autoComplete="off" autoCapitalize="none" placeholder="98765 43210 or name@okbank" />
              </label>
            )}
            {mode === 'QR' && (
              <label className="field"><span>QR code image (photo or screenshot) *</span>
                <input name="qr" type="file" required accept="image/jpeg,image/png,image/webp" />
              </label>
            )}
            {mode === 'Bank' && (
              <>
                <label className="field"><span>Account holder name *</span><input name="accountHolder" required maxLength={100} /></label>
                <label className="field"><span>Account number *</span>
                  <input name="accountNumber" required inputMode="numeric" pattern="[0-9 ]{9,22}" maxLength={22} autoComplete="off" />
                </label>
                <label className="field"><span>Re-enter account number *</span>
                  <input name="accountNumber2" required inputMode="numeric" pattern="[0-9 ]{9,22}" maxLength={22} autoComplete="off" />
                </label>
                <label className="field"><span>IFSC *</span>
                  <input name="ifsc" required maxLength={11} autoCapitalize="characters" pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" placeholder="SBIN0001234" />
                </label>
                <label className="field"><span>Bank name</span><input name="bankName" maxLength={100} /></label>
              </>
            )}

            <label className="field"><span>Requested by (your name)</span><input name="requesterName" maxLength={100} autoComplete="name" /></label>
            <label className="field"><span>Your phone</span><input name="requesterPhone" type="tel" maxLength={20} autoComplete="tel" /></label>
            {err && <p className="error">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Submit payment request'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
