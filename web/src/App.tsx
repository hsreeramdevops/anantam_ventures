import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import BillsPage from './pages/BillsPage';
import Dashboard from './pages/Dashboard';
import EntityPage from './pages/EntityPage';
import Login from './pages/Login';
import { StockReport, WagesReport } from './pages/Reports';

const CUSTOM: Record<string, string> = { bill: '/bills' };
const EXTRA_LINKS: Record<string, { to: string; label: string }[]> = {
  Site: [{ to: '/reports/stock', label: 'Stock Report' }, { to: '/reports/wages', label: 'Wages Report' }],
};

export default function App() {
  const { user, entities, loading, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();

  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <Login />;

  const groups = [...new Set(entities.map((e) => e.group))];
  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn mobile-only" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">☰</button>
        <strong className="brand">🏗️ Anantam Ventures</strong>
        <span className="spacer" />
        <span className="muted small">{user.name} · {user.role}</span>
        <button className="btn ghost" onClick={logout}>Sign out</button>
      </header>
      <nav className={`sidebar ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <NavLink to="/" end>Dashboard</NavLink>
        {groups.map((g) => (
          <div key={g}>
            <div className="nav-group">{g}</div>
            {entities.filter((e) => e.group === g).map((e) => (
              <NavLink key={e.type} to={CUSTOM[e.type] ?? `/e/${e.type}`}>{e.plural}</NavLink>
            ))}
            {(EXTRA_LINKS[g] ?? []).map((l) => <NavLink key={l.to} to={l.to}>{l.label}</NavLink>)}
          </div>
        ))}
      </nav>
      <main className="content" key={loc.pathname}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/bills" element={<BillsPage />} />
          <Route path="/e/:type" element={<EntityPage />} />
          <Route path="/reports/stock" element={<StockReport />} />
          <Route path="/reports/wages" element={<WagesReport />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
