import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { fmtDate } from '../format';
import { useProject } from '../project';
import { Doc, Project } from '../types';

export const guestLink = (p: Project) => `${window.location.origin}/u/${p.shareToken}`;
export const payLink = (p: Project) => `${window.location.origin}/pay/${p.payToken}`;

const LINKS = {
  upload: { title: 'Guest bill upload link', url: guestLink, token: (p: Project) => p.shareToken, on: (p: Project) => !!p.shareEnabled },
  pay: { title: 'Raise a payment request link', url: payLink, token: (p: Project) => p.payToken, on: (p: Project) => !!p.payEnabled && !!p.payToken },
};

/** Project list + picker. Admins can create/edit projects, manage members and the guest upload link. */
export default function Projects() {
  const { projects, current, canManage, select, reload, loading } = useProject();
  const [editing, setEditing] = useState<Partial<Project> | null>(null);
  const nav = useNavigate();

  const open = (p: Project) => { select(p.id); nav('/'); };

  return (
    <section>
      <div className="page-head">
        <h1>Projects</h1>
        {canManage && <button className="btn primary" onClick={() => setEditing({ status: 'Active', members: [] })}>+ New project</button>}
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && !projects.length && (
        <p className="muted">{canManage ? 'No projects yet. Create your first project.' : 'You have not been added to any project yet. Ask an admin to add you.'}</p>
      )}
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className={`card project-card ${current?.id === p.id ? 'selected' : ''}`}>
            <div className="row between project-card-head" role="button" tabIndex={0} title={`Open ${p.name}`}
              onClick={() => open(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); } }}>
              <strong>{p.name}</strong>
              <span className={`pill ${String(p.status ?? '').replace(/\s/g, '-').toLowerCase()}`}>{p.status}</span>
            </div>
            {p.location && <div className="muted small">{p.location}</div>}
            {p.startDate && <div className="muted small">Started {fmtDate(p.startDate)}</div>}
            <button className={`btn open-project ${current?.id === p.id ? 'current' : 'primary'}`} onClick={() => open(p)}>
              {current?.id === p.id ? '✓ Current project · Open' : 'Open project →'}
            </button>
            {canManage && <ShareLink project={p} kind="upload" onChange={reload} />}
            {canManage && <ShareLink project={p} kind="pay" onChange={reload} />}
            {canManage && <div className="row wrap"><button className="btn small" onClick={() => setEditing(p)}>Edit / members</button></div>}
          </div>
        ))}
      </div>
      {editing && <ProjectForm initial={editing} onCancel={() => setEditing(null)}
        onSaved={async (p) => { setEditing(null); await reload(); if (!editing.id) select(p.id); }} />}
    </section>
  );
}

function ShareLink({ project, kind, onChange }: { project: Project; kind: keyof typeof LINKS; onChange: () => void }) {
  const [msg, setMsg] = useState('');
  const l = LINKS[kind];
  const on = l.on(project);
  const hasToken = !!l.token(project);
  const act = async (action: 'regenerate' | 'disable' | 'enable') => {
    if (action === 'regenerate' && hasToken && !confirm('Create a new link? The current link will stop working immediately.')) return;
    try { await api.post(`/api/projects/${project.id}/share`, { action, link: kind }); setMsg(''); onChange(); } catch (x: any) { setMsg(x.message); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(l.url(project)); setMsg('Link copied'); } catch { setMsg(l.url(project)); }
  };
  return (
    <div className="share-box">
      <div className="small"><b>{l.title}</b> {on ? <span className="pill paid">On</span> : <span className="pill unpaid">Off</span>}</div>
      {on && <input className="share-url" readOnly value={l.url(project)} onFocus={(e) => e.target.select()} />}
      <div className="row wrap">
        {on && <button className="btn small" onClick={copy}>Copy link</button>}
        <button className="btn small" onClick={() => act('regenerate')}>{hasToken ? 'New link' : 'Create link'}</button>
        {hasToken && (on
          ? <button className="btn small danger" onClick={() => act('disable')}>Disable</button>
          : <button className="btn small ok" onClick={() => act('enable')}>Enable</button>)}
      </div>
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}

function ProjectForm({ initial, onCancel, onSaved }: { initial: Partial<Project>; onCancel: () => void; onSaved: (p: Project) => void }) {
  const { def } = useProject();
  const [v, setV] = useState<Partial<Project>>(initial);
  const [users, setUsers] = useState<Doc[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.list('user').then((r) => setUsers(r.items.filter((u) => u.role !== 'admin' && u.active !== false))).catch(() => undefined); }, []);

  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));
  const members = v.members ?? [];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    const body = { name: v.name, location: v.location, status: v.status, startDate: v.startDate, notes: v.notes, members };
    try {
      onSaved(initial.id ? await api.put<Project>(`/api/projects/${initial.id}`, body) : await api.post<Project>('/api/projects', body));
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="modal-bg" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial.id ? 'Edit project' : 'New project'}</h2>
        {def?.fields.map((f) => (
          <label key={f.name} className="field">
            <span>{f.label}{f.required ? ' *' : ''}</span>
            {f.type === 'select' ? (
              <select value={String((v as any)[f.name] ?? '')} required={f.required} onChange={(e) => set(f.name, e.target.value)}>
                {f.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea rows={2} value={String((v as any)[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
            ) : (
              <input type={f.type === 'date' ? 'date' : 'text'} required={f.required} value={String((v as any)[f.name] ?? '')}
                onChange={(e) => set(f.name, e.target.value)} />
            )}
          </label>
        ))}
        <fieldset className="field">
          <span>Members (admins always have access)</span>
          {!users.length && <span className="muted small">No non-admin users yet.</span>}
          {users.map((u) => (
            <label key={u.id} className="row small">
              <input type="checkbox" checked={members.includes(u.id)}
                onChange={(e) => set('members', e.target.checked ? [...members, u.id] : members.filter((m) => m !== u.id))} />
              {String(u.name)} <span className="muted">({String(u.role)})</span>
            </label>
          ))}
        </fieldset>
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy}>Save</button>
        </div>
      </form>
    </div>
  );
}
