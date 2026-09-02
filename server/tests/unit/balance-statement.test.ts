import { describe, expect, it } from 'vitest';
import { type LeaveBalance, noMovementsYet } from '../../src/domain/balance.js';
import {
  allowanceInWords,
  type BalanceStatementLine,
  lineFor,
  linesFor,
  NoLeaveYearToShow,
  NotOneOfTheirLeaveYears,
  statementFor,
  theYearToOpenOn,
  yearsToChooseFrom,
} from '../../src/domain/balance-statement.js';
import { type LeaveType, validateNewLeaveType } from '../../src/domain/leave-type.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';

/**
 * The balance screen, as rules rather than as a screen. FR 53, §7.4. LMS 401.
 *
 * Most of this story is arrangement — which rows, in which order, with which sentence
 * beside them — and every one of those is a pure function, so nearly all of it is here
 * rather than in ../integration/balance-statement.test.ts. What the integration suite is
 * for is the half this one cannot claim: that the figures are the ones a real ledger
 * produced, and that somebody else's statement is refused.
 *
 * Four claims, and they are the story's three criteria plus the one that stops the first
 * of them lying:
 *
 *   **Every leave type is on it**, including the ones nothing has happened in, and
 *   *not* including the ones this person could never ask for. The two limbs of
 *   {@link linesFor} are the whole of that and they pull in opposite directions, so both
 *   are asserted from both sides.
 *
 *   **The line adds up.** Six figures and the subtraction between them, with `adjustment`
 *   among them — a statement whose available cannot be reproduced from the figures beside
 *   it is the thing design principle 1 exists against.
 *
 *   **Prior years are the ones that were theirs.** A joiner does not get the year before
 *   they arrived and a leaver does not get the year after they went, and both come from
 *   the same function the pro rata grant asks.
 *
 *   **A nought says which kind of nought it is.** FR 32g. Compassionate leave at nought
 *   in January is not somebody who has used it all, and the sentence beside it is what
 *   stops the digit saying so.
 */

const YEAR_2025: LeaveYear = year('2025', '2025-01-01', '2025-12-31');
const YEAR_2026: LeaveYear = year('2026', '2026-01-01', '2026-12-31');
const YEAR_2027: LeaveYear = year('2027', '2027-01-01', '2027-12-31');

const YEARS = [YEAR_2025, YEAR_2026, YEAR_2027];

/** The four types every test below draws from, in the seed's own display order. */
const ANNUAL = leaveType({
  code: 'ANNUAL',
  name: 'Annual Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'QUOTA',
  displayOrder: 1,
});

const SICK = leaveType({
  code: 'SICK',
  name: 'Sick Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'QUOTA',
  exceedableWithDocument: true,
  displayOrder: 2,
});

const COMPASSIONATE = leaveType({
  code: 'COMPASSIONATE',
  name: 'Compassionate Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'EVENT',
  displayOrder: 3,
});

const MATERNITY = leaveType({
  code: 'MATERNITY',
  name: 'Maternity Leave',
  countingBasis: 'CALENDAR_DAYS',
  entitlementBasis: 'EVENT',
  unit: 'MONTHS',
  documentation: 'ALWAYS',
  genderRestriction: 'FEMALE',
  displayOrder: 4,
});

const PATERNITY = leaveType({
  code: 'PATERNITY',
  name: 'Paternity Leave',
  countingBasis: 'CALENDAR_DAYS',
  entitlementBasis: 'EVENT',
  unit: 'WEEKS',
  entitlementExpiryMonths: 6,
  genderRestriction: 'MALE',
  displayOrder: 5,
});

const ALL_TYPES = [ANNUAL, SICK, COMPASSIONATE, MATERNITY, PATERNITY];

