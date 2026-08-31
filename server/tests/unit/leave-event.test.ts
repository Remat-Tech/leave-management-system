import { describe, expect, it } from 'vitest';
import { daysToLapse } from '../../src/domain/balance.js';
import {
  AlreadyLapsed,
  assertHasHappened,
  decideTheLapse,
  expiryFor,
  hasExpired,
  InvalidLeaveEvent,
  isStillLive,
  type LapseCandidate,
  type LeaveEvent,
  NOT_LAPSED,
  type NotLapsedBecause,
  reasonForGrant,
  reasonForLapse,
  validateNewLeaveEvent,
  wasLapsed,
} from '../../src/domain/leave-event.js';
import { monthsAfter } from '../../src/domain/time.js';

/**
 * Entitlement that arrives with an event. FR 32g, FR 32e, §8.6aa. LMS 218.
 *
 * Two of the story's three criteria are pure functions and are proved here: the
 * deadline six months out, and what is left when it passes. The first criterion —
 * a grant recorded against the event — is a foreign key and two rows in one
 * transaction, so it is ../integration/leave-event.test.ts's.
 *
 * **Not one test below names a leave type.** `expiryFor` is handed a month count off
 * `leave_type.entitlement_expiry_months` and has no idea which type it belongs to;
 * paternity's six is data. A `code === 'PATERNITY'` anywhere above the database is the
 * bug design principle 5 exists to prevent, and this file is where it would have been
 * most tempting to write one.
 */

/* --------------------------------------------------------------- the deadline */

describe('when an unused grant runs out', () => {
  /* FR 32e, and the whole of the story's second criterion: paternity is fourteen days
     per birth, usable within six months. Six is a column; this is what it means. */
  it('is the same day of the month, so many months later', () => {
    expect(expiryFor('2026-03-04', 6)).toBe('2026-09-04');
    expect(expiryFor('2026-01-15', 6)).toBe('2026-07-15');
  });

  it('and crosses a year end without any special case', () => {
    expect(expiryFor('2026-10-20', 6)).toBe('2027-04-20');
    expect(expiryFor('2026-12-31', 1)).toBe('2027-01-31');
  });

  /**
   * And the end of a month is clamped rather than allowed to run over.
   *
   * This is the case that would otherwise be wrong on exactly the dates nobody tests.
   * `setUTCMonth` on the thirty-first of August plus six months produces the
   * thirty-first of February, which JavaScript rolls forward to the third of March —
   * a deadline three days later than anybody meant, quietly, for anyone whose child
   * was born at the end of a long month.
   */
  it('and the end of a long month lands on the end of a short one', () => {
    expect(expiryFor('2026-08-31', 6)).toBe('2027-02-28');
    expect(expiryFor('2026-08-31', 1)).toBe('2026-09-30');
    expect(expiryFor('2026-05-31', 1)).toBe('2026-06-30');
  });

  /* And a leap year is the calendar's business rather than this system's. */
  it('and February has twenty nine days when it has twenty nine days', () => {
    expect(expiryFor('2027-08-31', 6)).toBe('2028-02-29');
    expect(monthsAfter('2028-02-29', 12)).toBe('2029-02-28');
  });

  /**
   * Null where the type's grant never runs out, which is every event type but one.
   *
   * Maternity's hundred and twenty days, compassionate leave and the two unpaid types
   * all leave `entitlement_expiry_months` unset. Null is the answer rather than a
   * far-off date, because "this never runs out" and "this runs out in 2099" are
   * different facts and only one of them is true.
   */
  it('and never, where the type says nothing about it', () => {
    expect(expiryFor('2026-03-04', null)).toBeNull();
  });

  /* Nought months is not "never" — it is a month count somebody typed wrong, and a
     grant that ran out the day it was made would be a hundred and twenty days
     appearing and vanishing in one afternoon. */
  it('but nought months is refused rather than read as never', () => {
    expect(() => expiryFor('2026-03-04', 0)).toThrow(InvalidLeaveEvent);
    expect(() => expiryFor('2026-03-04', -6)).toThrow(InvalidLeaveEvent);
  });
});

describe('whether a grant has run out yet', () => {
  const event = (expiresOn: string | null, lapsedEntryId: string | null = null): LeaveEvent => ({
    id: '1',
    employeeId: '11',
    leaveTypeId: '2',
    leaveYearId: '3',
    occurredOn: '2026-03-04',
    expiresOn: expiresOn as LeaveEvent['expiresOn'],
    note: null,
    grantedEntryId: '41',
    lapsedEntryId,
    createdAt: new Date('2026-03-05T09:00:00Z'),
    updatedAt: new Date('2026-03-05T09:00:00Z'),
  });

  /* The deadline is the day itself, and a grant lapses *after* it. Somebody whose six
     months are up on the fourth of September may still take the leave on the fourth;
     what is left goes from the fifth. A boundary either way is arbitrary and this is
     the one a person would assume, which is the only argument that matters for a rule
     somebody is held to. */
  it('is still live on the deadline itself', () => {
    expect(hasExpired(event('2026-09-04'), '2026-09-04')).toBe(false);
    expect(hasExpired(event('2026-09-04'), '2026-09-05')).toBe(true);
  });

  it('and a grant that never runs out never has', () => {
    expect(hasExpired(event(null), '2099-01-01')).toBe(false);
    expect(isStillLive(event(null), '2099-01-01')).toBe(true);
  });

  /* Live means both: still within its deadline *and* not already closed off. An event
     the expiry job has dealt with has no claim on anything. */
  it('and one that has already lapsed is not live, whatever the date', () => {
    expect(isStillLive(event('2026-09-04', '42'), '2026-01-01')).toBe(false);
  });
});

