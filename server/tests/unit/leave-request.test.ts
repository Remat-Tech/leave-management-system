import { describe, expect, it } from 'vitest';
import type { DayCount } from '../../src/domain/leave-calculator.js';
import {
  assertItCostsSomething,
  countingBasisInWords,
  InvalidLeaveRequest,
  LeaveCountsNoDays,
  LeaveCrossesAYearEnd,
  noticeGiven,
  quoteFor,
  reachesPastTheEndOf,
  reasonForReservation,
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

/* ------------------------------------------------------------ the boundary */

describe('where this story stops', () => {
  /**
   * One status, and its shortness is the boundary rather than an omission.
   *
   * A list of six with five unreachable would be a promise the schema cannot keep, so
   * `leave_request_status_known` holds exactly this one and the approval story extends
   * it in a migration of its own — as LMS 218 extended the ledger's entry types to
   * admit LAPSE. This test is what fails if somebody adds a status here without the
   * migration that lets the database hold it.
   */
  it('has one status, because nothing yet moves a request', () => {
    expect([...REQUEST_STATUSES]).toEqual(['SUBMITTED']);
  });
});
