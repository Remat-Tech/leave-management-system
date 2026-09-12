/** Sends a table as a file to save. FR 64, LMS 511. */

import type { Response } from 'express';
import { tableAsCsv } from '../export/csv.js';
import { CONTENT_TYPES, type ExportFormat, fileNameOf, type Table } from '../export/table.js';
import { tableAsXlsx } from '../export/xlsx.js';

export function sendTable(response: Response, table: Table, format: ExportFormat): void {
  response
    .status(200)
    .setHeader('Content-Type', CONTENT_TYPES[format])
    .setHeader('Content-Disposition', `attachment; filename="${fileNameOf(table, format)}"`)
    /* Somebody's leave, so no copy is kept on the way. NFR SEC 03. */
    .setHeader('Cache-Control', 'no-store')
    .send(format === 'csv' ? tableAsCsv(table) : tableAsXlsx(table));
}