/* ------------------------------------------------------------- what lapses */

describe('what is left when the deadline passes', () => {
  const EXPIRED: LapseCandidate = {
    available: 14,
    anotherGrantIsLive: false,
    theYearIsClosed: false,
  };

  function candidate(overrides: Partial<LapseCandidate> = {}): LapseCandidate {
    return { ...EXPIRED, ...overrides };
  }

  function because(overrides: Partial<LapseCandidate>): NotLapsedBecause | undefined {
    const decision = decideTheLapse(candidate(overrides));

    return wasLapsed(decision) ? undefined : decision.because;
  }

  function lapsed(overrides: Partial<LapseCandidate> = {}): number | undefined {
    const decision = decideTheLapse(candidate(overrides));

    return wasLapsed(decision) ? decision.days : undefined;
  }

  /* The story's third criterion: the expiry job lapses whatever remains. */
  it('is whatever remains, and all of it', () => {
    expect(lapsed()).toBe(14);
    expect(lapsed({ available: 3 })).toBe(3);
  });

  /* §8.6aa lets one grant be drawn down by several requests, so a partly used grant is
     the ordinary case rather than the interesting one. What is left is what the
     balance says is left. */
  it('including a fraction, because what somebody is owed is divisible', () => {
    expect(lapsed({ available: 6.5 })).toBe(6.5);
  });

  it('and nothing at all where the grant was used up', () => {
    expect(because({ available: 0 })).toBe('NOTHING_LEFT');
  });

  /**
   * And a balance in arrears lapses nothing.
   *
   * Nought or less means the grant was used and then some — an adjustment HR posted,
   * or a type that may be exceeded. A `LAPSE` of negative days is a movement the wrong
   * way round that the ledger refuses anyway, and the debt is somebody's to settle by
   * hand, exactly as the rollover leaves it.
   */
  it('and nothing where the balance is overdrawn', () => {
    expect(because({ available: -3 })).toBe('NOTHING_LEFT');
  });

  /**
   * And nothing at all while another grant in the same balance is still live.
   *
   * The rare case that makes "whatever remains" honest. Two births in one leave year,
   * the first six months up and the second not: there is no per-grant consumption
   * anywhere in this system, so the days in the balance cannot be attributed to one or
   * the other. Lapsing the first's deadline would take days somebody still has a live
   * claim on, so nothing is taken and the second deadline catches what is left.
   *
   * Asked *before* the arithmetic, deliberately: a full balance with a live sibling is
   * refused for the right reason rather than for a lucky one.
   */
  it('and nothing while another grant in the same balance is still live', () => {
    expect(because({ anotherGrantIsLive: true })).toBe('ANOTHER_GRANT_IS_LIVE');
    expect(because({ anotherGrantIsLive: true, available: 0 })).toBe('ANOTHER_GRANT_IS_LIVE');
  });

  /**
   * And nothing into a leave year that has since been settled.
   *
   * A paternity grant made in December runs to June, and December's year may well have
   * been closed in February. §8.9 lets nothing but an `ADJUSTMENT` into a closed year,
   * so nothing is posted — and nothing is lost by that either, because a closed year's
   * balance cannot be booked against. Reported rather than thrown, so a nightly run
   * does not stop on it.
   */
  it('and nothing into a leave year that has been closed', () => {
    expect(because({ theYearIsClosed: true })).toBe('THE_YEAR_IS_CLOSED');
  });

  it('and every reason it can give is one of the four', () => {
    for (const reason of [
      because({ available: 0 })!,
      because({ anotherGrantIsLive: true })!,
      because({ theYearIsClosed: true })!,
    ]) {
      expect(NOT_LAPSED).toContain(reason);
    }
  });
});

/* ------------------------------------------------------------- once, and once only */

