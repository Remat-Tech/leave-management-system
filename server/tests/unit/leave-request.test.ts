import { describe, expect, it } from 'vitest';
import type { DayCount } from '../../src/domain/leave-calculator.js';
import {
  assertItCostsSomething,
  assertMayBeSettled,
  assertTheDaysAreThere,
  blocksTheCalendar,
  countingBasisInWords,
  InvalidLeaveRequest,
  LeaveAlreadySettled,
  type LeaveRequest,
  LeaveCountsNoDays,
  LeaveCrossesAYearEnd,
  LeaveOverlapsAnother,
  LIVE_STATUSES,
  NotEnoughDays,
  noticeGiven,
  periodsOverlap,
  QUOTE_WARNINGS,
  quoteFor,
  reachesPastTheEndOf,
  reasonForRelease,
  reasonForReservation,
  RELEASING_STATUSES,
  REQUEST_STATUSES,
  validateLeaveRequestChanges,
  validateNewLeaveRequest,
} from '../../src/domain/leave-request.js';
import {
  COUNTING_BASES,
  type LeaveType,
  validateNewLeaveType,
} from '../../src/domain/leave-type.js';
import type { LeaveYear } from '../../src/domain/leave-year.js';
import { eachDay } from '../../src/domain/time.js';

/**
 * Asking for leave, and being told what it costs first. FR 10, FR 11. LMS 301.
 *
 * The story's first two criteria are pure functions and are proved here: the four
 * fields a request is made of, and the quote a person is shown before they commit to a
 * fortnight. The third — the counting basis copied onto the row so that later
 * configuration cannot rewrite history — is a column and a trigger, so it is
 * ../integration/leave-request.test.ts's, and the half of it that lives in the type
 * system is that `countingBasis` is on `ValidatedLeaveRequest` and absent from
 * `LeaveRequestChanges`.
 *
 * **Not one test below names a leave type by its code.** The basis a request is priced
 * under arrives as data — `WORKING_DAYS` or `CALENDAR_DAYS` off the row — and the
 * sentence a person reads about it is a function of that and nothing else. A
 * `code === 'ANNUAL'` anywhere above the database is the bug design principle 5 exists
 * to prevent, and a file about what to *show* somebody is where it would have been
 * most tempting to write one.
 */

