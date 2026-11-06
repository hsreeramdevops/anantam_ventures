export type Role = 'admin' | 'accountant' | 'engineer' | 'viewer';
export const ROLES: Role[] = ['admin', 'accountant', 'engineer', 'viewer'];

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'money' | 'date' | 'select' | 'ref' | 'email' | 'boolean' | 'file';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  ref?: string;
  /** Show as a column in list views. */
  list?: boolean;
  /** Upload folder for file fields. */
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
  write: Role[];
  read: Role[];
}

export const CATEGORIES = [
  'Cement', 'Steel', 'Sand & Aggregates', 'Bricks & Blocks', 'Electrical', 'Plumbing & Sanitary',
  'Tiles & Flooring', 'Paint', 'Wood & Doors', 'Glass & Aluminium', 'Hardware', 'Labour & Contractor',
  'Machinery & Equipment Rent', 'Transport', 'Approvals & Legal', 'Professional Fees', 'Utilities',
  'Marketing', 'Office & Admin', 'Miscellaneous',
] as const;

export const PHASES = [
  'Land & Approvals', 'Foundation', 'Structure', 'Masonry', 'MEP', 'Finishing', 'Handover', 'General',
] as const;

export const PAY_MODES = ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Card'] as const;
const ALL: Role[] = [...ROLES];
const FIN: Role[] = ['admin', 'accountant'];
const SITE: Role[] = ['admin', 'engineer'];
const OPS: Role[] = ['admin', 'accountant', 'engineer'];

