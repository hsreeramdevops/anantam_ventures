import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { PayRequestBasics } from '../components/PaymentRequestDialog';

type Flow = 'choose' | 'bill' | 'pay';
interface Read { draft: string; read: boolean; vendorName: string | null; total: number | null; billDate: string | null }

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * The one public project link (/u/<token>; older /pay/<token> links land here too). No login:
 * a guest either uploads a bill (we read it and raise a payment request) or requests a payment.
 */
export default function PublicLanding({ initial = 'choose' }: { initial?: Flow }) {
  const { token = '' } = useParams();
  const t = encodeURIComponent(token);
  const [project, setProject] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [flow, setFlow] = useState<Flow>(initial);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ name: string }>(`/api/public/projects/${t}`)
      .then((r) => { setProject(r.name); setState('ready'); })
      .catch(() => setState('missing'));
  }, [t]);

  const restart = () => { setDone(null); setFlow('choose'); };

  return (
    <div className="login-wrap">
      <div className="card login guest">
        <h1>🏗️ Anantam Ventures</h1>
        {state === 'loading' && <p className="muted">Loading…</p>}
        {state === 'missing' && <p className="error">This link is invalid or has been disabled. Please ask the team for a new link.</p>}
        {state === 'ready' && done && (
          <>
            <h2>Sent ✅</h2>
            <p>{done}</p>
            <p className="muted small">The team will review it and pay. If you added your email, you'll get an update when it's paid.</p>
            <button className="btn primary block" onClick={restart}>Send another</button>
          </>
        )}
        {state === 'ready' && !done && flow === 'choose' && (
          <>
            <p>What would you like to do for <b>{project}</b>?</p>
            <div className="landing-choices">
              <button className="landing-choice" onClick={() => setFlow('bill')}>
                <span className="landing-icon">🧾</span>
                <b>Upload a bill</b>
                <span className="muted small">Photo or PDF of a bill. We read it and raise a payment request.</span>
              </button>
              <button className="landing-choice" onClick={() => setFlow('pay')}>
                <span className="landing-icon">💸</span>
                <b>Request a payment</b>
                <span className="muted small">No bill? Ask for a payment by UPI, QR, bank transfer or cash.</span>
              </button>
            </div>
          </>
        )}
        {state === 'ready' && !done && flow !== 'choose' && (
          <button className="btn ghost small back-link" onClick={() => setFlow('choose')}>← Back</button>
        )}
        {state === 'ready' && !done && flow === 'bill' && <BillFlow token={t} project={project!} onDone={setDone} />}
        {state === 'ready' && !done && flow === 'pay' && <PayFlow token={t} project={project!} onDone={setDone} />}
      </div>
    </div>
  );
}

function ContactFields({ prefix = '' }: { prefix?: string }) {
  const n = (s: string) => (prefix ? `${prefix}${s[0].toUpperCase()}${s.slice(1)}` : s);
  return (
    <>
      <label className="field"><span>Your name{prefix ? '' : ' *'}</span><input name={prefix ? n('name') : 'name'} required={!prefix} maxLength={100} autoComplete="name" /></label>
      <label className="field"><span>Your phone</span><input name={n('phone')} type="tel" maxLength={20} autoComplete="tel" /></label>
      <label className="field"><span>Your email (to get status updates)</span><input name={n('email')} type="email" maxLength={254} autoComplete="email" inputMode="email" /></label>
    </>
  );
}

function BillFlow({ token, project, onDone }: { token: string; project: string; onDone: (msg: string) => void }) {
  const [read, setRead] = useState<Read | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [payee, setPayee] = useState('');
  const form = useRef<HTMLFormElement>(null);

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setRead(null); setErr('');
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    setReading(true);
    try {
      const r = await api.post<Read>(`/api/public/upload/${token}/read`, fd);
      setRead(r);
      setPayee((p) => p || r.vendorName || '');
    } catch (x: any) { setErr(x.message); e.target.value = ''; } finally { setReading(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!read) { setErr('Choose the bill file first.'); return; }
    const fd = new FormData(form.current!);
    fd.delete('file');
    fd.append('draft', read.draft);
    setBusy(true); setErr('');
    try {
      const r = await api.post<{ total: number | null; payee: string }>(`/api/public/upload/${token}`, fd);
      onDone(`Your bill${r.total ? ` of ${inr(r.total)}` : ''} for ${r.payee} was sent to ${project}, and a payment request has been raised.`);
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <form ref={form} onSubmit={submit}>
      <h2>Upload a bill</h2>
      <p className="muted">Take a photo or upload the PDF of the bill. We'll read the amount and details automatically and
        raise a payment request to the team. You'll get an email when it's paid (if you add your email).</p>
      <label className="field"><span>Bill (PDF or photo, max 10 MB) *</span>
        <input name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" onChange={pick} />
      </label>
      {reading && <p className="muted">Reading your bill…</p>}
      {read && (
        <p className="small read-summary">
          {read.read && (read.total || read.vendorName)
            ? <>We read: {read.vendorName && <b>{read.vendorName}</b>}{read.total ? <> · {inr(read.total)}</> : null}{read.billDate ? <> · {read.billDate}</> : null}</>
            : <>We couldn't read the details automatically. The team will check the bill.</>}
        </p>
      )}
      <label className="field"><span>Whom to pay *</span>
        <input name="payee" required maxLength={100} value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Shop or person to be paid" />
        {read?.vendorName && payee === read.vendorName && <small className="muted">Read from the bill. Please check it is correct.</small>}
      </label>
      <label className="field"><span>Remarks *</span>
        <textarea name="remarks" required maxLength={1000} rows={3} placeholder="What is this bill for?" />
      </label>
      <ContactFields />
      {err && <p className="error">{err}</p>}
      <button className="btn primary block" disabled={busy || reading}>{busy ? 'Sending…' : 'Send bill & raise payment request'}</button>
    </form>
  );
}

function PayFlow({ token, project, onDone }: { token: string; project: string; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const form = useRef<HTMLFormElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const fd = new FormData(form.current!);
    try {
      await api.post(`/api/public/pay/${token}`, fd);
      onDone(`Payment request of ₹${fd.get('amount')} to ${fd.get('payee')} was sent to ${project}.`);
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <form ref={form} onSubmit={submit} className="pay-form">
      <h2>Request a payment</h2>
      <PayRequestBasics />
      <ContactFields prefix="requester" />
      {err && <p className="error">{err}</p>}
      <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Submit payment request'}</button>
    </form>
  );
}
