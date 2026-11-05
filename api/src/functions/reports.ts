import { app } from '@azure/functions';
import { config } from '../config';
import { sendMail } from '../auth/email';
import { HttpError, json, route } from '../http';
import { dashboard, digestItems, labourWages, loadAll, materialStock } from '../reports';
import { getStore } from '../store';
import crypto from 'crypto';

app.http('dashboard', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/dashboard',
  handler: route(async () => json(dashboard(await loadAll(
    ['bill', 'budget', 'customerPayment', 'flat', 'task', 'milestone', 'material', 'materialTxn', 'labourer', 'attendance', 'document'])))),
});

app.http('stockReport', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/stock',
  handler: route(async () => {
    const d = await loadAll(['material', 'materialTxn']);
    return json({ items: materialStock(d.material, d.materialTxn) });
  }),
});

app.http('wagesReport', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/wages',
  handler: route(async (req) => {
    const month = req.query.get('month') ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    const d = await loadAll(['labourer', 'attendance']);
    return json({ month, items: labourWages(d.labourer, d.attendance, month) });
  }),
});

const money = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN')}`;

/** Daily digest, called by the scheduled GitHub Action (SWA managed functions have no timer triggers). */
app.http('dailyDigest', {
  methods: ['POST'], authLevel: 'anonymous', route: 'jobs/daily-digest',
  handler: route(async (req) => {
    const key = req.headers.get('x-job-key') ?? '';
    const expected = config.jobKey;
    if (!expected || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      throw new HttpError(401, 'Bad job key');
    }
    const data = await loadAll(['bill', 'customerPayment', 'task', 'document', 'user']);
    const { bills, receivables, tasks, docs } = digestItems(data);
    const users = data.user.filter((u) => u.active !== false && u.email);
    let sent = 0;
    for (const u of users) {
      const lines: string[] = [];
      if (u.role === 'admin' || u.role === 'accountant') {
        bills.forEach((b) => lines.push(`Bill due ${b.dueDate}: ${b.vendorName ?? ''}${b.billNumber ? ` #${b.billNumber}` : ''} ${money(Number(b.total) - Number(b.paidAmount ?? 0))}`));
        receivables.forEach((p) => lines.push(`Customer payment due ${p.dueDate}: ${p.stage} ${money(p.amount)}`));
        docs.forEach((d) => lines.push(`Document expiring ${d.expiresOn}: ${d.title}`));
      }
      tasks.filter((t) => t.assigneeId === u.id || (!t.assigneeId && u.role === 'admin'))
        .forEach((t) => lines.push(`Task due ${t.dueDate}: ${t.title}${t.relatedTo ? ` (${t.relatedTo})` : ''}`));
      if (!lines.length) continue;
      await sendMail({ to: [String(u.email)], subject: `${config.appName}: ${lines.length} item(s) need attention`, text: lines.join('\n') });
      sent++;
    }
    return json({ ok: true, sent, counts: { bills: bills.length, receivables: receivables.length, tasks: tasks.length, docs: docs.length } });
  }, { auth: false }),
});
