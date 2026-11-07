import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api, fileUrl } from '../api';
import { useEntity } from '../auth';
import EntityForm from '../components/EntityForm';
import { Dim, PageHead, StatusTag } from '../components/fw';
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
  /** Title-block sheet name (defaults to the entity's plural). */
  sheet?: string;
  /** Hero block between the heading and the tabs (e.g. the outstanding figure). Gets the active tab's records. */
  hero?: (tabItems: Doc[], tabKey: string | undefined) => ReactNode;
  /** Class for the "+ New" button; '' keeps it outlined when another action is the page's yellow one. */
  newClass?: string;
  /** Custom cell content; return undefined for the default rendering. */
  cellRender?: (f: FieldDef, d: Doc) => ReactNode | undefined;
  /** Column order (listed names first) and columns to hide. */
  order?: string[];
  hideCols?: string[];
  rowClass?: (d: Doc) => string;
  /** Row click / Enter on the selected row. Defaults to Edit (when allowed) for Enter only. */
  onOpen?: (d: Doc) => void;
  /** Footer under the table; defaults to dimension-line totals of the money columns. */
  footer?: (rows: Doc[]) => ReactNode;
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

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
  const [selIdx, setSelIdx] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

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

  const cols = useMemo(() => {
    const listed = def?.fields.filter((f) => f.list && !props.hideCols?.includes(f.name)) ?? [];
    const rank = (f: FieldDef) => { const i = props.order?.indexOf(f.name) ?? -1; return i < 0 ? 999 : i; };
    return props.order ? [...listed].sort((a, b) => rank(a) - rank(b)) : listed;
  }, [def, props.order, props.hideCols]);
  const filterable = useMemo(() => cols.filter((f) => f.type === 'select').slice(0, 3), [cols]);

  const display = useCallback((f: FieldDef, d: Doc): string => {
    const v = (d[f.name] === null || d[f.name] === undefined || d[f.name] === '') && f.fallback ? d[f.fallback] : d[f.name];
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
  const setTab = useCallback((key: string) => setSearch((sp) => { sp.set('tab', key); return sp; }, { replace: true }), [setSearch]);
  useEffect(() => { setSelIdx(-1); }, [tab?.key, q, filters, quickOn]);

  // Keyboard: U/P/A (first letter of each tab) switch tabs, / searches, ↑/↓ select a row, Enter opens it.
  const openRow = props.onOpen ?? (def?.canWrite ? (d: Doc) => { reloadRefs(); setEditing(d); } : undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || editing || document.querySelector('.modal-bg')) return;
      const k = e.key;
      if (k === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      const t = props.tabs?.find((x) => x.label[0].toLowerCase() === k.toLowerCase());
      if (t && k.length === 1) { e.preventDefault(); setTab(t.key); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        if (!rows.length) return;
        e.preventDefault();
        setSelIdx((i) => {
          const n = k === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
          bodyRef.current?.children[n]?.scrollIntoView({ block: 'nearest' });
          return n;
        });
        return;
      }
      if (k === 'Enter' && openRow) {
        const el = e.target as HTMLElement | null;
        if (el && ['BUTTON', 'A'].includes(el.tagName)) return;
        const d = selIdx >= 0 ? rows[selIdx] : undefined;
        if (d) { e.preventDefault(); openRow(d); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selIdx, editing, openRow, props.tabs, setTab]);

  if (!def) return <p className="muted">Not available.</p>;

  const openEdit = (d: Partial<Doc>) => { reloadRefs(); setEditing(d); };
  const remove = async (d: Doc) => {
    if (!confirm(`Delete this ${def.label.toLowerCase()}?`)) return;
    try { await api.remove(type, d.id); load(); } catch (x: any) { alert(x.message); }
  };
  const moneyCols = cols.filter((c) => c.type === 'money');

  const tabItems = tab ? items.filter(tab.test) : items;
  const defaultFooter = (r: Doc[]) => moneyCols.length > 0 && (
    <div className="sum">
      {moneyCols.map((c) => (
        <span key={c.name} className="row">
          <span className="lbl">{c.label}</span>
          <Dim>{r.length} rows</Dim>
          <b>{money(r.reduce((s, d) => s + Number(d[c.name] ?? 0), 0))}</b>
        </span>
      ))}
    </div>
  );
  const footer = (props.footer ?? defaultFooter)(rows);

  return (
    <section>
      <PageHead title={def.plural} sheet={props.sheet ?? def.plural}>
        {props.toolbar?.(load, openEdit)}
        {def.canWrite && <button className={`btn ${props.newClass ?? 'primary'}`} onClick={() => openEdit({ ...props.defaults })}>+ New {def.label.toLowerCase()}</button>}
        <button className="btn ghost" onClick={() => downloadCsv(`${type}-${new Date().toISOString().slice(0, 10)}.csv`,
          def.fields.map((f) => f.label), rows.map((d) => def.fields.map((f) => (f.type === 'money' || f.type === 'number' ? d[f.name] : display(f, d)))))}>
          Export CSV
        </button>
      </PageHead>

      {props.hero?.(tabItems, tab?.key)}

      {props.tabs && (
        <div className="tabs" role="tablist" aria-label="Filter by payment status">
          {props.tabs.map((t) => {
            const inTab = items.filter(t.test);
            const on = tab?.key === t.key;
            return (
              <button key={t.key} role="tab" aria-selected={on} className={`tab ${on ? 'active' : ''}`} onClick={() => setTab(t.key)}
                title={`Press ${t.label[0].toUpperCase()}`}>
                <b>{t.label} <span className="key" aria-hidden="true">{t.label[0].toUpperCase()}</span></b>
                <span className={`muted ${t.key === 'unpaid' ? 'u' : ''}`}>{props.tabSummary ? props.tabSummary(inTab, t.key) : inTab.length}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="row wrap filters">
        <input ref={searchRef} className="search" placeholder="Search…  ( / )" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); if (e.key === 'Enter' && rows[0] && props.onOpen) props.onOpen(rows[0]); }} />
        {filterable.map((f) => (
          <select key={f.name} aria-label={f.label} value={filters[f.name] ?? ''} onChange={(e) => setFilters((s) => ({ ...s, [f.name]: e.target.value }))}>
            <option value="">All {f.label.toLowerCase()}</option>
            {f.options!.map((o) => <option key={o}>{o}</option>)}
          </select>
        ))}
        {props.quickFilter && (
          <button className={`fchip rev ${quickOn ? 'on' : ''}`} aria-pressed={quickOn} onClick={() => setQuickOn((o) => !o)}>
            {props.quickFilter.label} <span className="n">{tabItems.filter(props.quickFilter.test).length}</span>
          </button>
        )}
        <span className="spacer" />
        <span className="muted small mono">{rows.length} of {tabItems.length}</span>
      </div>
      {err && <p className="error">{err}</p>}

      <div className="table-wrap">
        <table className="stack">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name} className={c.type === 'money' ? 'num' : ''} aria-sort={activeSort?.key === c.name ? (activeSort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  onClick={() => setSort({ key: c.name, dir: activeSort?.key === c.name && activeSort.dir === 1 ? -1 : 1 })}>
                  {c.label}{activeSort?.key === c.name ? (activeSort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((d, ri) => (
              <tr key={d.id} className={`${props.onOpen ? 'clickable' : ''} ${ri === selIdx ? 'sel' : ''} ${props.rowClass?.(d) ?? ''}`}
                onClick={props.onOpen ? (e) => { if (!(e.target as HTMLElement).closest('a,button,input,select')) props.onOpen!(d); } : undefined}>
                {cols.map((c, i) => {
                  const custom = props.cellRender?.(c, d);
                  const text = display(c, d);
                  const empty = custom === undefined && !text && !(c.type === 'file' && d[c.name]) && i !== 0;
                  return (
                    <td key={c.name} data-label={c.label} className={`${c.type === 'money' ? 'num' : c.type === 'date' ? 'date' : ''} ${i === 0 ? 'lead' : ''} ${empty ? 'empty-cell' : ''}`}>
                      {custom !== undefined ? custom : c.type === 'file' && d[c.name] ? (
                        def.type === 'sitePhoto'
                          ? <a href={fileUrl(String(d[c.name]))} target="_blank" rel="noreferrer"><img className="thumb" src={fileUrl(String(d[c.name]))} alt="" loading="lazy" /></a>
                          : <a href={fileUrl(String(d[c.name]))} target="_blank" rel="noreferrer">View</a>
                      ) : c.name === 'status' ? <StatusTag status={d.status} />
                        : text}
                      {i === 0 && props.badge?.(d)}
                    </td>
                  );
                })}
                <td className="actions">
                  {props.rowActions?.(d, load)}
                  {def.canWrite && <button className="btn small" onClick={() => openEdit(d)}>Edit</button>}
                  {def.canWrite && <button className="btn small danger" onClick={() => remove(d)}>Delete</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={cols.length + 1} className="muted center lead">No records</td></tr>}
          </tbody>
          {footer && rows.length > 0 && <tfoot><tr><td colSpan={cols.length + 1}>{footer}</td></tr></tfoot>}
        </table>
      </div>

      {editing && (
        <EntityForm def={def} initial={editing} refs={refs} refLabel={label}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}
