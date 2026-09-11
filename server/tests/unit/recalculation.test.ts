import { describe, expect, it } from 'vitest';
import {
  type LeaveRequest,
  LeaveAlreadySettled,
  LeaveCannotBeMoved,
  recalculationTo,
  type RequestStatus,
} from '../../src/features/leave-request/leave-request.js';
import type { Holiday } from '../../src/features/holiday/holiday.js';
import {
  NOT_CREDITED_REASONS,
  notCreditedInWords,
  type Recalculation,
  reasonForRecalculation,
  recalculationInWords,
  whatAHolidayCredits,
} from '../../src/features/holiday/recalculation.js';
import { type LeaveType, validateNewLeaveType } from '../../src/features/leave-type/leave-type.js';
import type { WorkPattern } from '../../src/features/work-pattern/work-pattern.js';

/**
 * A public holiday declared inside leave somebody already had. FR 25, §8.8. LMS 508.
 *
 * Everything pure: how much a late-declared day is worth to one piece of agreed leave, and
 * the sentences that go with it. That the day actually comes back — a `RECALCULATION`, a
 * balance, a notice to everybody it touched — is ../integration/holiday-recalculation.test.ts's.
 *
 * The figure is never computed here. Every case below goes through `countLeaveDays` twice,
 * with the day on the calendar and without it, which is the whole argument for the function
 * existing: the recalculation asks what the leave costs *now* and compares.
 */

function leaveType(overrides: { code: string; name: string } & Record<string, unknown>): LeaveType {
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

const ANNUAL = leaveType({ code: 'ANNUAL_TEST', name: 'Annual Leave' });

/** FR 21, §7.3. The kind of leave that does not skip a holiday at all. */
const MATERNITY = leaveType({
  code: 'MATERNITY_TEST',
  name: 'Maternity Leave',
  countingBasis: 'CALENDAR_DAYS',
});

const MONDAY_TO_FRIDAY: WorkPattern = {
  id: 'mon-fri',
  name: 'Standard Mon-Fri',
  workingDays: [1, 2, 3, 4, 5],
  isDefault: true,
  createdAt: new Date('2026-01-05T00:00:00Z'),
  updatedAt: new Date('2026-01-05T00:00:00Z'),
};

/** Somebody who is off on Fridays, which is what makes a Friday holiday worth nothing. */
const FOUR_DAY_WEEK: WorkPattern = {
  ...MONDAY_TO_FRIDAY,
  id: 'mon-thu',
  workingDays: [1, 2, 3, 4],
};

/** Monday 2 March to Friday 6 March 2026, five working days. */
function aRequest(overrides: Partial<LeaveRequest> = {}): LeaveRequest {
  return {
    id: 'request-1',
    employeeId: 'ama',
    leaveTypeId: ANNUAL.id,
    leaveYearId: 'y2026',
    from: '2026-03-02',
    to: '2026-03-06',
    reason: 'A week by the sea',
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status: 'APPROVED' as RequestStatus,
    awaitingApprovalFrom: null,
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
    ...overrides,
  };
}

/** Friday 6 March 2026, gazetted after the leave above was approved. */
function aHoliday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: 'holiday-1',
    name: 'Independence Day',
    date: '2026-03-06',
    createdAt: new Date('2026-03-04T09:00:00Z'),
    updatedAt: new Date('2026-03-04T09:00:00Z'),
    ...overrides,
  };
}

function credits(overrides: Partial<Parameters<typeof whatAHolidayCredits>[0]> = {}) {
  const holiday = overrides.holiday ?? aHoliday();

  return whatAHolidayCredits({
    request: aRequest(),
    type: ANNUAL,
    pattern: MONDAY_TO_FRIDAY,
    holiday,
    calendar: [holiday],
    alreadyCredited: false,
    ...overrides,
  });
}

/* ------------------------------------------------ the day the country was not working */

describe('what a late-declared holiday is worth', () => {
  it('credits the difference the calendar makes', () => {
    expect(credits()).toEqual({ days: 1, because: null });
  });

  /* The whole of FR 25's "not charged leave for a day the country was not working": the
     figure is what the leave costs now against what it cost, and nothing else. */
  it('and a second holiday inside the same leave credits its own day, not both', () => {
    const declared = aHoliday();
    const already = aHoliday({ id: 'holiday-0', name: 'A Feast', date: '2026-03-03' });

    expect(credits({ holiday: declared, calendar: [already, declared] })).toEqual({
      days: 1,
      because: null,
    });
  });

  /* FR 25. The button is safe to press twice, and this is the half of that which stops the
     second press producing a hundred and forty refusals. The other half is the unique
     index, which is ../integration/holiday-recalculation.test.ts's. */
  it('and a day that has already been credited is worth nothing more', () => {
    expect(credits({ alreadyCredited: true })).toEqual({
      days: 0,
      because: 'ALREADY_CREDITED',
    });
  });
});

