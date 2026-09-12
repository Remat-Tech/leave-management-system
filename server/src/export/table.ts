/** Figures as one table, ready to be written to a file. FR 58, FR 64, LMS 511. */

export type Cell = string | number | null;

export interface Table {
  /** The file's name without its extension, and the sheet's. */
  name: string;
  headings: string[];
  rows: Cell[][];
}

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export class InvalidExportFormat extends Error {
  readonly field = 'format';

  constructor() {
    super('A report is exported as csv or xlsx.');
    this.name = 'InvalidExportFormat';
  }
}

export function readExportFormat(value: unknown): ExportFormat {
  const format = EXPORT_FORMATS.find((one) => one === value);

  if (format === undefined) {
    throw new InvalidExportFormat();
  }

  return format;
}

/** `leave-liability-2026.xlsx` from `Leave liability 2026`. */
export function fileNameOf(table: Table, format: ExportFormat): string {
  const base = table.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${base === '' ? 'export' : base}.${format}`;
}
