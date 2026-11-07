import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { PageHead } from '../components/fw';

interface Status {
  configured: boolean;
  botUsername: string | null;
  webhookRegistered: boolean;
  connected: boolean;
  telegramUsername: string | null;
  events: { key: string; label: string }[];
  projects: { id: string; name: string; events: string[] }[];
}

function BillEmailCard() {
  const [pref, setPref] = useState<{ billStatusEmails: boolean; email: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<typeof pref>('/api/notifications/email').then(setPref).catch((x) => setErr(x.message)); }, []);
  const toggle = async (on: boolean) => {
    setErr('');
    try { setPref(await api.put<NonNullable<typeof pref>>('/api/notifications/email', { billStatusEmails: on })); } catch (x: any) { setErr(x.message); }
  };
  return (
    <div className="card" style={{ maxWidth: 760, marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Email</h3>
      {pref && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={pref.billStatusEmails} onChange={(e) => toggle(e.target.checked)} />
          Email me when my bills change status (Unpaid / Partially Paid / Paid)
        </label>
      )}
      {pref && <p className="muted small">Sent to {pref.email} for bills you added. You never get an email for your own changes.</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export default function Notifications() {
  const { user } = useAuth();
  const [st, setSt] = useState<Status | null>(null);
  const [subs, setSubs] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get<Status>('/api/telegram/status');
      setSt(s);
      setSubs(Object.fromEntries(s.projects.map((p) => [p.id, p.events])));
      setDirty(false);
      setErr('');
    } catch (x: any) { setErr(x.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  const connect = () => run(async () => {
    // Open the tab synchronously so pop-up blockers allow it, then point it at the bot.
    const w = window.open('', '_blank');
    const r = await api.post<{ url: string }>('/api/telegram/link');
    if (w) w.location.href = r.url; else window.location.href = r.url;
    setMsg('In Telegram, tap Start. Then come back and press Refresh. The link works once and expires in 15 minutes.');
  });
  const disconnect = () => run(async () => { await api.post('/api/telegram/disconnect'); await load(); setMsg('Disconnected.'); });
  const register = () => run(async () => { await api.post('/api/telegram/register-webhook'); await load(); setMsg('Webhook registered.'); });
  const save = () => run(async () => { await api.put('/api/telegram/subscriptions', { subs }); await load(); setMsg('Saved.'); });

  const toggle = (pid: string, ev: string) => {
    setSubs((s) => {
      const cur = s[pid] ?? [];
      return { ...s, [pid]: cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev] };
    });
    setDirty(true);
  };

  if (!st) return <div>{err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}</div>;

  return (
    <div>
      <PageHead title="Notifications" sheet="Alerts" />
      <BillEmailCard />
      <div className="card" style={{ maxWidth: 760 }}>
        <h3 style={{ marginTop: 0 }}>Telegram</h3>
        {!st.configured ? (
          <p className="muted">Telegram not configured yet.{user?.role === 'admin' && ' See "Telegram notifications" in the README to create the bot.'}</p>
        ) : (
          <>
            <p>
              {st.connected
                ? <>✅ Connected{st.telegramUsername ? ` as @${st.telegramUsername}` : ''}{st.botUsername ? ` to @${st.botUsername}` : ''}.</>
                : <>Not connected. Connect to get alerts from {st.botUsername ? `@${st.botUsername}` : 'our bot'}.</>}
            </p>
            <div className="row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {st.connected
                ? <button className="btn danger" disabled={busy} onClick={disconnect}>Disconnect</button>
                : <button className="btn primary" disabled={busy} onClick={connect}>Connect Telegram</button>}
              <button className="btn" disabled={busy} onClick={load}>Refresh</button>
              {user?.role === 'admin' && (
                <button className="btn ghost" disabled={busy} onClick={register}
                  title="Tells Telegram where to send messages. Done automatically; use if /start doesn't respond.">
                  {st.webhookRegistered ? 'Re-register webhook' : 'Register webhook'}
                </button>
              )}
            </div>
          </>
        )}
        {msg && <p className="muted small">{msg}</p>}
        {err && <p className="error">{err}</p>}
      </div>

      {st.configured && (
        <div className="card" style={{ maxWidth: 760, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>What to send me</h3>
          {!st.connected && <p className="muted small">Choices are saved now and used once you connect.</p>}
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr><th>Project</th>{st.events.map((e) => <th key={e.key} style={{ textAlign: 'center' }}>{e.label}</th>)}</tr>
              </thead>
              <tbody>
                {st.projects.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    {st.events.map((e) => (
                      <td key={e.key} style={{ textAlign: 'center' }}>
                        <input type="checkbox" aria-label={`${p.name}: ${e.label}`}
                          checked={(subs[p.id] ?? []).includes(e.key)} onChange={() => toggle(p.id, e.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn primary block" disabled={busy || !dirty} onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}
