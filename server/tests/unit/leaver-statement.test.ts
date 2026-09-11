import { describe, expect, it } from 'vitest';
import { type LeaveBalance, noMovementsYet } from '../../src/features/balance/balance.js';
import {
  accruesOverTheYear,
  linesFor,
  NoLeaveYearCoversTheExitDate,
  exitDateOf,
  type LeaverSettlementLine,
  settlementFor,
  type SettlementFacts,
  type SettlementStep,
  StillEmployed,
} from '../../src/features/balance/leaver-statement.js';
import { BY_COMPLETED_TWELFTHS } from '../../src/features/entitlement/pro-rata.js';
import type { EntitlementRule } from '../../src/features/entitlement/entitlement-rule.js';
import type { Employee } from '../../src/features/employee/employee.js';
import { type LeaveType, validateNewLeaveType } from '../../src/features/leave-type/leave-type.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';

/**
 * The leaver figure. FR 37a, §8.6d, §8.7. LMS 509.
 *
 * The whole of the figure is arithmetic on two dates and five stored columns, so nearly all
 * of the story is here. ../integration/leaver-figure.test.ts carries the two halves a pure
 * function cannot: that the figures are the ones a real ledger produced, and that recording
 * an exit really does cancel what nobody had decided.
 *
 * Four claims:
 *
 *   **The figure is the accrual, not the grant.** Somebody granted a whole year and gone in
 *   July is owed the part they worked. That difference is the story.
 *
 *   **Carried days are owed in full.** They were accrued in the year before, so nothing
 *   about this year's exit date pro rates them.
 *
 *   **Only what accrues is settled.** Asked of the entitlement rule's own column and never
 *   of a leave type code, so sick leave is out because a sick day is not accrued.
 *
 *   **The working adds up to the answer.** The steps that enter the sum sum to `owed`, which
 *   is what makes a payment checkable rather than a number to be trusted.
 */

const YEAR_2026: LeaveYear = year('2026', '2026-01-01', '2026-12-31');

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
  displayOrder: 2,
});

const COMPASSIONATE = leaveType({
  code: 'COMPASSIONATE',
  name: 'Compassionate Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'EVENT',
  displayOrder: 3,
});

/** FR 28. Twenty days, pro rated for a part year, and the only shipped figure that is. */
const TWENTY_ACCRUING = rule(ANNUAL, 20, { prorateOnJoin: true });

/** FR 32a. Three days, and not accrued: a joiner in December gets all three. */
const THREE_FLAT = rule(SICK, 3, { prorateOnJoin: false });

/* 2026-01-01 to 2026-07-31 is 212 of the year's 365 days, so 20 × 212/365 = 11.62. */
const KOJO = employee({ startDate: '2022-11-07', exitDate: '2026-07-31' });

describe('a figure that is only asked of somebody who has left', () => {
  it('is refused for somebody still here, and says what to do first', () => {
    const here = employee({ startDate: '2022-11-07', exitDate: null, status: 'ACTIVE' });

    expect(() => exitDateOf(here)).toThrow(StillEmployed);
    expect(() => exitDateOf(here)).toThrow(/has not left/);
  });

  /* Belt and braces the database also holds: employee_terminated_has_exit_date refuses the
     row. Asked here because an accrual with no end date would otherwise run to the year end
     and quietly answer a whole year. */
  it('and for a record marked as gone with no date on it', () => {
    expect(() =>
      exitDateOf(employee({ startDate: '2022-11-07', exitDate: null, status: 'TERMINATED' })),
    ).toThrow(StillEmployed);
  });

  it('and is their last day where the record has one', () => {
    expect(exitDateOf(KOJO)).toBe('2026-07-31');
  });
});

