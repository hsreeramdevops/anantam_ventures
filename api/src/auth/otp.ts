import crypto from 'crypto';
import { config } from '../config';
import { Doc, getStore } from '../store';
import { sendMail } from './email';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;

export class RateLimitError extends Error {}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s: string) => crypto.createHmac('sha256', config.jwtSecret).update(s).digest('hex');

export async function findUser(identifier: string): Promise<Doc | null> {
  const id = identifier.trim().toLowerCase();
  if (!id) return null;
  const users = await getStore().list('user');
  return users.find((u) => u.active !== false && (u.username === id || u.email === id)) ?? null;
}

/** First login: if there are no users yet, the bootstrap admin email gets an admin account. */
async function bootstrapAdmin(identifier: string): Promise<Doc | null> {
  const email = identifier.trim().toLowerCase();
  if (!config.bootstrapAdminEmail || email !== config.bootstrapAdminEmail) return null;
  const store = getStore();
  if ((await store.list('user')).length > 0) return null;
  const now = new Date().toISOString();
  return store.put({
    id: crypto.randomUUID(), type: 'user', username: email.split('@')[0].replace(/[^a-z0-9._-]/g, ''),
    name: 'Administrator', email, role: 'admin', active: true, createdAt: now, createdBy: 'bootstrap',
  });
}

/** Sends an OTP if the account exists. Silent otherwise, so usernames can't be enumerated. */
export async function requestOtp(identifier: string): Promise<void> {
  const user = (await findUser(identifier)) ?? (await bootstrapAdmin(identifier));
  if (!user) return;
  const store = getStore();
  const otpId = sha(`otp:${user.id}`);
  const prev = await store.get('otp', otpId);
  const now = Date.now();
  let windowStart = now;
  let sends = 0;
  if (prev && now - Number(prev.windowStart) < OTP_SEND_WINDOW_MS) {
    windowStart = Number(prev.windowStart);
    sends = Number(prev.sends);
  }
  if (sends >= OTP_MAX_SENDS) throw new RateLimitError('Too many OTP requests. Try again in 15 minutes.');

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await store.put({
    id: otpId, type: 'otp', userId: user.id, codeHash: hmac(`${user.id}:${code}`),
    expiresAt: now + OTP_TTL_MS, attempts: 0, sends: sends + 1, windowStart,
  }, Math.ceil(OTP_SEND_WINDOW_MS / 1000));

  await sendMail({
    to: [String(user.email)],
    subject: `${config.appName} login code: ${code}`,
    text: `Your ${config.appName} login code is ${code}.\nIt expires in 10 minutes. If you did not request it, ignore this email.`,
    html: `<p>Your ${config.appName} login code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you did not request it, ignore this email.</p>`,
  });
}

/** Returns the user on success, null on any failure. */
export async function verifyOtp(identifier: string, code: string): Promise<Doc | null> {
  const user = await findUser(identifier);
  if (!user || !/^\d{6}$/.test(code.trim())) return null;
  const store = getStore();
  const otpId = sha(`otp:${user.id}`);
  const otp = await store.get('otp', otpId);
  if (!otp || !otp.codeHash) return null;
  if (Date.now() > Number(otp.expiresAt) || Number(otp.attempts) >= OTP_MAX_ATTEMPTS) return null;

  const expected = Buffer.from(String(otp.codeHash), 'hex');
  const actual = Buffer.from(hmac(`${user.id}:${code.trim()}`), 'hex');
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
    // Keep the doc (for send rate-limit window) but burn the code.
    await store.put({ ...otp, codeHash: null }, Math.ceil(OTP_SEND_WINDOW_MS / 1000));
    return user;
  }
  await store.put({ ...otp, attempts: Number(otp.attempts) + 1 }, Math.ceil(OTP_SEND_WINDOW_MS / 1000));
  return null;
}
