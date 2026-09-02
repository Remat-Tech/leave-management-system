import { describe, expect, it } from 'vitest';
import {
  appliesTo,
  assertDoesNotReachIntoAClosedYear,
  assertMayBeCorrected,
  byPrecedence,
  coversDay,
  type EntitlementRule,
  EntitlementRuleAlreadyApplies,
  InvalidEntitlementRule,
  isStillADraft,
  NOTHING_IS_CLOSED_YET,
  ReachesIntoAClosedYear,
  resolve,
  RULE_SCOPES,
  rulesInForce,
  scopeOf,
  specificityOf,
  validateEntitlementRuleChanges,
  validateNewEntitlementRule,
} from '../../src/features/entitlement/entitlement-rule.js';

/**
 * What a leave type is worth, and from when. FR 31, §5.5. LMS 203.
 *
 * The story's fourth criterion is "resolution logic implemented once and unit
 * tested hard", and this file is the second half of that. The first half is that
 * there is one implementation to test: the repository fetches candidates and
 * orders nothing, the migration creates no view, and
 * ../integration/entitlement-rule.test.ts asserts that the database has not
 * quietly grown a second opinion.
 *
 * The property everything below is really about: **the answer to "what was this
 * worth" depends only on the day it is asked about, and never on when it is
 * asked.** A figure raised this morning cannot move what last March resolved to.
 * Three separate things make that true and each is tested apart:
 *
 *   Resolution takes a day, and there is no undated form of the question.
 *
 *   A rule that has taken effect cannot be corrected or withdrawn.
 *
 *   A new rule cannot be dated back into a leave year that has been closed.
 *
 * The resolution tests are written to fail if the rule is ever reduced to "the
 * latest row wins" or "the narrowest row wins" alone — most of them have a rule
 * that would win under one key and lose under the other.
 */

