import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, fileUrl } from '../api';
import { Doc, EntityDef, FieldDef } from '../types';
import { PayTo, payToOf } from './PayDialog';
import PayToFields, { payToFromForm } from './PayToFields';

interface Props {
  def: EntityDef;
  initial: Partial<Doc>;
  refs: Record<string, Doc[]>;
  refLabel: (type: string, id: unknown) => string;
  onSaved: (doc: Doc) => void;
  onCancel: () => void;
}

export default function EntityForm({ def, initial, refs, refLabel, onSaved, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  const editable = def.fields.filter((f) => !f.readonly);
  const isBill = def.type === 'bill';
  const formRef = useRef<HTMLFormElement>(null);
  const current = isBill ? payToOf(initial as Doc) : null;
  const [payPrefill, setPayPrefill] = useState<PayTo | null>(current);

  // New bill for a known vendor: offer the payment details from that vendor's latest bill.
  const vendorId = isBill && !initial.id ? String(values.vendorId ?? '') : '';
  useEffect(() => {
    if (!vendorId) return;
    let live = true;
    api.list('bill').then(({ items }) => {
      const prev = items.filter((b) => b.vendorId === vendorId && payToOf(b))
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      const chosen = formRef.current ? new FormData(formRef.current).get('mode') : '';
      if (live && prev && !chosen) setPayPrefill(payToOf(prev));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [vendorId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      for (const f of editable) body[f.name] = values[f.name] ?? null;
      if (isBill) {
        const payTo = await payToFromForm(formRef.current!, payPrefill);
        if (payTo || current) body.payTo = payTo;
      }
      const saved = initial.id ? await api.update(def.type, initial.id, body) : await api.create(def.type, body);
      onSaved(saved);
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-bg" onClick={onCancel}>
      <form ref={formRef} className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{initial.id ? 'Edit' : 'New'} {def.label.toLowerCase()}</h2>
        <div className="form-grid">
          {editable.map((f) => (
            <Field key={f.name} f={f} value={values[f.name]} onChange={(v) => set(f.name, v)} refs={refs} refLabel={refLabel} />
          ))}
        </div>
        {isBill && (
          <fieldset className="pay-section">
            <legend>How to pay this vendor</legend>
            {payPrefill && !current && <p className="muted small">Pre-filled from this vendor's previous bill. Choose “Not set” to skip.</p>}
            <PayToFields initial={payPrefill} optional idPrefix="bill-pt" />
          </fieldset>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ f, value, onChange, refs, refLabel }: {
  f: FieldDef; value: unknown; onChange: (v: unknown) => void;
  refs: Record<string, Doc[]>; refLabel: (t: string, id: unknown) => string;
}) {
  const v = value === null || value === undefined ? '' : String(value);
  const label = <>{f.label}{f.required && <span className="req">*</span>}</>;
  switch (f.type) {
    case 'textarea':
      return <label className="wide">{label}<textarea rows={3} value={v} onChange={(e) => onChange(e.target.value)} /></label>;
    case 'select':
      return (
        <label>{label}
          <select value={v} required={f.required} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {f.options!.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
      );
    case 'ref':
      return (
        <label>{label}
          <select value={v} required={f.required} onChange={(e) => onChange(e.target.value)}>
            <option value="">—</option>
            {(refs[f.ref!] ?? []).map((d) => <option key={d.id} value={d.id}>{refLabel(f.ref!, d.id)}</option>)}
          </select>
        </label>
      );
    case 'boolean':
      return <label className="check"><input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />{f.label}</label>;
    case 'file':
      return <FileField f={f} value={v} onChange={onChange} />;
    default:
      return (
        <label>{label}
          <input
            type={f.type === 'money' || f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'}
            step={f.type === 'money' ? '0.01' : 'any'} required={f.required} value={v}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}

function FileField({ f, value, onChange }: { f: FieldDef; value: string; onChange: (v: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <label className="wide">{f.label}{f.required && <span className="req">*</span>}
      <div className="row">
        <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp"
          capture={f.folder === 'photos' ? 'environment' : undefined}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true); setErr('');
            try { onChange((await api.upload(f.folder ?? 'documents', file)).name); }
            catch (x: any) { setErr(x.message); } finally { setBusy(false); }
          }} />
        {busy && <span className="muted small">Uploading…</span>}
        {value && !busy && <a href={fileUrl(value)} target="_blank" rel="noreferrer">View current</a>}
      </div>
      {err && <span className="error small">{err}</span>}
    </label>
  );
}
