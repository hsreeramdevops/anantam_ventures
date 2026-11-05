import path from 'path';
import { config, isProd } from '../config';
import { CosmosStore } from './cosmosStore';
import { FileStore } from './fileStore';
import { Store } from './types';

export * from './types';

let store: Store | null = null;
export function getStore(): Store {
  if (!store) {
    store = isProd()
      ? new CosmosStore(config.cosmosEndpoint, config.cosmosKey, config.cosmosDatabase, config.cosmosContainer)
      : new FileStore(path.resolve(config.dataDir, 'db.json'));
  }
  return store;
}
export function setStore(s: Store) {
  store = s;
}