describe('which leave types are on a statement', () => {
  it('lists a type nothing has ever moved, so an unused allowance is still shown', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: [ANNUAL, SICK],
      balances: [],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL', 'SICK']);
    expect(lines.every((line) => line.available === 0)).toBe(true);
    expect(lines.every((line) => !line.hasMoved)).toBe(true);
  });

  /* FR 05. A line reading nought against a type he can never ask for is worse than no
     line, because it invites him to wonder where the days went. */
  it('leaves out a type this person is not eligible for', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'MALE',
      year: YEAR_2026,
      years: YEARS,
      types: ALL_TYPES,
      balances: [],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL', 'SICK', 'COMPASSIONATE', 'PATERNITY']);
  });

  /* The cautious reading `LeaveTypeService.offeredTo` takes, for the same reason: a
     restricted type offered to somebody whose record is incomplete teaches them that the
     screen lies. */
  it('and leaves out both restricted types where the record does not say', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: null,
      year: YEAR_2026,
      years: YEARS,
      types: ALL_TYPES,
      balances: [],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL', 'SICK', 'COMPASSIONATE']);
  });

  it('leaves out a retired type nothing has moved', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: [ANNUAL, { ...SICK, isActive: false }],
      balances: [],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL']);
  });

  /**
   * The limb that is asked first, and the one that matters most.
   *
   * A figure that exists has to be explainable. A retired type, or one this person is no
   * longer eligible for, that still holds days is on the statement whatever the other
   * rule says — otherwise the days are simply gone from the screen with nothing to say
   * why, which is the failure design principle 1 is named for.
   */
  it('but shows a retired type that still holds days, and says it is retired', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: [ANNUAL, { ...SICK, isActive: false }],
      balances: [balance(SICK, YEAR_2026, { entitled: 3, taken: 1 })],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL', 'SICK']);
    expect(lineOf(lines, 'SICK').stillOffered).toBe(false);
    expect(lineOf(lines, 'SICK').available).toBe(2);
  });

  it('and shows a type this person is no longer eligible for where days moved in it', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'MALE',
      year: YEAR_2026,
      years: YEARS,
      types: ALL_TYPES,
      balances: [balance(MATERNITY, YEAR_2026, { entitled: 120, taken: 120 })],
    });

    expect(codesOf(lines)).toContain('MATERNITY');
    expect(lineOf(lines, 'MATERNITY').taken).toBe(120);
  });

  /* §7.4 orders the balance read by display_order so that a screen and a report agree
     without either of them deciding. */
  it('orders them by the type display order rather than by the balances that exist', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: [COMPASSIONATE, ANNUAL, SICK],
      balances: [balance(COMPASSIONATE, YEAR_2026, { entitled: 5 })],
    });

    expect(codesOf(lines)).toEqual(['ANNUAL', 'SICK', 'COMPASSIONATE']);
  });

  it('ignores balances belonging to another leave year', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: [ANNUAL],
      balances: [balance(ANNUAL, YEAR_2025, { entitled: 20, taken: 20 })],
    });

    expect(lineOf(lines, 'ANNUAL').entitled).toBe(0);
    expect(lineOf(lines, 'ANNUAL').hasMoved).toBe(false);
  });
});

describe('what one line says', () => {
  /**
   * The story's first criterion, and the reason `adjustment` is on the line beside the
   * four the backlog names: without it the subtraction cannot be reproduced by the person
   * reading it, and the missing term is the one they are querying.
   */
  it('carries the five stored figures and the two the reader would otherwise compute', () => {
    const line = lineFor(
      ANNUAL,
      balance(ANNUAL, YEAR_2026, {
        entitled: 20,
        carriedOver: 5,
        adjustment: -2,
        taken: 6,
        pending: 4,
      }),
    );

    expect(line.entitled).toBe(20);
    expect(line.carriedOver).toBe(5);
    expect(line.adjustment).toBe(-2);
    expect(line.taken).toBe(6);
    expect(line.pending).toBe(4);

    expect(line.owed).toBe(23);
    expect(line.available).toBe(13);
    expect(line.entitled + line.carriedOver + line.adjustment - line.taken - line.pending).toBe(
      line.available,
    );
  });

  /* §8.6b. Sick leave goes below nought on purpose, and a screen that clamped it would
     hide exactly the case FR 32a exists for. */
  it('shows a negative balance as a negative balance', () => {
    const line = lineFor(SICK, balance(SICK, YEAR_2026, { entitled: 3, taken: 6 }));

    expect(line.available).toBe(-3);
  });

  /* The story's third criterion. Two types with the same figure mean different things,
     and the difference is invisible unless it is written. FR 22. */
  it('says the counting basis in words rather than as a constant', () => {
    expect(lineFor(ANNUAL, empty(ANNUAL)).countingBasisInWords).toMatch(/working days/);
    expect(lineFor(ANNUAL, empty(ANNUAL)).countingBasisInWords).toMatch(/cost nothing/);

    expect(lineFor(MATERNITY, empty(MATERNITY)).countingBasisInWords).toMatch(/calendar days/);
    expect(lineFor(MATERNITY, empty(MATERNITY)).countingBasisInWords).toMatch(/every day/);
  });

  it('and no line shows an underscored constant to anybody', () => {
    const lines = linesFor({
      employeeId: '1',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: YEARS,
      types: ALL_TYPES,
      balances: [],
    });

    for (const line of lines) {
      expect(line.countingBasisInWords).not.toMatch(/_/);
      expect(line.allowanceInWords).not.toMatch(/_/);
    }
  });

  it('carries the unit the allowance is expressed in, which is not how it is counted', () => {
    expect(lineFor(MATERNITY, empty(MATERNITY)).unit).toBe('MONTHS');
    expect(lineFor(MATERNITY, empty(MATERNITY)).countingBasis).toBe('CALENDAR_DAYS');
  });

  it('tells a balance nothing has moved from one that has been moved back to nought', () => {
    expect(lineFor(ANNUAL, empty(ANNUAL)).hasMoved).toBe(false);
    expect(lineFor(ANNUAL, empty(ANNUAL)).updatedAt).toBeNull();

    const netted = lineFor(ANNUAL, balance(ANNUAL, YEAR_2026, { entitled: 20, taken: 20 }));

    expect(netted.available).toBe(0);
    expect(netted.hasMoved).toBe(true);
  });
});

