export interface Doc {
  id: string;
  type: string;
  [k: string]: unknown;
}

export interface Store {
  list(type: string): Promise<Doc[]>;
  get(type: string, id: string): Promise<Doc | null>;
  /** Insert or replace. `ttlSeconds` lets Cosmos expire short-lived docs (OTPs, audit). */
  put(doc: Doc, ttlSeconds?: number): Promise<Doc>;
  delete(type: string, id: string): Promise<void>;
}
