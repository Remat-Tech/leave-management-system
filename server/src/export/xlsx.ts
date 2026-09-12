/** A table as a one-sheet workbook, written without a library. ECMA-376, FR 64, LMS 511. */

import { crc32, deflateRawSync } from 'node:zlib';
import type { Cell, Table } from './table.js';

export function tableAsXlsx(table: Table): Buffer {
  return zip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELATIONSHIPS],
    ['xl/workbook.xml', workbook(sheetNameOf(table.name))],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELATIONSHIPS],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', worksheet(table)],
  ]);
}

/* ------------------------------------------------------------------- the parts */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CONTENT_TYPES =
  `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELATIONSHIPS =
  `${XML}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELATIONSHIPS =
  `${XML}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
  '</Relationships>';

/** Style 1 is the bold heading row. */
const STYLES =
  `${XML}<styleSheet xmlns="${MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

function workbook(sheetName: string): string {
  return (
    `${XML}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

function worksheet(table: Table): string {
  const rows = [table.headings, ...table.rows].map((cells, index) => {
    const row = index + 1;
    const style = index === 0 ? ' s="1"' : '';

    return (
      `<row r="${String(row)}">` +
      cells
        .map((cell, column) => cellXml(cell, `${columnName(column)}${String(row)}`, style))
        .join('') +
      '</row>'
    );
  });

  return (
    `${XML}<worksheet xmlns="${MAIN}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>' +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

/** Text as an inline string, so nothing typed is ever read as a formula. */
function cellXml(cell: Cell, reference: string, style: string): string {
  if (cell === null) {
    return '';
  }

  if (typeof cell === 'number') {
    return `<c r="${reference}"${style}><v>${String(cell)}</v></c>`;
  }

  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
}

/** `A`, `Z`, `AA` from 0, 25, 26. */
export function columnName(index: number): string {
  let name = '';

  for (let left = index + 1; left > 0; left = Math.floor((left - 1) / 26)) {
    name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
  }

  return name;
}

/** At most 31 characters, none of `[]:*?/\`. */
function sheetNameOf(name: string): string {
  return (
    name
      .replace(/[[\]:*?/\\]/g, ' ')
      .slice(0, 31)
      .trim() || 'Sheet1'
  );
}

/** Escapes markup and drops the control characters XML cannot hold. */
function escapeXml(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- XML 1.0 cannot hold these
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

/* --------------------------------------------------------------------- the zip */

/** 1980-01-01, so the same table is the same bytes. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const DEFLATED = 8;

function zip(entries: [name: string, content: string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const packed = deflateRawSync(raw);
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}
