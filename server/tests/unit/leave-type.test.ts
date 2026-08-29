import { describe, expect, it } from 'vitest';
import {
  assertEligible,
  assertMayBeSplit,
  assertStillOffered,
  assertWithinBackdatingWindow,
  balanceMayBeExceededWithDocument,
  byDisplayOrder,
  countsWorkingDays,
  documentationRequired,
  grantExpires,
  hasRunningBalance,
  InvalidLeaveType,
  type LeaveType,
  LeaveTypeMayNotBeSplit,
  LeaveTypeRetired,
  type NewLeaveType,
  NotEligibleForLeaveType,
  noticeShortfall,
  TooLateToRecord,
  validateLeaveTypeChanges,
  validateNewLeaveType,
} from '../../src/domain/leave-type.js';

/**
 * A leave type and the rules it carries. FR 21, FR 31, FR 32, §5.5. LMS 201.
 *
 * The whole of the shaping is pure functions, so this is where the story is
 * proved. ../integration/leave-type.test.ts shows that the service asks the
 * policy, that the database holds the same rules as constraints, and that the
 * seven types of FR 32 are on a migrated database with the shapes §4.3.1 gives
 * them.
 *
 * The property every test below is really about: **a rule is a field, and no rule
 * is a branch on a code.** Nothing here constructs a type by name and expects
 * behaviour from it; every assertion sets the field the rule is about and reads
 * the answer back. A test that said "maternity counts calendar days" would be
 * asserting the fixture rather than the system, which is precisely the mistake
 * design principle 5 of the Technical Design Document warns about.
 *
 * Two distinctions get the most attention, because both are pairs of rules that
 * look alike and behave differently, and getting either backwards produces a
 * system that is wrong for one type at a time:
 *
 *   Notice warns and backdating refuses. FR 17 against FR 18.
 *
 *   A documentation threshold is about the length of the request; an exceedable
 *   balance is about the yearly allowance. FR 13 against FR 32a.
 */

/** The fields every type has to name, so a test can vary only what it is about. */
const SOUND: NewLeaveType = {
  code: 'ANNUAL',
  name: 'Annual Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'QUOTA',
};

/** A stored record, built from the same validation a real one goes through. */
function stored(overrides: Partial<NewLeaveType> = {}, isActive = true): LeaveType {
  return {
    id: '1',
    ...validateNewLeaveType({ ...SOUND, ...overrides }),
    deductsFromAnnual: false,
    isActive,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** The field a refusal blamed, which is what a form puts the message next to. */
function refusedField(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidLeaveType);
    return (error as InvalidLeaveType).field;
  }

  throw new Error('That was accepted, and should not have been.');
}

describe('a new type', () => {
  it('carries every rule the story asks for, and defaults the rest', () => {
    expect(validateNewLeaveType(SOUND)).toEqual({
      code: 'ANNUAL',
      name: 'Annual Leave',
      description: null,
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      isPaid: true,
      unit: 'DAYS',
      documentation: 'NOT_REQUIRED',
      documentationAfterDays: null,
      exceedableWithDocument: false,
      entitlementExpiryMonths: null,
      mayBeSplit: true,
      minNoticeCalendarDays: 0,
      /* FR 18 and the TDD's column default. Every type may be recorded a week
         late, because every type can be overtaken by events. */
      maxBackdateCalendarDays: 7,
      genderRestriction: null,
      displayOrder: 0,
      /* FR 38a and LMS 204's second criterion. Manager then HR, applied here
         rather than left to the writer, so that a type created through a form
         that said nothing about approvals reads as the type it is straight away.
         What a chain is and what makes one nonsense is ./approval-chain.test.ts. */
      approvalChain: ['MANAGER', 'HR'],
    });
  });

  it('takes every rule when every rule is given', () => {
    const type = validateNewLeaveType({
      code: 'paternity',
      name: '  Paternity Leave  ',
      description: '  Usable within six months of the birth.  ',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
      isPaid: true,
      unit: 'WEEKS',
      entitlementExpiryMonths: 6,
      mayBeSplit: true,
      genderRestriction: 'MALE',
      displayOrder: 5,
    });

    expect(type.code).toBe('PATERNITY');
    expect(type.name).toBe('Paternity Leave');
    expect(type.description).toBe('Usable within six months of the birth.');
    expect(type.unit).toBe('WEEKS');
    expect(type.entitlementExpiryMonths).toBe(6);
  });

  it('names the field when a closed set is given something outside it', () => {
    expect(
      refusedField(() => validateNewLeaveType({ ...SOUND, countingBasis: 'HOURS' as never })),
    ).toBe('countingBasis');
    expect(
      refusedField(() => validateNewLeaveType({ ...SOUND, entitlementBasis: 'ACCRUED' as never })),
    ).toBe('entitlementBasis');
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, unit: 'HOURS' as never }))).toBe(
      'unit',
    );
  });
});

