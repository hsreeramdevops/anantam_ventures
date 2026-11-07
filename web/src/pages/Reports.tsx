import { useEffect, useState } from 'react';
import { api } from '../api';
import { downloadCsv, money } from '../format';
import { PageHead } from '../components/fw';

interface StockRow { id: string; name: string; unit: string; inQty: number; outQty: number; stock: number; avgRate: number | null; reorderLevel: number | null; low: boolean }
interface WageRow { id: string; name: string; trade: string; dailyWage: number; days: number; otHours: number; gross: number; advance: number; net: number }

export function StockReport() {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<{ items: StockRow[] }>('/api/reports/stock').then((r) => setRows(r.items)).catch((x) => setErr(x.message)); }, []);
  return (
    <section>
      <PageHead title="Material stock" sheet="Stock">
        <button className="btn ghost" onClick={() => downloadCsv('stock.csv', ['Material', 'Unit', 'In', 'Out', 'Stock', 'Avg rate', 'Reorder level'],
          rows.map((r) => [r.name, r.unit, r.inQty, r.outQty, r.stock, r.avgRate, r.reorderLevel]))}>Export CSV</button>
      </PageHead>
      {err && <p className="error">{err}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th>Material</th><th>Unit</th><th className="num">In</th><th className="num">Out</th><th className="num">Stock</th><th className="num">Avg rate</th><th className="num">Reorder at</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.low ? 'over' : ''}>
              <td>{r.name}</td><td>{r.unit}</td><td className="num">{r.inQty}</td><td className="num">{r.outQty}</td>
              <td className="num"><b>{r.stock}</b></td><td className="num">{money(r.avgRate)}</td><td className="num">{r.reorderLevel ?? ''}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="muted center">Add materials and stock entries first.</td></tr>}
        </tbody>
      </table></div>
    </section>
  );
}

export function WagesReport() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState<WageRow[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get<{ items: WageRow[] }>(`/api/reports/wages?month=${month}`).then((r) => { setRows(r.items); setErr(''); }).catch((x) => setErr(x.message));
  }, [month]);
  const total = rows.reduce((s, r) => s + r.net, 0);
  return (
    <section>
      <PageHead title="Labour wages" sheet="Wages">
        <div className="row">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button className="btn ghost" onClick={() => downloadCsv(`wages-${month}.csv`, ['Name', 'Trade', 'Daily wage', 'Days', 'OT hrs', 'Gross', 'Advance', 'Net payable'],
            rows.map((r) => [r.name, r.trade, r.dailyWage, r.days, r.otHours, r.gross, r.advance, r.net]))}>Export CSV</button>
        </div>
      </PageHead>
      {err && <p className="error">{err}</p>}
      <p className="small muted">Full day = 1, half day = 0.5. Overtime paid at daily wage ÷ 8 per hour. Net payable: <b>{money(total)}</b></p>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Trade</th><th className="num">Wage/day</th><th className="num">Days</th><th className="num">OT hrs</th><th className="num">Gross</th><th className="num">Advance</th><th className="num">Net</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td><td>{r.trade}</td><td className="num">{money(r.dailyWage)}</td><td className="num">{r.days}</td><td className="num">{r.otHours}</td>
              <td className="num">{money(r.gross)}</td><td className="num">{money(r.advance)}</td><td className="num"><b>{money(r.net)}</b></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="muted center">No attendance this month.</td></tr>}
        </tbody>
      </table></div>
    </section>
  );
}
