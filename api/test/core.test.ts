import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.LOCAL_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'av-'));
process.env.BOOTSTRAP_ADMIN_EMAIL = 'Owner@Example.com';

import { categorize } from '../src/ai/categorize';
import { mapInvoice } from '../src/ai/docintel';
import { devOutbox } from '../src/auth/email';
import { requestOtp, verifyOtp, RateLimitError } from '../src/auth/otp';
import { sniffType, newBlobName, isValidBlobName } from '../src/files/blob';
import { dashboard, labourWages, materialStock } from '../src/reports';
import { entityDef, validate, ValidationError } from '../src/schema';
import { createEntity, deleteEntity, updateEntity } from '../src/service';
import { FileStore } from '../src/store/fileStore';
import { setStore } from '../src/store';
import { SessionUser } from '../src/auth/session';

const admin: SessionUser = { id: 'u1', username: 'admin', name: 'A', email: 'a@x.com', role: 'admin' };
const viewer: SessionUser = { ...admin, id: 'u2', username: 'v', role: 'viewer' };

beforeEach(() => {
  setStore(new FileStore(path.join(mkdtempSync(path.join(os.tmpdir(), 'av-db-')), 'db.json')));
  devOutbox.length = 0;
});

describe('validate', () => {
  const bill = entityDef('bill')!;
  it('coerces money, drops unknown fields', () => {
    const v = validate(bill, { payee: 'P', total: '1,234.567', category: 'Cement', hacker: 'x' });
    expect(v.total).toBe(1234.57);
    expect(v).not.toHaveProperty('hacker');
  });
  it('rejects bad select / missing required / bad dates', () => {
    expect(() => validate(bill, { total: 1, category: 'Nope' })).toThrow(ValidationError);
    expect(() => validate(bill, { payee: 'P', category: 'Cement' })).toThrow(/Total is required/);
    expect(() => validate(bill, { total: 1, category: 'Cement' })).toThrow(/Whom to pay is required/);
    expect(validate(bill, { paidAmount: 5 }, true)).toEqual({ paidAmount: 5 });
    expect(() => validate(bill, { payee: 'P', total: 1, category: 'Cement', dueDate: '05/11/2026' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('categorize', () => {
  it('uses keywords and vendor defaults', () => {
    expect(categorize('UltraTech OPC 53 grade 50 bags')).toBe('Cement');
    expect(categorize('TMT Fe 550D 12mm')).toBe('Steel');
    expect(categorize('M-Sand 2 loads')).toBe('Sand & Aggregates');
    expect(categorize('random stuff')).toBe('Miscellaneous');
    expect(categorize('cement', 'Transport')).toBe('Transport');
  });
});

describe('mapInvoice', () => {
  it('maps Document Intelligence fields and derives tax', () => {
    const p = mapInvoice({
      content: 'Sri Balaji Traders cement',
      documents: [{ fields: {
        VendorName: { valueString: 'Sri Balaji Traders' }, InvoiceId: { valueString: 'INV-42' },
        InvoiceDate: { valueDate: '2026-10-01' }, SubTotal: { valueCurrency: { amount: 1000 } },
        InvoiceTotal: { valueCurrency: { amount: 1180 } },
        Items: { valueArray: [{ valueObject: { Description: { valueString: 'OPC cement 53' } } }] },
      } }],
    });
    expect(p).toMatchObject({ vendorName: 'Sri Balaji Traders', billNumber: 'INV-42', billDate: '2026-10-01', subtotal: 1000, total: 1180, tax: 180 });
    expect(categorize(p.itemsText)).toBe('Cement');
  });
});

describe('OTP login', () => {
  it('bootstraps the first admin and verifies once', async () => {
    await requestOtp('owner@example.com');
    const code = devOutbox[0].subject.match(/(\d{6})/)![1];
    expect(await verifyOtp('owner@example.com', '000000' === code ? '111111' : '000000')).toBeNull();
    const user = await verifyOtp('owner', code);
    expect(user?.role).toBe('admin');
    expect(await verifyOtp('owner', code)).toBeNull(); // single use
  });
  it('is silent for unknown users and rate-limits', async () => {
    await requestOtp('nobody@example.com');
    expect(devOutbox).toHaveLength(0);
    await requestOtp('owner@example.com');
    await requestOtp('owner@example.com');
    await requestOtp('owner@example.com');
    await expect(requestOtp('owner@example.com')).rejects.toBeInstanceOf(RateLimitError);
  });
  it('locks after too many wrong codes', async () => {
    await requestOtp('owner@example.com');
    const code = devOutbox[0].subject.match(/(\d{6})/)![1];
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await verifyOtp('owner', wrong);
    expect(await verifyOtp('owner', code)).toBeNull();
  });
});

describe('service rules', () => {
  it('derives bill payment status', async () => {
    const b = await createEntity(admin, 'bill', { payee: 'P', total: 1000, category: 'Cement' }, {}, 'p1');
    expect(b.status).toBe('Unpaid');
    const p = await updateEntity(admin, 'bill', b.id, { paidAmount: 400 }, 'p1');
    expect(p.status).toBe('Partially Paid');
    const f = await updateEntity(admin, 'bill', b.id, { status: 'Paid', paidAmount: null }, 'p1');
    expect(f).toMatchObject({ status: 'Paid', paidAmount: 1000 });
    const u = await updateEntity(admin, 'bill', b.id, { status: 'Unpaid' }, 'p1');
    expect(u).toMatchObject({ status: 'Unpaid', paidAmount: 0 });
  });
  it('enforces roles', async () => {
    await expect(createEntity(viewer, 'bill', { total: 1, category: 'Cement' })).rejects.toThrow(/Not allowed/);
  });
  it('booking flips flat status', async () => {
    const { getStore } = await import('../src/store');
    const flat = await createEntity(admin, 'flat', { number: '101', status: 'Available' }, {}, 'p1');
    const bk = await createEntity(admin, 'booking', { flatId: flat.id, customerName: 'Ravi', agreedPrice: 5000000 }, {}, 'p1');
    expect((await getStore().get('flat', flat.id))!.status).toBe('Booked');
    await deleteEntity(admin, 'booking', bk.id, 'p1');
    expect((await getStore().get('flat', flat.id))!.status).toBe('Available');
  });
  it('protects last admin and unique usernames', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'a@x.com'; // only the owner may set roles
    const a = await createEntity(admin, 'user', { username: 'Boss', name: 'B', email: 'b@x.com', role: 'admin' });
    expect(a.username).toBe('boss');
    await expect(createEntity(admin, 'user', { username: 'boss', name: 'C', email: 'c@x.com', role: 'viewer' })).rejects.toThrow(/taken/);
    await expect(updateEntity(admin, 'user', a.id, { role: 'viewer' })).rejects.toThrow(/last active admin/);
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
  });
});

describe('reports', () => {
  it('computes stock, wages and dashboard', () => {
    const stock = materialStock([{ id: 'm', type: 'material', name: 'Cement', reorderLevel: 20 }],
      [{ id: '1', type: 'materialTxn', materialId: 'm', direction: 'In', quantity: 50, rate: 400 },
       { id: '2', type: 'materialTxn', materialId: 'm', direction: 'Out', quantity: 35 }]);
    expect(stock[0]).toMatchObject({ stock: 15, low: true, avgRate: 400 });
    const w = labourWages([{ id: 'l', type: 'labourer', name: 'X', dailyWage: 800 }],
      [{ id: 'a', type: 'attendance', labourerId: 'l', date: '2026-11-01', presence: 'Full Day', overtimeHours: 2 },
       { id: 'b', type: 'attendance', labourerId: 'l', date: '2026-11-02', presence: 'Half Day', advancePaid: 300 }], '2026-11');
    expect(w[0]).toMatchObject({ days: 1.5, gross: 1400, net: 1100 });
    const d = dashboard({
      bill: [{ id: 'b', type: 'bill', total: 1000, category: 'Cement', status: 'Unpaid', dueDate: '2026-11-01' }],
      budget: [{ id: 'g', type: 'budget', category: 'Cement', amount: 500 }],
    }, '2026-11-05');
    expect(d.totals).toMatchObject({ spend: 1000, unpaidBills: 1000, overdueBills: 1 });
    expect(d.budgetVsActual[0]).toMatchObject({ category: 'Cement', over: true });
  });
});

describe('files', () => {
  it('sniffs types and validates names', () => {
    expect(sniffType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffType(Buffer.from('MZ\x90'))).toBeNull();
    const n = newBlobName('bills', '../../etc/passwd bill.pdf');
    expect(isValidBlobName(n)).toBe(true);
    expect(isValidBlobName('bills/../../secret')).toBe(false);
  });
});
