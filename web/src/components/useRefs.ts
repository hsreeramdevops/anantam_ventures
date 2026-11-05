import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Doc, EntityDef } from '../types';

/** Loads every entity referenced by `def`'s ref fields so ids can be shown as names and picked in forms. */
export function useRefs(def: EntityDef | undefined) {
  const { entities } = useAuth();
  const [refs, setRefs] = useState<Record<string, Doc[]>>({});

  const load = useCallback(async () => {
    if (!def) return;
    const types = [...new Set(def.fields.filter((f) => f.type === 'ref' && f.ref).map((f) => f.ref!))]
      .filter((t) => entities.some((e) => e.type === t));
    const pairs = await Promise.all(types.map(async (t) => [t, (await api.list(t).catch(() => ({ items: [] }))).items] as const));
    setRefs(Object.fromEntries(pairs));
  }, [def, entities]);

  useEffect(() => { load(); }, [load]);

  const label = useCallback((refType: string, id: unknown) => {
    if (!id) return '';
    const target = entities.find((e) => e.type === refType);
    const doc = refs[refType]?.find((d) => d.id === id);
    if (!doc) return '—';
    if (refType === 'flat') return [doc.block, doc.number].filter(Boolean).join('-');
    if (refType === 'booking') return `${doc.customerName}`;
    return String(doc[target?.titleField ?? 'name'] ?? doc.id);
  }, [refs, entities]);

  return { refs, label, reload: load };
}
