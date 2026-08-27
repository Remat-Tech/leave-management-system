/**
 * A spreadsheet, as far as this system is concerned: a row of headings and rows
 * of text under them. FR 08.
 *
 * This is the mechanical half of the staff import — how a file becomes rows —
 * kept apart from ./staff-import.ts, which is what those rows have to say to be
 * an employee record. The split is worth having because the two fail for
 * completely different reasons and at completely different times: a file that is
 * not a spreadsheet at all fails once, before anything else runs, and a row with
 * a bad start date fails on its own and lets the other four hundred through.
 *
 * Pure, like the rest of /domain: text in, rows out, no filesystem and no
 * upload. Whatever hands the bytes over — a route in Phase 5, a test, a script —
 * decodes them to a string first.
 *
 * **What is read is the delimited export, not the .xlsx.** Comma separated,
 * semicolon separated (which is what Excel writes in most of Europe), or tab.
 * That is a deliberate line and not a shortcut:
 *
 *   An .xlsx is a zip of XML with a shared string table, a styles part, and
 *   dates held as a serial number counting from an epoch that is wrong on
 *   purpose for compatibility with a Lotus bug. Reading one properly is a
 *   dependency, and reading one improperly is how an import quietly moves
 *   everybody's start date by a day or two.
 *
 *   Every spreadsheet in existence exports CSV, and every one of them opens it.
 *   "Save as CSV" is one menu item for the HR officer and no attack surface for
 *   us.
 *
 * A story that genuinely needs the workbook itself — because HR will not accept
 * the extra step, or because a sheet has to be picked out of several — brings a
 * parser with it and hands {@link Sheet} to the rest of this unchanged. Nothing
 * above here knows what the file was.
 */

/**
 * The delimiters that are sniffed for, in the order they win a tie.
 *
 * Semicolon is here because it is what Excel writes wherever the list separator
 * is a semicolon, which is most of Europe, and a file like that read as comma
 * separated is one enormous column with a heading nobody can map. Tab is what
 * "Unicode text" saves as and what a paste out of a browser produces.
 */
const DELIMITERS = [',', ';', '\t', '|'] as const;

/** One row of the file, with the line it came from. */
export interface SheetRow {
  /**
   * The line the row starts on, counting from 1 and counting the heading row.
   *
   * This is the number the HR officer sees down the side of their spreadsheet,
   * which is the entire point of carrying it: a dry run report that says "row 4"
   * when the file says 5 is worse than one that says nothing.
   */
  line: number;
  /** The cells, by the heading above them, trimmed. */
  cells: Record<string, string>;
  /**
   * What is structurally wrong with this row, if anything.
   *
   * Carried rather than thrown, because one row with an unescaped delimiter in
   * it should be reported next to every other refusal in the dry run rather than
   * stopping the file from being read at all. {@link readSheet} throws only for
   * what makes the whole file unreadable.
   */
  problem: string | null;
}

export interface Sheet {
  /** The headings as written, trimmed, in the order the file has them. */
  headings: string[];
  rows: SheetRow[];
  /** What separated the cells, sniffed unless the caller said. */
  delimiter: string;
}

/**
 * A file that is not a spreadsheet, or is one nothing could be made of.
 *
 * Distinct from every per-row refusal, and thrown rather than reported, because
 * there is no partial answer to give: a dry run over a file with two columns
 * called "Email" cannot say which of them it read.
 */
export class UnreadableSpreadsheet extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableSpreadsheet';
  }
}

/**
 * Reads a delimited file into headings and rows.
 *
 * The delimiter is sniffed from the heading row unless one is given, quoted
 * cells are unwrapped, and a byte order mark — which Excel puts on the front of
 * every CSV it saves as UTF-8 — is stripped, so the first heading is `Employee
 * Number` rather than a U+FEFF followed by `Employee Number`. That last one is
 * worth more than it looks: the mark is invisible in every editor, so without
 * this the first column silently fails to map, and it is the column holding the
 * identifier every other row is matched by.
 *
 * Rows that are entirely empty are dropped rather than reported. A trailing
 * blank line is what almost every exporter writes, and reporting it as a bad row
 * would put a refusal in the report of every well formed file.
 */
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

/**
 * The value under a heading, or the empty string when the file has no such
 * column.
 *
 * Absent and blank deliberately come back the same. A column HR did not include
 * and a cell they left empty mean the same thing to an import — "this file says
 * nothing about that" — and making callers tell them apart would put the same
 * `?? ''` at every reading site.
 */
export function cellOf(row: SheetRow, heading: string | undefined): string {
  return heading === undefined ? '' : (row.cells[heading] ?? '');
}

/**
 * Headings compared the way a person compares them.
 *
 * `Employee Number`, `employee_number` and `EmployeeNo.` are the same column
 * wearing three different coats, and an HR officer who renamed a heading in
 * their own spreadsheet has not changed which column it is. Case, spaces,
 * underscores and punctuation all come out, so what is left is the letters and
 * digits.
 */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Excel writes a byte order mark on the front of every UTF-8 CSV it saves.
 *
 * It is invisible in every editor and it is part of the first heading as far as
 * a string comparison is concerned, so the first column — the one holding the
 * employee number — is the one that mysteriously fails to map.
 */
function stripByteOrderMark(text: string): string {
  // Written as an escape rather than as the character itself, which is
  // invisible in the source too and which the linter rightly refuses.
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * Which character separated the cells, decided by which one produces the most
 * columns in the heading row.
 *
 * A heading row is the best place to ask, because it is the one row guaranteed
 * to have a value in every column and no free text in it. A file whose winner
 * gives one column is treated as comma separated: it may genuinely be a single
 * column file, and if it is not, the mapping is about to fail with a message
 * that lists the headings it found, which is far more use than a guess.
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

/**
 * The delimited format, as RFC 4180 describes it and as spreadsheets actually
 * write it.
 *
 * A hand written state machine rather than a split on the delimiter, because the
 * two differ exactly where the data gets interesting: `"Owusu-Ansah, Nana"` is
 * one cell, `"She said ""no"""` is one cell with quotes in it, and a quoted cell
 * may contain the newline of a two line address. Splitting on commas turns the
 * first of those into two columns and the whole row into a refusal HR cannot
 * explain.
 *
 * Line endings are whatever the file has. A CSV written on Windows and read on a
 * Mac, or the other way round, is the ordinary case rather than the exception.
 *
 * The line number counts newlines inside quoted cells too, so it is the line the
 * editor shows rather than the number of records read so far.
 */
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

/**
 * Drops the empty columns off the right hand end.
 *
 * A spreadsheet that once had a column in it keeps writing the delimiter for it
 * long after the heading was cleared, so a perfectly ordinary file arrives with
 * two nameless columns on the end. They are dropped only when nothing under them
 * has a value either — a nameless column with data in it is a heading somebody
 * deleted by accident, which is worth refusing rather than ignoring.
 */
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
