/** A table as CSV, the way Excel opens it. RFC 4180. FR 64, LMS 511. */

import type { Cell, Table } from './table.js';

/** Excel reads the file as UTF-8 only with this on the front. */
const BYTE_ORDER_MARK = '\uFEFF';

/** What a spreadsheet would run as a formula. OWASP CSV injection. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function tableAsCsv(table: Table): Buffer {
  const lines = [table.headings, ...table.rows].map((row) => row.map(cellAsCsv).join(','));

  return Buffer.from(`${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`, 'utf8');
}

function cellAsCsv(cell: Cell): string {
  if (cell === null) {
    return '';
  }

  if (typeof cell === 'number') {
    return String(cell);
  }

  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