/** A stored rule, with only the fields the test is about set. */
function rule(overrides: Partial<EntitlementRule> = {}): EntitlementRule {
  return {
    id: '1',
    leaveTypeId: 'annual',
    employeeId: null,
    departmentId: null,
    entitlementDays: 20,
    prorateOnJoin: false,
    carriesOver: false,
    carryoverMaxDays: null,
    carryoverExpiryMonth: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    note: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Kwame, in Operations. The person every resolution below is about. */
const KWAME = { employeeId: '7', departmentId: '3' };

function on(day: string) {
  return { ...KWAME, on: day };
}

describe('how narrowly a rule is aimed', () => {
  it('is read off the scope fields rather than stored beside them', () => {
    expect(scopeOf(rule())).toBe('EVERYBODY');
    expect(scopeOf(rule({ departmentId: '3' }))).toBe('DEPARTMENT');
    expect(scopeOf(rule({ employeeId: '7' }))).toBe('EMPLOYEE');
  });

  /* A person beats a team beats everybody, and the numbers come from the order of
     RULE_SCOPES so that the two lists cannot get out of step. */
  it('scores a person above a team above everybody', () => {
    expect(specificityOf(rule({ employeeId: '7' }))).toBeGreaterThan(
      specificityOf(rule({ departmentId: '3' })),
    );
    expect(specificityOf(rule({ departmentId: '3' }))).toBeGreaterThan(specificityOf(rule()));
  });

  it('has three rungs, because nothing narrower than a person exists', () => {
    expect([...RULE_SCOPES]).toEqual(['EVERYBODY', 'DEPARTMENT', 'EMPLOYEE']);
  });
});

describe('the days a rule covers', () => {
  const spring = rule({ effectiveFrom: '2026-03-01', effectiveTo: '2026-05-31' });

  it('includes both ends, because a rule that starts on a day applies on it', () => {
    expect(coversDay(spring, '2026-03-01')).toBe(true);
    expect(coversDay(spring, '2026-05-31')).toBe(true);
  });

  it('excludes the day before and the day after', () => {
    expect(coversDay(spring, '2026-02-28')).toBe(false);
    expect(coversDay(spring, '2026-06-01')).toBe(false);
  });

  it('runs on forever when there is no end date, which is what a standing rule is', () => {
    expect(coversDay(rule({ effectiveFrom: '2026-01-01' }), '2044-12-25')).toBe(true);
  });

  it('covers exactly one day when both dates are that day', () => {
    const oneDay = rule({ effectiveFrom: '2026-07-04', effectiveTo: '2026-07-04' });

    expect(coversDay(oneDay, '2026-07-04')).toBe(true);
    expect(coversDay(oneDay, '2026-07-03')).toBe(false);
    expect(coversDay(oneDay, '2026-07-05')).toBe(false);
  });

  /* Ten characters compare correctly as text, which is the whole reason a
     calendar date is stored as ten characters. A year boundary is where a
     comparison that parsed months and days separately would go wrong. */
  it('compares across a year end without parsing anything', () => {
    const rollover = rule({ effectiveFrom: '2026-12-31', effectiveTo: '2027-01-01' });

    expect(coversDay(rollover, '2026-12-31')).toBe(true);
    expect(coversDay(rollover, '2027-01-01')).toBe(true);
    expect(coversDay(rollover, '2026-12-30')).toBe(false);
  });
});

describe('who a rule is aimed at', () => {
  it('reaches the person it names and nobody else', () => {
    expect(appliesTo(rule({ employeeId: '7' }), KWAME)).toBe(true);
    expect(appliesTo(rule({ employeeId: '8' }), KWAME)).toBe(false);
  });

  it('reaches everybody in the department it names', () => {
    expect(appliesTo(rule({ departmentId: '3' }), KWAME)).toBe(true);
    expect(appliesTo(rule({ departmentId: '4' }), KWAME)).toBe(false);
  });

  it('reaches everybody when it names nobody', () => {
    expect(appliesTo(rule(), KWAME)).toBe(true);
    expect(appliesTo(rule(), { employeeId: '99', departmentId: '99' })).toBe(true);
  });
});

describe('resolution: the most specific rule wins', () => {
  const everybody = rule({ id: '1', entitlementDays: 20 });
  const theTeam = rule({ id: '2', departmentId: '3', entitlementDays: 22 });
  const kwame = rule({ id: '3', employeeId: '7', entitlementDays: 25 });

  it('prefers the rule naming the person over the one naming their team', () => {
    expect(resolve([everybody, theTeam, kwame], on('2026-06-01'))?.entitlementDays).toBe(25);
  });

  it('prefers the rule naming the team over the one naming nobody', () => {
    expect(resolve([everybody, theTeam], on('2026-06-01'))?.entitlementDays).toBe(22);
  });

  it('falls back to the company rule when neither of the others is aimed here', () => {
    const somebodyElse = rule({ id: '4', employeeId: '8', entitlementDays: 30 });
    const anotherTeam = rule({ id: '5', departmentId: '4', entitlementDays: 30 });

    expect(resolve([everybody, somebodyElse, anotherTeam], on('2026-06-01'))?.entitlementDays).toBe(
      20,
    );
  });

  /* The one that would pass under "the latest row wins" and has to fail: the
     company rule is newer than the personal one and still loses, because
     specificity is the first key and not a tie break. */
  it('prefers a specific rule even when a wider one was written later', () => {
    const newerForEverybody = rule({
      id: '9',
      entitlementDays: 21,
      effectiveFrom: '2026-05-01',
    });

    expect(resolve([newerForEverybody, kwame], on('2026-06-01'))?.entitlementDays).toBe(25);
  });

  it('does not let a specific rule win on a day it does not cover', () => {
    const lastYearOnly = rule({
      id: '9',
      employeeId: '7',
      entitlementDays: 25,
      effectiveFrom: '2025-01-01',
      effectiveTo: '2025-12-31',
    });

    expect(resolve([everybody, lastYearOnly], on('2026-06-01'))?.entitlementDays).toBe(20);
    expect(resolve([everybody, lastYearOnly], on('2025-06-01'))?.entitlementDays).toBe(25);
  });
});

describe('resolution: then the latest effective from', () => {
  const original = rule({ id: '1', entitlementDays: 20, effectiveFrom: '2026-01-01' });
  const raised = rule({ id: '2', entitlementDays: 22, effectiveFrom: '2027-01-01' });

  it('takes the later rule once it has started', () => {
    expect(resolve([original, raised], on('2027-01-01'))?.entitlementDays).toBe(22);
  });

  it('leaves the earlier one answering every day before that', () => {
    expect(resolve([original, raised], on('2026-12-31'))?.entitlementDays).toBe(20);
  });

  /* Both rules are open ended and both cover 2027. Nothing had to be closed off
     for the answer to change, which is what makes changing a figure one row
     rather than two — and a second operation that can be forgotten is how a year
     ends up with no figure at all. */
  it('does not need the earlier rule to have been closed off', () => {
    expect(original.effectiveTo).toBeNull();
    expect(coversDay(original, '2027-06-01')).toBe(true);
    expect(resolve([original, raised], on('2027-06-01'))?.entitlementDays).toBe(22);
  });

  it('ignores a rule that has not started yet', () => {
    expect(resolve([original, raised], on('2026-06-01'))?.entitlementDays).toBe(20);
  });

  it('gives the same answer whichever order the rows arrive in', () => {
    const forwards = resolve([original, raised], on('2027-06-01'));
    const backwards = resolve([raised, original], on('2027-06-01'));

    expect(forwards?.id).toBe(backwards?.id);
  });

  /* Precedence within one rung is the starting date and not the id: a rule
     entered afterwards for an earlier date does not overtake one already there. */
  it('is decided by the date the rule starts, not the order it was typed', () => {
    const enteredLater = rule({ id: '99', entitlementDays: 18, effectiveFrom: '2025-01-01' });

    expect(resolve([raised, enteredLater], on('2027-06-01'))?.entitlementDays).toBe(22);
  });
});

describe('the whole of the story: last year does not move', () => {
  const twenty = rule({ id: '1', entitlementDays: 20, effectiveFrom: '2026-01-01' });

  it('answers a day in a past year the same before and after a rise', () => {
    const before = resolve([twenty], on('2026-03-15'));

    const raised = rule({ id: '2', entitlementDays: 22, effectiveFrom: '2027-01-01' });
    const after = resolve([twenty, raised], on('2026-03-15'));

    expect(before?.entitlementDays).toBe(20);
    expect(after?.entitlementDays).toBe(20);
    expect(after?.id).toBe(before?.id);
  });

  it('answers the same way for a personal arrangement agreed years later', () => {
    const negotiated = rule({
      id: '3',
      employeeId: '7',
      entitlementDays: 30,
      effectiveFrom: '2028-01-01',
    });

    expect(resolve([twenty, negotiated], on('2026-03-15'))?.entitlementDays).toBe(20);
    expect(resolve([twenty, negotiated], on('2028-03-15'))?.entitlementDays).toBe(30);
  });

  /* There is no undated form of this question anywhere, and this is that stated
     as a test: the same set of rules gives four different answers for four days,
     so no caller can be holding "the figure" as a single number. */
  it('gives one answer per day rather than one answer', () => {
    const rules = [
      twenty,
      rule({ id: '2', entitlementDays: 22, effectiveFrom: '2027-01-01' }),
      rule({ id: '3', departmentId: '3', entitlementDays: 24, effectiveFrom: '2028-01-01' }),
      rule({ id: '4', employeeId: '7', entitlementDays: 30, effectiveFrom: '2029-01-01' }),
    ];

    const figures = ['2026-06-01', '2027-06-01', '2028-06-01', '2029-06-01'].map(
      (day) => resolve(rules, on(day))?.entitlementDays,
    );

    expect(figures).toEqual([20, 22, 24, 30]);
  });
});

describe('when no rule applies at all', () => {
  it('says so, rather than throwing, because unpaid leave has no figure', () => {
    expect(resolve([], on('2026-06-01'))).toBeUndefined();
  });

  it('says so for a day before the earliest rule, rather than reaching backwards', () => {
    expect(resolve([rule({ effectiveFrom: '2026-01-01' })], on('2025-12-31'))).toBeUndefined();
  });

  /* Nobody having said anything is not the same as somebody having said nothing.
     A rule of zero days is a decision and comes back as one. */
  it('is not the same answer as a rule of zero days', () => {
    const nothing = rule({ employeeId: '7', entitlementDays: 0 });

    expect(resolve([nothing], on('2026-06-01'))?.entitlementDays).toBe(0);
    expect(resolve([nothing], on('2026-06-01'))).toBeDefined();
  });
});

describe('every rule in force, best first', () => {
  const everybody = rule({ id: '1', entitlementDays: 20 });
  const theTeam = rule({ id: '2', departmentId: '3', entitlementDays: 22 });
  const kwame = rule({ id: '3', employeeId: '7', entitlementDays: 25 });
  const expired = rule({ id: '4', employeeId: '7', effectiveTo: '2025-12-31' });
  const someoneElse = rule({ id: '5', employeeId: '8' });

  it('is the chain a screen shows to explain a figure', () => {
    expect(
      rulesInForce([everybody, theTeam, kwame], on('2026-06-01')).map((each) => each.id),
    ).toEqual(['3', '2', '1']);
  });

  it('leaves out what does not apply to this person or this day', () => {
    const inForce = rulesInForce([everybody, expired, someoneElse], on('2026-06-01'));

    expect(inForce.map((each) => each.id)).toEqual(['1']);
  });

  it('agrees with the resolved answer, which is its first entry', () => {
    const rules = [everybody, theTeam, kwame, expired, someoneElse];

    expect(resolve(rules, on('2026-06-01'))).toBe(rulesInForce(rules, on('2026-06-01'))[0]);
  });

  it('leaves the array it was given alone rather than sorting it in place', () => {
    const rules = [everybody, kwame, theTeam];

    rulesInForce(rules, on('2026-06-01'));

    expect(rules.map((each) => each.id)).toEqual(['1', '3', '2']);
  });
});

describe('the ordering itself', () => {
  /* Ids are bigints held as strings. The third key is unreachable while the
     unique index stands, and it still has to be an ordering rather than a
     comparison that reads '9' as greater than '10'. */
  it('breaks an impossible tie by the row written later', () => {
    const nine = rule({ id: '9' });
    const ten = rule({ id: '10' });

    expect(byPrecedence(nine, ten)).toBeGreaterThan(0);
    expect(byPrecedence(ten, nine)).toBeLessThan(0);
  });

  it('is the same comparison in both directions, so a sort is stable', () => {
    const earlier = rule({ id: '1', effectiveFrom: '2026-01-01' });
    const later = rule({ id: '2', effectiveFrom: '2027-01-01' });

    expect(byPrecedence(earlier, later)).toBeGreaterThan(0);
    expect(byPrecedence(later, earlier)).toBeLessThan(0);
    expect(byPrecedence(earlier, earlier)).toBe(0);
  });
});

describe('a rule that has taken effect is history', () => {
  const today = '2026-08-29';

  it('counts a rule starting after today as a draft', () => {
    expect(isStillADraft(rule({ effectiveFrom: '2026-08-30' }), today)).toBe(true);
  });

  /* Today is not a draft. Somebody may already have been told what they are owed
     this morning, which is the whole reason the comparison is strict. */
  it('counts a rule starting today as already applying', () => {
    expect(isStillADraft(rule({ effectiveFrom: today }), today)).toBe(false);
    expect(isStillADraft(rule({ effectiveFrom: '2026-08-28' }), today)).toBe(false);
  });

  it('lets a draft be corrected', () => {
    expect(() => assertMayBeCorrected(rule({ effectiveFrom: '2027-01-01' }), today)).not.toThrow();
  });

  it('refuses to let one that applies be changed, and says what to do instead', () => {
    const applied = rule({ id: '4', effectiveFrom: '2026-01-01' });

    expect(() => assertMayBeCorrected(applied, today)).toThrow(EntitlementRuleAlreadyApplies);

    try {
      assertMayBeCorrected(applied, today);
    } catch (error) {
      expect((error as Error).message).toContain('2026-01-01');
      expect((error as Error).message).toContain('later date');
      expect((error as EntitlementRuleAlreadyApplies).entitlementRuleId).toBe('4');
    }
  });

  it('names the thing that was actually attempted', () => {
    const applied = rule({ effectiveFrom: '2026-01-01' });

    expect(() => assertMayBeCorrected(applied, today, 'withdrawn')).toThrow(/withdrawn/);
    expect(() => assertMayBeCorrected(applied, today, 'changed')).toThrow(/changed/);
  });
});

describe('a closed leave year is never reached back into', () => {
  it('refuses a rule dated before the earliest open day', () => {
    expect(() => assertDoesNotReachIntoAClosedYear('2025-06-01', '2026-01-01')).toThrow(
      ReachesIntoAClosedYear,
    );
  });

  it('allows one starting on the first open day', () => {
    expect(() => assertDoesNotReachIntoAClosedYear('2026-01-01', '2026-01-01')).not.toThrow();
  });

  it('allows one starting later still', () => {
    expect(() => assertDoesNotReachIntoAClosedYear('2027-04-01', '2026-01-01')).not.toThrow();
  });

  /* Null is the check answered, not the check skipped. On go live nothing has
     been closed, and entering the current policy from 1 January is exactly what
     HR has to be able to do. */
  it('allows any date at all where no year has been closed', () => {
    expect(() => assertDoesNotReachIntoAClosedYear('2019-01-01', null)).not.toThrow();
  });

  it('says which date it would have to start from instead', () => {
    try {
      assertDoesNotReachIntoAClosedYear('2025-06-01', '2026-01-01');
    } catch (error) {
      expect((error as Error).message).toContain('2026-01-01');
      expect((error as ReachesIntoAClosedYear).effectiveFrom).toBe('2025-06-01');
    }
  });

  it('has a boundary of nothing until leave years exist', async () => {
    await expect(NOTHING_IS_CLOSED_YET()).resolves.toBeNull();
  });
});

describe('validating a new rule', () => {
  const sound = { leaveTypeId: '1', entitlementDays: 20, effectiveFrom: '2026-01-01' };

  it('fills in the defaults, so the record read back is the record written', () => {
    expect(validateNewEntitlementRule(sound)).toEqual({
      leaveTypeId: '1',
      employeeId: null,
      departmentId: null,
      entitlementDays: 20,
      prorateOnJoin: false,
      carriesOver: false,
      carryoverMaxDays: null,
      carryoverExpiryMonth: null,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      note: null,
    });
  });

  it('refuses a rule naming both an employee and a department', () => {
    expect(() =>
      validateNewEntitlementRule({ ...sound, employeeId: '7', departmentId: '3' }),
    ).toThrow(InvalidEntitlementRule);
  });

  it('accepts either scope on its own', () => {
    expect(validateNewEntitlementRule({ ...sound, employeeId: '7' }).employeeId).toBe('7');
    expect(validateNewEntitlementRule({ ...sound, departmentId: '3' }).departmentId).toBe('3');
  });

  /* FR 24. Whole days only, and the refusal says so, because a half day is a
     thing this company settles with a manager rather than a thing it stores. */
  it('refuses a fraction of a day', () => {
    expect(() => validateNewEntitlementRule({ ...sound, entitlementDays: 20.5 })).toThrow(
      /whole number/,
    );
  });

  it('refuses a negative allowance', () => {
    expect(() => validateNewEntitlementRule({ ...sound, entitlementDays: -1 })).toThrow(
      InvalidEntitlementRule,
    );
  });

  it('accepts zero, which is a decision rather than an absence', () => {
    expect(validateNewEntitlementRule({ ...sound, entitlementDays: 0 }).entitlementDays).toBe(0);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => validateNewEntitlementRule({ ...sound, effectiveTo: '2025-12-31' })).toThrow(
      /before it starts/,
    );
  });

  it('accepts a period that ends on the day it starts', () => {
    expect(validateNewEntitlementRule({ ...sound, effectiveTo: '2026-01-01' }).effectiveTo).toBe(
      '2026-01-01',
    );
  });

  it('refuses a date that is not ten characters of YYYY-MM-DD', () => {
    expect(() => validateNewEntitlementRule({ ...sound, effectiveFrom: '01/01/2026' })).toThrow(
      InvalidEntitlementRule,
    );
    expect(() => validateNewEntitlementRule({ ...sound, effectiveFrom: '2026-02-31' })).toThrow(
      InvalidEntitlementRule,
    );
  });

  it('refuses a carry over cap where nothing carries over', () => {
    expect(() =>
      validateNewEntitlementRule({ ...sound, carriesOver: false, carryoverMaxDays: 5 }),
    ).toThrow(InvalidEntitlementRule);
  });

  it('refuses an expiry month where nothing carries over', () => {
    expect(() =>
      validateNewEntitlementRule({ ...sound, carriesOver: false, carryoverExpiryMonth: 3 }),
    ).toThrow(InvalidEntitlementRule);
  });

  it('accepts carrying over with neither, which is uncapped and never expiring', () => {
    const carried = validateNewEntitlementRule({ ...sound, carriesOver: true });

    expect(carried.carriesOver).toBe(true);
    expect(carried.carryoverMaxDays).toBeNull();
    expect(carried.carryoverExpiryMonth).toBeNull();
  });

  it('refuses a cap of no days, which is not carrying over', () => {
    expect(() =>
      validateNewEntitlementRule({ ...sound, carriesOver: true, carryoverMaxDays: 0 }),
    ).toThrow(InvalidEntitlementRule);
  });

  it('refuses a month outside the year', () => {
    for (const month of [0, 13, 1.5]) {
      expect(() =>
        validateNewEntitlementRule({
          ...sound,
          carriesOver: true,
          carryoverExpiryMonth: month,
        }),
      ).toThrow(InvalidEntitlementRule);
    }
  });

  it('reports the field a refusal is about, so a form can point at it', () => {
    try {
      validateNewEntitlementRule({ ...sound, employeeId: '7', departmentId: '3' });
    } catch (error) {
      expect((error as InvalidEntitlementRule).field).toBe('departmentId');
    }
  });

  it('trims a note and treats a blank one as none', () => {
    expect(validateNewEntitlementRule({ ...sound, note: '  board minute 4  ' }).note).toBe(
      'board minute 4',
    );
    expect(validateNewEntitlementRule({ ...sound, note: '   ' }).note).toBeNull();
  });
});

describe('validating a change to a draft', () => {
  const current = rule({
    id: '1',
    carriesOver: true,
    carryoverMaxDays: 5,
    effectiveFrom: '2027-01-01',
    effectiveTo: '2027-12-31',
  });

  it('returns only what the change actually named', () => {
    expect(validateEntitlementRuleChanges({ entitlementDays: 22 }, current)).toEqual({
      entitlementDays: 22,
    });
  });

  it('changes nothing when nothing was named', () => {
    expect(validateEntitlementRuleChanges({}, current)).toEqual({});
  });

  /* Both pairs that have to agree can be half mentioned, so a change is judged
     against the record as it will be rather than against the change alone. */
  it('judges a carry over cap against the flag already on the row', () => {
    expect(validateEntitlementRuleChanges({ carryoverMaxDays: 10 }, current)).toEqual({
      carryoverMaxDays: 10,
    });

    expect(() => validateEntitlementRuleChanges({ carriesOver: false }, current)).toThrow(
      InvalidEntitlementRule,
    );
  });

  it('judges a new start date against the end date already on the row', () => {
    expect(() => validateEntitlementRuleChanges({ effectiveFrom: '2028-01-01' }, current)).toThrow(
      /before it starts/,
    );

    expect(validateEntitlementRuleChanges({ effectiveFrom: '2027-06-01' }, current)).toEqual({
      effectiveFrom: '2027-06-01',
    });
  });

  it('lets a scope be cleared, which is different from leaving it alone', () => {
    const personal = rule({ employeeId: '7', effectiveFrom: '2027-01-01' });

    expect(validateEntitlementRuleChanges({ employeeId: null }, personal)).toEqual({
      employeeId: null,
    });
    expect(validateEntitlementRuleChanges({}, personal)).toEqual({});
  });

  it('refuses a change that would name both scopes at once', () => {
    const personal = rule({ employeeId: '7', effectiveFrom: '2027-01-01' });

    expect(() => validateEntitlementRuleChanges({ departmentId: '3' }, personal)).toThrow(
      InvalidEntitlementRule,
    );
  });
});
