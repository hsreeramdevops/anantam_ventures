import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, money } from '../format';
import { PageHead } from '../components/fw';

interface Named { name: string; value: number }
interface Dash {
  totals: Record<string, number>;
  spendByCategory: Named[];
  spendByPhase: Named[];
  spendByMonth: Named[];
  budgetVsActual: { category: string; budget: number; actual: number; variance: number; over: boolean }[];
  flats: Record<string, number>;
  dueSoon: { id: string; vendorName?: string; billNumber?: string; dueDate: string; outstanding: number }[];
  lowStock: { id: string; name: string; stock: number; unit: string; reorderLevel: number }[];
  expiringDocs: { id: string; title: string; expiresOn: string }[];
}

function Bars({ data, fmt = money }: { data: Named[]; fmt?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="muted small">No data yet</p>;
  return (
    <div className="bars">
      {data.map((d) => (
        <div key={d.name} className="bar-row">
          <span className="bar-label">{d.name}</span>
          <span className="bar"><span style={{ width: `${(d.value / max) * 100}%` }} /></span>
          <span className="bar-val">{fmt(d.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<Dash>('/api/reports/dashboard').then(setD).catch((x) => setErr(x.message)); }, []);
  if (err) return <p className="error">{err}</p>;
  if (!d) return <p className="muted">Loading…</p>;
  const t = d.totals;
  const kpis: [string, string, string?, boolean?][] = [
    ['Total spend', money(t.spend), '/bills?tab=all'],
    [`Unpaid (${t.unpaidCount ?? 0})`, money(t.unpaidBills), '/bills?tab=unpaid', t.unpaidBills > 0],
    [`Paid (${t.paidCount ?? 0})`, money(t.paidBills ?? 0), '/bills?tab=paid'],
    ['Payment requests to pay', String(t.payRequests ?? 0), '/bills?tab=unpaid', (t.payRequests ?? 0) > 0],
    ['Overdue bills', String(t.overdueBills), '/bills?tab=unpaid', t.overdueBills > 0],
    ['Bills to review', String(t.billsToReview), '/bills', t.billsToReview > 0],
    ['Customer receivable', money(t.receivable), '/e/customerPayment'],
    ['Received from customers', money(t.received), '/e/customerPayment'],
    ['Overdue receivables', String(t.overdueReceivables), '/e/customerPayment', t.overdueReceivables > 0],
    ['Open follow-ups', `${t.openTasks} (${t.overdueTasks} overdue)`, '/e/task', t.overdueTasks > 0],
    ['Construction progress', `${t.progress}%`, '/e/milestone'],
    ['Wages this month', money(t.wagesThisMonth), '/reports/wages'],
  ];

  return (
    <section>
      <PageHead title="Dashboard" sheet="Dashboard" />
      <div className="kpis">
        {kpis.map(([label, value, to, alert]) => (
          <Link key={label} to={to ?? '/'} className={`kpi ${alert ? 'alert' : ''}`}>
            <span className="lbl">{label}</span>
            <strong>{value}</strong>
          </Link>
        ))}
      </div>
      <div className="flats-strip card">
        <strong>Flats</strong>
        {Object.entries(d.flats).map(([k, v]) => <span key={k} className={`pill ${k.toLowerCase()}`}>{k}: {v}</span>)}
        <div className="progress"><span style={{ width: `${t.progress}%` }} /></div>
      </div>

      <div className="grid2">
        <div className="card"><h3>Spend by category</h3><Bars data={d.spendByCategory} /></div>
        <div className="card"><h3>Spend by month</h3><Bars data={d.spendByMonth} /></div>
        <div className="card"><h3>Spend by phase</h3><Bars data={d.spendByPhase} /></div>
        <div className="card">
          <h3>Budget vs actual</h3>
          {!d.budgetVsActual.length ? <p className="muted small">Add budgets to compare.</p> : (
            <table className="compact">
              <thead><tr><th>Category</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Left</th></tr></thead>
              <tbody>{d.budgetVsActual.map((b) => (
                <tr key={b.category} className={b.over ? 'over' : ''}>
                  <td>{b.category}</td><td className="num">{money(b.budget)}</td><td className="num">{money(b.actual)}</td><td className="num">{money(b.variance)}</td>
                </tr>))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h3>Bills due in 7 days / overdue</h3>
          {!d.dueSoon.length ? <p className="muted small">Nothing due.</p> : (
            <ul className="list">{d.dueSoon.map((b) => (
              <li key={b.id}><span>{fmtDate(b.dueDate)} · {b.vendorName ?? '—'}{b.billNumber ? ` #${b.billNumber}` : ''}</span><b>{money(b.outstanding)}</b></li>
            ))}</ul>
          )}
        </div>
        <div className="card">
          <h3>Alerts</h3>
          <ul className="list">
            {d.lowStock.map((m) => <li key={m.id}><span>Low stock: {m.name}</span><b>{m.stock} {m.unit}</b></li>)}
            {d.expiringDocs.map((x) => <li key={x.id}><span>Document expiring: {x.title}</span><b>{fmtDate(x.expiresOn)}</b></li>)}
            {!d.lowStock.length && !d.expiringDocs.length && <li className="muted small">No alerts</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}
