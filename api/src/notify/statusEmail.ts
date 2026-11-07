import crypto from 'crypto';
import { sendMail } from '../auth/email';
import { RateLimitError } from '../auth/otp';
import { config } from '../config';
import { hitRateLimit } from '../ratelimit';
import { Doc, getStore } from '../store';
import { billLink, payToSummary } from './telegram';
import { canAccessProject } from '../projects';
import { SessionUser } from '../auth/session';

/**
 * Emails the person who raised a bill when its status changes (Unpaid ⇄ Partially Paid ⇄ Paid).
 * Requestor = `submitterEmail` for guest / payment-request bills, else the team member who created it.
 */
export const MAX_EMAILS_PER_BILL = 20;
export const MAX_EMAILS_PER_ADDRESS_PER_HOUR = 10;
const SEND_TIMEOUT_MS = 8000;
const GUEST_SOURCES = ['guest', 'payment-request'];

// ---------- signed one-click unsubscribe tokens ----------
type UnsubTarget = { kind: 'bill' | 'user'; id: string };
const sign = (payload: string) => crypto.createHmac('sha256', `unsub|${config.jwtSecret}`).update(payload).digest('base64url');

export function unsubscribeToken(t: UnsubTarget): string {
  const payload = Buffer.from(`${t.kind}:${t.id}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubTarget | null {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const m = /^(bill|user):(.{1,100})$/.exec(Buffer.from(payload, 'base64url').toString());
  return m ? { kind: m[1] as UnsubTarget['kind'], id: m[2] } : null;
}

export async function applyUnsubscribe(t: UnsubTarget): Promise<boolean> {
  const store = getStore();
  const doc = await store.get(t.kind, t.id);
  if (!doc) return false;
  if (t.kind === 'bill') await store.put({ ...doc, statusEmailOptOut: true });
  else await store.put({ ...doc, billStatusEmails: false });
  return true;
}

// ---------- message ----------
const inr = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function statusEmail(bill: Doc, prevStatus: string, projectName: string, opts: { link: string | null; unsubscribeUrl: string }) {
  const payee = String(bill.payee ?? bill.vendorName ?? 'payee').slice(0, 100);
  const total = Number(bill.total ?? 0);
  const paid = Number(bill.paidAmount ?? 0);
  const balance = Math.max(0, Math.round((total - paid) * 100) / 100);
  const status = String(bill.status ?? 'Unpaid');
  const payments = Array.isArray(bill.payments) ? bill.payments as Record<string, unknown>[] : [];
  const reference = payments.length ? payments[payments.length - 1].note : null;
  const rows: [string, string][] = [
    ['Project', projectName],
    ['Pay to / vendor', payee],
    ['Status', `${prevStatus || 'Unpaid'} → ${status}`],
    ['Amount', inr(total)],
    ['Paid so far', inr(paid)],
    ['Balance', inr(balance)],
  ];
  if (bill.paidDate && paid > 0) rows.push(['Paid date', String(bill.paidDate)]);
  if (bill.paymentMode && paid > 0) rows.push(['Payment mode', String(bill.paymentMode)]);
  if (reference) rows.push(['Reference / UTR', String(reference).slice(0, 300)]);
  const payTo = payToSummary(bill.payTo);
  if (payTo) rows.push(['Payee details', payTo]);
  if (bill.billNumber) rows.push(['Bill #', String(bill.billNumber)]);
  if (bill.remarks) rows.push(['Your remarks', String(bill.remarks).slice(0, 500)]);

  const subject = `Payment update: ${inr(total)} to ${payee} is now ${status}`;
  const text = [
    `${config.appName}: ${subject}`, '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(opts.link ? ['', `View the bill: ${opts.link}`] : []),
    '', `Don't want these emails? Unsubscribe: ${opts.unsubscribeUrl}`,
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2733">
<p><b>${esc(config.appName)}</b>: ${esc(subject)}</p>
<table cellpadding="4" style="border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="color:#6b7785;vertical-align:top">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${opts.link ? `<p><a href="${esc(opts.link)}">View the bill</a></p>` : ''}
<p style="color:#6b7785;font-size:12px">Don't want these emails? <a href="${esc(opts.unsubscribeUrl)}">Unsubscribe</a>.</p></div>`;
  return { subject, text, html };
}

// ---------- trigger ----------
interface Recipient { email: string; unsub: UnsubTarget; link: string | null; userId: string | null }

async function recipientFor(bill: Doc): Promise<Recipient | null> {
  if (bill.statusEmailOptOut) return null;
  // Guests (public links) can't sign in, so no app link. Team-raised payment requests fall through to the creator.
  if (GUEST_SOURCES.includes(String(bill.source)) && (bill.submitterEmail || String(bill.createdBy ?? '').startsWith('guest:'))) {
    return bill.submitterEmail ? { email: String(bill.submitterEmail), unsub: { kind: 'bill', id: bill.id }, link: null, userId: null } : null;
  }
  const creator = (await getStore().list('user')).find((u) => u.username === bill.createdBy);
  if (!creator || creator.active === false || !creator.email || creator.billStatusEmails === false) return null;
  // Someone removed from the project no longer gets its bill details.
  const project = await getStore().get('project', String(bill.projectId ?? ''));
  if (!project || !canAccessProject({ id: creator.id, role: creator.role } as SessionUser, project)) return null;
  return { email: String(creator.email), unsub: { kind: 'user', id: creator.id }, link: billLink(bill), userId: creator.id };
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([
  p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms).unref?.()),
]);

/** Never throws; returns true when an email was sent. */
export async function notifyBillStatusEmail(actor: { id: string; username?: string; email?: string }, prev: Doc, bill: Doc): Promise<boolean> {
  try {
    if ((prev.status ?? 'Unpaid') === (bill.status ?? 'Unpaid')) return false;
    const to = await recipientFor(bill);
    if (!to) return false;
    // Never email the person who made the change.
    if (to.userId === actor.id || (actor.email && actor.email.toLowerCase() === to.email.toLowerCase())) return false;

    const store = getStore();
    const counter = await store.get('billmail', bill.id);
    const sent = Number(counter?.count ?? 0);
    if (sent >= MAX_EMAILS_PER_BILL) return false;
    try {
      await hitRateLimit(`billmail:${to.email.toLowerCase()}`, MAX_EMAILS_PER_ADDRESS_PER_HOUR, 3600_000);
    } catch (e) {
      if (e instanceof RateLimitError) { console.warn('bill status email skipped: per-address limit reached'); return false; }
      throw e;
    }
    await store.put({ id: bill.id, type: 'billmail', count: sent + 1, at: new Date().toISOString() });

    const projectName = String((await store.get('project', String(bill.projectId ?? '')))?.name ?? 'Project');
    const unsubscribeUrl = `${config.publicUrl}/api/public/unsubscribe?t=${encodeURIComponent(unsubscribeToken(to.unsub))}`;
    const mail = statusEmail(bill, String(prev.status ?? 'Unpaid'), projectName, { link: to.link, unsubscribeUrl });
    await withTimeout(sendMail({ to: [to.email], ...mail }), SEND_TIMEOUT_MS);
    return true;
  } catch (e: any) {
    console.warn(`bill status email failed: ${e.message}`);
    return false;
  }
}
