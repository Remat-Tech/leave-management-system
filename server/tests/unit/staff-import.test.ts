import { describe, expect, it } from 'vitest';
import type { Employee } from '../../src/domain/employee.js';
import { readSheet, type SheetRow } from '../../src/domain/spreadsheet.js';
import {
  type ColumnMapping,
  compare,
  type CurrentRow,
  describePlan,
  type DraftRow,
  fingerprintOf,
  findManagerCycles,
  type ImportPlan,
  InvalidColumnMapping,
  InvalidImportRow,
  orderForWriting,
  type PlannedChange,
  type PlannedCreate,
  readDraft,
  resolveColumnMapping,
  summarise,
} from '../../src/domain/staff-import.js';

/**
 * The rules a staff import obeys, checked without a database. FR 08, LMS 107.
 *
 * What is asserted here is everything that can be decided from the file and the
 * file alone: which column holds which field, what one row says, whether the
 * reporting lines the file describes loop, and what order the rows have to be
 * written in. Everything that needs to know what is already in the tables — that
 * a department exists, that an employee number is somebody's — is the integration
 * suite's, because it genuinely cannot be answered here.
 *
 * The dry run report itself is asserted in both places, and deliberately. It is
 * the deliverable of this story: a report that says the wrong line number, or
 * that quietly omits a rejection, is a failure of the feature even when every
 * record it eventually writes is correct.
 */

const HEADINGS = 'Employee Number,First Name,Last Name,Email,Department,Line Manager,Start Date';

const ROW = 'RH-0100,Esi,Nyarko,esi.nyarko@rematholdings.com,Operations,RH-0010,2026-09-01';

/** The one employee the comparison tests are run against. */
const ADWOA: Employee = {
  id: '11',
  employeeNumber: 'RH-0011',
  firstName: 'Adwoa',
  lastName: 'Frimpong',
  workEmail: 'adwoa.frimpong@rematholdings.com',
  jobTitle: 'Operations Officer',
  departmentId: '5',
  managerId: '10',
  workPatternId: '1',
  startDate: '2023-08-14',
  exitDate: null,
  employmentType: 'FULL_TIME',
  employmentStatus: 'ACTIVE',
  gender: 'FEMALE',
  createdAt: new Date('2026-08-27T09:00:00Z'),
  updatedAt: new Date('2026-08-27T09:00:00Z'),
};

const CURRENT: CurrentRow = {
  employee: ADWOA,
  departmentName: 'Operations',
  managerNumber: 'RH-0010',
  workPatternName: 'Standard Mon-Fri',
};

/** The rows of a file, already mapped, which is what readDraft is given. */
function rowsOf(csv: string): { rows: SheetRow[]; mapping: ColumnMapping } {
  const sheet = readSheet(csv);
  return { rows: sheet.rows, mapping: resolveColumnMapping(sheet.headings) };
}

function draftOf(csv: string): DraftRow {
  const { rows, mapping } = rowsOf(csv);
  return readDraft(rows[0], mapping);
}