describe('the code', () => {
  it('is uppercased, so a type is one type however it was typed', () => {
    expect(validateNewLeaveType({ ...SOUND, code: ' annual ' }).code).toBe('ANNUAL');
  });

  /* A code is a column heading in an export and a value in the import of FR 08,
     and one with a space or a comma in it breaks both — months later, and for
     somebody who did not type it. */
  it.each([['ANNUAL LEAVE'], ['ANNUAL,SICK'], ['_ANNUAL'], ['ANNUAL-LEAVE']])(
    'refuses %s, which would not survive a spreadsheet',
    (code) => {
      expect(refusedField(() => validateNewLeaveType({ ...SOUND, code }))).toBe('code');
    },
  );

  /* MAT_EXT_UNPAID is the shipped type this rule has to accept. */
  it.each([['ANNUAL'], ['MAT_EXT_UNPAID'], ['A1']])('accepts %s', (code) => {
    expect(validateNewLeaveType({ ...SOUND, code }).code).toBe(code);
  });

  it('refuses a blank one and one too long for the column', () => {
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, code: '   ' }))).toBe('code');
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, code: 'A'.repeat(41) }))).toBe(
      'code',
    );
  });
});

describe('the name and description', () => {
  it('are trimmed, because they are copied off a handbook more often than typed', () => {
    const type = validateNewLeaveType({
      ...SOUND,
      name: ' Annual Leave ',
      description: ' Yours. ',
    });

    expect(type.name).toBe('Annual Leave');
    expect(type.description).toBe('Yours.');
  });

  /* One representation of "nobody wrote one", so a screen has one thing to test. */
  it('read a blank description as none at all', () => {
    expect(validateNewLeaveType({ ...SOUND, description: '   ' }).description).toBeNull();
  });

  it('refuse a blank name or one longer than the column holds', () => {
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, name: ' ' }))).toBe('name');
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, name: 'x'.repeat(81) }))).toBe(
      'name',
    );
  });
});

describe('the documentation rule and its threshold, FR 13', () => {
  /* The one pair the SRS and the TDD both leave unguarded, and a real fault:
     `requires_attachment` and `attachment_required_after_days` are two columns
     describing one rule, and either can be set without the other. */
  it('refuses a rule of AFTER_DAYS with no number to read', () => {
    expect(
      refusedField(() => validateNewLeaveType({ ...SOUND, documentation: 'AFTER_DAYS' })),
    ).toBe('documentationAfterDays');
  });

  it.each([['NOT_REQUIRED'], ['ALWAYS']] as const)(
    'refuses a number beside %s, which would never be read',
    (documentation) => {
      expect(
        refusedField(() =>
          validateNewLeaveType({ ...SOUND, documentation, documentationAfterDays: 2 }),
        ),
      ).toBe('documentationAfterDays');
    },
  );

  it('refuses a threshold of zero rather than reading it as always', () => {
    expect(
      refusedField(() =>
        validateNewLeaveType({
          ...SOUND,
          documentation: 'AFTER_DAYS',
          documentationAfterDays: 0,
        }),
      ),
    ).toBe('documentationAfterDays');
  });

  const afterTwo = stored({ documentation: 'AFTER_DAYS', documentationAfterDays: 2 });

  /* "Documentation after two days" means two days is fine and the third is not.
     Backwards, it sends everybody with a two day absence to a clinic. */
  it('asks after the threshold, not at it', () => {
    expect(documentationRequired(afterTwo, 1)).toBe(false);
    expect(documentationRequired(afterTwo, 2)).toBe(false);
    expect(documentationRequired(afterTwo, 3)).toBe(true);
  });

  it('asks always, or never, when that is the rule', () => {
    expect(documentationRequired(stored({ documentation: 'ALWAYS' }), 1)).toBe(true);
    expect(documentationRequired(stored(), 99)).toBe(false);
  });
});