/* -------------------------------- the story's second criterion, read two ways */

describe('what it leaves alone', () => {
  /* §7.3. Maternity leave is not shortened by Christmas: a calendar-day type never
     consulted the calendar, so both counts are the same and there is no difference. */
  it('leaves leave counted in calendar days exactly as it was', () => {
    expect(
      credits({
        request: aRequest({ leaveTypeId: MATERNITY.id, countingBasis: 'CALENDAR_DAYS', days: 5 }),
        type: MATERNITY,
      }),
    ).toEqual({ days: 0, because: 'COUNTS_CALENDAR_DAYS' });
  });

  /* FR 23, §7.3. The pattern is asked before the calendar, so a holiday on somebody's rest
     day cost them nothing and gives them nothing back. */
  it('and credits nothing for a holiday on a day the person does not work', () => {
    expect(credits({ pattern: FOUR_DAY_WEEK })).toEqual({
      days: 0,
      because: 'NOT_A_DAY_THEY_WORK',
    });
  });

  /* FR 11, LMS 303. The request's own basis, not the type's as it now stands: a type
     switched to calendar days last week does not un-credit leave priced before that. */
  it('and reads the basis off the request rather than off the type', () => {
    expect(
      credits({
        request: aRequest({ countingBasis: 'CALENDAR_DAYS' }),
        type: ANNUAL,
      }),
    ).toEqual({ days: 0, because: 'COUNTS_CALENDAR_DAYS' });
  });

  it('and a holiday outside the leave changes nothing', () => {
    const outside = aHoliday({ date: '2026-03-10' });

    expect(credits({ holiday: outside, calendar: [outside] })).toEqual({
      days: 0,
      because: 'NOT_A_DAY_THEY_WORK',
    });
  });
});

/* ------------------------------------------------- and it is agreed leave or nothing */

describe('the leave a holiday may be credited into', () => {
  /* §6, §8.8. Days still held are priced again by nothing and spent by nothing, so there is
     nothing to credit. Read off the table rather than asked here, as `RECLASSIFY` is. */
  it('is leave that was agreed, and every other state is refused by the table', () => {
    expect(recalculationTo(aRequest())).toBe('APPROVED');

    /* Which of the two refusals a state gets is `refuseTheMove`'s: a request that has ended
       is told its days are already back, and a live one is told the move is not available. */
    for (const status of ['SUBMITTED', 'UNROUTABLE'] as const) {
      expect(() => recalculationTo(aRequest({ status }))).toThrow(LeaveCannotBeMoved);
    }

    for (const status of ['WITHDRAWN', 'CANCELLED', 'REFUSED'] as const) {
      expect(() => recalculationTo(aRequest({ status }))).toThrow(LeaveAlreadySettled);
    }
  });
});

/* -------------------------------------------------------------------- the words */

describe('what it says', () => {
  /* FR 27. The question a reader has of this line next March is "why did I get a day back",
     and the gazetted name answers it where "recalculated" does not. */
  it('names the gazetted day on the ledger entry', () => {
    expect(reasonForRecalculation({ typeName: 'Annual Leave', holiday: aHoliday(), days: 1 })).toBe(
      '1 day of Annual Leave credited back, 2026-03-06 declared Independence Day after ' +
        'this leave was approved',
    );
  });

  it('and counts in days rather than in day(s)', () => {
    expect(
      reasonForRecalculation({ typeName: 'Annual Leave', holiday: aHoliday(), days: 2 }),
    ).toContain('2 days of Annual Leave');
  });

  /* NFR USA 03. Every reason has a sentence, so a screen never shows a bare token. */
  it('and every reason for crediting nothing has words of its own', () => {
    for (const because of NOT_CREDITED_REASONS) {
      const said = notCreditedInWords(because, 'Maternity Leave');

      expect(said.length).toBeGreaterThan(20);
      expect(said).not.toContain('_');
    }
  });

  /* The one line the person whose leave it is reads, and it says the dates have not moved. */
  it('and tells the person the day is back without offering to move their leave', () => {
    const credited: Recalculation = {
      id: 'recalculation-1',
      leaveRequestId: 'request-1',
      holidayId: 'holiday-1',
      holidayDate: '2026-03-06',
      days: 1,
      reason: 'a sentence',
      ledgerEntryId: 'entry-1',
      recordedBy: 'HR',
      recordedByEmployeeId: 'hr-1',
      recordedAt: new Date('2026-03-04T10:00:00Z'),
    };

    const said = recalculationInWords(credited, 'Independence Day');

    expect(said).toContain('Independence Day');
    expect(said).toContain('back in your balance');
  });
});