describe('a nought that means not yet', () => {
  /* FR 32g. The two sides of the division, and the sentence is the only thing that says
     which side a nought is on. */
  it('says a quota type is a yearly allowance', () => {
    expect(allowanceInWords(ANNUAL, empty(ANNUAL))).toMatch(/yearly allowance/);
    expect(allowanceInWords(ANNUAL, empty(ANNUAL))).toMatch(/start of the leave year/);
  });

  it('says an event type with nothing granted is waiting on an occasion', () => {
    const said = allowanceInWords(COMPASSIONATE, empty(COMPASSIONATE));

    expect(said).toMatch(/per occasion/);
    expect(said).toMatch(/nothing here until an occasion arises/);
  });

  it('and stops saying so once an occasion has arisen', () => {
    const said = allowanceInWords(
      COMPASSIONATE,
      balance(COMPASSIONATE, YEAR_2026, { entitled: 5 }),
    );

    expect(said).toMatch(/per occasion/);
    expect(said).not.toMatch(/nothing here until/);
  });

  /* FR 32e, and the only type it is true of today. A screen that showed fourteen days
     without saying they run out is a screen that costs somebody the days. */
  it('says when a grant that expires runs out', () => {
    expect(allowanceInWords(PATERNITY, empty(PATERNITY))).toMatch(/within 6 months/);
    expect(allowanceInWords(COMPASSIONATE, empty(COMPASSIONATE))).not.toMatch(/within/);
  });

  it('and says it in the singular where a type lapses after one month', () => {
    const monthly = { ...PATERNITY, entitlementExpiryMonths: 1 };

    expect(allowanceInWords(monthly, empty(monthly))).toMatch(/within 1 month of it/);
  });
});

describe('which leave years a person may choose between', () => {
  const employedThrough2026 = { startedOn: '2026-03-01', leftOn: null };

  it('offers the years they were employed for and not the one before they arrived', () => {
    const choices = yearsToChooseFrom(YEARS, employedThrough2026, []);

    expect(labelsOf(choices)).toEqual(['2026', '2027']);
  });

  it('stops at the year a leaver left in', () => {
    const choices = yearsToChooseFrom(YEARS, { startedOn: '2022-11-07', leftOn: '2026-07-31' }, []);

    expect(labelsOf(choices)).toEqual(['2025', '2026']);
  });

  it('offers a single year to somebody who joined and left inside it', () => {
    const choices = yearsToChooseFrom(YEARS, { startedOn: '2026-02-01', leftOn: '2026-09-30' }, []);

    expect(labelsOf(choices)).toEqual(['2026']);
  });

  /**
   * The safety net limb. A figure that exists has to be reachable whatever put it there,
   * and an adjustment filed under a year somebody was not employed for is exactly such a
   * figure — there is no other screen it would ever appear on.
   */
  it('offers a year they hold a balance in even though they were not employed for it', () => {
    const choices = yearsToChooseFrom(YEARS, employedThrough2026, [YEAR_2025.id]);

    expect(labelsOf(choices)).toEqual(['2025', '2026', '2027']);
  });

  /* FR 36. The rollover fills next year in the moment this one closes, so a picker that
     hid it would hide the days somebody is planning around. */
  it('offers the year ahead, which already holds what was carried into it', () => {
    expect(labelsOf(yearsToChooseFrom(YEARS, employedThrough2026, []))).toContain('2027');
  });

  /* Ordered by the day the year starts rather than by its id, so a company that moves to
     an April start does not get its years out of order. */
  it('lists them oldest first however they arrived', () => {
    const choices = yearsToChooseFrom(
      [YEAR_2027, YEAR_2025, YEAR_2026],
      { startedOn: '2020-01-01', leftOn: null },
      [],
    );

    expect(labelsOf(choices)).toEqual(['2025', '2026', '2027']);
  });

  it('offers nothing to somebody employed in none of them', () => {
    expect(yearsToChooseFrom(YEARS, { startedOn: '2030-01-05', leftOn: null }, [])).toEqual([]);
  });
});