describe('an exceedable balance, FR 32a', () => {
  /**
   * The distinction this story is easiest to get wrong.
   *
   * Sick leave's three days is "a documentation threshold, not a hard cap", and
   * the threshold is the *yearly allowance* rather than the length of the
   * request. A four day absence by somebody who has taken no sick leave all year
   * needs nothing; the fourth day of the year does. Reading it as a
   * documentation rule would demand a certificate from the first person to be
   * ill for most of a week and let the person on their ninth day through.
   */
  const sick = stored({ exceedableWithDocument: true });

  it('is a separate rule from the documentation threshold, and off by default', () => {
    expect(balanceMayBeExceededWithDocument(sick)).toBe(true);
    expect(balanceMayBeExceededWithDocument(stored())).toBe(false);

    // And it says nothing about the length of a request, however long.
    expect(documentationRequired(sick, 40)).toBe(false);
  });
});

describe('the entitlement expiry, FR 32e', () => {
  /* Paternity, and today only paternity: 14 days per birth usable within six
     months. Not carry over — unused annual days rolling forward is FR 36 and
     lives on leave_entitlement_rule with the effective dates. */
  it('says whether an unused grant lapses', () => {
    expect(grantExpires(stored({ entitlementBasis: 'EVENT', entitlementExpiryMonths: 6 }))).toBe(
      true,
    );
    expect(grantExpires(stored())).toBe(false);
  });

  it('refuses zero months, which would lapse the grant immediately', () => {
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, entitlementExpiryMonths: 0 }))).toBe(
      'entitlementExpiryMonths',
    );
  });

  /* Deliberately no rule tying this to an entitlement basis. An earlier draft
     refused an expiry on anything but a QUOTA type, which is exactly backwards:
     paternity is the one type that has one and it is EVENT based. */
  it('is allowed on an event type, which is the only kind that has one today', () => {
    expect(() =>
      validateNewLeaveType({ ...SOUND, entitlementBasis: 'EVENT', entitlementExpiryMonths: 6 }),
    ).not.toThrow();
  });
});

describe('the two windows', () => {
  /**
   * FR 17 against FR 18, and they are not symmetrical.
   *
   * Annual leave carries both: fourteen days of expected notice and seven days
   * of permitted backdating. An earlier draft of this file held them to be
   * mutually exclusive, which would have made the one type everybody uses
   * unconfigurable.
   */
  const annual = stored({ minNoticeCalendarDays: 14 });

  it('are both set on annual leave, which is what the SRS asks for', () => {
    expect(annual.minNoticeCalendarDays).toBe(14);
    expect(annual.maxBackdateCalendarDays).toBe(7);
  });

  /* FR 17: "the system shall warn and require the employee to acknowledge, then
     allow it through, since whether short notice is workable is a judgement for
     the approvers". A number, not a refusal. */
  it('report a notice shortfall rather than refusing it', () => {
    expect(noticeShortfall(annual, 14)).toBe(0);
    expect(noticeShortfall(annual, 30)).toBe(0);
    expect(noticeShortfall(annual, 10)).toBe(4);
    expect(noticeShortfall(annual, 0)).toBe(14);
  });

  it('report no shortfall at all for a type that asks for no notice', () => {
    expect(noticeShortfall(stored(), 0)).toBe(0);
  });

  /* FR 18, and this one does refuse: beyond the window "only HR may enter the
     record, with a reason". */
  it('refuse backdating past the window, and permit it up to it', () => {
    expect(() => assertWithinBackdatingWindow(annual, -7)).not.toThrow();
    expect(() => assertWithinBackdatingWindow(annual, -8)).toThrow(TooLateToRecord);
  });

  it('treat a request made on the day as notice of none, not as backdating', () => {
    expect(() => assertWithinBackdatingWindow(stored(), 0)).not.toThrow();
  });

  /* The person who hits this cannot use the exemption themselves, so the message
     has to name who can. NFR USA 03: say what to do, not only what is wrong. */
  it('name HR in the refusal, because HR is the way past it', () => {
    try {
      assertWithinBackdatingWindow(annual, -30);
    } catch (error) {
      expect((error as TooLateToRecord).permitted).toBe(7);
      expect((error as TooLateToRecord).daysAgo).toBe(30);
      expect((error as Error).message).toMatch(/Ask HR/);
    }
  });

  it('treat a backdated request as short of the whole notice period', () => {
    // It gave no notice at all, which is the largest shortfall there is.
    expect(noticeShortfall(annual, -3)).toBe(14);
  });

  it('refuse a negative window, a fractional one, and one in the wrong unit', () => {
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, minNoticeCalendarDays: -1 }))).toBe(
      'minNoticeCalendarDays',
    );
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, minNoticeCalendarDays: 1.5 }))).toBe(
      'minNoticeCalendarDays',
    );
    // 366 is somebody who meant days typing a year. The refusal names the unit.
    expect(refusedField(() => validateNewLeaveType({ ...SOUND, minNoticeCalendarDays: 366 }))).toBe(
      'minNoticeCalendarDays',
    );
  });

  it('refuse half a day of notice from a caller rather than rounding it', () => {
    expect(refusedField(() => noticeShortfall(annual, 7.5))).toBe('daysOfNotice');
    expect(refusedField(() => assertWithinBackdatingWindow(annual, -7.5))).toBe('daysOfNotice');
  });
});

