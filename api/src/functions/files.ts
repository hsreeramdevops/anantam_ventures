import { app, HttpRequest } from '@azure/functions';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '../config';
import { blobProjectId, Folder, FOLDERS, isValidBlobName, newBlobName, readFile, saveFile, sniffType } from '../files/blob';
import { HttpError, json, route } from '../http';
import { DEFAULT_PROJECT_ID, getAccessibleProject, requireProject } from '../projects';

export interface Upload { data: Buffer; type: string; name: string; form: FormData }

/** Reads the multipart body; size-limited and magic-byte checked (PDF/JPEG/PNG/WEBP only). */
export async function readUpload(req: HttpRequest, form?: FormData | null): Promise<Upload> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, 'File too large (max 10 MB)');
  form ??= await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!form || !file || typeof file === 'string') throw new HttpError(400, 'Attach a file in the "file" field');
  const data = Buffer.from(await (file as Blob).arrayBuffer());
  if (data.length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large (max 10 MB)');
  const type = sniffType(data);
  if (!type || !ALLOWED_UPLOAD_TYPES.includes(type)) throw new HttpError(415, 'Only PDF, JPEG, PNG or WEBP files are allowed');
  return { data, type, name: (file as File).name || 'upload', form };
}

app.http('fileUpload', {
  methods: ['POST'], authLevel: 'anonymous', route: 'files',
  handler: route(async (req, _ctx, user) => {
    if (user!.role === 'viewer') throw new HttpError(403, 'Not allowed');
    const folder = (req.query.get('folder') ?? '') as Folder;
    if (!FOLDERS.includes(folder)) throw new HttpError(400, 'Invalid folder');
    const project = await requireProject(req, user!);
    const { data, type, name } = await readUpload(req);
    const blobName = newBlobName(folder, name, project.id);
    await saveFile(blobName, data, type);
    return json({ name: blobName }, 201);
  }),
});

app.http('fileDownload', {
  methods: ['GET'], authLevel: 'anonymous', route: 'files/{*path}',
  handler: route(async (req, _ctx, user) => {
    const path = req.params.path ?? '';
    if (!isValidBlobName(path)) throw new HttpError(404, 'Not found');
    // Access follows the project embedded in the file name (legacy files belong to the default project).
    await getAccessibleProject(user!, blobProjectId(path) ?? DEFAULT_PROJECT_ID);
    const f = await readFile(path);
    if (!f) throw new HttpError(404, 'Not found');
    return {
      status: 200, body: f.data,
      headers: {
        'Content-Type': f.contentType, 'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
      },
    };
  }),
});
