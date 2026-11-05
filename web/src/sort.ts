import { FieldDef } from './types';

export interface SortSpec { key: string; dir: 1 | -1 }
type Kind = 'number' | 'date' | 'text';

const empty = (v: unknown) => v === null || v === undefined || v === '';

export const sortKind = (f: Pick<FieldDef, 'name' | 'type'>): Kind =>
  f.type === 'money' || f.type === 'number' ? 'number'
    : f.type === 'date' || f.name === 'at' || f.name === 'createdAt' || f.name === 'updatedAt' ? 'date' : 'text';

/**
 * Compares two values for a column. Dates (ISO `YYYY-MM-DD` or timestamps) compare chronologically on the raw
 * value, numbers numerically, text case-insensitively. Empty values always sort last, whatever the direction.
 */
export function compareValues(kind: Kind, a: unknown, b: unknown, dir: 1 | -1, text?: (v: unknown) => string): number {
  const ea = empty(a), eb = empty(b);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1;
  let cmp: number;
  if (kind === 'number') cmp = Number(a) - Number(b);
  else if (kind === 'date') {
    const ta = Date.parse(String(a)), tb = Date.parse(String(b));
    cmp = Number.isNaN(ta) || Number.isNaN(tb) ? String(a).localeCompare(String(b)) : ta - tb;
  } else {
    const t = text ?? String;
    cmp = t(a).localeCompare(t(b), undefined, { sensitivity: 'base', numeric: true });
  }
  return cmp * dir;
}

/** Default order when no column is clicked: the main date (first listed date column) newest first. */
export function defaultSort(fields: FieldDef[]): SortSpec | null {
  const listed = fields.filter((f) => f.list);
  const main = listed.find((f) => f.name === 'billDate') ?? listed.find((f) => sortKind(f) === 'date');
  return main ? { key: main.name, dir: -1 } : null;
}