describe('the gender restriction, FR 05', () => {
  const maternity = stored({
    countingBasis: 'CALENDAR_DAYS',
    entitlementBasis: 'EVENT',
    genderRestriction: 'FEMALE',
  });

  it('is absent by default, which is what most types are', () => {
    expect(validateNewLeaveType(SOUND).genderRestriction).toBeNull();
  });

  it('is one of the two an employee record can hold', () => {
    expect(
      refusedField(() => validateNewLeaveType({ ...SOUND, genderRestriction: 'OTHER' as never })),
    ).toBe('genderRestriction');
  });

  it('lets an unrestricted type through for anybody, recorded or not', () => {
    expect(() => assertEligible(stored(), 'MALE')).not.toThrow();
    expect(() => assertEligible(stored(), null)).not.toThrow();
  });

  it('lets the restriction through for somebody it names and refuses somebody it does not', () => {
    expect(() => assertEligible(maternity, 'FEMALE')).not.toThrow();
    expect(() => assertEligible(maternity, 'MALE')).toThrow(NotEligibleForLeaveType);
  });

  /* FR 05 makes the column optional and limits it "to eligibility checks only".
     Refusing an incomplete record as ineligible would quietly make it mandatory
     after all, and would be a lie: nobody has established that they are. */
  it('tells a record that says nothing apart from one that says otherwise', () => {
    try {
      assertEligible(maternity, null);
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect((error as NotEligibleForLeaveType).genderNotRecorded).toBe(true);
      expect((error as Error).message).toMatch(/does not say/);
    }

    try {
      assertEligible(maternity, 'MALE');
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect((error as NotEligibleForLeaveType).genderNotRecorded).toBe(false);
      expect((error as Error).message).not.toMatch(/does not say/);
    }
  });
});

describe('a change to an existing type', () => {
  it('touches only what it names', () => {
    expect(validateLeaveTypeChanges({ name: 'Vacation' }, stored())).toEqual({ name: 'Vacation' });
  });

  /* The reason this function takes the current record and the department and
     working pattern ones do not: the rule spans two fields and the change names
     one of them. */
  it('judges the documentation pair against the record as it will be', () => {
    const current = stored({ documentation: 'AFTER_DAYS', documentationAfterDays: 2 });

    // The threshold is already there, so naming only the rule is complete.
    expect(() => validateLeaveTypeChanges({ documentation: 'AFTER_DAYS' }, current)).not.toThrow();

    // And taking the rule away without the threshold leaves a figure nothing reads.
    expect(refusedField(() => validateLeaveTypeChanges({ documentation: 'ALWAYS' }, current))).toBe(
      'documentationAfterDays',
    );
  });

  it('lets both halves move together in one change', () => {
    const current = stored({ documentation: 'AFTER_DAYS', documentationAfterDays: 2 });

    expect(
      validateLeaveTypeChanges({ documentation: 'ALWAYS', documentationAfterDays: null }, current),
    ).toEqual({ documentation: 'ALWAYS', documentationAfterDays: null });
  });

  /* FR 31, which is the story: no leave rule requires a code change. Each of
     these was one in the system this replaces. */
  it('moves a counting basis, a notice window and an exceedable balance', () => {
    const current = stored();

    expect(
      validateLeaveTypeChanges(
        {
          countingBasis: 'CALENDAR_DAYS',
          minNoticeCalendarDays: 21,
          exceedableWithDocument: true,
        },
        current,
      ),
    ).toEqual({
      countingBasis: 'CALENDAR_DAYS',
      minNoticeCalendarDays: 21,
      exceedableWithDocument: true,
    });
  });
});