/** A stored leave type, with the fields a test is not about held still. */
function leaveType(
  overrides: Partial<Parameters<typeof validateNewLeaveType>[0]> & { code: string; name: string },
): LeaveType {
  return {
    id: overrides.code,
    ...validateNewLeaveType({
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      ...overrides,
    }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

const ANNUAL = leaveType({ code: 'ANNUAL_TEST', name: 'Annual Leave', minNoticeCalendarDays: 14 });

const PERIOD = { from: '2026-03-02', to: '2026-03-10' };

/** Nine days spanned, seven counted: a weekend in the middle cost nothing. */
const SEVEN_OF_NINE: DayCount = {
  days: 7,
  calendarDays: 9,
  free: [
    { date: '2026-03-07', because: 'NOT_A_WORKING_DAY', name: null },
    { date: '2026-03-08', because: 'NOT_A_WORKING_DAY', name: null },
  ],
};

/** A stored leave year, with the fields no test here is about held still. */
function leaveYear(label: string, startDate: string, endDate: string): LeaveYear {
  return {
    id: `year-${label}`,
    label,
    startDate,
    endDate,
    isClosed: false,
    closedAt: null,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** The two years the database ships with. §5.4. */
const Y2026 = leaveYear('2026', '2026-01-01', '2026-12-31');
const Y2027 = leaveYear('2027', '2027-01-01', '2027-12-31');

/** Leave already on the books: the second to the tenth of March, six days of nine. */
const BOOKED = { from: '2026-03-02', to: '2026-03-10' };

/** And a period somebody is asking for on top of it. */
const WANTED = { from: '2026-03-05', to: '2026-03-12' };

/** A request as it comes back out of the table, with the fields no test is about held
    still. */
function aStoredRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'employee-1',
    leaveTypeId: ANNUAL.id,
    leaveYearId: Y2026.id,
    from: BOOKED.from,
    to: BOOKED.to,
    reason: 'My sister is getting married',
    countingBasis: 'WORKING_DAYS',
    days: 6,
    calendarDays: 9,
    status: 'SUBMITTED',
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

function aQuote(overrides: Partial<Parameters<typeof quoteFor>[0]> = {}) {
  return quoteFor({
    type: ANNUAL,
    period: PERIOD,
    count: SEVEN_OF_NINE,
    availableNow: 20,
    daysOfNotice: 30,
    ...overrides,
  });
}

/* ------------------------------------------------------ what the person is shown */

describe('the quote, before anything is written', () => {
  it('says what it costs and what it spans, which are two different numbers', () => {
    const quote = aQuote();

    expect(quote.days).toBe(7);
    expect(quote.calendarDays).toBe(9);
  });

  /* The story's second criterion. A number on its own is an assertion; the free days
     are what make it an explanation somebody accepts. NFR USA 03. */
  it('and names the days inside the period that cost nothing', () => {
    expect(aQuote().free).toEqual(SEVEN_OF_NINE.free);
  });

  it('and says which basis it was counted under, in a sentence and as the value', () => {
    const quote = aQuote();

    expect(quote.countingBasis).toBe('WORKING_DAYS');
    expect(quote.countingBasisInWords).toMatch(/working days/);
  });

  it('and what the balance holds now, and what it would hold afterwards', () => {
    const quote = aQuote({ availableNow: 20 });

    expect(quote.availableNow).toBe(20);
    expect(quote.availableAfter).toBe(13);
  });

  it('and who would decide it', () => {
    expect(aQuote().approvedBy).toMatch(/manager/i);
  });

  it('and has nothing to warn about when there is nothing to warn about', () => {
    expect(aQuote().warnings).toEqual([]);
  });
});

describe('the basis, said to a person rather than to a database', () => {
  it.each(COUNTING_BASES)('%s reads as a sentence rather than as the value', (basis) => {
    const said = countingBasisInWords(basis);

    expect(said).not.toContain('_');
    expect(said.length).toBeGreaterThan(20);
  });

  /* The two have to say different things, because the whole reason a person is shown
     the basis is to know whether the weekend inside their fortnight is being charged
     for. Two sentences that differed only in wording would answer nothing. */
  it('and the two bases say opposite things about a weekend', () => {
    expect(countingBasisInWords('WORKING_DAYS')).toMatch(/cost nothing/);
    expect(countingBasisInWords('CALENDAR_DAYS')).toMatch(/every day/);
  });
});

/* ------------------------------------------------------------------- warnings */

describe('what is worth saying without refusing', () => {
  /* FR 17 is a warning by design. Leave is sometimes needed at short notice, and a
     system that refused it would be a system people worked around. */
  it('says how short the notice is, and that it can still be submitted', () => {
    const quote = aQuote({ daysOfNotice: 4 });
    const short = quote.warnings.find((warning) => warning.code === 'SHORT_NOTICE');

    expect(short?.message).toContain('14');
    expect(short?.message).toContain('4');
    expect(short?.message).toMatch(/still be submitted/);
  });

  it('and says nothing about notice when there is enough of it', () => {
    expect(aQuote({ daysOfNotice: 14 }).warnings).toEqual([]);
    expect(aQuote({ daysOfNotice: 15 }).warnings).toEqual([]);
  });

  /* FR 13, judged on the length of the request rather than on the type alone — a
     threshold type warns for a fortnight and says nothing for a day. */
  it('says when this length of this type needs something attached', () => {
    const sick = leaveType({
      code: 'SICK_TEST',
      name: 'Sick Leave',
      documentation: 'AFTER_DAYS',
      documentationAfterDays: 3,
    });

    const long = quoteFor({
      type: sick,
      period: PERIOD,
      count: SEVEN_OF_NINE,
      availableNow: 20,
      daysOfNotice: 30,
    });
    const short = quoteFor({
      type: sick,
      period: PERIOD,
      count: { days: 2, calendarDays: 2, free: [] },
      availableNow: 20,
      daysOfNotice: 30,
    });

    expect(long.warnings.map((warning) => warning.code)).toContain('DOCUMENTATION_REQUIRED');
    expect(short.warnings.map((warning) => warning.code)).not.toContain('DOCUMENTATION_REQUIRED');
  });

  /**
   * And when the days are not there, which is the one warning that is usually a
   * refusal.
   *
   * Two sentences rather than one, and the difference is `exceedableWithDocument`. FR
   * 32a makes sick leave a documentation threshold rather than a cap, so telling
   * somebody they cannot ask would be wrong for that type and right for annual leave.
   * The quote reads the column, exactly as the balance does inside its lock.
   */
  it('says the days are short, and whether that stops the request', () => {
    const annual = aQuote({ availableNow: 3 });
    const sick = quoteFor({
      type: leaveType({
        code: 'SICK_TEST',
        name: 'Sick Leave',
        exceedableWithDocument: true,
      }),
      period: PERIOD,
      count: SEVEN_OF_NINE,
      availableNow: 3,
      daysOfNotice: 30,
    });

    expect(annual.warnings.map((warning) => warning.code)).toContain('NOT_ENOUGH_DAYS');
    expect(annual.warnings.find((w) => w.code === 'NOT_ENOUGH_DAYS')?.message).toMatch(
      /cannot be submitted/,
    );

    expect(sick.warnings.find((w) => w.code === 'NOT_ENOUGH_DAYS')?.message).toMatch(
      /can still be submitted/,
    );
  });

  /* §8.6b. A balance that may be exceeded goes below nought on purpose, and the quote
     says so rather than clamping — somebody about to go three days over is owed the
     figure they are about to be at. */
  it('and shows the figure the balance would actually be at, below nought included', () => {
    expect(aQuote({ availableNow: 3 }).availableAfter).toBe(-4);
  });

  it('and can say more than one thing at once', () => {
    const quote = aQuote({ availableNow: 3, daysOfNotice: 1 });

    expect(quote.warnings.map((warning) => warning.code).sort()).toEqual([
      'NOT_ENOUGH_DAYS',
      'SHORT_NOTICE',
    ]);
  });
});

/* -------------------------------------------------------------------- notice */

describe('how much notice a request gives', () => {
  it('is the days between asking and the first day off', () => {
    expect(noticeGiven('2026-03-02', '2026-03-09')).toBe(7);
    expect(noticeGiven('2026-03-02', '2026-03-03')).toBe(1);
  });

  it('and is nothing at all for leave starting today', () => {
    expect(noticeGiven('2026-03-02', '2026-03-02')).toBe(0);
  });

  /* FR 18. HR entering an absence after the fact is ordinary work, and the figure is
     carried with its magnitude because "three weeks late" and "a day late" are not the
     same conversation. */
  it('and goes negative, by the right amount, for leave that has already begun', () => {
    expect(noticeGiven('2026-03-02', '2026-03-01')).toBe(-1);
    expect(noticeGiven('2026-03-22', '2026-03-01')).toBe(-21);
  });

  /* Counted in calendar days, never working ones. A manager's warning does not get
     shorter because the person asking does not work Wednesdays. */
  it('and counts every day, whoever is asking', () => {
    expect(noticeGiven('2026-03-06', '2026-03-09')).toBe(3);
  });
});

/* ------------------------------------------------------------- what is stored */

describe('what a request has to say', () => {
  const SOUND = {
    employeeId: '1',
    leaveTypeId: '2',
    leaveYearId: '3',
    from: '2026-03-02',
    to: '2026-03-10',
    reason: 'My sister is getting married',
    countingBasis: 'WORKING_DAYS' as const,
    days: 7,
    calendarDays: 9,
  };

  function refusedField(build: () => unknown): string {
    try {
      build();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLeaveRequest);
      return (error as InvalidLeaveRequest).field;
    }

    throw new Error('That was accepted, and should not have been.');
  }

  it('carries the four fields FR 10 asks for, and what they were priced at', () => {
    expect(validateNewLeaveRequest(SOUND)).toEqual({
      ...SOUND,
      status: 'SUBMITTED',
    });
  });

  /* The story's third criterion in the type system: the basis is on the stored shape,
     so a request carries the rule it was priced under rather than looking it up. */
  it('and the basis it was counted under is one of the stored fields', () => {
    expect(
      validateNewLeaveRequest({ ...SOUND, countingBasis: 'CALENDAR_DAYS' }).countingBasis,
    ).toBe('CALENDAR_DAYS');
  });

  /**
   * And the status is not a field a caller supplies.
   *
   * The README's rule is that only the state machine moves a request. That starts here:
   * a caller who could name the status could submit something already approved, which
   * is the one shape of this call that would skip every check the approval story is
   * going to add.
   */
  it('and is always submitted, whatever a caller passes', () => {
    const sneaky = { ...SOUND, status: 'APPROVED' } as unknown as typeof SOUND;

    expect(validateNewLeaveRequest(sneaky).status).toBe('SUBMITTED');
  });

  it.each(['employeeId', 'leaveTypeId', 'leaveYearId'] as const)('needs a %s', (field) => {
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, [field]: '' }))).toBe(field);
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, [field]: '   ' }))).toBe(field);
  });

  it.each(['from', 'to'] as const)('needs %s as a date in one unambiguous form', (field) => {
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, [field]: '02/03/2026' }))).toBe(
      field,
    );
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, [field]: '2026-02-30' }))).toBe(
      field,
    );
  });

  /* FR 10, and the argument is who reads it: a manager looking at five days in March
     with nothing against them is being asked to agree to something blind. */
  it('needs a reason, and trims it rather than storing the spaces', () => {
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, reason: '' }))).toBe('reason');
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, reason: '   ' }))).toBe('reason');
    expect(validateNewLeaveRequest({ ...SOUND, reason: '  a wedding  ' }).reason).toBe('a wedding');
  });

  /* FR 24. Leave is requested in whole days; the ledger's fractions are entitlement,
     which is a different thing held in a different column. */
  it.each([2.5, 0, -3])('refuses %s days, because leave is asked for in whole days', (days) => {
    expect(refusedField(() => validateNewLeaveRequest({ ...SOUND, days }))).toBe('days');
  });

  /**
   * And the check on `days` has a floor and no ceiling. FR 20a, LMS 309.
   *
   * The rule is "at least one", and the absence of a second half to that sentence is
   * the requirement. `requireWholeDays` is where a maximum would go if the system had
   * one — it is the one function that judges the figure a request costs — so this is
   * where the absence is worth asserting rather than assumed.
   *
   * A whole year of working days is well past anything a balance would cover, and that
   * is the point: what stops a long request is the *balance*, which is the company's
   * own entitlement figure and therefore a limit the company set. Nothing about the
   * number of days is refused for being large.
   */
  it.each([20, 120, 260, 366])('and accepts %s days, because FR 20a sets no maximum', (days) => {
    expect(validateNewLeaveRequest({ ...SOUND, days, calendarDays: days }).days).toBe(days);
  });
});