describe('which year the screen opens on', () => {
  const choices = YEARS;

  it('opens on the year covering today', () => {
    expect(theYearToOpenOn(choices, '2026-09-02')?.label).toBe('2026');
  });

  /* A leaver, and a database the calendar has outrun. Showing them the last year they
     were actually in is right; showing them one they were never in is not. */
  it('falls back to the latest year that has already started', () => {
    expect(theYearToOpenOn([YEAR_2025, YEAR_2026], '2028-04-01')?.label).toBe('2026');
  });

  it('and to the earliest for somebody whose only year has not begun', () => {
    expect(theYearToOpenOn([YEAR_2027], '2026-09-02')?.label).toBe('2027');
  });

  it('and answers nothing where there is nothing to choose from', () => {
    expect(theYearToOpenOn([], '2026-09-02')).toBeUndefined();
  });
});

describe('the statement as a whole', () => {
  it('carries the year, the lines and the years to switch to', () => {
    const statement = statementFor({
      employeeId: '7',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: [YEAR_2025, YEAR_2026],
      types: [ANNUAL, SICK],
      balances: [balance(ANNUAL, YEAR_2026, { entitled: 20, pending: 5 })],
    });

    expect(statement.employeeId).toBe('7');
    expect(statement.year.label).toBe('2026');
    expect(labelsOf(statement.years)).toEqual(['2025', '2026']);
    expect(codesOf(statement.lines)).toEqual(['ANNUAL', 'SICK']);
    expect(lineOf(statement.lines, 'ANNUAL').available).toBe(15);
  });

  /**
   * Twenty annual days and three sick days are not twenty-three of anything.
   *
   * Asserted as an absence because that is the only way to assert it: the failure this
   * guards against is somebody adding a helpful footing to the table, and the day a
   * `total` appears on this type it will look reasonable.
   */
  it('and no total across the lines, because there is no such number', () => {
    const statement = statementFor({
      employeeId: '7',
      gender: 'FEMALE',
      year: YEAR_2026,
      years: [YEAR_2026],
      types: [ANNUAL, SICK],
      balances: [],
    });

    expect(Object.keys(statement).sort()).toEqual(['employeeId', 'lines', 'year', 'years']);
  });
});

describe('the two refusals', () => {
  /* Different mistakes with different fixes: one is a picker offering too much, the other
     is a gap only HR can close. Both name what to do about it. NFR USA 03. */
  it('names the years that are available when one that is not was asked for', () => {
    const refusal = new NotOneOfTheirLeaveYears('7', YEAR_2025, [YEAR_2026, YEAR_2027]);

    expect(refusal.leaveYearId).toBe(YEAR_2025.id);
    expect(refusal.message).toMatch(/2025 is not a leave year/);
    expect(refusal.message).toMatch(/2026, 2027/);
  });

  it('and says so plainly when there are none at all', () => {
    expect(new NotOneOfTheirLeaveYears('7', YEAR_2025, []).message).toMatch(
      /no leave years to show/,
    );
  });

  it('and asks for a leave year to be defined where none covers anybody', () => {
    const refusal = new NoLeaveYearToShow('7');

    expect(refusal.employeeId).toBe('7');
    expect(refusal.message).toMatch(/HR Administrator/);
  });
});

/* ------------------------------------------------------------------------ fixtures */

/**
 * A leave type built through its own validator, so a fixture cannot describe a type the
 * system would refuse. The same technique ../unit/leave-request.test.ts uses.
 */
function leaveType(input: Parameters<typeof validateNewLeaveType>[0]): LeaveType {
  const validated = validateNewLeaveType(input);

  return {
    ...validated,
    id: `type-${validated.code}`,
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function year(label: string, startDate: string, endDate: string): LeaveYear {
  return {
    id: `year-${label}`,
    label,
    startDate,
    endDate,
    isClosed: false,
    closedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/** A balance something has moved. `updatedAt` is what makes it one. */
function balance(
  type: LeaveType,
  leaveYear: LeaveYear,
  figures: Partial<LeaveBalance>,
): LeaveBalance {
  return {
    ...empty(type, leaveYear),
    updatedAt: new Date('2026-03-01T09:00:00Z'),
    ...figures,
  };
}

/** A balance nothing has moved, which is what a type with no row comes back as. */
function empty(type: LeaveType, leaveYear: LeaveYear = YEAR_2026): LeaveBalance {
  return noMovementsYet({
    employeeId: '1',
    leaveTypeId: type.id,
    leaveYearId: leaveYear.id,
  });
}

function codesOf(lines: readonly BalanceStatementLine[]): string[] {
  return lines.map((line) => line.code);
}

function labelsOf(years: readonly LeaveYear[]): string[] {
  return years.map((one) => one.label);
}

function lineOf(lines: readonly BalanceStatementLine[], code: string): BalanceStatementLine {
  const line = lines.find((one) => one.code === code);

  if (line === undefined) {
    throw new Error(`No line for ${code}. The statement had ${codesOf(lines).join(', ')}.`);
  }

  return line;
}