describe('which kinds of leave are settled', () => {
  /**
   * FR 37a's "only annual leave", and the reason it is not a code.
   *
   * `prorate_on_join` is the accrual flag. Annual leave carries it and nothing else shipped
   * does, so asking the column settles annual leave today and settles a second accruing type
   * the day HR writes one — with nothing here edited.
   */
  it('is whatever accrues over the year, read off the rule rather than the code', () => {
    expect(accruesOverTheYear({ type: ANNUAL, rule: TWENTY_ACCRUING })).toBe(true);
    expect(accruesOverTheYear({ type: SICK, rule: THREE_FLAT })).toBe(false);
  });

  /* An event type has no yearly figure at all — FR 32g — so there is nothing for a part year
     to be a part of, whatever its rule says. */
  it('and never a type granted per occasion, whatever its rule says', () => {
    expect(
      accruesOverTheYear({
        type: COMPASSIONATE,
        rule: rule(COMPASSIONATE, 5, { prorateOnJoin: true }),
      }),
    ).toBe(false);
  });

  it('and never a type no rule reaches, because there is no figure to pro rate', () => {
    expect(accruesOverTheYear({ type: ANNUAL, rule: undefined })).toBe(false);
    expect(
      accruesOverTheYear({ type: ANNUAL, rule: rule(ANNUAL, 0, { prorateOnJoin: true }) }),
    ).toBe(false);
  });

  it('so a statement carries the accruing type and leaves the rest off it', () => {
    const lines = linesFor(
      facts({
        entitlements: [
          { type: ANNUAL, rule: TWENTY_ACCRUING },
          { type: SICK, rule: THREE_FLAT },
          { type: COMPASSIONATE, rule: undefined },
        ],
        balances: [balance(ANNUAL, { entitled: 20, taken: 8 }), balance(SICK, { entitled: 3 })],
      }),
    );

    expect(lines.map((line) => line.code)).toEqual(['ANNUAL']);
  });
});

describe('the figure itself', () => {
  /**
   * The story's first criterion: accrued to the exit date, less taken, plus carried over.
   *
   * 20 × 212/365 = 11.62 accrued, 3 carried in, 8 taken, so 6.62 owed — against a balance
   * screen that says 15 are left, because that figure is drawn against a whole year's grant.
   */
  it('is the accrual to the exit date, less taken, plus carried over', () => {
    const line = onlyLine(
      facts({ balances: [balance(ANNUAL, { entitled: 20, carriedOver: 3, taken: 8 })] }),
    );

    expect(line.accrued).toBe(11.62);
    expect(line.granted).toBe(20);
    expect(line.grantedAhead).toBe(8.38);
    expect(line.carriedOver).toBe(3);
    expect(line.taken).toBe(8);
    expect(line.owed).toBe(6.62);
    expect(line.availableOnTheBalance).toBe(15);
  });

  /* FR 36. Days carried in were accrued in the year before, so this year's exit date has
     nothing to say about them. A carry pro rated a second time is days taken away twice. */
  it('and carried days are owed in full, whenever in the year somebody left', () => {
    const early = onlyLine(
      facts({
        employee: employee({ startDate: '2020-01-01', exitDate: '2026-01-31' }),
        balances: [balance(ANNUAL, { entitled: 20, carriedOver: 4 })],
      }),
    );

    expect(early.accrued).toBe(1.7);
    expect(early.owed).toBe(5.7);
  });

  /** FR 37. An adjustment is in the sum, signed, because it is days somebody is owed. */
  it('and an adjustment moves it the way it was posted', () => {
    expect(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20, adjustment: -2 })] })).owed,
    ).toBe(9.62);

    expect(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20, adjustment: 2 })] })).owed,
    ).toBe(13.62);
  });

  /**
   * And it goes below nought where more was taken than was accrued, rather than stopping there.
   *
   * Somebody who took their whole year in January and left in March has been overpaid, and a
   * figure clamped at nought would hide exactly the case FR 37a exists to surface.
   */
  it('and goes below nought where more was taken than accrued', () => {
    const line = onlyLine(
      facts({
        employee: employee({ startDate: '2020-01-01', exitDate: '2026-03-31' }),
        balances: [balance(ANNUAL, { entitled: 20, taken: 18 })],
      }),
    );

    expect(line.accrued).toBe(4.93);
    expect(line.owed).toBe(-13.07);
  });

  /* A joiner who also left inside the year moves both ends, which is `employedPortionOf`
     doing the same clipping at both — the property LMS 215 built it for. */
  it('and settles somebody who joined and left in the same year from both ends', () => {
    const line = onlyLine(
      facts({
        employee: employee({ startDate: '2026-04-01', exitDate: '2026-06-30' }),
        balances: [balance(ANNUAL, { entitled: 15.07 })],
      }),
    );

    expect(line.accrued).toBe(4.99);
    expect(line.owed).toBe(4.99);
  });

  /**
   * LMS 013. The rule is behind a name, so swapping it moves the figure and nothing else.
   *
   * The same test ../unit/pro-rata.test.ts makes about the grant, made about the settlement:
   * a candidate rule answering differently is what proves the seam is real rather than
   * decorative.
   */
  it('and follows whichever pro rata rule is in force', () => {
    const settlement = settlementFor(facts({}), BY_COMPLETED_TWELFTHS);

    expect(settlement.proRataRule.name).toBe('completed-twelfths');
    /* Six complete twelfths of 2026 by 31 July, against 11.62 under the rule in force. */
    expect(settlement.lines[0].accrued).toBe(10);
  });
});

