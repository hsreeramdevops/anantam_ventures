import { Container, CosmosClient } from '@azure/cosmos';
import { Doc, Store } from './types';

const SYSTEM = ['_rid', '_self', '_etag', '_attachments', '_ts', 'ttl'];
const clean = (d: Record<string, unknown>): Doc => {
  for (const k of SYSTEM) delete d[k];
  return d as Doc;
};

/** Single container partitioned by /type, so every list is a cheap single-partition query. */
export class CosmosStore implements Store {
  private container: Container;
  constructor(endpoint: string, key: string, database: string, container: string) {
    this.container = new CosmosClient({ endpoint, key }).database(database).container(container);
  }

  async list(type: string) {
    const { resources } = await this.container.items
      .query({ query: 'SELECT * FROM c WHERE c.type = @t', parameters: [{ name: '@t', value: type }] },
        { partitionKey: type, maxItemCount: 1000 })
      .fetchAll();
    return resources.map(clean);
  }
  async get(type: string, id: string) {
    try {
      const { resource } = await this.container.item(id, type).read();
      return resource ? clean(resource) : null;
    } catch (e: any) {
      if (e.code === 404) return null;
      throw e;
    }
  }
  async put(doc: Doc, ttlSeconds?: number) {
    const body = ttlSeconds ? { ...doc, ttl: ttlSeconds } : doc;
    const { resource } = await this.container.items.upsert(body);
    return clean(resource as any);
  }
  async delete(type: string, id: string) {
    try {
      await this.container.item(id, type).delete();
    } catch (e: any) {
      if (e.code !== 404) throw e;
    }
  }
}
