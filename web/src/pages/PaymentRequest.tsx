import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { PayRequestBasics } from '../components/PaymentRequestDialog';

/** Public page behind a project's "Raise a payment request" link: no login, mobile-first. */
export default function PaymentRequest() {
  const { token = '' } = useParams();
  const [project, setProject] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'sent'>('loading');
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
            <button className="btn" onClick={() => { form.current?.reset(); setState('ready'); }}>Raise another request</button>
          </>
        )}
        {state === 'ready' && (
          <form ref={form} onSubmit={submit} className="pay-form">
            <p>Raise a payment request for <b>{project}</b></p>
            <PayRequestBasics />

            <label className="field"><span>Requested by (your name)</span><input name="requesterName" maxLength={100} autoComplete="name" /></label>
            <label className="field"><span>Your phone</span><input name="requesterPhone" type="tel" maxLength={20} autoComplete="tel" /></label>
            <label className="field"><span>Your email (to get status updates)</span><input name="requesterEmail" type="email" maxLength={254} autoComplete="email" inputMode="email" /></label>
            {err && <p className="error">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Submit payment request'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
