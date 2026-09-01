import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidEntitlementRule,
  type NewEntitlementRule,
  validateEntitlementRuleChanges,
  validateNewEntitlementRule,
  type EntitlementRule,
} from '../../src/domain/entitlement-rule.js';
import { countLeaveDays } from '../../src/domain/leave-calculator.js';
import {
  assertWithinBackdatingWindow,
  documentationRequired,
  InvalidLeaveType,
  type LeaveType,
  type NewLeaveType,
  noticeShortfall,
  validateNewLeaveType,
} from '../../src/domain/leave-type.js';
import { MONDAY_TO_FRIDAY, type WorkPattern } from '../../src/domain/work-pattern.js';
import { isWholeDays, WHOLE_DAYS_ONLY } from '../../src/domain/whole-days.js';

/**
 * Leave is recorded in whole days only. FR 24. LMS 209.
 *
 * The story has two criteria and they are checked in two different ways, because
 * they fail in two different ways.
 *
 * **No fractional day input anywhere** is a runtime rule, so it is proved by
 * handing half a day to every entry point in the domain that takes a number of
 * days and watching each of them refuse it. The interesting assertion is not that
 * they throw — it is that none of them *rounds*, because a validator that quietly
 * turns 0.5 into 1 passes every test anybody thinks to write and produces a
 * balance nobody can explain.
 *
 * **No half day flags in the schema or the API** is not a runtime rule at all. A
 * column is not a value that can be validated; by the time `allows_half_day`
 * exists, the rule already lives in two places and one of them is a `BOOLEAN`
 * somebody will eventually read. So it is checked against the SQL and the source
 * text, the same way ./migrations.test.ts checks that a moment is never a bare
 * `TIMESTAMP`. The schema half of that lives there, beside its sibling; the source
 * half is here, because the API surface is what this file is about.
 *
 * The Technical Design Document specifies `NUMERIC(5,2)` for `day_count` (§5.6) and
 * `NUMERIC(6,2)` for every balance column (§5.7), "kept only so that a future policy
 * change does not need a migration". This build declines that: it holds integers,
 * and widening one is a three line migration on the day the policy actually changes.
 * A `NUMERIC` column that must never hold a fraction is a rule nothing enforces, and
 * §7.3's own note — `day_count` "is always an integer despite its numeric type" — is
 * the admission that it would not be enforced. ./migrations.test.ts holds the schema
 * to that, and says which future story is expected to argue with it.
 */

/* ------------------------------------------------------------- the predicate */