describe('what may be changed afterwards', () => {
  it('is the reason, and only the reason', () => {
    expect(validateLeaveRequestChanges({ reason: '  a wedding  ' })).toEqual({
      reason: 'a wedding',
    });
  });

  it('and a change that names nothing is refused rather than doing nothing', () => {
    expect(() => validateLeaveRequestChanges({})).toThrow(InvalidLeaveRequest);
    expect(() => validateLeaveRequestChanges({})).toThrow(/cannot be edited/);
  });

  it('and a reason cannot be blanked by a path the create would have refused', () => {
    expect(() => validateLeaveRequestChanges({ reason: '   ' })).toThrow(InvalidLeaveRequest);
  });
});

/* -------------------------------------------------------- the words in a balance */

describe('what the reservation says it is for', () => {
  it('names the kind of leave, how much, and when', () => {
    const said = reasonForReservation('Annual Leave', PERIOD, 7);

    expect(said).toContain('Annual Leave');
    expect(said).toContain('7 days');
    expect(said).toContain('2026-03-02');
    expect(said).toContain('2026-03-10');
  });

  it('and counts one day as a day', () => {
    expect(
      reasonForReservation('Annual Leave', { from: '2026-03-02', to: '2026-03-02' }, 1),
    ).toContain('1 day of');
  });

  /* No identifiers. The join is `leave_ledger_entry.leave_request_id`; a reason full
     of ids is a reason nobody reads. */
  it('and carries no id for somebody to look up', () => {
    expect(reasonForReservation('Annual Leave', PERIOD, 7)).not.toMatch(/\bid\b/i);
  });
});

/* --------------------------------------------- dates that are obviously wrong */

