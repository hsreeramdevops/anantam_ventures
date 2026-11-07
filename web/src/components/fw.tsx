import { ReactNode, useState } from 'react';
import { money } from '../format';
import { useProject } from '../project';

const NON_LATIN = /[^\u0000-\u024F\u2000-\u20CF\u2190-\u21FF\u2713\s]/;
/** Condensed uppercase only reads well in Latin script; other scripts keep normal case. */
export const caseClass = (text: unknown) => (NON_LATIN.test(String(text ?? '')) ? 'nocase' : '');

const sheetDate = () => new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

/** Drawing title block: project, sheet (screen) and today's date. */
export function TitleBlock({ sheet }: { sheet: string }) {
  const { current } = useProject();
  return (
    <div className="titleblock" aria-label="Title block">
      <div><span className="lbl">Project</span><b title={current?.name}>{current?.name ?? 'All projects'}</b></div>
      <div><span className="lbl">Sheet</span><b>{sheet}</b></div>
      <div><span className="lbl">Date</span><b>{sheetDate()}</b></div>
    </div>
  );
}

/** Page heading with the title block on the right. */
export function PageHead({ title, sheet, sub, children }: { title: ReactNode; sheet: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className={typeof title === 'string' ? caseClass(title) : ''}>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
        {children && <div className="actions-bar" style={{ marginTop: 14 }}>{children}</div>}
      </div>
      <TitleBlock sheet={sheet} />
    </div>
  );
}

/** Status in colour plus a second cue: solid fill, hatching, or outline with a tick. */
export function StatusTag({ status }: { status: unknown }) {
  const s = String(status ?? '');
  if (s === 'Paid') return <span className="tag ok">✓ Paid</span>;
  if (s === 'Partially Paid') return <span className="tag part">Part</span>;
  if (s === 'Unpaid') return <span className="tag u">Unpaid</span>;
  return s ? <span className={`pill ${s.replace(/\s/g, '-').toLowerCase()}`}>{s}</span> : null;
}

/** Revision cloud marker: AI-read data still needs a human check. */
export function ReviewCloud({ label = 'AI read · check' }: { label?: string }) {
  return (
    <span className="rev" title="Needs review">
      <svg viewBox="0 0 16 14" aria-hidden="true"><path d="M8 1 15 13H1z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="11.5" fontSize="7" textAnchor="middle" fill="currentColor" fontFamily="monospace" fontWeight="700">1</text></svg>
      {label}
    </span>
  );
}

/** Paid portion solid, remaining balance hatched. `preview` shows a payment being entered. */
export function HatchBar({ total, paid, preview = 0, size, label }: { total: number; paid: number; preview?: number; size?: 'mini' | 'big'; label?: string }) {
  const pct = (v: number) => `${total > 0 ? Math.min(100, Math.max(0, (v / total) * 100)) : 0}%`;
  return (
    <span className={`hatchbar ${size ?? ''}`} role="img" aria-label={`${money(paid)} paid of ${money(total)}`}>
      <i style={{ width: pct(paid) }}>{label}</i>
      {preview > 0 && <i className="preview" style={{ width: pct(preview) }} />}
    </span>
  );
}

/** Dimension line: |←— value —→| */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="dim" aria-hidden="false"><span>{children}</span></span>;
}

/** Stencil [COPY] chip; inverts with a tick for 1s after copying. */
export function CopyChip({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={`cbtn ${done ? 'done' : ''}`} aria-label={`Copy ${label}`}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1000); } catch { prompt(label, value); }
      }}>{done ? '✓ COPIED' : 'COPY'}</button>
  );
}
