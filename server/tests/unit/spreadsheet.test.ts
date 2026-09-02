import { describe, expect, it } from 'vitest';
import {
  cellOf,
  normaliseHeading,
  readSheet,
  UnreadableSpreadsheet,
} from '../../src/features/staff-import/spreadsheet.js';

/**
 * Turning a file into rows. FR 08, LMS 107.
 *
 * All of this is the awkward half of reading a spreadsheet rather than the easy
 * half, and deliberately so. A well formed comma separated file with no quotes
 * in it is two lines of code; what these assert is the file that actually
 * arrives — saved by Excel with a byte order mark on the front, separated by
 * semicolons because the machine is set to a European locale, with a surname
 * that has a comma in it, ending without a newline, and with two empty columns
 * on the right hand end that nobody has noticed since 2019.
 *
 * Each of those, read wrongly, produces an import that looks like it worked.
 */

const HEADINGS = 'Employee Number,First Name,Last Name';

function refusal(fn: () => unknown): UnreadableSpreadsheet {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnreadableSpreadsheet) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the file to be refused, but it was read.');
}

describe('reading a delimited file', () => {
  it('reads the headings and the rows under them', () => {
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko\nRH-0101,Kojo,Mensah\n`);

    expect(sheet.headings).toEqual(['Employee Number', 'First Name', 'Last Name']);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0].cells).toEqual({
      'Employee Number': 'RH-0100',
      'First Name': 'Esi',
      'Last Name': 'Nyarko',
    });
  });

  it('numbers each row the way the HR officer’s editor numbers it', () => {
    // The heading row is line 1, so the first employee is line 2. A report that
    // says "row 1" when the file says 2 sends somebody to the wrong line.
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko\nRH-0101,Kojo,Mensah\n`);

    expect(sheet.rows.map((row) => row.line)).toEqual([2, 3]);
  });

  it('keeps counting lines through a newline inside a quoted cell', () => {
    const sheet = readSheet(`${HEADINGS}\nRH-0100,"Esi\nAdwoa",Nyarko\nRH-0101,Kojo,Mensah\n`);

    expect(sheet.rows[0].cells['First Name']).toBe('Esi\nAdwoa');
    // The second employee is on line 4, because the first one took two lines.
    expect(sheet.rows[1].line).toBe(4);
  });

  it('strips the byte order mark Excel puts on the front of a UTF-8 CSV', () => {
    // Invisible in every editor, and part of the first heading as far as any
    // string comparison is concerned — so without this the employee number
    // column is the one that mysteriously fails to map.
    const sheet = readSheet(`\uFEFF${HEADINGS}\nRH-0100,Esi,Nyarko\n`);

    expect(sheet.headings[0]).toBe('Employee Number');
  });

  it('reads the last row of a file that does not end with a newline', () => {
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko`);

    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].cells['Last Name']).toBe('Nyarko');
  });

  it('reads a file written on Windows and a file written on a Mac', () => {
    const windows = readSheet(`${HEADINGS}\r\nRH-0100,Esi,Nyarko\r\n`);
    const mac = readSheet(`${HEADINGS}\rRH-0100,Esi,Nyarko\r`);

    expect(windows.rows[0].cells['Last Name']).toBe('Nyarko');
    expect(mac.rows[0].cells['Last Name']).toBe('Nyarko');
  });

  it('drops the blank line at the end that every exporter writes', () => {
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko\n\n\n`);

    expect(sheet.rows).toHaveLength(1);
  });
});

describe('quoted cells', () => {
  it('keeps a comma that is inside quotes inside one cell', () => {
    // Nana Owusu-Ansah's surname is the reason this matters. Split on commas
    // and the row shifts by one column from there on.
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Nana,"Owusu-Ansah, Jr"\n`);

    expect(sheet.rows[0].cells['Last Name']).toBe('Owusu-Ansah, Jr');
  });

  it('reads a doubled quote inside a quoted cell as one quote', () => {
    const sheet = readSheet(`Employee Number,Job Title\nRH-0100,"The ""Interim"" Lead"\n`);

    expect(sheet.rows[0].cells['Job Title']).toBe('The "Interim" Lead');
  });

  it('leaves a quote in the middle of an unquoted cell alone', () => {
    // An apostrophe-happy job title is not a quoting error.
    const sheet = readSheet(`Employee Number,Job Title\nRH-0100,Manager 6" Team\n`);

    expect(sheet.rows[0].cells['Job Title']).toBe('Manager 6" Team');
  });
});

