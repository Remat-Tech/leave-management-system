import { describe, expect, it } from 'vitest';
import type { DayCount } from '../../src/domain/leave-calculator.js';
import {
  countingBasisInWords,
  InvalidLeaveRequest,
  LeaveCrossesAYearEnd,
  noticeGiven,
  quoteFor,
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

  /* And leave over a year end is refused with both years named, rather than split.
     `may_be_split` and `assertMayBeSplit()` are what a story offering the split uses. */
  it('and refuses a period crossing a year end in words somebody can act on', () => {
    const refusal = new LeaveCrossesAYearEnd(
      { from: '2026-12-28', to: '2027-01-05' },
      '2026',
      '2026-12-31',
    );

    expect(refusal.message).toContain('2026-12-31');
    expect(refusal.message).toMatch(/two requests/);
  });
});
