import { useEffect, useState } from 'react';
import { api, fileUrl } from '../api';
import type { PayTo } from './PayDialog';

type Mode = PayTo['mode'];
export const PAY_TO_MODES: { value: Mode; label: string }[] = [
  { value: 'UPI', label: 'UPI / GPay' },
  { value: 'QR', label: 'QR code' },
  { value: 'Bank', label: 'Bank account' },
  { value: 'Cash', label: 'Cash' },
];

/**
 * Payee payment-details inputs (uncontrolled, named: mode, upi, qr, accountHolder, accountNumber,
 * accountNumber2, ifsc, bankName). Shared by the public /pay form, the team payment request and the bill form.
 * `optional` adds a "Not set" choice; `initial` pre-fills (an existing QR is kept unless replaced).
 */
export default function PayToFields({ initial, optional, idPrefix = 'pt' }: { initial?: PayTo | null; optional?: boolean; idPrefix?: string }) {
  const [mode, setMode] = useState<Mode | ''>(initial?.mode ?? (optional ? '' : 'UPI'));
  const [key, setKey] = useState(0);
  // Re-mount the inputs when the prefill changes (e.g. a vendor's previous details).
  useEffect(() => { setMode(initial?.mode ?? (optional ? '' : 'UPI')); setKey((k) => k + 1); }, [initial, optional]);
  const choices = optional ? [{ value: '' as const, label: 'Not set' }, ...PAY_TO_MODES] : PAY_TO_MODES;
  const req = !!mode;
  return (
    <div className="pay-fields" key={key}>
      <div className="mode-choice" role="radiogroup">
        {choices.map((m) => (
          <label key={m.value || 'none'}>
            <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} id={`${idPrefix}-${m.value || 'none'}`} />
            {m.label}
          </label>
        ))}
      </div>
      {mode === 'UPI' && (
        <label className="field"><span>UPI mobile number or UPI ID *</span>
          <input name="upi" required={req} maxLength={100} autoComplete="off" autoCapitalize="none" placeholder="98765 43210 or name@okbank"
            defaultValue={initial?.mode === 'UPI' ? initial.upi ?? '' : ''} />
        </label>
      )}
      {mode === 'QR' && (
        <label className="field"><span>QR code image (photo or screenshot){initial?.qrFile ? ' (leave empty to keep current)' : ' *'}</span>
          <input name="qr" type="file" required={req && !initial?.qrFile} accept="image/jpeg,image/png,image/webp" />
          {initial?.qrFile && (
            <a href={fileUrl(initial.qrFile)} target="_blank" rel="noreferrer"><img className="qr-img" src={fileUrl(initial.qrFile)} alt="Current QR code" /></a>
          )}
        </label>
      )}
      {mode === 'Bank' && (
        <>
          <label className="field"><span>Account holder name *</span><input name="accountHolder" required maxLength={100} defaultValue={initial?.accountHolder ?? ''} /></label>
          <label className="field"><span>Account number *</span>
            <input name="accountNumber" required inputMode="numeric" pattern="[0-9 ]{9,22}" maxLength={22} autoComplete="off" defaultValue={initial?.accountNumber ?? ''} />
          </label>
          <label className="field"><span>Re-enter account number *</span>
            <input name="accountNumber2" required inputMode="numeric" pattern="[0-9 ]{9,22}" maxLength={22} autoComplete="off" defaultValue={initial?.accountNumber ?? ''} />
          </label>
          <label className="field"><span>IFSC *</span>
            <input name="ifsc" required maxLength={11} autoCapitalize="characters" pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" placeholder="SBIN0001234" defaultValue={initial?.ifsc ?? ''} />
          </label>
          <label className="field"><span>Bank name</span><input name="bankName" maxLength={100} defaultValue={initial?.bankName ?? ''} /></label>
        </>
      )}
    </div>
  );
}

const QR_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Reads PayToFields from a form into the JSON `payTo` the bills API accepts, uploading a new QR image first.
 * Returns null when "Not set" is chosen.
 */
export async function payToFromForm(form: HTMLFormElement, current: PayTo | null): Promise<Record<string, string> | null> {
  const fd = new FormData(form);
  const mode = String(fd.get('mode') ?? '');
  if (!mode) return null;
  const out: Record<string, string> = { mode };
  for (const k of ['upi', 'accountHolder', 'accountNumber', 'accountNumber2', 'ifsc', 'bankName']) {
    const v = fd.get(k);
    if (typeof v === 'string') out[k] = v;
  }
  if (mode === 'QR') {
    const file = fd.get('qr');
    if (file instanceof File && file.size > 0) {
      const ext = QR_EXT[file.type];
      if (!ext) throw new Error('QR code must be a JPEG, PNG or WEBP image');
      const named = new File([file], `qr.${ext}`, { type: file.type });
      out.qrFile = (await api.upload('documents', named)).name;
    } else if (current?.mode === 'QR' && current.qrFile) out.qrFile = current.qrFile;
  }
  return out;
}