describe('the counting basis, FR 21', () => {
  it('says whether the working pattern is consulted at all', () => {
    expect(countsWorkingDays(stored({ countingBasis: 'WORKING_DAYS' }))).toBe(true);
    expect(countsWorkingDays(stored({ countingBasis: 'CALENDAR_DAYS' }))).toBe(false);
  });
});

describe('the entitlement basis, FR 32g', () => {
  it('says whether the year rollover opens a balance to be short of', () => {
    expect(hasRunningBalance(stored({ entitlementBasis: 'QUOTA' }))).toBe(true);
    expect(hasRunningBalance(stored({ entitlementBasis: 'EVENT' }))).toBe(false);
  });
});

describe('splitting, §8.6aa', () => {
  it('allows one period whatever the rule says, because that is not a split', () => {
    expect(() => assertMayBeSplit(stored({ mayBeSplit: false }), 1)).not.toThrow();
  });

  it('refuses more than one where the type must be continuous', () => {
    expect(() => assertMayBeSplit(stored({ mayBeSplit: false }), 2)).toThrow(
      LeaveTypeMayNotBeSplit,
    );
  });

  it('allows more than one where it may be split, which is every type today', () => {
    expect(() => assertMayBeSplit(stored(), 4)).not.toThrow();
  });
});

describe('a retired type', () => {
  it('is closed to anything new', () => {
    expect(() => assertStillOffered(stored({}, false))).toThrow(LeaveTypeRetired);
  });

  it('and an offered one is not', () => {
    expect(() => assertStillOffered(stored())).not.toThrow();
  });
});

describe('the display order, §7.4', () => {
  it('sorts by the order HR set, then by name so two equals are still fixed', () => {
    const types = [
      stored({ name: 'Unpaid Leave', code: 'UNPAID', displayOrder: 6 }),
      stored({ name: 'Annual Leave', displayOrder: 1 }),
      stored({ name: 'Bereavement', code: 'BEREAVEMENT', displayOrder: 6 }),
    ];

    expect([...types].sort(byDisplayOrder).map((type) => type.name)).toEqual([
      'Annual Leave',
      'Bereavement',
      'Unpaid Leave',
    ]);
  });
});

describe('no rule is a branch on a code', () => {
  /**
   * Design principle 5 of the Technical Design Document, said as a test.
   *
   * "If either is written as an `if` on a type code, every future leave type
   * becomes a code change." Two types with the same code and opposite rules
   * answer according to their rules — so a type called MATERNITY that an HR
   * Administrator has reconfigured to count working days counts working days,
   * which is exactly what they should get and exactly what a hard coded system
   * would not give them.
   */
  it('two types with one code and opposite rules answer differently', () => {
    const asShipped = stored({
      code: 'MATERNITY',
      name: 'Maternity Leave',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
      mayBeSplit: false,
      genderRestriction: 'FEMALE',
      documentation: 'ALWAYS',
    });
    const asReconfigured = stored({
      code: 'MATERNITY',
      name: 'Parental Leave',
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      mayBeSplit: true,
      genderRestriction: null,
      documentation: 'NOT_REQUIRED',
    });

    expect(countsWorkingDays(asShipped)).toBe(false);
    expect(countsWorkingDays(asReconfigured)).toBe(true);

    expect(hasRunningBalance(asShipped)).toBe(false);
    expect(hasRunningBalance(asReconfigured)).toBe(true);

    expect(documentationRequired(asShipped, 1)).toBe(true);
    expect(documentationRequired(asReconfigured, 1)).toBe(false);

    expect(() => assertMayBeSplit(asShipped, 2)).toThrow();
    expect(() => assertMayBeSplit(asReconfigured, 2)).not.toThrow();

    expect(() => assertEligible(asShipped, 'MALE')).toThrow();
    expect(() => assertEligible(asReconfigured, 'MALE')).not.toThrow();
  });
});
