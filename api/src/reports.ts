import { isProjectScoped } from './schema';
import { Doc, getStore } from './store';

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => isoDate(new Date(Date.parse(date) + days * 86400000));

export function materialStock(materials: Doc[], txns: Doc[]) {
  return materials.map((m) => {
    let inQty = 0, outQty = 0, inValue = 0;
    for (const t of txns) {
      if (t.materialId !== m.id) continue;
      if (t.direction === 'In') { inQty += n(t.quantity); inValue += n(t.quantity) * n(t.rate); }
      else outQty += n(t.quantity);
    }
    const stock = r2(inQty - outQty);
    const reorder = m.reorderLevel == null ? null : n(m.reorderLevel);
    return {
      id: m.id, name: m.name, unit: m.unit, inQty: r2(inQty), outQty: r2(outQty), stock,
      avgRate: inQty ? r2(inValue / inQty) : null, reorderLevel: reorder, low: reorder !== null && stock <= reorder,
    };
  });
}

/** Wages for a month (YYYY-MM): full day = 1, half = 0.5, overtime paid at wage/8 per hour. */
export function labourWages(labourers: Doc[], attendance: Doc[], month: string) {
  return labourers.map((l) => {
    let days = 0, otHours = 0, advance = 0;
    for (const a of attendance) {
      if (a.labourerId !== l.id || !String(a.date).startsWith(month)) continue;
      days += a.presence === 'Full Day' ? 1 : a.presence === 'Half Day' ? 0.5 : 0;
      otHours += n(a.overtimeHours);
      advance += n(a.advancePaid);
    }
    const wage = n(l.dailyWage);
    const gross = r2(days * wage + otHours * (wage / 8));
    return { id: l.id, name: l.name, trade: l.trade, dailyWage: wage, days, otHours, gross, advance: r2(advance), net: r2(gross - advance) };
  }).filter((w) => w.days > 0 || w.advance > 0);
}