/**
 * FR 16, FR 16a, §8.3. LMS 303.
 *
 * The story is somebody finding out while the form is still open rather than after two
 * days in an approver's queue, so every refusal below is a pure function of what was
 * typed and can be reached before a single row is read past the leave year.
 *
 * The third of them — a period the wrong way round — is `validateLeavePeriod` and is
 * proved in ./leave-calculator.test.ts, because it is about the {@link LeavePeriod} type
 * rather than about a request. What is asserted here is that the other two are refusals
 * *about a request*, made from answers the calculator handed over rather than by the
 * calculator itself.
 */
describe('a period that costs nothing cannot be asked for', () => {
  /** Two days off, both of them free: the weekend somebody booked by mistake. */
  const WEEKEND = { from: '2026-03-07', to: '2026-03-08' };
  const NOTHING: DayCount = {
    days: 0,
    calendarDays: 2,
    free: [
      { date: '2026-03-07', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-03-08', because: 'NOT_A_WORKING_DAY', name: null },
    ],
  };

  it('is refused on the count, rather than by the counting', () => {
    expect(() => assertItCostsSomething(ANNUAL, WEEKEND, NOTHING)).toThrow(LeaveCountsNoDays);
  });

  /* One day is enough, and the boundary is worth pinning: a request for a single
     Friday off is the most common one there is. */
  it('and a single day that costs a day is not refused', () => {
    expect(() =>
      assertItCostsSomething(
        ANNUAL,
        { from: '2026-03-06', to: '2026-03-06' },
        {
          days: 1,
          calendarDays: 1,
          free: [],
        },
      ),
    ).not.toThrow();
  });

  /**
   * The message names the days rather than only the verdict, because the person looking
   * at it has typed two dates they believe in. It also names the way out: somebody who
   * really did mean to record the whole period has chosen the wrong kind of leave rather
   * than the wrong dates, and a type counting calendar days is the answer.
   */
  it('and says which days were free, and what to do instead', () => {
    const refusal = refusalFrom(() => assertItCostsSomething(ANNUAL, WEEKEND, NOTHING));

    expect(refusal.message).toContain('Annual Leave');
    expect(refusal.message).toContain('2026-03-07');
    expect(refusal.message).toContain('counts every day');
  });

  /* It carries the days it refused on and the type that refused, so a screen can offer
     the alternative rather than only describing it. The free days are the calculator's
     own — nothing recounts them for the message. */
  it('and carries the type and the free days it was given', () => {
    const refusal = refusalFrom(() => assertItCostsSomething(ANNUAL, WEEKEND, NOTHING));

    expect(refusal.leaveTypeId).toBe(ANNUAL.id);
    expect(refusal.period).toEqual(WEEKEND);
    expect(refusal.free).toEqual(NOTHING.free);
  });

  /* And a long run of nothing is summarised rather than listed, because a refusal
     naming sixty days is a refusal nobody reads to the end of. */
  it('and summarises a long run of free days rather than listing them', () => {
    const week = { from: '2026-03-02', to: '2026-03-06' };
    const refusal = refusalFrom(() =>
      assertItCostsSomething(ANNUAL, week, {
        days: 0,
        calendarDays: 5,
        free: [...eachDay(week.from, week.to)].map((date) => ({
          date,
          because: 'NOT_A_WORKING_DAY' as const,
          name: null,
        })),
      }),
    );

    expect(refusal.message).toContain('and 1 more');
  });

  function refusalFrom(build: () => void): LeaveCountsNoDays {
    try {
      build();
    } catch (error) {
      expect(error).toBeInstanceOf(LeaveCountsNoDays);
      return error as LeaveCountsNoDays;
    }

    throw new Error('That was accepted, and should not have been.');
  }
});

describe('a period that crosses a leave year end', () => {
  /** The twenty-eighth of December into the fifth of January: two balances. */
  const OVER_THE_YEAR_END = { from: '2026-12-28', to: '2027-01-05' };

  /* A request is one period against one balance and a balance belongs to one leave
     year, so reserving all ten days against either would be a figure that reconciles
     and is wrong. `may_be_split` and `assertMayBeSplit()` are what a story offering the
     split uses; this one refuses. */
  it('is spotted by comparing the last day against the year it started in', () => {
    expect(reachesPastTheEndOf(Y2026, OVER_THE_YEAR_END)).toBe(true);
  });

  /* And the last day of the year is inside it, which is the boundary the whole refusal
     turns on: a request ending on the thirty-first of December is a legitimate one. */
  it('and a period ending on the last day of the year does not', () => {
    expect(reachesPastTheEndOf(Y2026, { from: '2026-12-28', to: '2026-12-31' })).toBe(false);
  });

  /**
   * The message, verbatim. FR 16.
   *
   * Asserted whole rather than in fragments, because the second sentence is the point of
   * the refusal: a person at a form told only "no" is left doing date arithmetic to
   * discover what they may type, and they will get it wrong at exactly the boundary that
   * produced the refusal. The two dates are what they retype, so both are in the
   * sentence and both are said the way a person says a date — a month spelled out,
   * because `01/01/2027` and `01/12/2026` are the ambiguity this system refuses
   * everywhere else.
   */
  it('and says so in two sentences, the second of which is what to do', () => {
    expect(new LeaveCrossesAYearEnd(OVER_THE_YEAR_END, Y2026, Y2027).message).toBe(
      'This request crosses into the 2027 leave year. Submit one request ending ' +
        '31 December 2026, and another starting 1 January 2027.',
    );
  });

  /* The story asks for the code by name. A message is reworded the first time somebody
     reads it aloud; a code is what a form branches on to offer the split as two
     prefilled requests. */
  it('and carries the error code a client branches on', () => {
    expect(new LeaveCrossesAYearEnd(OVER_THE_YEAR_END, Y2026, Y2027).code).toBe('CROSS_LEAVE_YEAR');
  });

  /**
   * **Every year and every date in that sentence is read off the record.**
   *
   * §5.4 is explicit that a leave year need not be a calendar year, so a company running
   * April to March gets its own boundary and its own labels — '2027/28' rather than
   * '2027', the thirty-first of March rather than the thirty-first of December. A
   * message with a December in it would be right for the seeded database and wrong for
   * the first company that configures its own year, and nothing would say so.
   */
  it('and names the years and the dates the record gives, not the ones we ship with', () => {
    const thisYear = leaveYear('2026/27', '2026-04-01', '2027-03-31');
    const nextYear = leaveYear('2027/28', '2027-04-01', '2028-03-31');

    expect(
      new LeaveCrossesAYearEnd({ from: '2027-03-30', to: '2027-04-02' }, thisYear, nextYear)
        .message,
    ).toBe(
      'This request crosses into the 2027/28 leave year. Submit one request ending ' +
        '31 March 2027, and another starting 1 April 2027.',
    );
  });

  /**
   * And the year being crossed into may not exist yet, which is legitimate.
   *
   * A gap *after* the last leave year is not a gap — it is next year's decision, and
   * `assertFitsAmong` says so. The label then falls back to the year part of the day to
   * resume on, which is still read off the record rather than written down: the sentence
   * stays true and the two dates in it, which are the half somebody acts on, stay right.
   */
  it('and still says what to do when nobody has defined the year after', () => {
    expect(new LeaveCrossesAYearEnd(OVER_THE_YEAR_END, Y2026, undefined).message).toBe(
      'This request crosses into the 2027 leave year. Submit one request ending ' +
        '31 December 2026, and another starting 1 January 2027.',
    );
  });

  /* The two dates are on the object as well as in the sentence, so a form can prefill
     the pair rather than parse a message to find them. */
  it('and carries the two days on the refusal itself', () => {
    const refusal = new LeaveCrossesAYearEnd(OVER_THE_YEAR_END, Y2026, Y2027);

    expect(refusal.endsOn).toBe('2026-12-31');
    expect(refusal.resumesOn).toBe('2027-01-01');
    expect(refusal.leaveYearId).toBe(Y2026.id);
    expect(refusal.period).toEqual(OVER_THE_YEAR_END);
  });
});

/* ------------------------------------------- leave over leave already booked */

/**
 * FR 15, §5.6. LMS 304.
 *
 * The defect is a balance consumed twice for the same days, and what makes it worth a
 * story of its own is that nothing about it looks wrong while it happens: two
 * reservations, both reconciling, both explainable, and a figure that is still
 * incorrect. Design principle 1 cannot catch it, because the record is faithful — the
 * request was one nobody should have been allowed to make.
 *
 * The rule is here as a predicate and a list. The *reading* — which rows exist, and
 * which one is in the way — is the service's, and ../integration/leave-request.test.ts
 * is where that meets a real table and the exclusion constraint behind it.
 */
describe('two periods sharing a day', () => {
  /* Inclusive at both ends on both sides, which is the whole rule. The pair that
     matters most is the one that touches: leave to the tenth and leave from the tenth
     share the tenth, and a comparison that missed it would book one day twice — which
     is the defect itself, arriving through the off-by-one nobody tests. */
  it.each([
    ['the same days twice', { from: '2026-03-02', to: '2026-03-10' }, true],
    ['a period wholly inside another', { from: '2026-03-04', to: '2026-03-05' }, true],
    ['a period wholly containing another', { from: '2026-02-01', to: '2026-04-01' }, true],
    ['a period sharing only the first day', { from: '2026-02-20', to: '2026-03-02' }, true],
    ['a period sharing only the last day', { from: '2026-03-10', to: '2026-03-20' }, true],
    ['a period ending the day before', { from: '2026-02-20', to: '2026-03-01' }, false],
    ['a period starting the day after', { from: '2026-03-11', to: '2026-03-20' }, false],
    ['a period in another month', { from: '2026-06-01', to: '2026-06-05' }, false],
  ])('%s', (_name, other, expected) => {
    expect(periodsOverlap(BOOKED, other)).toBe(expected);
    /* And symmetrically, because neither period is the one being asked for as far as
       this function is concerned, and a rule that held in one direction only would
       depend on which row a query happened to return first. */
    expect(periodsOverlap(other, BOOKED)).toBe(expected);
  });
});

describe('which requests hold the days', () => {
  /**
   * The list is deliberately not "every status there is", and today those are the same
   * list — which is exactly why it is worth a test.
   *
   * `REQUEST_STATUSES` has one value and it is the pending one, so the two agree today
   * and will stop agreeing the moment the approval story lands: APPROVED joins this
   * list, and WITHDRAWN, CANCELLED and REFUSED do not. This asserts the shape of the
   * decision rather than its current answer, so a status added to one list without a
   * thought about the other is a failing test rather than a fortnight in March blocked
   * by leave that was refused in January.
   */
  it('is a list of its own, not a reading of every status', () => {
    expect([...LIVE_STATUSES]).toEqual(['SUBMITTED']);

    for (const status of LIVE_STATUSES) {
      expect(REQUEST_STATUSES).toContain(status);
    }
  });

  it('and a submitted request holds them, because it is waiting to be decided', () => {
    expect(blocksTheCalendar('SUBMITTED')).toBe(true);
  });

  /**
   * And none of LMS 306's three endings holds them, which is what the list was for.
   *
   * Until they existed this list and `REQUEST_STATUSES` held the same single value and
   * every query filtering by it filtered nothing. Three statuses arrived, none joined
   * this list, and the queries written against it started excluding rows without a line
   * of them changing — which is the whole of "days that came back are days somebody may
   * book again".
   */
  it('and none of the three endings does, because their days came back', () => {
    for (const status of RELEASING_STATUSES) {
      expect(blocksTheCalendar(status)).toBe(false);
      expect(LIVE_STATUSES).not.toContain(status);
    }
  });

  /* And every one of them is a status the schema can actually hold. */
  it('and every ending is a status in its own right', () => {
    for (const status of RELEASING_STATUSES) {
      expect(REQUEST_STATUSES).toContain(status);
    }
  });
});

/* --------------------------------------------------- the three endings, LMS 306 */

/**
 * A request ends once, and gives its days back when it does. FR 26, §8.2. LMS 306.
 *
 * The domain's whole share of the story: which statuses end a request, whether one may
 * be ended, and what the movement says it was for. The movement itself is
 * `BalanceService.releaseForRequest` and the desks are in the policy, so what is provable
 * without a database is exactly this.
 */
describe('ending a request', () => {
  it('is allowed while it is still waiting to be decided', () => {
    expect(() => assertMayBeSettled(aStoredRequest({ status: 'SUBMITTED' }))).not.toThrow();
  });

  /**
   * And refused once it has ended, whichever of the three ended it.
   *
   * The rule that makes "my days cannot be given back twice" true rather than hoped for.
   * The balance cannot be the guard here: `pending` is per employee, leave type and leave
   * year, so where the person has other leave waiting there would be days for a second
   * release to take and the ledger would accept it — crediting them for a fortnight
   * nobody was holding, with every entry reconciling.
   */
  it.each([...RELEASING_STATUSES])('and refused once it is already %s', (status) => {
    expect(() => assertMayBeSettled(aStoredRequest({ status }))).toThrow(LeaveAlreadySettled);
  });

  it('and the refusal says which ending it already had, in words', () => {
    const refusal = refusalFor('WITHDRAWN');

    expect(refusal.message).toContain('already withdrawn');
    expect(refusal.message).toMatch(/ask for them again/i);
    expect(refusal.status).toBe('WITHDRAWN');
    expect(refusal.leaveRequestId).toBe('request-1');
  });

  /* Said the way a person says it, never as the stored value. The same rule
     `countingBasisInWords` follows, and one mapping rather than one per message. */
  it.each([
    ['WITHDRAWN', 'withdrawn'],
    ['CANCELLED', 'cancelled'],
    ['REFUSED', 'refused'],
  ] as const)('and %s reads as "%s" rather than as the value', (status, said) => {
    expect(refusalFor(status).message).toContain(`already ${said}`);
    expect(refusalFor(status).message).not.toContain(status);
  });

  it('and carries the code a client branches on', () => {
    expect(refusalFor('REFUSED').code).toBe('ALREADY_SETTLED');
  });

  /** The refusal, caught, for the tests that are about what it says. */
  function refusalFor(status: (typeof RELEASING_STATUSES)[number]): LeaveAlreadySettled {
    try {
      assertMayBeSettled(aStoredRequest({ status }));
    } catch (error) {
      return error as LeaveAlreadySettled;
    }

    throw new Error(`A ${status} request was not refused.`);
  }
});

describe('what the release says it is for', () => {
  /**
   * The other half of the reservation's sentence, and they read as a pair in a history.
   *
   * "6 days of Annual Leave requested … held while it is decided", then "6 days of Annual
   * Leave given back … the request was withdrawn". That pairing is what makes a balance
   * explain itself to the person reading it rather than merely reconcile.
   */
  it('says how much, of what, when, and which ending it was', () => {
    expect(reasonForRelease('Annual Leave', PERIOD, 6, 'WITHDRAWN')).toBe(
      '6 days of Annual Leave given back, 2026-03-02 to 2026-03-10, ' + 'the request was withdrawn',
    );
  });

  /**
   * And which of the three is in the sentence, because nothing else records it.
   *
   * Five days coming back look identical whether the person changed their mind, a
   * manager turned it down or HR unwound it — and those are three different
   * conversations. The status on the request says so too, but a balance history is read
   * on its own.
   */
  it.each([
    ['WITHDRAWN', 'withdrawn'],
    ['CANCELLED', 'cancelled'],
    ['REFUSED', 'refused'],
  ] as const)('and names %s as "%s"', (status, said) => {
    expect(reasonForRelease('Annual Leave', PERIOD, 6, status)).toContain(
      `the request was ${said}`,
    );
  });

  it('and counts a single day as a day', () => {
    expect(reasonForRelease('Sick Leave', PERIOD, 1, 'REFUSED')).toContain('1 day of Sick Leave');
  });

  /* The request id is deliberately not in it. `leave_ledger_entry.leave_request_id` is
     the join, and a reason full of identifiers is a reason nobody reads. */
  it('and does not carry an identifier anybody would have to look up', () => {
    expect(reasonForRelease('Annual Leave', PERIOD, 6, 'WITHDRAWN')).not.toMatch(/request-\d/);
  });
});

describe('the refusal, which names the leave already in the way', () => {
  /**
   * "You cannot book those days" tells somebody nothing they can act on.
   *
   * They are looking at a form they believe in and the clash is with a row they cannot
   * see, so the sentence carries the other request's dates, what it cost and what kind
   * it is — which between them identify it on any leave page. NFR USA 03, and the same
   * argument `LeaveCrossesAYearEnd` makes about naming the two dates to resubmit on.
   */
  it('says which leave, when, how long and of what kind', () => {
    expect(
      new LeaveOverlapsAnother(WANTED, { request: aStoredRequest(), typeName: 'Annual Leave' })
        .message,
    ).toBe(
      'You already have leave from 2 March 2026 to 10 March 2026 — 6 days of Annual ' +
        'Leave. The same days cannot be booked twice, or they come off your balance ' +
        'twice. Withdraw that request, or ask for dates outside it.',
    );
  });

  /* The kind is named because it is very often not the kind being asked for — sick
     leave inside a booked fortnight is the case FR 32b is about — and "you already have
     leave" over a row the person thinks of as something else is a refusal they will
     read twice and then dispute. */
  it('and names the kind it actually was, not the kind being asked for', () => {
    const refusal = new LeaveOverlapsAnother(WANTED, {
      request: aStoredRequest({ days: 1, from: '2026-03-05', to: '2026-03-05' }),
      typeName: 'Sick Leave',
    });

    expect(refusal.message).toContain('1 day of Sick Leave');
    expect(refusal.message).toContain('5 March 2026');
  });

  it('and carries the conflicting request, so a screen can link to it', () => {
    const conflict = aStoredRequest();
    const refusal = new LeaveOverlapsAnother(WANTED, {
      request: conflict,
      typeName: 'Annual Leave',
    });

    expect(refusal.conflict?.request).toBe(conflict);
    expect(refusal.period).toEqual(WANTED);
  });

  it('and the error code a client branches on', () => {
    expect(new LeaveOverlapsAnother(WANTED).code).toBe('OVERLAPPING_REQUEST');
  });

  /**
   * And the one case where it cannot name anything.
   *
   * Two submissions of the same fortnight racing each other: both service checks read a
   * table with no conflict in it, both pass, and `leave_request_never_overlaps` refuses
   * the second as it writes. By then the transaction is aborted and cannot be asked
   * which row it collided with. The same class and the same code either way — a caller
   * should not have to handle two shapes of "those days clash" — and a second sentence
   * that says to go and look rather than pretending to have looked.
   */
  it('but still says what happened when the database refused it instead', () => {
    const refusal = new LeaveOverlapsAnother(WANTED);

    expect(refusal.conflict).toBeUndefined();
    expect(refusal.message).toContain('at the same moment');
    expect(refusal.message).toContain('reload');
  });
});

/* --------------------------------------------------- days that are not there */

/**
 * Told at once that the days are not there. FR 14, NFR USA 03. LMS 305.
 *
 * The rule is four lines and the sentence is the story, so most of what follows is about
 * the sentence. A person who is refused has to be able to act without going and looking
 * anything up — the whole point of "at once" is that the next thing they do is fix the
 * request, not open another screen — and that is a property of what the message says
 * rather than of the comparison that produced it.
 *
 * `daysToReserve` in ../../src/domain/balance.ts refuses the same thing inside the lock
 * and is the guarantee; ../integration/leave-request.test.ts is where the two are held
 * to the same answer, because only a real balance can show that.
 */
describe('a request the balance does not hold', () => {
  const SHORT = leaveType({ code: 'ANNUAL_SHORT', name: 'Annual Leave' });

  function refuse(availableNow: number): NotEnoughDays {
    try {
      assertTheDaysAreThere(SHORT, PERIOD, SEVEN_OF_NINE, availableNow);
    } catch (error) {
      return error as NotEnoughDays;
    }

    throw new Error(`${availableNow} days was not refused, and seven were asked for.`);
  }

  it('is refused when it costs more than is left', () => {
    expect(() => assertTheDaysAreThere(SHORT, PERIOD, SEVEN_OF_NINE, 6)).toThrow(NotEnoughDays);
  });

  /* Seven days against seven is the boundary, and it is spendable. A balance is what may
     be booked, so a request that empties it exactly is an ordinary request. */
  it('and is allowed when it costs exactly what is left', () => {
    expect(() => assertTheDaysAreThere(SHORT, PERIOD, SEVEN_OF_NINE, 7)).not.toThrow();
    expect(() => assertTheDaysAreThere(SHORT, PERIOD, SEVEN_OF_NINE, 8)).not.toThrow();
  });

  /**
   * FR 32a, §8.6b. A type that may be exceeded is not refused, and the flag is a column.
   *
   * Sick leave's allowance is the point at which a medical certificate is asked for
   * rather than a cap, so the balance going below nought is the design. Nothing here
   * compares a leave type's code to anything — design principle 5 — and this is the pair
   * that shows the column doing the work: same period, same count, same empty balance,
   * two answers.
   */
  it('and is not refused at all for a type that may go past its allowance', () => {
    const sick = leaveType({
      code: 'SICK_TEST',
      name: 'Sick Leave',
      exceedableWithDocument: true,
    });

    expect(() => assertTheDaysAreThere(sick, PERIOD, SEVEN_OF_NINE, 0)).not.toThrow();
    expect(() => assertTheDaysAreThere(SHORT, PERIOD, SEVEN_OF_NINE, 0)).toThrow(NotEnoughDays);
  });

  /* The story's second criterion, and the one it is named for. */
  it('and the message states the figure that is available', () => {
    expect(refuse(3).message).toBe(
      'This is 7 days of Annual Leave and you have 3 left — 4 days more than the balance ' +
        'holds. Ask for 3 days or fewer, or speak to HR if the balance itself looks wrong.',
    );
  });

  /**
   * And the second sentence is the useful one, exactly as `LeaveCrossesAYearEnd`'s is.
   *
   * A refusal that only says no leaves somebody at a form guessing, and the guess it
   * produces is "try six" followed by a second refusal. So the figure they may actually
   * ask for is in the sentence.
   */
  it('and says what could be asked for instead', () => {
    expect(refuse(3).couldAskFor).toBe(3);
    expect(refuse(3).message).toContain('Ask for 3 days or fewer');
  });

  /**
   * And what it offers is a whole number of days. FR 24.
   *
   * §8.6d pro rates a mid year joiner to a fraction, so a balance of 2.5 is ordinary.
   * Two days is what somebody may actually book against it, and telling them to ask for
   * 2.5 would be telling them to do the one thing `requireWholeDays` refuses.
   */
  it('and floors a fractional balance to the days that can actually be booked', () => {
    expect(refuse(2.5).couldAskFor).toBe(2);
    expect(refuse(2.5).message).toContain('Ask for 2 days or fewer');
  });

  /* And the shortfall is not a figure with a tail of decimal places on it. `7 - 2.52` in
     doubles is 4.48 and a little, which is not a number to show anybody. */
  it('and says how short it is, to the precision a balance is held to', () => {
    expect(refuse(2.52).shortBy).toBe(4.48);
    expect(refuse(2.52).message).toContain('4.48 days more');
  });

  /**
   * And where there is nothing at all, it stops offering.
   *
   * "Ask for 0 days or fewer" is an invitation to do something `requireWholeDays`
   * refuses, and a negative balance — legitimately left there by an exceedable type —
   * would produce worse. The sentence says what is true and stops.
   */
  it('and offers nothing where there is nothing to offer', () => {
    expect(refuse(0).message).toContain('nothing left to book against');
    expect(refuse(0).message).not.toContain('Ask for');
    expect(refuse(0).couldAskFor).toBe(0);

    expect(refuse(-2).couldAskFor).toBe(0);
    expect(refuse(-2).message).toContain('you have -2 left');
  });

  /* A day is a day and not "1 days", in both halves of the sentence. */
  it('and counts in words that agree with the number', () => {
    const oneDay: DayCount = { days: 1, calendarDays: 1, free: [] };

    expect(() => assertTheDaysAreThere(SHORT, PERIOD, oneDay, 0)).toThrow(
      /This is 1 day of Annual Leave/,
    );
    expect(refuse(6).message).toContain('1 day more than the balance holds');
  });

  it('and carries the arithmetic, so a screen need not parse the sentence', () => {
    const refusal = refuse(3);

    expect(refusal.requested).toBe(7);
    expect(refusal.available).toBe(3);
    expect(refusal.shortBy).toBe(4);
    expect(refusal.leaveTypeId).toBe(SHORT.id);
    expect(refusal.period).toEqual(PERIOD);
  });

  /**
   * And the code is the quote's warning code, deliberately.
   *
   * The warning and the refusal are one condition seen at two moments — before somebody
   * commits, where it is worth saying, and as they do, where it stops them. A form that
   * highlights the balance on the quote highlights it on the refusal with the same
   * branch, rather than drawing them as two unrelated problems.
   */
  it('and the error code a client branches on is the quote warning code', () => {
    expect(refuse(3).code).toBe('NOT_ENOUGH_DAYS');
    expect([...QUOTE_WARNINGS]).toContain(refuse(3).code);
  });

  /**
   * And the quote and the refusal open with the same clause.
   *
   * They are the same fact told twice and a person may well meet both, in that order.
   * Two descriptions of one figure is how somebody comes to believe they are two
   * problems; what differs is what follows, which is the half each exists for.
   */
  it('and opens with the clause the quote warns in', () => {
    const warning = quoteFor({
      type: SHORT,
      period: PERIOD,
      count: SEVEN_OF_NINE,
      availableNow: 3,
      daysOfNotice: 30,
    }).warnings.find((each) => each.code === 'NOT_ENOUGH_DAYS');

    const shared = 'This is 7 days of Annual Leave and you have 3 left';

    expect(warning?.message).toContain(shared);
    expect(refuse(3).message).toContain(shared);

    /* And then they diverge, because one may still be submitted and the other may not. */
    expect(warning?.message).toContain('cannot be submitted as it stands');
    expect(refuse(3).message).toContain('Ask for 3 days or fewer');
  });
});

/* ------------------------------------------------------------ the boundary */

describe('where this story stops', () => {
  /**
   * Four statuses, and the shortness of the list is still the boundary.
   *
   * A list of six with two unreachable would be a promise the schema cannot keep, so
   * `leave_request_status_known` holds exactly these four and the approval story extends
   * it in a migration of its own — as LMS 218 extended the ledger's entry types to admit
   * LAPSE, and as LMS 306 extended this one to admit the three endings. This test is what
   * fails if somebody adds a status here without the migration that lets the database
   * hold it.
   */
  it('has the four statuses something can actually reach', () => {
    expect([...REQUEST_STATUSES]).toEqual(['SUBMITTED', 'WITHDRAWN', 'CANCELLED', 'REFUSED']);
  });

  /**
   * And `APPROVED` is not one of them, which is the boundary this story stopped at.
   *
   * The three that arrived release days. Approval *commits* them — the hold becomes days
   * taken and available does not move — and which desk in FR 38a's chain may agree needs
   * the chain, the type and how far the request has got, none of which exists yet. The
   * story that brings it brings its own migration.
   *
   * Written as an assertion rather than a comment because the tempting thing, on the
   * afternoon somebody starts the approval story, is to add the status here and reach the
   * migration later.
   */
  it('and nothing here approves one, which is the next story’s', () => {
    expect(REQUEST_STATUSES).not.toContain('APPROVED');
  });
});
