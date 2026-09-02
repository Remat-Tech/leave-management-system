/**
 * A spreadsheet, as far as this system is concerned: a row of headings and rows of text under them. FR 08.
 */

/** The delimiters that are sniffed for, in the order they win a tie. */
const DELIMITERS = [',', ';', '\t', '|'] as const;

/** One row of the file, with the line it came from. */
export interface SheetRow {
  /** The line the row starts on, counting from 1 and counting the heading row. */
  line: number;
  /** The cells, by the heading above them, trimmed. */
  cells: Record<string, string>;
  /** What is structurally wrong with this row, if anything. */
  problem: string | null;
}

export interface Sheet {
  /** The headings as written, trimmed, in the order the file has them. */
  headings: string[];
  rows: SheetRow[];
  /** What separated the cells, sniffed unless the caller said. */
  delimiter: string;
}

/** A file that is not a spreadsheet, or is one nothing could be made of. */
export class UnreadableSpreadsheet extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableSpreadsheet';
  }
}

/** Reads a delimited file into headings and rows. */
export function readSheet(text: string, options: { delimiter?: string } = {}): Sheet {
  const body = stripByteOrderMark(text);

  if (body.trim() === '') {
    throw new UnreadableSpreadsheet(
      'The file is empty. A staff import needs a row of column headings and at ' +
        'least one row under it.',
    );
  }

  const delimiter = options.delimiter ?? sniffDelimiter(body);
  const records = parseDelimited(body, delimiter).filter(
    (record) => !record.values.every((value) => value.trim() === ''),
  );

  const [headingRecord, ...dataRecords] = records;
  if (headingRecord === undefined) {
    throw new UnreadableSpreadsheet('The file has no rows in it.');
  }

  const headings = trimTrailingBlankColumns(
    headingRecord.values.map((value) => value.trim()),
    dataRecords,
  );

  assertHeadingsAreUsable(headings);

  return {
    headings,
    delimiter,
    rows: dataRecords.map((record) => toRow(record, headings)),
  };
}

/** The value under a heading, or the empty string when the file has no such column. */
export function cellOf(row: SheetRow, heading: string | undefined): string {
  return heading === undefined ? '' : (row.cells[heading] ?? '');
}

/** Headings compared the way a person compares them. */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Excel writes a byte order mark on the front of every UTF-8 CSV it saves. */
function stripByteOrderMark(text: string): string {
  // Written as an escape rather than as the character itself, which is
  // invisible in the source too and which the linter rightly refuses.
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * Which character separated the cells, decided by which one produces the most columns in the heading row.
 */
function sniffDelimiter(text: string): string {
  let best = ',';
  let widest = 1;

  for (const candidate of DELIMITERS) {
    const [first] = parseDelimited(text, candidate);
    const width = first?.values.length ?? 0;

    if (width > widest) {
      best = candidate;
      widest = width;
    }
  }

  return best;
}

/** A record as the parser produces it, before headings are put to it. */
interface RawRecord {
  line: number;
  values: string[];
}

/** The delimited format, as RFC 4180 describes it and as spreadsheets actually write it. */
function parseDelimited(text: string, delimiter: string): RawRecord[] {
  const records: RawRecord[] = [];

  let values: string[] = [];
  let value = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endValue = () => {
    values.push(value);
    value = '';
  };

  const endRecord = () => {
    endValue();
    records.push({ line: recordLine, values });
    values = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted cell is one literal quote. Anything
        // else closes the cell.
        if (text[index + 1] === '"') {
          value += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') {
          line++;
        }
        value += char;
      }
      continue;
    }

    // A quote only opens a cell at the start of one. Elsewhere it is a quote
    // somebody typed, which is what an apostrophe-happy job title contains.
    if (char === '"' && value === '') {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      endValue();
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') {
        index++;
      }
      endRecord();
      line++;
      recordLine = line;
      continue;
    }

    value += char;
  }

  // The last row, when the file does not end with a newline. Most do; the ones
  // that do not would otherwise lose their final employee.
  if (value !== '' || values.length > 0) {
    endRecord();
  }

  return records;
}

/** Drops the empty columns off the right hand end. */
function trimTrailingBlankColumns(headings: string[], records: RawRecord[]): string[] {
  let width = headings.length;

  while (
    width > 0 &&
    headings[width - 1] === '' &&
    records.every((record) => (record.values[width - 1] ?? '').trim() === '')
  ) {
    width--;
  }

  return headings.slice(0, width);
}

function assertHeadingsAreUsable(headings: string[]): void {
  if (headings.length === 0) {
    throw new UnreadableSpreadsheet('The first row of the file has no column headings in it.');
  }

  const blank = headings.indexOf('');
  if (blank !== -1) {
    throw new UnreadableSpreadsheet(
      `Column ${blank + 1} has data in it but no heading. Give it one, or delete the ` +
        'column, so that every value in the file is under a column that can be mapped.',
    );
  }

  /* Two headings that differ only in case or punctuation are the same column as
     far as the mapping is concerned, so this is compared the way the mapping
     compares. A file with Email and E-mail in it cannot be read: there is no
     answer to which one holds the work address, and choosing one silently is how
     half the company gets the wrong address. */
  const seen = new Map<string, string>();
  for (const heading of headings) {
    const key = normaliseHeading(heading);
    const first = seen.get(key);

    if (first !== undefined) {
      throw new UnreadableSpreadsheet(
        `The file has two columns that name the same thing: "${first}" and ` +
          `"${heading}". Remove or rename one, so there is one answer to which ` +
          'column a value comes from.',
      );
    }

    seen.set(key, heading);
  }
}

function toRow(record: RawRecord, headings: string[]): SheetRow {
  const cells: Record<string, string> = {};

  headings.forEach((heading, index) => {
    cells[heading] = (record.values[index] ?? '').trim();
  });

  /* More values than there are columns, which is almost always an unescaped
     delimiter inside a cell — "Owusu-Ansah, Nana" typed without the quotes. It
     is reported rather than thrown, and reported on the row it happened to,
     because everything after it in the row has shifted along by one and reading
     any of it would file somebody's start date under their job title. */
  const extra = record.values.slice(headings.length).filter((value) => value.trim() !== '');
  const problem =
    extra.length === 0
      ? null
      : `This row has ${record.values.length} values but the file has ${headings.length} ` +
        'columns. That is usually a comma inside a cell that was not put in quotes; ' +
        'everything after it has shifted into the wrong column.';

  return { line: record.line, cells, problem };
}
