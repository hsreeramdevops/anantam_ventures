export type Role = 'admin' | 'accountant' | 'engineer' | 'viewer';
export type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'ref' | 'email' | 'boolean' | 'file';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  ref?: string;
  list?: boolean;
  folder?: 'bills' | 'photos' | 'documents';
  readonly?: boolean;
}

export interface EntityDef {
  type: string;
  label: string;
  plural: string;
  group: string;
  titleField: string;
  fields: FieldDef[];
  canWrite: boolean;
}

export interface Doc {
  id: string;
  type: string;
  [k: string]: unknown;
}

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  location?: string | null;
  status?: string;
  startDate?: string | null;
  notes?: string | null;
  members?: string[];
  shareToken?: string;
  shareEnabled?: boolean;
  payToken?: string;
  payEnabled?: boolean;
}
