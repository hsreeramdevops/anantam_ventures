import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, fileUrl } from '../api';
import { useEntity } from '../auth';
import EntityForm from '../components/EntityForm';
import { useRefs } from '../components/useRefs';
import { downloadCsv, fmtDate, money } from '../format';
import { compareValues, defaultSort, SortSpec, sortKind } from '../sort';
import { Doc, FieldDef } from '../types';

interface Props {
  type?: string;
  toolbar?: (reload: () => void, openEdit: (d: Doc) => void) => ReactNode;
  rowActions?: (d: Doc, reload: () => void) => ReactNode;
  defaults?: Record<string, unknown>;
  reloadKey?: number;
  /** Toggle filter shown as a button with a count badge (e.g. "Needs review"). */
  quickFilter?: { label: string; test: (d: Doc) => boolean };
  /** Extra marker rendered after the first column's value (e.g. a "Guest" pill). */
  badge?: (d: Doc) => ReactNode;
  /** Top-level tabs (e.g. Unpaid / Paid / All); the first is the default, `?tab=<key>` selects one. */
  tabs?: { key: string; label: string; test: (d: Doc) => boolean }[];
  /** Summary shown inside each tab button for the records in that tab (e.g. count and total). */
  tabSummary?: (items: Doc[], tabKey: string) => ReactNode;
}

