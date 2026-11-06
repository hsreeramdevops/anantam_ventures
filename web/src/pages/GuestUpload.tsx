import { FormEvent, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';

/** Public page behind a project's share link: no login, submit a bill with remarks. */
export default function GuestUpload() {
  const { token = '' } = useParams();
  const [project, setProject] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'sent'>('loading');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    api.get<{ name: string }>(`/api/public/projects/${encodeURIComponent(token)}`)
      .then((r) => { setProject(r.name); setState('ready'); })
      .catch(() => setState('missing'));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.post(`/api/public/upload/${encodeURIComponent(token)}`, new FormData(form.current!));
      setState('sent');
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="card login guest">
        <h1>🏗️ Anantam Ventures</h1>
        {state === 'loading' && <p className="muted">Loading…</p>}
        {state === 'missing' && <p className="error">This upload link is invalid or has been disabled. Please ask for a new link.</p>}
        {state === 'sent' && (
          <>
            <h2>Thank you!</h2>
            <p>Your bill was sent to <b>{project}</b>. The team will review it.</p>
            <button className="btn" onClick={() => { form.current?.reset(); setState('ready'); }}>Upload another bill</button>
          </>
        )}
        {state === 'ready' && (
          <form ref={form} onSubmit={submit}>
            <p>Upload a bill for <b>{project}</b></p>
            <label className="field"><span>Bill (PDF or photo, max 10 MB) *</span>
              <input name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" capture="environment" />
            </label>
            <label className="field"><span>Remarks *</span>
              <textarea name="remarks" required maxLength={1000} rows={3} placeholder="What is this bill for?" />
            </label>
            <label className="field"><span>Your name *</span><input name="name" required maxLength={100} autoComplete="name" /></label>
            <label className="field"><span>Phone</span><input name="phone" type="tel" maxLength={20} autoComplete="tel" /></label>
            <label className="field"><span>Your email (to get status updates)</span><input name="email" type="email" maxLength={254} autoComplete="email" inputMode="email" /></label>
            {err && <p className="error">{err}</p>}
            <button className="btn primary block" disabled={busy}>{busy ? 'Uploading…' : 'Submit bill'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