describe('an event lapses once', () => {
  /**
   * The half of idempotence this file holds, and it is deliberately thinner than
   * `daysToGrant`'s and `daysToCarry`'s.
   *
   * Those two count entries in the *balance*, because a year is granted once and
   * carried once. A lapse is once per **event** — two births in one leave year each
   * have their own deadline — so counting `LAPSE` entries in the balance would refuse
   * the second birth's deadline because the first had already run. The question is a
   * fact about the event row, and `BalanceService.lapse` asks it inside the
   * transaction that posts the entry.
   */
  it('so the days rule checks only that there are days', () => {
    expect(daysToLapse(14)).toBe(14);
    expect(daysToLapse(6.5)).toBe(6.5);
    expect(() => daysToLapse(0)).toThrow(/not one/);
    expect(() => daysToLapse(-3)).toThrow(/none to take/);
  });

  it('and the refusal for a second one names the event rather than the balance', () => {
    expect(new AlreadyLapsed('41').message).toMatch(/event 41 has already lapsed/i);
    expect(new AlreadyLapsed('41').leaveEventId).toBe('41');
  });
});

/* --------------------------------------------------------------------- the words */

describe('what the entries say', () => {
  /* FR 27. "Maternity Leave, 120 days" explains nothing; the day it was for explains
     all of it without anybody opening another screen. */
  it('a grant names the day the thing happened', () => {
    expect(reasonForGrant('Maternity Leave', '2026-03-04', null)).toBe(
      'Maternity Leave for the event recorded on 2026-03-04',
    );
  });

  /* And the deadline where there is one, because the person reading it is the person
     who has to use the days before it. */
  it('and the deadline, where the grant has one', () => {
    expect(reasonForGrant('Paternity Leave', '2026-03-04', '2026-09-04')).toBe(
      'Paternity Leave for the event recorded on 2026-03-04, usable up to 2026-09-04',
    );
  });

  /* A lapse names the deadline rather than the night the job ran. The question is
     always "when was I supposed to have used these", and the answer is not "last night
     at two in the morning". */
  it('and a lapse names the deadline that was missed', () => {
    expect(reasonForLapse('Paternity Leave', '2026-03-04', '2026-09-04')).toBe(
      'Unused Paternity Leave from the event on 2026-03-04 lapsed after 2026-09-04. FR 32e',
    );
  });
});

/* ------------------------------------------------------------- what is valid */

describe('what an event has to have', () => {
  const SOUND = {
    employeeId: '11',
    leaveTypeId: '2',
    leaveYearId: '3',
    occurredOn: '2026-03-04' as const,
    expiresOn: '2026-09-04' as const,
    grantedEntryId: '41',
  };

  it('is four ids, a day, and the grant it caused', () => {
    expect(validateNewLeaveEvent(SOUND)).toMatchObject({ ...SOUND, note: null });
  });

  it('and refuses a deadline that is not after the day it happened', () => {
    expect(() => validateNewLeaveEvent({ ...SOUND, expiresOn: '2026-03-04' as const })).toThrow(
      InvalidLeaveEvent,
    );
    expect(() => validateNewLeaveEvent({ ...SOUND, expiresOn: '2026-01-01' as const })).toThrow(
      /not after the event/,
    );
  });

  /* A note explains rather than decides, so it is trimmed and optional — unlike a
     ledger entry's reason, which is mandatory because the grant it explains is the
     figure somebody disputes. */
  it('and keeps a note, trimmed, or nothing at all', () => {
    expect(validateNewLeaveEvent({ ...SOUND, note: '  second child  ' }).note).toBe('second child');
    expect(validateNewLeaveEvent({ ...SOUND, note: '   ' }).note).toBeNull();
  });

  it('and names the field when an id is missing', () => {
    expect(() => validateNewLeaveEvent({ ...SOUND, employeeId: '' })).toThrow(
      /employee it happened to/,
    );
    expect(() => validateNewLeaveEvent({ ...SOUND, grantedEntryId: '' })).toThrow(
      /grant it caused/,
    );
  });
});

describe('an event has to have happened', () => {
  /**
   * The failure this prevents is a typo rather than fraud: 2027 for 2026 in January
   * puts somebody's maternity leave a year out and starts the six month clock in the
   * wrong place, and nothing downstream would notice.
   */
  it('so a date in the future is refused', () => {
    expect(() => assertHasHappened('2026-03-05', '2026-03-04')).toThrow(InvalidLeaveEvent);
    expect(() => assertHasHappened('2027-03-04', '2026-03-04')).toThrow(/has not happened yet/);
  });

  it('and today is soon enough', () => {
    expect(() => assertHasHappened('2026-03-04', '2026-03-04')).not.toThrow();
  });

  /**
   * And FR 18's backdating window is deliberately not applied.
   *
   * Seven days is what the leave types hold for entering an *absence* after the fact.
   * A birth told to HR three weeks late is ordinary — the parents have other things on
   * — and refusing it would leave the entitlement ungrantable, which is the story's
   * failure rather than a rule being enforced.
   */
  it('and a birth told to HR three weeks late is recorded, not refused', () => {
    expect(() => assertHasHappened('2026-03-04', '2026-03-25')).not.toThrow();
    expect(() => assertHasHappened('2025-03-04', '2026-03-04')).not.toThrow();
  });
});
