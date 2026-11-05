import { FormEvent, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

export default function Login() {
  const { refresh } = useAuth();
  const [step, setStep] = useState<'id' | 'code'>('id');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/auth/request-otp', { identifier });
      setMsg(r.message); setStep('code');
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/api/auth/verify-otp', { identifier, code });
      await refresh();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <div className="card login">
        <h1>🏗️ Anantam Ventures</h1>
        <p className="muted">Construction management</p>
        {step === 'id' ? (
          <form onSubmit={sendCode}>
            <label>Username or email
              <input autoFocus required value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" />
            </label>
            <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Email me a login code'}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="small">{msg}</p>
            <label>6-digit code
              <input autoFocus required inputMode="numeric" pattern="\d{6}" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
            </label>
            <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Sign in'}</button>
            <div className="row between">
              <button type="button" className="btn link" onClick={() => { setStep('id'); setCode(''); }}>Change user</button>
              <button type="button" className="btn link" disabled={busy} onClick={() => sendCode()}>Resend code</button>
            </div>
          </form>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}