export function dashboard(data: Record<string, Doc[]>, today = isoDate(new Date())) {
  const { bill = [], budget = [], customerPayment = [], flat = [], task = [], milestone = [], material = [], materialTxn = [], labourer = [], attendance = [], document = [] } = data;
  const soon = addDays(today, 7);

  const spendByCategory: Record<string, number> = {};
  const spendByPhase: Record<string, number> = {};
  const spendByMonth: Record<string, number> = {};
  let totalSpend = 0, unpaid = 0, overdueBills = 0, paid = 0, unpaidCount = 0, paidCount = 0, payRequests = 0;
  const dueSoon: Doc[] = [];
  for (const b of bill) {
    const t = n(b.total);
    totalSpend += t;
    spendByCategory[String(b.category ?? 'Miscellaneous')] = (spendByCategory[String(b.category ?? 'Miscellaneous')] ?? 0) + t;
    spendByPhase[String(b.phase ?? 'General')] = (spendByPhase[String(b.phase ?? 'General')] ?? 0) + t;
    const m = String(b.billDate ?? b.createdAt ?? '').slice(0, 7);
    if (m) spendByMonth[m] = (spendByMonth[m] ?? 0) + t;
    // Paid bills count in full even if paidAmount was never filled in (e.g. imported history).
    paid += b.status === 'Paid' ? t : Math.min(t, n(b.paidAmount));
    if (b.status === 'Paid') paidCount++;
    if (b.status !== 'Paid') {
      const outstanding = t - n(b.paidAmount);
      unpaid += outstanding;
      unpaidCount++;
      if (b.source === 'payment-request') payRequests++;
      if (b.dueDate && String(b.dueDate) < today) overdueBills++;
      if (b.dueDate && String(b.dueDate) <= soon) dueSoon.push({ ...b, outstanding: r2(outstanding) });
    }
  }

  const budgetByCategory: Record<string, number> = {};
  for (const b of budget) budgetByCategory[String(b.category)] = (budgetByCategory[String(b.category)] ?? 0) + n(b.amount);
  const budgetVsActual = Object.keys({ ...budgetByCategory, ...spendByCategory }).sort().map((category) => {
    const budgeted = r2(budgetByCategory[category] ?? 0), actual = r2(spendByCategory[category] ?? 0);
    return { category, budget: budgeted, actual, variance: r2(budgeted - actual), over: budgeted > 0 && actual > budgeted };
  });

  let receivable = 0, received = 0, overdueReceivables = 0;
  for (const p of customerPayment) {
    received += n(p.receivedAmount);
    if (p.status !== 'Received') {
      receivable += n(p.amount) - n(p.receivedAmount);
      if (p.dueDate && String(p.dueDate) < today) overdueReceivables++;
    }
  }

  const flats: Record<string, number> = { Available: 0, Blocked: 0, Booked: 0, Sold: 0 };
  for (const f of flat) flats[String(f.status)] = (flats[String(f.status)] ?? 0) + 1;

  const openTasks = task.filter((t) => t.status !== 'Done');
  const progress = milestone.length ? Math.round(milestone.reduce((s, m) => s + Math.min(100, n(m.percentComplete)), 0) / milestone.length) : 0;
  const lowStock = materialStock(material, materialTxn).filter((m) => m.low);
  const month = today.slice(0, 7);
  const wages = labourWages(labourer, attendance, month);
  const expiringDocs = document.filter((d) => d.expiresOn && String(d.expiresOn) <= addDays(today, 30));

  return {
    today,
    totals: {
      spend: r2(totalSpend), unpaidBills: r2(unpaid), overdueBills, paidBills: r2(paid), unpaidCount, paidCount, payRequests, receivable: r2(receivable), received: r2(received),
      overdueReceivables, openTasks: openTasks.length, overdueTasks: openTasks.filter((t) => t.dueDate && String(t.dueDate) < today).length,
      progress, wagesThisMonth: r2(wages.reduce((s, w) => s + w.gross, 0)), billsToReview: bill.filter((b) => b.needsReview).length,
    },
    spendByCategory: Object.entries(spendByCategory).map(([k, v]) => ({ name: k, value: r2(v) })).sort((a, b) => b.value - a.value),
    spendByPhase: Object.entries(spendByPhase).map(([k, v]) => ({ name: k, value: r2(v) })).sort((a, b) => b.value - a.value),
    spendByMonth: Object.entries(spendByMonth).sort().slice(-12).map(([k, v]) => ({ name: k, value: r2(v) })),
    budgetVsActual,
    flats,
    dueSoon: dueSoon.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).slice(0, 20),
    lowStock,
    expiringDocs: expiringDocs.map((d) => ({ id: d.id, title: d.title, expiresOn: d.expiresOn })),
  };
}

/** Loads every doc of `types`; with `projectId`, only that project's docs (global types are unfiltered). */
export async function loadAll(types: string[], projectId?: string) {
  const store = getStore();
  const entries = await Promise.all(types.map(async (t) => {
    const docs = await store.list(t);
    return [t, projectId && isProjectScoped(t) ? docs.filter((d) => d.projectId === projectId) : docs] as const;
  }));
  return Object.fromEntries(entries) as Record<string, Doc[]>;
}

/** Items that need attention today, used for the daily digest email. */
export function digestItems(data: Record<string, Doc[]>, today = isoDate(new Date())) {
  const in3 = addDays(today, 3);
  const bills = (data.bill ?? []).filter((b) => b.status !== 'Paid' && b.dueDate && String(b.dueDate) <= in3);
  const receivables = (data.customerPayment ?? []).filter((p) => p.status !== 'Received' && p.dueDate && String(p.dueDate) <= in3);
  const tasks = (data.task ?? []).filter((t) => t.status !== 'Done' && t.dueDate && String(t.dueDate) <= today);
  const docs = (data.document ?? []).filter((d) => d.expiresOn && String(d.expiresOn) <= addDays(today, 30));
  return { bills, receivables, tasks, docs };
}
