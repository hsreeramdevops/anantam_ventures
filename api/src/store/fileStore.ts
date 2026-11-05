import { promises as fs } from 'fs';
import path from 'path';
import { Doc, Store } from './types';

/** Local-dev store: one JSON file. Not for production. */
export class FileStore implements Store {
  private cache: Record<string, Record<string, Doc>> | null = null;
  private writing = Promise.resolve();
  constructor(private file: string) {}

  private async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  private async save() {
    const data = JSON.stringify(this.cache, null, 1);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, data);
    });
    await this.writing;
  }

  async list(type: string) {
    const db = await this.load();
    return Object.values(db[type] ?? {}).map((d) => ({ ...d }));
  }
  async get(type: string, id: string) {
    const db = await this.load();
    const d = db[type]?.[id];
    return d ? { ...d } : null;
  }
  async put(doc: Doc) {
    const db = await this.load();
    (db[doc.type] ??= {})[doc.id] = { ...doc };
    await this.save();
    return doc;
  }
  async delete(type: string, id: string) {
    const db = await this.load();
    if (db[type]) delete db[type][id];
    await this.save();
  }
}