describe('what counts as a number of days', () => {
  it('accepts a whole number, including zero and a negative one', () => {
    /* Whether a figure may be zero or below it is each caller's rule and each of
       them states its own; this answers only whether it is a count at all. */
    expect(isWholeDays(0)).toBe(true);
    expect(isWholeDays(20)).toBe(true);
    expect(isWholeDays(-5)).toBe(true);
    expect(isWholeDays(120)).toBe(true);
  });

  it('refuses a fraction, however it is written', () => {
    expect(isWholeDays(0.5)).toBe(false);
    expect(isWholeDays(19.5)).toBe(false);
    expect(isWholeDays(-0.5)).toBe(false);
    expect(isWholeDays(1 / 3)).toBe(false);

    /* The one that arrives by arithmetic rather than by typing: 0.30000000000000004
       is not a number anybody entered, and it is what a system that adds halves
       produces after enough of them. */
    expect(isWholeDays(0.1 + 0.2)).toBe(false);
  });

  it('refuses a number written as text', () => {
    /* Coercing here would mean the day a NUMERIC column arrives from the driver as
       the string '20.00', the system reads twenty and says nothing at all. */
    expect(isWholeDays('20')).toBe(false);
    expect(isWholeDays('20.5')).toBe(false);
    expect(isWholeDays('')).toBe(false);
  });

  it('refuses what is not a number', () => {
    expect(isWholeDays(null)).toBe(false);
    expect(isWholeDays(undefined)).toBe(false);
    expect(isWholeDays(NaN)).toBe(false);
    expect(isWholeDays(Infinity)).toBe(false);
    expect(isWholeDays(-Infinity)).toBe(false);
    expect(isWholeDays(true)).toBe(false);
    expect(isWholeDays([20])).toBe(false);
  });

  /**
   * A whole number so large it stops behaving like one.
   *
   * `Number.isInteger(2 ** 53 + 1)` is true and `2 ** 53 + 1 === 2 ** 53` is also
   * true, so past that point a figure is a whole number that no longer adds up.
   * Every caller bounds its own range far below this and none of them should have
   * to think about it, so the floor of "arithmetic on this still works" is here.
   */
  it('refuses a figure too large to count with', () => {
    expect(isWholeDays(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isWholeDays(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isWholeDays(1e300)).toBe(false);
  });

  it('says where the morning off actually goes', () => {
    /* The reason is the useful part of the refusal. "0.5 is not a whole number"
       tells somebody what they already know. */
    expect(WHOLE_DAYS_ONLY).toMatch(/whole days/);
    expect(WHOLE_DAYS_ONLY).toMatch(/manager/);
    expect(WHOLE_DAYS_ONLY).toMatch(/FR 24/);
  });
});

/* ------------------------------------------------ no fractional day, anywhere */

/** The fields an entitlement rule has to name, so a test can vary only the figure. */
const SOUND_RULE: NewEntitlementRule = {
  leaveTypeId: '1',
  entitlementDays: 20,
  effectiveFrom: '2026-01-01',
};

/** The fields a leave type has to name, likewise. */
const SOUND_TYPE: NewLeaveType = {
  code: 'ANNUAL',
  name: 'Annual Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'QUOTA',
};

/** A stored rule, built through the same validation a real one goes through. */
function storedRule(overrides: Partial<NewEntitlementRule> = {}): EntitlementRule {
  return {
    id: '1',
    ...validateNewEntitlementRule({ ...SOUND_RULE, ...overrides }),
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** A stored leave type, likewise. */
function storedType(overrides: Partial<NewLeaveType> = {}): LeaveType {
  return {
    id: '1',
    ...validateNewLeaveType({ ...SOUND_TYPE, ...overrides }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/**
 * Every place in the domain where a caller hands over a number of days.
 *
 * A list rather than a test each, because the criterion is "anywhere" and a list
 * is the only shape that can be read against the source and found short.
 *
 * It is a list somebody has to extend, and there is no scan that can extend it
 * automatically — "this argument is a number of days" is not a thing the type
 * `number` says. What keeps it honest is that it is short enough to check against
 * ../../src/domain by eye, and that the two figures added since LMS 201 are both
 * on it. A day figure added without a line here is the gap this story leaves open,
 * and naming it is more use than a count that only catches the list shrinking.
 */
const EVERY_FIGURE_IN_DAYS: ReadonlyArray<{
  what: string;
  half: (value: number) => unknown;
}> = [
  {
    what: 'an entitlement, FR 28',
    half: (value) => validateNewEntitlementRule({ ...SOUND_RULE, entitlementDays: value }),
  },
  {
    what: 'a change to an entitlement, FR 31',
    half: (value) => validateEntitlementRuleChanges({ entitlementDays: value }, storedRule()),
  },
  {
    what: 'a carry over cap, FR 36',
    half: (value) =>
      validateNewEntitlementRule({
        ...SOUND_RULE,
        carriesOver: true,
        carryoverMaxDays: value,
      }),
  },
  {
    what: 'a notice window, FR 17',
    half: (value) => validateNewLeaveType({ ...SOUND_TYPE, minNoticeCalendarDays: value }),
  },
  {
    what: 'a backdating window, FR 18',
    half: (value) => validateNewLeaveType({ ...SOUND_TYPE, maxBackdateCalendarDays: value }),
  },
  {
    what: 'a documentation threshold, FR 13',
    half: (value) => validateNewLeaveType({ ...SOUND_TYPE, documentationAfterDays: value }),
  },
  {
    what: 'the notice actually given, FR 17',
    half: (value) => noticeShortfall(storedType({ minNoticeCalendarDays: 14 }), value),
  },
  {
    what: 'the days since leave was taken, FR 18',
    half: (value) => assertWithinBackdatingWindow(storedType(), value),
  },
  {
    what: 'the length of a request, FR 13',
    half: (value) => documentationRequired(storedType({ documentationAfterDays: 2 }), value),
  },
];

describe('no figure in days takes half of one', () => {
  it('there are figures to check', () => {
    expect(EVERY_FIGURE_IN_DAYS.length).toBeGreaterThan(0);
  });

  it.each(EVERY_FIGURE_IN_DAYS)('$what refuses half a day', ({ half }) => {
    expect(() => half(0.5)).toThrow();
    expect(() => half(7.5)).toThrow();
  });

  /**
   * The assertion the story is really about.
   *
   * Refusing is the easy half. What has to be true beside it is that nothing
   * *accepts* a fraction and hands back a whole number, because that is the
   * failure with no symptom: a request for 7.5 days that books 8 charges somebody
   * for a day they did not take, and one that books 7 gives one away, and the only
   * trace either leaves is a balance that is slightly wrong forever.
   */
  it.each(EVERY_FIGURE_IN_DAYS)('$what never rounds one', ({ half }) => {
    let accepted: unknown;

    try {
      accepted = half(7.5);
    } catch {
      return; // Refused, which is the answer this story wants.
    }

    throw new Error(
      `7.5 was accepted and came back as ${JSON.stringify(accepted)}. A fraction of a ` +
        'day is refused at the boundary, never rounded into one.',
    );
  });

  /* Both refusals reach a form, and each names the field the message goes beside.
     A shared thrower in ../../src/domain/whole-days.ts would have had to invent a
     third error type that reaches no form at all, which is why the predicate is
     shared and the refusal is not. */
  it('blames the field the message has to appear next to', () => {
    expect(() => validateNewEntitlementRule({ ...SOUND_RULE, entitlementDays: 0.5 })).toThrow(
      InvalidEntitlementRule,
    );
    expect(() => validateNewLeaveType({ ...SOUND_TYPE, minNoticeCalendarDays: 0.5 })).toThrow(
      InvalidLeaveType,
    );

    const refusal = (() => {
      try {
        validateNewEntitlementRule({ ...SOUND_RULE, entitlementDays: 0.5 });
      } catch (error) {
        return error as InvalidEntitlementRule;
      }
      throw new Error('That was accepted, and should not have been.');
    })();

    expect(refusal.field).toBe('entitlementDays');
    expect(refusal.message).toContain('FR 24');
  });
});

/* --------------------------------------------- and nothing computes half of one */

describe('what the calculator hands back is always a whole day', () => {
  const STANDARD: WorkPattern = {
    id: 'standard',
    name: 'Standard Mon-Fri',
    workingDays: [...MONDAY_TO_FRIDAY],
    isDefault: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };

  const WORKING = storedType({ code: 'W_TEST', name: 'Working day type' });
  const CALENDAR = storedType({
    code: 'C_TEST',
    name: 'Calendar day type',
    countingBasis: 'CALENDAR_DAYS',
    entitlementBasis: 'EVENT',
  });

  /**
   * A period starting every week of the year, at six lengths, on both bases.
   *
   * Swept rather than picked, because the shape of a fractional-day bug is that it
   * appears on one length of period and not another: an implementation that divided
   * `(end - start)` by 86,400,000 would return whole numbers all year and
   * 30.958333 for the one period that spans a clock change. Nothing here divides —
   * `countLeaveDays()` walks and increments — and this is what keeps that true of
   * whatever replaces it.
   *
   * The count of periods actually reached is asserted, because a sweep whose every
   * iteration was skipped is a test that passes by doing nothing.
   */
  it('over periods starting every week of a year, counted either way', () => {
    let counted = 0;

    for (const type of [WORKING, CALENDAR]) {
      for (let start = 1; start <= 360; start += 7) {
        for (const length of [0, 1, 6, 13, 29, 119]) {
          const from = dayOfYear(start);
          const to = dayOfYear(start + length);

          /* Every period comes back with a number since LMS 303, a single Saturday of
             annual leave included — that one costs nought, and nought is whole. The
             sweep used to skip those, which is a sweep that stopped looking at exactly
             the periods most likely to produce a fraction. */
          const count = countLeaveDays(type, { from, to }, STANDARD, []);

          expect(isWholeDays(count.days), `${from} to ${to} cost ${count.days}`).toBe(true);
          expect(isWholeDays(count.calendarDays)).toBe(true);
          counted += 1;
        }
      }
    }

    /* 2 bases × 52 starts × 6 lengths, and none skipped since LMS 303. */
    expect(counted).toBe(2 * 52 * 6);
  });

  /* The one date arithmetic in the system that divides, ./time.ts's
     calendarDaysBetween(), does it across the two days Ghana does not observe but
     other calendars do. Both are whole here because both ends are UTC midnights. */
  it('across a period long enough to contain a clock change elsewhere', () => {
    const count = countLeaveDays(CALENDAR, { from: '2026-03-01', to: '2026-11-30' }, STANDARD, []);

    expect(count.days).toBe(275);
    expect(isWholeDays(count.days)).toBe(true);
  });
});

/* ------------------------------------------ no half day flag, schema or API */

/**
 * How a half day flag would be spelled, in SQL or in TypeScript.
 *
 * Matched exactly rather than as a bare `/half/`, because this codebase says
 * "half" constantly in prose — `editableHalfOf()`, "the loud half", "a report that
 * splits in half" — and a scan that fired on those would be turned off within a
 * week. What is being looked for is an identifier: a column, a field, a property.
 */
const A_HALF_DAY_FLAG =
  /\b(half_days?|is_half_day|allows_half_day|halfDays?|isHalfDay|allowsHalfDay)\b/;

describe('nothing in the API is named for a half day', () => {
  const SRC = join(process.cwd(), 'server', 'src');
  const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );

  it('there are sources to check', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  /**
   * `allows_half_day` is in §5.5 of the Technical Design Document and is not in
   * this schema, and its absence is the decision rather than an omission.
   *
   * FR 24 puts half days outside the system entirely — they "do not reduce any
   * leave balance, and are out of scope" — so a column saying whether a type
   * permits one is a switch with nothing behind it. Ship the switch and somebody
   * eventually wires it up, one screen at a time, and the first anybody knows is a
   * balance holding 12.5.
   */
  it('no field, property or type is a half day', () => {
    const naming = sources.filter((file) =>
      A_HALF_DAY_FLAG.test(readFileSync(join(SRC, file), 'utf8')),
    );

    expect(naming).toEqual([]);
  });

  /* The scan is only worth having if it can fail, and a regex written against
     nothing is a regex nobody has run. This is the flag as §5.5 spells it. */
  it('would catch one if somebody added it', () => {
    expect(A_HALF_DAY_FLAG.test('allows_half_day BOOLEAN NOT NULL DEFAULT TRUE')).toBe(true);
    expect(A_HALF_DAY_FLAG.test('  allowsHalfDay: boolean;')).toBe(true);
    expect(A_HALF_DAY_FLAG.test('  isHalfDay?: boolean;')).toBe(true);

    /* And leaves the prose alone, which is the reason it is spelled out rather
       than written as a bare /half/. */
    expect(A_HALF_DAY_FLAG.test('editableHalfOf(current)')).toBe(false);
    expect(A_HALF_DAY_FLAG.test('Half days are settled with a manager.')).toBe(false);
    expect(A_HALF_DAY_FLAG.test('a report that splits in half')).toBe(false);
  });
});

/** A day of 2026, so a loop can name periods without a date library. */
function dayOfYear(offset: number): string {
  const day = new Date(Date.UTC(2026, 0, offset));
  return day.toISOString().slice(0, 10);
}
