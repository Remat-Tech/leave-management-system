import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tableAsCsv } from '../../src/export/csv.js';
import {
  fileNameOf,
  InvalidExportFormat,
  readExportFormat,
  type Table,
} from '../../src/export/table.js';
import { columnName, tableAsXlsx } from '../../src/export/xlsx.js';

/** Exporting a table. FR 64, LMS 511. */

const TABLE: Table = {
  name: 'Leave liability 2026',
  headings: ['Employee', 'Days', 'Reason'],
  rows: [
    ['Ama Mensah', 4.5, 'Wedding, "abroad"'],
    ['=HYPERLINK("x")', -2, null],
  ],
};

describe('as CSV', () => {
  const text = tableAsCsv(TABLE).toString('utf8');

  it('starts with the byte order mark Excel needs and ends each row with CRLF', () => {
    expect(text.startsWith('\uFEFFEmployee,Days,Reason\r\n')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('quotes commas and quotes, and writes numbers bare', () => {
    expect(text).toContain('Ama Mensah,4.5,"Wedding, ""abroad"""\r\n');
  });

  it('never lets typed text run as a formula', () => {
    expect(text).toContain(`"'=HYPERLINK(""x"")",-2,\r\n`);
  });
});

describe('as XLSX', () => {
  const files = unzip(tableAsXlsx(TABLE));

  it('is a workbook with one sheet named after the table', () => {
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(files.get('xl/workbook.xml')).toContain('name="Leave liability 2026"');
  });

  it('writes text as inline strings, escaped, and numbers as values', () => {
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';

    expect(sheet).toContain(
      '<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Employee</t>',
    );
    expect(sheet).toContain('<c r="B2"><v>4.5</v></c>');
    expect(sheet).toContain('Wedding, &quot;abroad&quot;');
    expect(sheet).not.toContain('<f>');
  });

  it('is the same bytes for the same table', () => {
    expect(tableAsXlsx(TABLE).equals(tableAsXlsx(TABLE))).toBe(true);
  });

  it('names columns past Z', () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
  });
});

describe('what may be asked for', () => {
  it('is csv or xlsx', () => {
    expect(readExportFormat('xlsx')).toBe('xlsx');
    expect(() => readExportFormat('pdf')).toThrow(InvalidExportFormat);
    expect(() => readExportFormat(undefined)).toThrow(InvalidExportFormat);
  });

  it('names the file after the table', () => {
    expect(fileNameOf(TABLE, 'csv')).toBe('leave-liability-2026.csv');
  });
});

/** Every file in a zip, by name, read through its central directory. */
function unzip(archive: Buffer): Map<string, string> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const files = new Map<string, string>();

  for (let index = 0; index < count; index += 1) {
    const packedSize = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const start = offset + 30 + archive.readUInt16LE(offset + 26);

    files.set(name, inflateRawSync(archive.subarray(start, start + packedSize)).toString('utf8'));
    at += 46 + nameLength;
  }

  return files;
}
