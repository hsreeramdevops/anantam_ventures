import { EmailClient } from '@azure/communication-email';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../config';

export interface Mail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Captured mails in local dev so tests / developers can read OTPs. */
export const devOutbox: Mail[] = [];

let client: EmailClient | null = null;

export async function sendMail(mail: Mail): Promise<void> {
  if (!config.acsConnection || !config.emailSender) {
    devOutbox.push(mail);
    if (devOutbox.length > 50) devOutbox.shift();
    const line = `[dev-mail ${new Date().toISOString()}] to=${mail.to.join(',')} subject="${mail.subject}"\n${mail.text}\n\n`;
    console.warn(line);
    if (!process.env.VITEST) {
      await mkdir(config.dataDir, { recursive: true });
      await appendFile(path.join(config.dataDir, 'dev-mail.log'), line);
    }
    return;
  }
  client ??= new EmailClient(config.acsConnection);
  const poller = await client.beginSend({
    senderAddress: config.emailSender,
    recipients: { to: mail.to.map((address) => ({ address })) },
    content: { subject: mail.subject, plainText: mail.text, html: mail.html },
  });
  await poller.pollUntilDone();
}
