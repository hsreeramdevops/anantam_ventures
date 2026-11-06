import { app } from '@azure/functions';
import { config } from '../config';
import { sendMail } from '../auth/email';
import { HttpError, json, route } from '../http';
import { dashboard, digestItems, labourWages, loadAll, materialStock } from '../reports';
import { canAccessProject, ensureMigrated, requireProject } from '../projects';
import { SessionUser } from '../auth/session';
import { getStore } from '../store';
import { sendMessage, subscribedEvents, telegramConfigured } from '../notify/telegram';
import crypto from 'crypto';

app.http('dashboard', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/dashboard',
  handler: route(async (req, _ctx, user) => json(dashboard(await loadAll(
    ['bill', 'budget', 'customerPayment', 'flat', 'task', 'milestone', 'material', 'materialTxn', 'labourer', 'attendance', 'document'],
    (await requireProject(req, user!)).id)))),
});

app.http('stockReport', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/stock',
  handler: route(async (req, _ctx, user) => {
    const d = await loadAll(['material', 'materialTxn'], (await requireProject(req, user!)).id);
    return json({ items: materialStock(d.material, d.materialTxn) });
  }),
});

app.http('wagesReport', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/wages',
  handler: route(async (req, _ctx, user) => {
    const projectId = (await requireProject(req, user!)).id;
    const month = req.query.get('month') ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    const d = await loadAll(['labourer', 'attendance'], projectId);
    return json({ month, items: labourWages(d.labourer, d.attendance, month) });
  }),
});

const money = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN')}`;

/** Daily digest, called by the scheduled GitHub Action (SWA managed functions have no timer triggers). */
app.http('dailyDigest', {
  methods: ['POST'], authLevel: 'anonymous', route: 'jobs/daily-digest',
  handler: route(async (req, ctx) => {
    const key = req.headers.get('x-job-key') ?? '';
    const expected = config.jobKey;
    if (!expected || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
      throw new HttpError(401, 'Bad job key');
    }
    await ensureMigrated();
    const data = await loadAll(['bill', 'customerPayment', 'task', 'document', 'user', 'project']);
    const { bills, receivables, tasks, docs } = digestItems(data);
    const projectName = new Map(data.project.map((p) => [p.id, String(p.name ?? 'Project')]));
    const users = data.user.filter((u) => u.active !== false && u.email);
    let sent = 0;
    let tgSent = 0;
    const tgLinks = new Map(telegramConfigured() ? (await getStore().list('tglink')).map((l) => [l.id, l]) : []);
    for (const u of users) {
      const su = { id: u.id, role: u.role } as SessionUser;
      // Lines grouped by project; each user only sees projects they can access.
      const byProject = new Map<string, string[]>();
      const add = (pid: unknown, line: string) => {
        const p = data.project.find((x) => x.id === pid);
        if (!p || !canAccessProject(su, p)) return;
        byProject.set(p.id, [...(byProject.get(p.id) ?? []), line]);
      };
      if (u.role === 'admin' || u.role === 'accountant') {
        bills.forEach((b) => add(b.projectId, `Bill due ${b.dueDate}: ${b.vendorName ?? ''}${b.billNumber ? ` #${b.billNumber}` : ''} ${money(Number(b.total) - Number(b.paidAmount ?? 0))}`));
        receivables.forEach((p) => add(p.projectId, `Customer payment due ${p.dueDate}: ${p.stage} ${money(p.amount)}`));
        docs.forEach((d) => add(d.projectId, `Document expiring ${d.expiresOn}: ${d.title}`));
      }
      tasks.filter((t) => t.assigneeId === u.id || (!t.assigneeId && u.role === 'admin'))
        .forEach((t) => add(t.projectId, `Task due ${t.dueDate}: ${t.title}${t.relatedTo ? ` (${t.relatedTo})` : ''}`));
      const count = [...byProject.values()].reduce((s, l) => s + l.length, 0);
      if (!count) continue;
      const text = [...byProject.entries()]
        .map(([pid, lines]) => `== ${projectName.get(pid)} ==\n${lines.join('\n')}`).join('\n\n');
      await sendMail({ to: [String(u.email)], subject: `${config.appName}: ${count} item(s) need attention`, text });
      sent++;
      // Telegram copy, only for the projects this user subscribed the digest for.
      const link = tgLinks.get(u.id);
      if (link?.chatId) {
        const tgText = [...byProject.entries()].filter(([pid]) => subscribedEvents(link, String(u.role), pid).includes('digest'))
          .map(([pid, lines]) => `== ${projectName.get(pid)} ==\n${lines.join('\n')}`).join('\n\n');
        if (tgText) {
          await sendMessage(String(link.chatId), `📋 ${config.appName} daily digest\n\n${tgText}`)
            .then(() => { tgSent++; }).catch((e) => ctx.warn(`telegram digest failed: ${e.message}`));
        }
      }
    }
    return json({ ok: true, sent, telegram: tgSent, counts: { bills: bills.length, receivables: receivables.length, tasks: tasks.length, docs: docs.length } });
  }, { auth: false }),
});
