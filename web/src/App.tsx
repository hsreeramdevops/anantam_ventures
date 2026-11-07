import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { useProject } from './project';
import PublicLanding from './pages/PublicLanding';
import BillView from './pages/BillView';
import Projects from './pages/Projects';
import Notifications from './pages/Notifications';
import BillsPage from './pages/BillsPage';
import Dashboard from './pages/Dashboard';
import EntityPage from './pages/EntityPage';
import UsersPage from './pages/UsersPage';
import Login from './pages/Login';
import { StockReport, WagesReport } from './pages/Reports';

const CUSTOM: Record<string, string> = { bill: '/bills' };
const EXTRA_LINKS: Record<string, { to: string; label: string }[]> = {
  Site: [{ to: '/reports/stock', label: 'Stock Report' }, { to: '/reports/wages', label: 'Wages Report' }],
};

export default function App() {
  const { user, entities, loading, logout } = useAuth();
  const { projects, current, select, loading: projectsLoading } = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  // Links from notifications carry ?project=<id>; switch to it if this user can access it.
  const wantProject = new URLSearchParams(loc.search).get('project');
  useEffect(() => {
    if (wantProject && wantProject !== current?.id && projects.some((p) => p.id === wantProject)) select(wantProject);
  }, [wantProject, projects, current?.id, select]);

  // Public project link: no login, nothing else reachable. Older /pay/ links open on "Request a payment".
  if (loc.pathname.startsWith('/u/')) return <Routes><Route path="/u/:token" element={<PublicLanding />} /></Routes>;
  if (loc.pathname.startsWith('/pay/')) return <Routes><Route path="/pay/:token" element={<PublicLanding initial="pay" />} /></Routes>;
  if (loading) return <div className="login-wrap"><p className="lbl">Loading…</p></div>;
  if (!user) return <Login />;
  if (projectsLoading) return <div className="login-wrap"><p className="lbl">Loading projects…</p></div>;

  const groups = [...new Set(entities.map((e) => e.group))];
  const code = (g: number, i: number) => `${g}.${String(i + 1).padStart(2, '0')}`;
  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn mobile-only" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" aria-expanded={menuOpen}>☰</button>
        <NavLink to={current ? '/' : '/projects'} className="brand"><i aria-hidden="true" /><span>Anantam Ventures</span></NavLink>
        {projects.length > 0 && (
          <label className="pswitch">
            <span className="lbl">Project</span>
            <select className="project-switch" aria-label="Project" value={current?.id ?? ''}
              onChange={(e) => { if (e.target.value === '__all') { nav('/projects'); return; } select(e.target.value); nav('/'); }}>
              {!current && <option value="">Select project…</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="__all">All projects…</option>
            </select>
          </label>
        )}
        <span className="spacer" />
        <span className="who">{user.name} <span className="mono">· {user.role}</span></span>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </header>
      <nav className={`sidebar ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <div className="nav-group" style={{ marginTop: 0 }}>Sheets</div>
        <NavLink to="/projects"><span className="mono">0.01</span>Projects</NavLink>
        <NavLink to="/notifications"><span className="mono">0.02</span>Notifications</NavLink>
        {current && <NavLink to="/" end><span className="mono">0.03</span>Dashboard</NavLink>}
        {current && groups.map((g, gi) => (
          <div key={g}>
            <div className="nav-group">{g}</div>
            {[...entities.filter((e) => e.group === g).map((e) => ({ to: CUSTOM[e.type] ?? `/e/${e.type}`, label: e.plural })), ...(EXTRA_LINKS[g] ?? [])]
              .map((l, i) => <NavLink key={l.to} to={l.to}><span className="mono">{code(gi + 1, i)}</span>{l.label}</NavLink>)}
          </div>
        ))}
      </nav>
      <main className="content" key={`${current?.id}:${loc.pathname}`}>
        {loc.pathname === '/notifications' ? <Notifications /> : !current ? <Projects /> : <Routes>
          <Route path="/projects" element={<Projects />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/bills/:id" element={<BillView />} />
          <Route path="/e/user" element={<UsersPage />} />
          <Route path="/e/:type" element={<EntityPage />} />
          <Route path="/reports/stock" element={<StockReport />} />
          <Route path="/reports/wages" element={<WagesReport />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>}
      </main>
    </div>
  );
}