export default function EntityPage(props: Props) {
  const params = useParams();
  const type = props.type ?? params.type ?? '';
  const def = useEntity(type);
  const { refs, label, reload: reloadRefs } = useRefs(def);
  const [items, setItems] = useState<Doc[]>([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [editing, setEditing] = useState<Partial<Doc> | null>(null);
  const [quickOn, setQuickOn] = useState(false);
  const [search, setSearch] = useSearchParams();
  const tab = props.tabs?.find((t) => t.key === search.get('tab')) ?? props.tabs?.[0];

  const load = useCallback(async () => {
    try { setItems((await api.list(type)).items); setErr(''); } catch (x: any) { setErr(x.message); }
  }, [type]);
  useEffect(() => { load(); }, [load, props.reloadKey]);
  // Deep link (e.g. from a Telegram alert): ?open=<id> opens that record once loaded.
  useEffect(() => {
    const id = search.get('open');
    const d = id ? items.find((x) => x.id === id) : null;
    if (!d) return;
    reloadRefs(); setEditing(d);
    const next = new URLSearchParams(search); next.delete('open'); setSearch(next, { replace: true });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const cols = useMemo(() => def?.fields.filter((f) => f.list) ?? [], [def]);
  const filterable = useMemo(() => cols.filter((f) => f.type === 'select').slice(0, 3), [cols]);

  const display = useCallback((f: FieldDef, d: Doc): string => {
    const v = d[f.name];
    if (f.type === 'money') return money(v);
    if (f.type === 'date') return fmtDate(v);
    if (f.type === 'boolean') return v ? 'Yes' : '';
    if (f.type === 'ref') return label(f.ref!, v);
    if (f.name === 'at') return new Date(String(v)).toLocaleString('en-IN');
    return v === null || v === undefined ? '' : String(v);
  }, [label]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let r = (tab ? items.filter(tab.test) : items).filter((d) => Object.entries(filters).every(([k, v]) => !v || d[k] === v));
    if (quickOn && props.quickFilter) r = r.filter(props.quickFilter.test);
    if (needle) r = r.filter((d) => cols.some((f) => display(f, d).toLowerCase().includes(needle)) || String(d.notes ?? '').toLowerCase().includes(needle));
    const s = sort ?? defaultSort(cols);
    const f = s && cols.find((c) => c.name === s.key);
    if (s && f) {
      const kind = sortKind(f);
      // Text columns compare what the user sees (e.g. ref labels); dates/numbers compare raw values.
      const text = kind === 'text' ? (d: Doc) => display(f, d) : null;
      r = [...r].sort((a, b) =>
        (text ? compareValues('text', text(a), text(b), s.dir) : compareValues(kind, a[s.key], b[s.key], s.dir))
        || compareValues('date', a.createdAt, b.createdAt, -1));
    }
    return r;
  }, [items, filters, q, sort, cols, display, quickOn, props.quickFilter, tab]);
  const activeSort = sort ?? defaultSort(cols);

  if (!def) return <p className="muted">Not available.</p>;

  const openEdit = (d: Partial<Doc>) => { reloadRefs(); setEditing(d); };
  const remove = async (d: Doc) => {
    if (!confirm(`Delete this ${def.label.toLowerCase()}?`)) return;
    try { await api.remove(type, d.id); load(); } catch (x: any) { alert(x.message); }
  };
  const moneyCols = cols.filter((c) => c.type === 'money');

  return (
    <section>
      <div className="page-head">
        <h1>{def.plural}</h1>
        <div className="row wrap">
          {props.toolbar?.(load, openEdit)}
          <button className="btn ghost" onClick={() => downloadCsv(`${type}-${new Date().toISOString().slice(0, 10)}.csv`,
            def.fields.map((f) => f.label), rows.map((d) => def.fields.map((f) => (f.type === 'money' || f.type === 'number' ? d[f.name] : display(f, d)))))}>
            Export CSV
          </button>
          {def.canWrite && <button className="btn primary" onClick={() => openEdit({ ...props.defaults })}>+ New {def.label.toLowerCase()}</button>}
        </div>
      </div>

      {props.tabs && (
        <div className="tabs" role="tablist">
          {props.tabs.map((t) => {
            const inTab = items.filter(t.test);
            return (
              <button key={t.key} role="tab" aria-selected={tab?.key === t.key} className={`tab ${tab?.key === t.key ? 'active' : ''}`}
                onClick={() => setSearch((sp) => { sp.set('tab', t.key); return sp; }, { replace: true })}>
                <span>{t.label}</span>
                <span className="muted small">{props.tabSummary ? props.tabSummary(inTab, t.key) : inTab.length}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="row wrap filters">
        <input className="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        {filterable.map((f) => (
          <select key={f.name} value={filters[f.name] ?? ''} onChange={(e) => setFilters((s) => ({ ...s, [f.name]: e.target.value }))}>
            <option value="">All {f.label.toLowerCase()}</option>
            {f.options!.map((o) => <option key={o}>{o}</option>)}
          </select>
        ))}
        {props.quickFilter && (
          <button className={`btn small ${quickOn ? 'primary' : ''}`} onClick={() => setQuickOn((o) => !o)}>
            {props.quickFilter.label} <span className="pill unpaid">{(tab ? items.filter(tab.test) : items).filter(props.quickFilter.test).length}</span>
          </button>
        )}
        <span className="muted small">{rows.length} of {tab ? items.filter(tab.test).length : items.length}</span>
        {moneyCols.length > 0 && (
          <span className="small">{moneyCols.map((c) => `${c.label}: ${money(rows.reduce((s, d) => s + Number(d[c.name] ?? 0), 0))}`).join(' · ')}</span>
        )}
      </div>
      {err && <p className="error">{err}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name} onClick={() => setSort({ key: c.name, dir: activeSort?.key === c.name && activeSort.dir === 1 ? -1 : 1 })}>
                  {c.label}{activeSort?.key === c.name ? (activeSort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                {cols.map((c, i) => (
                  <td key={c.name} className={c.type === 'money' ? 'num' : ''}>
                    {c.type === 'file' && d[c.name] ? (
                      def.type === 'sitePhoto'
                        ? <a href={fileUrl(String(d[c.name]))} target="_blank" rel="noreferrer"><img className="thumb" src={fileUrl(String(d[c.name]))} alt="" loading="lazy" /></a>
                        : <a href={fileUrl(String(d[c.name]))} target="_blank" rel="noreferrer">View</a>
                    ) : c.name === 'status' ? <span className={`pill ${String(d.status ?? '').replace(/\s/g, '-').toLowerCase()}`}>{display(c, d)}</span>
                      : display(c, d)}
                    {i === 0 && props.badge?.(d)}
                  </td>
                ))}
                <td className="actions">
                  {props.rowActions?.(d, load)}
                  {def.canWrite && <button className="btn small" onClick={() => openEdit(d)}>Edit</button>}
                  {def.canWrite && <button className="btn small danger" onClick={() => remove(d)}>Delete</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cols.length + 1} className="muted center">No records</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <EntityForm def={def} initial={editing} refs={refs} refLabel={label}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}