describe('choosing the delimiter', () => {
  it('reads a semicolon separated file, which is what Excel writes in Europe', () => {
    const sheet = readSheet('Employee Number;First Name;Last Name\nRH-0100;Esi;Nyarko\n');

    expect(sheet.delimiter).toBe(';');
    expect(sheet.rows[0].cells['First Name']).toBe('Esi');
  });

  it('reads a tab separated file', () => {
    const sheet = readSheet('Employee Number\tFirst Name\nRH-0100\tEsi\n');

    expect(sheet.delimiter).toBe('\t');
    expect(sheet.rows[0].cells['First Name']).toBe('Esi');
  });

  it('uses the delimiter it was given rather than sniffing', () => {
    const sheet = readSheet('a|b\n1|2\n', { delimiter: '|' });

    expect(sheet.headings).toEqual(['a', 'b']);
  });
});

describe('a file that cannot be read at all', () => {
  it('refuses an empty file', () => {
    expect(refusal(() => readSheet('   \n  \n')).message).toContain('empty');
  });

  it('refuses two columns that name the same thing', () => {
    /* There is no answer to which one holds the work address, and choosing the
       first silently is how half the company ends up unable to sign in. */
    const error = refusal(() => readSheet('Email,E-mail\na@b.com,c@d.com\n'));

    expect(error.message).toContain('"Email"');
    expect(error.message).toContain('"E-mail"');
  });

  it('refuses a column that has data in it but no heading', () => {
    const error = refusal(() => readSheet('Employee Number,,Last Name\nRH-0100,Esi,Nyarko\n'));

    expect(error.message).toContain('Column 2');
  });
});

describe('columns on the right hand end', () => {
  it('drops the empty ones an old spreadsheet keeps writing', () => {
    const sheet = readSheet(`${HEADINGS},,\nRH-0100,Esi,Nyarko,,\n`);

    expect(sheet.headings).toEqual(['Employee Number', 'First Name', 'Last Name']);
    expect(sheet.rows[0].problem).toBeNull();
  });

  it('keeps refusing one that is empty in the heading but has data under it', () => {
    // A heading somebody deleted by accident, which is worth refusing rather
    // than quietly ignoring a column full of values.
    expect(() => readSheet(`${HEADINGS},\nRH-0100,Esi,Nyarko,Operations\n`)).toThrow(
      UnreadableSpreadsheet,
    );
  });
});

describe('a row with more values than the file has columns', () => {
  it('reports the row rather than refusing the file', () => {
    /* One unquoted comma should cost one line of the dry run report, not the
       other four hundred rows. */
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko\nRH-0101,Nana,Owusu,Ansah\n`);

    expect(sheet.rows[0].problem).toBeNull();
    expect(sheet.rows[1].problem).toContain('not put in quotes');
  });

  it('pads a row that stops early, because trailing empty cells are often omitted', () => {
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi\n`);

    expect(sheet.rows[0].problem).toBeNull();
    expect(sheet.rows[0].cells['Last Name']).toBe('');
  });
});

describe('cellOf', () => {
  it('reads the cell under a heading, trimmed', () => {
    const sheet = readSheet(`${HEADINGS}\n RH-0100 ,Esi,Nyarko\n`);

    expect(cellOf(sheet.rows[0], 'Employee Number')).toBe('RH-0100');
  });

  it('gives the empty string for a column the file does not have', () => {
    // A column HR left out and a cell they left empty mean the same thing to an
    // import: the file says nothing about that field.
    const sheet = readSheet(`${HEADINGS}\nRH-0100,Esi,Nyarko\n`);

    expect(cellOf(sheet.rows[0], undefined)).toBe('');
    expect(cellOf(sheet.rows[0], 'Gender')).toBe('');
  });
});

describe('normaliseHeading', () => {
  it('treats the same column written three ways as the same column', () => {
    expect(normaliseHeading('Employee Number')).toBe('employeenumber');
    expect(normaliseHeading('employee_number')).toBe('employeenumber');
    expect(normaliseHeading('  EmployeeNumber.  ')).toBe('employeenumber');
  });
});