describe('the working behind it', () => {
  /** The story's second criterion. The steps that enter the sum reach the answer. */
  it('adds up to the figure', () => {
    const line = onlyLine(
      facts({
        balances: [balance(ANNUAL, { entitled: 20, carriedOver: 3, adjustment: -1, taken: 8 })],
      }),
    );

    expect(sumOf(line.working)).toBe(line.owed);
    expect(line.owed).toBe(5.62);
  });

  it('and names every part of it, in the order the sum is performed', () => {
    const line = onlyLine(
      facts({
        balances: [balance(ANNUAL, { entitled: 20, carriedOver: 3, adjustment: -1, taken: 8 })],
      }),
    );

    expect(line.working.map((step) => step.label)).toEqual([
      'A whole year of Annual Leave',
      'Accrued to 2026-07-31',
      'Granted in 2026',
      'Carried over from the year before',
      'Adjusted by hand',
      'Taken',
      'Owed on exit',
    ]);
  });

  /* An adjustment of nothing is not a line of the working. A nought beside "adjusted by hand"
     reads as a correction somebody made, and nobody made one. */
  it('and leaves out an adjustment nobody posted', () => {
    const line = onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20 })] }));

    expect(line.working.map((step) => step.label)).not.toContain('Adjusted by hand');
  });

  /**
   * §8.6d. The arithmetic is written out, because a figure of 11.62 against twenty days is
   * the one a person queries, and "212 of the year's 365 days" is the answer.
   */
  it('and shows the accrual as the arithmetic it is', () => {
    const accrued = stepOf(onlyLine(facts({})), 'Accrued to 2026-07-31');

    expect(accrued.days).toBe(11.62);
    expect(accrued.part).toBe('ADDS');
    expect(accrued.says).toContain('2026-01-01 to 2026-07-31');
    expect(accrued.says).toContain('212 days');
    expect(accrued.says).toContain('365 days');
  });

  /**
   * FR 37a's comparison, said in words: what was granted against what the part year is worth.
   *
   * It explains the figure rather than entering it, which is the distinction `part` carries —
   * a grant already in the balance is not a term of the sum.
   */
  it('and says how far the grant ran ahead of the accrual, without adding it in', () => {
    const granted = stepOf(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20 })] })),
      'Granted in 2026',
    );

    expect(granted.part).toBe('EXPLAINS');
    expect(granted.days).toBe(20);
    expect(granted.says).toContain('8.38 days');
  });

  /* The opposite case, which is a run of the annual grant that never reached this person.
     Told apart from the ordinary one, because only one of the two is somebody's mistake. */
  it('and says so the other way where the year was granted short', () => {
    const granted = stepOf(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 5 })] })),
      'Granted in 2026',
    );

    expect(granted.says).toContain('less than was accrued');
  });

  /**
   * FR 46, §8.7. Days still held are the story's fourth criterion failing, so they are said
   * rather than quietly left out of a sum they are not part of.
   */
  it('and points out days still held, which an exit should have left none of', () => {
    const held = stepOf(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20, pending: 4 })] })),
      'Still being decided',
    );

    expect(held.part).toBe('EXPLAINS');
    expect(held.says).toContain('cancelled when the exit is recorded');
  });

  it('and says nothing about days held where none are', () => {
    const line = onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20 })] }));

    expect(line.working.map((step) => step.label)).not.toContain('Still being decided');
  });

  /* The last step is the answer, and it says which way it went. A signed number on its own
     is the thing this screen exists to replace. */
  it('and ends with the answer, said rather than left as a sign', () => {
    const owed = stepOf(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20 })] })),
      'Owed on exit',
    );

    expect(owed.says).toContain('fall to the final payment');

    const overtaken = stepOf(
      onlyLine(facts({ balances: [balance(ANNUAL, { entitled: 20, taken: 18 })] })),
      'Owed on exit',
    );

    expect(overtaken.says).toContain('more Annual Leave were taken than were accrued');
  });
});

