import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';

export const FOLDERS = ['bills', 'photos', 'documents'] as const;
export type Folder = (typeof FOLDERS)[number];

const NAME_RE = /^(bills|photos|documents)\/\d{4}\/\d{2}\/[0-9a-f-]{36}-[A-Za-z0-9._-]{1,100}$/;
export const isValidBlobName = (n: string) => NAME_RE.test(n);

let container: ContainerClient | null = null;
const blob = () => {
  if (!config.storageConnection) return null;
  container ??= BlobServiceClient.fromConnectionString(config.storageConnection).getContainerClient(config.storageContainer);
  return container;
};
const localPath = (name: string) => path.resolve(config.dataDir, 'files', name);

export function newBlobName(folder: Folder, originalName: string): string {
  const d = new Date();
  const safe = originalName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-100) || 'file';
  return `${folder}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}-${safe}`;
}

export async function saveFile(name: string, data: Buffer, contentType: string): Promise<void> {
  const c = blob();
  if (c) {
    await c.getBlockBlobClient(name).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
    return;
  }
  await fs.mkdir(path.dirname(localPath(name)), { recursive: true });
  await fs.writeFile(localPath(name), data);
  await fs.writeFile(`${localPath(name)}.type`, contentType);
}

export async function readFile(name: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!isValidBlobName(name)) return null;
  const c = blob();
  try {
    if (c) {
      const b = c.getBlockBlobClient(name);
      const props = await b.getProperties();
      return { data: await b.downloadToBuffer(), contentType: props.contentType ?? 'application/octet-stream' };
    }
    return {
      data: await fs.readFile(localPath(name)),
      contentType: await fs.readFile(`${localPath(name)}.type`, 'utf8').catch(() => 'application/octet-stream'),
    };
  } catch {
    return null;
  }
}

/** Light magic-byte check so a renamed executable can't masquerade as a PDF/image. */
export function sniffType(data: Buffer): string | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