function rowRefusal(csv: string): InvalidImportRow {
  try {
    draftOf(csv);
  } catch (error) {
    if (error instanceof InvalidImportRow) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the row to be refused, but it was read.');
}

function mappingRefusal(headings: string[], given?: ColumnMapping): InvalidColumnMapping {
  try {
    resolveColumnMapping(headings, given);
  } catch (error) {
    if (error instanceof InvalidColumnMapping) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the mapping to be refused, but it was accepted.');
}

describe('mapping columns to fields', () => {
  it('works out the ordinary headings without being told anything', () => {
    const mapping = resolveColumnMapping(HEADINGS.split(','));

    expect(mapping).toEqual({
      employeeNumber: 'Employee Number',
      firstName: 'First Name',
      lastName: 'Last Name',
      workEmail: 'Email',
      department: 'Department',
      manager: 'Line Manager',
      startDate: 'Start Date',
    });
  });

  it('recognises a heading whatever its case, spacing and punctuation', () => {
    const mapping = resolveColumnMapping([
      'staff_no',
      'FORENAME',
      'Surname',
      'e-mail address',
      'Dept.',
      'Reports To',
      'Commencement Date',
    ]);

    expect(mapping.employeeNumber).toBe('staff_no');
    expect(mapping.workEmail).toBe('e-mail address');
    expect(mapping.manager).toBe('Reports To');
    expect(mapping.startDate).toBe('Commencement Date');
  });

  it('lets the caller’s mapping win over the guess', () => {
    /* An HR officer who has said that Ref is the employee number should not be
       second guessed because the file also has a column called Staff No. */
    const mapping = resolveColumnMapping([...HEADINGS.split(','), 'Ref'], {
      employeeNumber: 'Ref',
    });

    expect(mapping.employeeNumber).toBe('Ref');
  });

  it('ignores columns nothing reads', () => {
    // Cost centres and desk locations are perfectly reasonable things for HR's
    // spreadsheet to hold and none of this system's business.
    const mapping = resolveColumnMapping([...HEADINGS.split(','), 'Cost Centre', 'Desk']);

    expect(Object.values(mapping)).not.toContain('Cost Centre');
  });

  it('refuses a file with no column for a required field, and lists what it has', () => {
    const error = mappingRefusal(['Employee Number', 'First Name', 'Last Name']);

    expect(error.fields).toContain('workEmail');
    expect(error.fields).toContain('department');
    expect(error.fields).toContain('manager');
    expect(error.fields).toContain('startDate');
    // The answer is sitting in the list of headings, so the message carries it.
    expect(error.message).toContain('"Employee Number"');
  });

  it('requires a line manager column even though a cell in it may be blank', () => {
    /* FR 02 restated for a file. Without the column every row is silently the
       head of the organisation, and the person who finds out is the employee
       whose first request vanishes. */
    const error = mappingRefusal(
      'Employee Number,First Name,Last Name,Email,Department,Start Date'.split(','),
    );

    expect(error.fields).toEqual(['manager']);
  });

  it('refuses two columns that could both be the same field', () => {
    const error = mappingRefusal([...HEADINGS.split(','), 'Manager']);

    expect(error.fields).toEqual(['manager']);
    expect(error.message).toContain('More than one column');
  });

  it('accepts that ambiguity once the caller says which column is meant', () => {
    const mapping = resolveColumnMapping([...HEADINGS.split(','), 'Manager'], {
      manager: 'Line Manager',
    });

    expect(mapping.manager).toBe('Line Manager');
  });

  it('refuses a mapping that names a column the file does not have', () => {
    const error = mappingRefusal(HEADINGS.split(','), { gender: 'Sex At Birth' });

    expect(error.fields).toEqual(['gender']);
    expect(error.message).toContain('Sex At Birth');
  });

  it('does not guess at Title, Type or Number', () => {
    /* Guessing wrong is worse than not guessing: an unmapped column is one line
       of a mapping, a column mapped to the wrong field is a dry run that looks
       right and imports everybody's salutation as their job title. */
    const mapping = resolveColumnMapping([...HEADINGS.split(','), 'Title', 'Type', 'Number']);

    expect(mapping.jobTitle).toBeUndefined();
    expect(mapping.employmentType).toBeUndefined();
  });
});

describe('reading one row', () => {
  it('reads the fields the file gives it', () => {
    expect(draftOf(`${HEADINGS}\n${ROW}\n`)).toEqual({
      line: 2,
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      department: 'Operations',
      manager: 'RH-0010',
      startDate: '2026-09-01',
    });
  });

  it('folds the work address to lower case, because it is an identifier', () => {
    const row = ROW.replace('esi.nyarko@', 'Esi.Nyarko@');

    expect(draftOf(`${HEADINGS}\n${row}\n`).workEmail).toBe('esi.nyarko@rematholdings.com');
  });

  it('reads a blank line manager as the head of the organisation', () => {
    /* The one blank in this system that means something rather than nothing. The
       domain refuses '' precisely so that whoever maps blanks to null does it
       knowingly, and this is that layer doing it knowingly. */
    const row = ROW.replace(',RH-0010,', ',,');

    expect(draftOf(`${HEADINGS}\n${row}\n`).manager).toBeNull();
  });

  it('leaves an optional field out when the cell is blank rather than nulling it', () => {
    /* The rule the whole story turns on. A partial spreadsheet of new starters
       must not be an instruction that wipes the job title of everybody it
       touches. */
    const draft = draftOf(`${HEADINGS},Job Title,Gender\n${ROW},,\n`);

    expect('jobTitle' in draft).toBe(false);
    expect('gender' in draft).toBe(false);
  });

  it('reads the optional fields when the cells have something in them', () => {
    const draft = draftOf(
      `${HEADINGS},Job Title,Work Pattern,Exit Date,Employment Type,Gender\n` +
        `${ROW},Operations Officer,Part time,2027-03-31,Part time,Female\n`,
    );

    expect(draft.jobTitle).toBe('Operations Officer');
    expect(draft.workPattern).toBe('Part time');
    expect(draft.exitDate).toBe('2027-03-31');
    expect(draft.employmentType).toBe('PART_TIME');
    expect(draft.gender).toBe('FEMALE');
  });

  it('reads a fixed value the way somebody types it', () => {
    // "Part time", "part-time" and "PART_TIME" are the same answer, and making
    // an HR officer retype a column the system understood is not worth doing.
    for (const written of ['Part time', 'part-time', 'PART_TIME', ' full time ']) {
      const draft = draftOf(`${HEADINGS},Employment Type\n${ROW},${written}\n`);
      expect(draft.employmentType).toMatch(/^(PART|FULL)_TIME$/);
    }
  });

  it('refuses a value outside the list and says what the list is', () => {
    const error = rowRefusal(`${HEADINGS},Employment Type\n${ROW},Zero hours\n`);

    expect(error.field).toBe('employmentType');
    expect(error.message).toContain('FULL_TIME');
  });

  it('refuses a required cell that is empty, and names the column it is under', () => {
    const error = rowRefusal(`${HEADINGS}\n${ROW.replace(',Operations,', ',,')}\n`);

    expect(error.field).toBe('department');
    expect(error.message).toContain('"Department"');
  });

  it('refuses a date that is not written YYYY-MM-DD', () => {
    /* 31/07/2026 and 07/31/2026 are the same eleven characters meaning two
       different days, and start_date is what a first entitlement is calculated
       from. Guessing is not an option worth having. */
    const error = rowRefusal(`${HEADINGS}\n${ROW.replace('2026-09-01', '01/09/2026')}\n`);

    expect(error.field).toBe('startDate');
    expect(error.message).toContain('YYYY-MM-DD');
  });

  it('drops the midnight a spreadsheet adds to a date column', () => {
    const draft = draftOf(`${HEADINGS}\n${ROW.replace('2026-09-01', '2026-09-01 00:00:00')}\n`);

    expect(draft.startDate).toBe('2026-09-01');
  });

  it('refuses a row whose values have shifted into the wrong columns', () => {
    const error = rowRefusal(`${HEADINGS}\n${ROW},an extra value\n`);

    expect(error.field).toBeNull();
    expect(error.message).toContain('quotes');
  });
});

describe('comparing a row against the record it names', () => {
  it('finds nothing to change when the record already says what the file says', () => {
    const draft = draftOf(
      `${HEADINGS},Job Title\n` +
        'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,RH-0010,' +
        '2023-08-14,Operations Officer\n',
    );

    expect(compare(CURRENT, draft).differences).toEqual([]);
  });

  it('reports a change in the file’s own words rather than in ids', () => {
    const draft = draftOf(
      `${HEADINGS},Job Title\n` +
        'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Finance,RH-0006,' +
        '2023-08-14,Finance Officer\n',
    );

    const comparison = compare(CURRENT, draft);

    expect(comparison.differences).toEqual([
      { field: 'jobTitle', from: 'Operations Officer', to: 'Finance Officer' },
      { field: 'department', from: 'Operations', to: 'Finance' },
      { field: 'manager', from: 'RH-0010', to: 'RH-0006' },
    ]);
    expect(comparison.movesDepartment).toBe(true);
    expect(comparison.movesManager).toBe(true);
    expect(comparison.movesWorkPattern).toBe(false);
  });

  it('does not report a difference that is only capitals', () => {
    /* A file that writes OPERATIONS where the record says Operations is naming
       the same team. Reporting it would fill the report with rows nobody meant
       to touch, which is how a genuine change three pages down goes unread. */
    const draft = draftOf(
      `${HEADINGS}\n` +
        'RH-0011,Adwoa,Frimpong,ADWOA.FRIMPONG@REMATHOLDINGS.COM,OPERATIONS,rh-0010,' +
        '2023-08-14\n',
    );

    expect(compare(CURRENT, draft).differences).toEqual([]);
  });

  it('leaves a field alone when the file says nothing about it', () => {
    // No Job Title column at all, so the job title is not touched.
    const draft = draftOf(
      `${HEADINGS}\n` +
        'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,RH-0010,' +
        '2023-08-14\n',
    );

    const comparison = compare(CURRENT, draft);

    expect(comparison.differences).toEqual([]);
    expect('jobTitle' in comparison.changes).toBe(false);
  });

  it('reports somebody being made the head of the organisation', () => {
    const draft = draftOf(
      `${HEADINGS}\n` +
        'RH-0011,Adwoa,Frimpong,adwoa.frimpong@rematholdings.com,Operations,,2023-08-14\n',
    );

    expect(compare(CURRENT, draft).differences).toEqual([
      { field: 'manager', from: 'RH-0010', to: null },
    ]);
  });
});

describe('finding loops in the reporting lines', () => {
  const linesOf = (pairs: [string, string | null][]) => new Map(pairs);

  it('finds none in a tree', () => {
    expect(
      findManagerCycles(
        linesOf([
          ['ceo', null],
          ['director', 'ceo'],
          ['lead', 'director'],
          ['officer', 'lead'],
        ]),
      ),
    ).toEqual([]);
  });

  it('finds a loop of three and gives it in reporting order', () => {
    const [loop] = findManagerCycles(
      linesOf([
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ]),
    );

    // a reports to b, b reports to c, c reports to a.
    expect(loop).toEqual(['a', 'b', 'c']);
  });

  it('finds somebody recorded as their own line manager', () => {
    expect(findManagerCycles(linesOf([['a', 'a']]))).toEqual([['a']]);
  });

  it('reports one loop once rather than once per person hanging off it', () => {
    /* Six people report into a loop of two. A report with eight copies of the
       same sentence in it is one an HR officer stops reading. */
    const cycles = findManagerCycles(
      linesOf([
        ['a', 'b'],
        ['b', 'a'],
        ['c', 'a'],
        ['d', 'c'],
        ['e', 'd'],
      ]),
    );

    expect(cycles).toHaveLength(1);
  });

  it('finds every loop when there is more than one', () => {
    expect(
      findManagerCycles(
        linesOf([
          ['a', 'b'],
          ['b', 'a'],
          ['c', 'd'],
          ['d', 'c'],
        ]),
      ),
    ).toHaveLength(2);
  });

  it('does not call a manager who is nobody a loop', () => {
    // An unresolved reference is a different problem with a different answer,
    // and is refused where the reference is checked.
    expect(findManagerCycles(linesOf([['a', 'nobody']]))).toEqual([]);
  });

  it('finds a loop closed by one row through people the file never mentions', () => {
    /* The case the trigger cannot describe and a per row check cannot see: the
       file moves one person, and the loop runs through five records it does not
       touch. */
    const cycles = findManagerCycles(
      linesOf([
        ['ceo', null],
        ['director', 'ceo'],
        ['manager', 'director'],
        ['lead', 'manager'],
        // The one line the file changes: the director now reports to the lead.
        ['director', 'lead'],
      ]),
    );

    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(['director', 'lead', 'manager']);
  });
});

describe('the order the rows are written in', () => {
  function create(line: number, employeeNumber: string, managerNumber: string | null) {
    const draft: DraftRow = {
      line,
      employeeNumber,
      firstName: 'A',
      lastName: 'B',
      workEmail: `${employeeNumber}@rematholdings.com`,
      department: 'Operations',
      manager: managerNumber,
      startDate: '2026-09-01',
    };

    return {
      line,
      employeeNumber,
      fullName: 'A B',
      draft,
      record: {
        employeeNumber,
        firstName: 'A',
        lastName: 'B',
        workEmail: draft.workEmail,
        departmentId: '5',
        startDate: '2026-09-01',
      },
      managerNumber,
    } satisfies PlannedCreate;
  }

  function change(line: number, employeeNumber: string, managerNumber?: string | null) {
    return {
      line,
      employeeId: employeeNumber,
      employeeNumber,
      fullName: 'A B',
      changes: {},
      ...(managerNumber !== undefined && { managerNumber }),
      differences: [],
    } satisfies PlannedChange;
  }

  function planOf(creates: PlannedCreate[], changes: PlannedChange[] = []): ImportPlan {
    return { mapping: {}, creates, changes, unchanged: [], rejected: [], fingerprint: '' };
  }

  /** The reporting lines the plan would end up with, which is what places each row. */
  function linesOf(pairs: [string, string | null][]) {
    return new Map(pairs.map(([number, manager]) => [number.toLowerCase(), manager]));
  }

  it('writes a manager before the report who names them', () => {
    /* manager_id is an ordinary foreign key, checked at the end of the statement
       that writes the row, so a joiner cannot name a manager three lines further
       down the file who does not exist yet. Sorting the file by hand is not
       something to ask of an HR officer. */
    const plan = planOf([
      create(2, 'RH-0103', 'RH-0102'),
      create(3, 'RH-0102', 'RH-0101'),
      create(4, 'RH-0101', null),
    ]);

    const lines = linesOf([
      ['rh-0103', 'rh-0102'],
      ['rh-0102', 'rh-0101'],
      ['rh-0101', null],
    ]);

    expect(numbersOf(orderForWriting(plan, lines))).toEqual(['RH-0101', 'RH-0102', 'RH-0103']);
  });

  it('leaves a file that is already in order alone', () => {
    const plan = planOf([
      create(2, 'RH-0101', null),
      create(3, 'RH-0102', 'RH-0101'),
      create(4, 'RH-0103', 'RH-0102'),
    ]);

    const lines = linesOf([
      ['rh-0101', null],
      ['rh-0102', 'rh-0101'],
      ['rh-0103', 'rh-0102'],
    ]);

    expect(numbersOf(orderForWriting(plan, lines))).toEqual(['RH-0101', 'RH-0102', 'RH-0103']);
  });

  it('hangs a joiner off the reporting lines the file does not touch', () => {
    // The manager is already in the database and is not a row of the file, so
    // the depth of the joiner is only knowable from the organisation as a whole.
    const plan = planOf([create(2, 'RH-0200', 'RH-0010'), create(3, 'RH-0201', 'RH-0200')]);

    const lines = linesOf([
      ['rh-0001', null],
      ['rh-0010', 'rh-0001'],
      ['rh-0200', 'rh-0010'],
      ['rh-0201', 'rh-0200'],
    ]);

    expect(numbersOf(orderForWriting(plan, lines))).toEqual(['RH-0200', 'RH-0201']);
  });

  it('moves somebody up before it moves anybody under them', () => {
    /* A manager and their report swapping over. Written the other way round, the
       first of the two writes leaves a loop standing, and EmployeeService walks
       up from the proposed manager and refuses it — rightly, for the single edit
       it was written for. */
    const plan = planOf(
      [],
      [
        // Akosua moves under Kofi, who is currently her report.
        change(2, 'RH-0007', 'RH-0010'),
        // Kofi moves up to where she was.
        change(3, 'RH-0010', 'RH-0003'),
      ],
    );

    const lines = linesOf([
      ['rh-0001', null],
      ['rh-0003', 'rh-0001'],
      ['rh-0010', 'rh-0003'],
      ['rh-0007', 'rh-0010'],
    ]);

    expect(numbersOf(orderForWriting(plan, lines))).toEqual(['RH-0010', 'RH-0007']);
  });

  function numbersOf(operations: ReturnType<typeof orderForWriting>) {
    return operations.map((operation) =>
      operation.kind === 'create'
        ? operation.create.employeeNumber
        : operation.change.employeeNumber,
    );
  }
});

describe('the plan itself', () => {
  const PLAN: ImportPlan = {
    mapping: { employeeNumber: 'Employee Number' },
    creates: [],
    changes: [],
    unchanged: [{ line: 2, employeeNumber: 'RH-0011', fullName: 'Adwoa Frimpong' }],
    rejected: [
      {
        line: 3,
        employeeNumber: 'RH-0102',
        field: 'startDate',
        reason: '"01/09/2026" is not a date this import can read.',
      },
    ],
    fingerprint: '',
  };

  it('counts every row of the file', () => {
    expect(summarise(PLAN)).toEqual({
      toCreate: 0,
      toChange: 0,
      unchanged: 1,
      rejected: 1,
      rows: 2,
    });
  });

  it('fingerprints the same plan the same way twice', () => {
    expect(fingerprintOf(PLAN)).toBe(fingerprintOf({ ...PLAN }));
  });

  it('fingerprints a different decision differently', () => {
    /* This is what makes "nothing is written until the dry run is confirmed" a
       guarantee about *this* dry run: if somebody else moved the records
       underneath it, the confirmation is refused rather than applied to a plan
       nobody read. */
    const moved: ImportPlan = { ...PLAN, unchanged: [] };

    expect(fingerprintOf(moved)).not.toBe(fingerprintOf(PLAN));
  });

  it('puts the line number in front of every line of the report', () => {
    const report = describePlan(PLAN);

    expect(report).toContain('Nothing has been written');
    expect(report).toContain('line 3');
    expect(report).toContain('01/09/2026');
    // The unmapped columns are shown as well, so the reader can see that the
    // file said nothing about a field rather than wondering.
    expect(report).toContain('gender: not in the file');
  });
});