describe('the settlement as a whole', () => {
  it('carries who it is about, when they went, and the year it is settled against', () => {
    const settlement = settlementFor(facts({}));

    expect(settlement.name).toBe('Kojo Antwi');
    expect(settlement.exitDate).toBe('2026-07-31');
    expect(settlement.year.label).toBe('2026');
    expect(settlement.portion).toEqual({ from: '2026-01-01', to: '2026-07-31' });
    /** LMS 013. The figure says which rule produced it, as the grant's reason does. */
    expect(settlement.proRataRule.name).toBe('calendar-days');
  });

  /* A balance nothing has moved is not a missing balance. Somebody who left before the annual
     run reached them is owed the accrual all the same, and the working says the grant was short. */
  it('and settles a balance nothing has ever moved', () => {
    const line = onlyLine(facts({ balances: [] }));

    expect(line.granted).toBe(0);
    expect(line.owed).toBe(11.62);
  });

  /** The refusal a leave year nobody defined produces, kept apart from a figure of nought. */
  it('and the gap it cannot answer is named rather than answered', () => {
    expect(new NoLeaveYearCoversTheExitDate(KOJO, '2029-04-01').message).toContain('2029-04-01');
  });
});

/* -------------------------------------------------------------------------- fixtures */

/** The facts, with the accruing type and Kojo's dates unless a test says otherwise. */
function facts(over: Partial<SettlementFacts>): SettlementFacts {
  const who = over.employee ?? KOJO;

  return {
    employee: who,
    exitDate: over.exitDate ?? who.exitDate ?? '2026-07-31',
    year: over.year ?? YEAR_2026,
    entitlements: over.entitlements ?? [{ type: ANNUAL, rule: TWENTY_ACCRUING }],
    balances: over.balances ?? [balance(ANNUAL, { entitled: 20 })],
  };
}

function onlyLine(input: SettlementFacts): LeaverSettlementLine {
  const [line] = linesFor(input);

  if (line === undefined) {
    throw new Error('No line was settled, and every fixture here settles one.');
  }

  return line;
}

function stepOf(line: LeaverSettlementLine, label: string): SettlementStep {
  const step = line.working.find((one) => one.label === label);

  if (step === undefined) {
    throw new Error(
      `No step called ${label}. The working was ${line.working.map((one) => one.label).join(', ')}.`,
    );
  }

  return step;
}

/** The steps that enter the sum, summed. Two decimal places, as every figure here is. */
function sumOf(steps: readonly SettlementStep[]): number {
  const total = steps
    .filter((step) => step.part !== 'EXPLAINS')
    .reduce((running, step) => running + step.days, 0);

  return Math.round(total * 100) / 100;
}

function employee(over: {
  startDate: string;
  exitDate: string | null;
  status?: Employee['employmentStatus'];
}): Employee {
  return {
    id: 'employee-1',
    employeeNumber: 'RH-0013',
    firstName: 'Kojo',
    lastName: 'Antwi',
    workEmail: 'kojo.antwi@rematholdings.com',
    jobTitle: 'Operations Officer',
    departmentId: 'department-1',
    managerId: 'employee-2',
    workPatternId: 'pattern-1',
    startDate: over.startDate,
    exitDate: over.exitDate,
    employmentType: 'FULL_TIME',
    employmentStatus: over.status ?? 'TERMINATED',
    gender: 'MALE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function rule(
  type: LeaveType,
  entitlementDays: number,
  over: { prorateOnJoin: boolean },
): EntitlementRule {
  return {
    id: `rule-${type.code}`,
    leaveTypeId: type.id,
    employeeId: null,
    departmentId: null,
    entitlementDays,
    prorateOnJoin: over.prorateOnJoin,
    carriesOver: over.prorateOnJoin,
    carryoverMaxDays: null,
    carryoverExpiryMonth: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    note: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

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

function balance(type: LeaveType, figures: Partial<LeaveBalance>): LeaveBalance {
  return {
    ...noMovementsYet({
      employeeId: 'employee-1',
      leaveTypeId: type.id,
      leaveYearId: YEAR_2026.id,
    }),
    updatedAt: new Date('2026-03-01T09:00:00Z'),
    ...figures,
  };
}