export const ENTITIES: EntityDef[] = [
  {
    type: 'bill', label: 'Bill', plural: 'Bills & Expenses', group: 'Finance', titleField: 'billNumber',
    write: OPS, read: ALL,
    fields: [
      { name: 'vendorId', label: 'Vendor', type: 'ref', ref: 'vendor' },
      { name: 'vendorName', label: 'Vendor name', type: 'text', list: true },
      { name: 'billNumber', label: 'Bill #', type: 'text', list: true },
      { name: 'billDate', label: 'Bill date', type: 'date', list: true },
      { name: 'dueDate', label: 'Due date', type: 'date', list: true },
      { name: 'subtotal', label: 'Subtotal', type: 'money' },
      { name: 'tax', label: 'Tax (GST)', type: 'money' },
      { name: 'total', label: 'Total', type: 'money', required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true, list: true },
      { name: 'phase', label: 'Phase', type: 'select', options: PHASES },
      { name: 'status', label: 'Status', type: 'select', options: ['Unpaid', 'Partially Paid', 'Paid'], list: true },
      { name: 'paidAmount', label: 'Paid amount', type: 'money' },
      { name: 'paidDate', label: 'Paid date', type: 'date' },
      { name: 'paymentMode', label: 'Payment mode', type: 'select', options: PAY_MODES },
      { name: 'file', label: 'Bill file', type: 'file', folder: 'bills' },
      { name: 'needsReview', label: 'Needs review', type: 'boolean', list: true },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
      { name: 'source', label: 'Source', type: 'text', readonly: true },
      { name: 'submitterName', label: 'Submitted by', type: 'text', readonly: true },
      { name: 'submitterPhone', label: 'Submitter phone', type: 'text', readonly: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'vendor', label: 'Vendor', plural: 'Vendors & Contractors', group: 'Finance', titleField: 'name',
    write: OPS, read: ALL,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Supplier', 'Contractor', 'Consultant', 'Other'], list: true },
      { name: 'category', label: 'Default category', type: 'select', options: CATEGORIES, list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'gstin', label: 'GSTIN', type: 'text' },
      { name: 'bankDetails', label: 'Bank / UPI', type: 'textarea' },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'budget', label: 'Budget line', plural: 'Budgets', group: 'Finance', titleField: 'category',
    write: FIN, read: ALL,
    fields: [
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true, list: true },
      { name: 'phase', label: 'Phase', type: 'select', options: PHASES, list: true },
      { name: 'amount', label: 'Budget amount', type: 'money', required: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'flat', label: 'Flat', plural: 'Flats / Units', group: 'Sales', titleField: 'number',
    write: FIN, read: ALL,
    fields: [
      { name: 'number', label: 'Flat #', type: 'text', required: true, list: true },
      { name: 'block', label: 'Block / Tower', type: 'text', list: true },
      { name: 'floor', label: 'Floor', type: 'number', list: true },
      { name: 'unitType', label: 'Type', type: 'select', options: ['1BHK', '2BHK', '3BHK', '4BHK', 'Penthouse', 'Shop', 'Other'], list: true },
      { name: 'areaSqft', label: 'Area (sq ft)', type: 'number', list: true },
      { name: 'price', label: 'List price', type: 'money', list: true },
      { name: 'facing', label: 'Facing', type: 'select', options: ['North', 'South', 'East', 'West', 'NE', 'NW', 'SE', 'SW'] },
      { name: 'status', label: 'Status', type: 'select', options: ['Available', 'Blocked', 'Booked', 'Sold'], required: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'booking', label: 'Booking', plural: 'Bookings & Customers', group: 'Sales', titleField: 'customerName',
    write: FIN, read: ALL,
    fields: [
      { name: 'flatId', label: 'Flat', type: 'ref', ref: 'flat', required: true, list: true },
      { name: 'customerName', label: 'Customer', type: 'text', required: true, list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'bookingDate', label: 'Booking date', type: 'date', list: true },
      { name: 'agreedPrice', label: 'Agreed price', type: 'money', required: true, list: true },
      { name: 'loanBank', label: 'Home loan bank', type: 'text' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Cancelled', 'Registered'], list: true },
      { name: 'agreement', label: 'Agreement file', type: 'file', folder: 'documents' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'customerPayment', label: 'Customer payment', plural: 'Customer Payment Schedule', group: 'Sales', titleField: 'stage',
    write: FIN, read: ALL,
    fields: [
      { name: 'bookingId', label: 'Booking', type: 'ref', ref: 'booking', required: true, list: true },
      { name: 'stage', label: 'Stage / milestone', type: 'text', required: true, list: true },
      { name: 'percent', label: '% of price', type: 'number' },
      { name: 'amount', label: 'Amount due', type: 'money', required: true, list: true },
      { name: 'dueDate', label: 'Due date', type: 'date', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Pending', 'Demand Sent', 'Received'], list: true },
      { name: 'receivedAmount', label: 'Received amount', type: 'money' },
      { name: 'receivedDate', label: 'Received date', type: 'date', list: true },
      { name: 'receiptNo', label: 'Receipt #', type: 'text' },
      { name: 'paymentMode', label: 'Payment mode', type: 'select', options: PAY_MODES },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'task', label: 'Follow-up', plural: 'Follow-ups & Tasks', group: 'Operations', titleField: 'title',
    write: OPS, read: ALL,
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Follow-up', 'Task', 'Approval', 'Site Visit', 'Call'], list: true },
      { name: 'assigneeId', label: 'Assignee', type: 'ref', ref: 'user', list: true },
      { name: 'relatedTo', label: 'Related to (vendor/customer/etc.)', type: 'text', list: true },
      { name: 'dueDate', label: 'Due date', type: 'date', list: true },
      { name: 'priority', label: 'Priority', type: 'select', options: ['Low', 'Medium', 'High'], list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Open', 'In Progress', 'Done'], required: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'milestone', label: 'Milestone', plural: 'Site Progress', group: 'Site', titleField: 'name',
    write: SITE, read: ALL,
    fields: [
      { name: 'name', label: 'Milestone', type: 'text', required: true, list: true },
      { name: 'phase', label: 'Phase', type: 'select', options: PHASES, list: true },
      { name: 'plannedDate', label: 'Planned date', type: 'date', list: true },
      { name: 'actualDate', label: 'Actual date', type: 'date', list: true },
      { name: 'percentComplete', label: '% complete', type: 'number', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'sitePhoto', label: 'Site photo', plural: 'Site Photos', group: 'Site', titleField: 'caption',
    write: SITE, read: ALL,
    fields: [
      { name: 'photo', label: 'Photo', type: 'file', folder: 'photos', required: true, list: true },
      { name: 'caption', label: 'Caption', type: 'text', list: true },
      { name: 'milestoneId', label: 'Milestone', type: 'ref', ref: 'milestone', list: true },
      { name: 'takenOn', label: 'Date', type: 'date', list: true },
    ],
  },
  {
    type: 'material', label: 'Material', plural: 'Materials', group: 'Site', titleField: 'name',
    write: SITE, read: ALL,
    fields: [
      { name: 'name', label: 'Material', type: 'text', required: true, list: true },
      { name: 'unit', label: 'Unit', type: 'select', options: ['Bags', 'Kg', 'Tonne', 'Cft', 'Cum', 'Nos', 'Litre', 'Sq ft', 'Rft', 'Load'], required: true, list: true },
      { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, list: true },
      { name: 'reorderLevel', label: 'Reorder level', type: 'number', list: true },
    ],
  },
  {
    type: 'materialTxn', label: 'Stock entry', plural: 'Material Stock In / Out', group: 'Site', titleField: 'date',
    write: SITE, read: ALL,
    fields: [
      { name: 'materialId', label: 'Material', type: 'ref', ref: 'material', required: true, list: true },
      { name: 'direction', label: 'In / Out', type: 'select', options: ['In', 'Out'], required: true, list: true },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, list: true },
      { name: 'date', label: 'Date', type: 'date', required: true, list: true },
      { name: 'vendorId', label: 'Vendor (for In)', type: 'ref', ref: 'vendor', list: true },
      { name: 'rate', label: 'Rate / unit', type: 'money' },
      { name: 'usedFor', label: 'Used for / location', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'labourer', label: 'Labourer', plural: 'Labour', group: 'Site', titleField: 'name',
    write: SITE, read: ALL,
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'trade', label: 'Trade', type: 'select', options: ['Mason', 'Helper', 'Carpenter', 'Bar Bender', 'Electrician', 'Plumber', 'Painter', 'Tiler', 'Welder', 'Other'], list: true },
      { name: 'dailyWage', label: 'Daily wage', type: 'money', required: true, list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'contractorId', label: 'Contractor', type: 'ref', ref: 'vendor', list: true },
      { name: 'active', label: 'Active', type: 'boolean', list: true },
    ],
  },
  {
    type: 'attendance', label: 'Attendance', plural: 'Attendance', group: 'Site', titleField: 'date',
    write: SITE, read: ALL,
    fields: [
      { name: 'labourerId', label: 'Labourer', type: 'ref', ref: 'labourer', required: true, list: true },
      { name: 'date', label: 'Date', type: 'date', required: true, list: true },
      { name: 'presence', label: 'Presence', type: 'select', options: ['Full Day', 'Half Day', 'Absent'], required: true, list: true },
      { name: 'overtimeHours', label: 'Overtime hrs', type: 'number', list: true },
      { name: 'advancePaid', label: 'Advance paid', type: 'money', list: true },
    ],
  },
  {
    type: 'document', label: 'Document', plural: 'Document Vault', group: 'Operations', titleField: 'title',
    write: OPS, read: ALL,
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['Approval', 'Agreement', 'Title Deed', 'Plan / Drawing', 'NOC', 'Insurance', 'Tax', 'Other'], list: true },
      { name: 'file', label: 'File', type: 'file', folder: 'documents', required: true, list: true },
      { name: 'issuedOn', label: 'Issued on', type: 'date' },
      { name: 'expiresOn', label: 'Expires on', type: 'date', list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'user', label: 'User', plural: 'Users', group: 'Admin', titleField: 'name',
    write: ['admin'], read: ALL,
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, list: true },
      { name: 'name', label: 'Full name', type: 'text', required: true, list: true },
      { name: 'email', label: 'Email (OTP is sent here)', type: 'email', required: true, list: true },
      { name: 'role', label: 'Role', type: 'select', options: ROLES, required: true, list: true },
      { name: 'active', label: 'Active', type: 'boolean', list: true },
    ],
  },
  {
    type: 'audit', label: 'Audit entry', plural: 'Audit Log', group: 'Admin', titleField: 'summary',
    write: [], read: ['admin'],
    fields: [
      { name: 'at', label: 'When', type: 'text', list: true, readonly: true },
      { name: 'by', label: 'By', type: 'text', list: true, readonly: true },
      { name: 'action', label: 'Action', type: 'text', list: true, readonly: true },
      { name: 'entityType', label: 'Entity', type: 'text', list: true, readonly: true },
      { name: 'summary', label: 'Summary', type: 'text', list: true, readonly: true },
    ],
  },
];

export const entityDef = (type: string) => ENTITIES.find((e) => e.type === type);

/** Types that live outside projects. Everything else in ENTITIES carries a `projectId`. */
export const GLOBAL_TYPES: readonly string[] = ['user', 'audit'];
export const isProjectScoped = (type: string) => !!entityDef(type) && !GLOBAL_TYPES.includes(type);

export const PROJECT_STATUSES = ['Active', 'On hold', 'Completed'] as const;

/** Projects are managed through /api/projects (not the generic entity routes). */
export const PROJECT_DEF: EntityDef = {
  type: 'project', label: 'Project', plural: 'Projects', group: 'Admin', titleField: 'name',
  write: ['admin'], read: ALL,
  fields: [
    { name: 'name', label: 'Project name', type: 'text', required: true, list: true },
    { name: 'location', label: 'Location / address', type: 'textarea', list: true },
    { name: 'status', label: 'Status', type: 'select', options: PROJECT_STATUSES, required: true, list: true },
    { name: 'startDate', label: 'Start date', type: 'date', list: true },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ValidationError extends Error {}

/** Optional email typed into a public form; returns null when blank, throws when malformed. */
export function optionalEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.length > 254 || !/^[^\s@<>(),;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) throw new ValidationError('Email address looks invalid');
  return v;
}

/** Keeps only declared fields, coerces types and checks constraints. */
export function validate(def: EntityDef, input: Record<string, unknown>, partial = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.readonly) continue;
    const has = Object.prototype.hasOwnProperty.call(input, f.name);
    let v = input[f.name];
    if (v === '' || v === undefined) v = null;
    if (v === null) {
      if (f.required && (!partial || has)) throw new ValidationError(`${f.label} is required`);
      if (has || !partial) out[f.name] = null;
      continue;
    }
    switch (f.type) {
      case 'number':
      case 'money': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
        if (!Number.isFinite(n)) throw new ValidationError(`${f.label} must be a number`);
        if (f.type === 'money' && n < 0) throw new ValidationError(`${f.label} cannot be negative`);
        v = f.type === 'money' ? Math.round(n * 100) / 100 : n;
        break;
      }
      case 'boolean':
        v = v === true || v === 'true' || v === 'on' || v === 1;
        break;
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v)) throw new ValidationError(`${f.label} must be YYYY-MM-DD`);
        break;
      case 'email':
        v = String(v).trim().toLowerCase();
        if (!EMAIL_RE.test(v as string)) throw new ValidationError(`${f.label} is not a valid email`);
        break;
      case 'select':
        if (!f.options!.includes(String(v))) throw new ValidationError(`${f.label} must be one of: ${f.options!.join(', ')}`);
        v = String(v);
        break;
      default:
        v = String(v).slice(0, f.type === 'textarea' ? 5000 : 500).trim();
    }
    out[f.name] = v;
  }
  return out;
}
