/** What a leaver is owed on their last day, and the working behind it. FR 37a, §8.6d, §8.7, LMS 509. */

import { available as availableOn, type LeaveBalance, noMovementsYet } from './balance.js';
import type { Employee } from '../employee/employee.js';
import {
  byDisplayOrder,
  type CountingBasis,
  countingBasisLabel,
  hasRunningBalance,
  isEligible,
  type LeaveType,
} from '../leave-type/leave-type.js';
import type { EntitlementRule } from '../entitlement/entitlement-rule.js';
import {
  type EmployedPortion,
  employedPortionOf,
  proRataDaysFor,
  type ProRataRule,
  THE_RULE_IN_FORCE,
} from '../entitlement/pro-rata.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import { calendarDaysBetween, type CalendarDate } from '../../shared/time.js';

/** Somebody still here, asked for a figure that only an ending produces. FR 06. */
export class StillEmployed extends Error {
  readonly employeeId: string;

  constructor(employee: Employee) {
    super(
      `${employee.firstName} ${employee.lastName} has not left. A leaver's figure is ` +
        `accrued to an exit date, and there is no exit date on this record. Record the ` +
        `leaving first; the figure follows from it.`,
    );
    this.name = 'StillEmployed';
    this.employeeId = employee.id;
  }
}

/** An exit date in no leave year anybody has defined. §5.4. */
export class NoLeaveYearCoversTheExitDate extends Error {
  readonly employeeId: string;
  readonly exitDate: CalendarDate;

  constructor(employee: Employee, exitDate: CalendarDate) {
    super(
      `No leave year covers ${exitDate}, so there is no year to settle against. Every ` +
        `balance is per person, per leave type, per leave year. Ask an HR Administrator ` +
        `to define the leave year that covers the exit date. §5.4.`,
    );
    this.name = 'NoLeaveYearCoversTheExitDate';
    this.employeeId = employee.id;
    this.exitDate = exitDate;
  }
}

/** Which way a step of the working moves the figure. */
export const SETTLEMENT_PARTS = ['ADDS', 'TAKES', 'EXPLAINS'] as const;

export type SettlementPart = (typeof SETTLEMENT_PARTS)[number];

/** One step of the working, in the order it is read. The story's second criterion. */
export interface SettlementStep {
  label: string;
  /** Signed as it enters the sum. An `EXPLAINS` step enters no sum. */
  days: number;
  part: SettlementPart;
  /** One sentence, so the step can be checked without the rest of the screen. */
  says: string;
}

/** One kind of leave settled on exit. FR 37a. */
export interface LeaverSettlementLine {
  leaveTypeId: string;
  code: string;
  name: string;
  countingBasis: CountingBasis;
  countingBasisLabel: string;
  /** What a whole year is worth, off the rule in force on the exit date. FR 32h. */
  fullYearDays: number;
  /** §8.6d, called with the exit date. */
  accrued: number;
  /** GRANT entries less LAPSE, which is what the year actually put in. */
  granted: number;
  /** `granted − accrued`. Positive where a whole year was granted and not worked. */
  grantedAhead: number;
  /** FR 36. */
  carriedOver: number;
  /** FR 37. */
  adjustment: number;
  taken: number;
  /** Nothing, once the exit cancelled what was still being decided. FR 46. */
  pending: number;
  /** `accrued + carriedOver + adjustment − taken`. FR 37a. */
  owed: number;
  /** What the balance screen says, which is a different question. §8.6. */
  availableOnTheBalance: number;
  working: SettlementStep[];
}

/** One leaver's final figure. FR 37a, §8.7. */
export interface LeaverSettlement {
  employeeId: string;
  employeeNumber: string;
  name: string;
  jobTitle: string | null;
  startDate: CalendarDate;
  exitDate: CalendarDate;
  /** The year the exit date falls in, which is the only year settled. */
  year: LeaveYear;
  /** The part of that year they were employed for. */
  portion: EmployedPortion;
  /** The rule the accrual was reached by, named on the figure it produced. LMS 013. */
  proRataRule: { name: string; says: string };
  lines: LeaverSettlementLine[];
}

/** One leave type and the rule reaching this person on the exit date. */
export interface TypeAndRule {
  type: LeaveType;
  rule: EntitlementRule | undefined;
}

/** Everything a settlement is assembled from, all of it read by the caller. */
export interface SettlementFacts {
  employee: Employee;
  exitDate: CalendarDate;
  year: LeaveYear;
  entitlements: readonly TypeAndRule[];
  balances: readonly LeaveBalance[];
}

/** Their last day, or a refusal. FR 06. */
export function exitDateOf(employee: Employee): CalendarDate {
  if (employee.employmentStatus !== 'TERMINATED' || employee.exitDate === null) {
    throw new StillEmployed(employee);
  }

  return employee.exitDate;
}

/**
 * Whether this type is settled on exit. FR 37a's "only annual leave", as a column.
 *
 * `prorate_on_join` is the accrual flag: annual leave is pro rated for part of a year and
 * sick leave is not, because a sick day is not something anybody accrues. Asked of the rule
 * rather than of a code, so a second accruing type HR writes next year is settled too.
 */
export function accruesOverTheYear({ type, rule }: TypeAndRule): boolean {
  return (
    hasRunningBalance(type) && rule !== undefined && rule.prorateOnJoin && rule.entitlementDays > 0
  );
}

/** The lines of one settlement, in the order §7.4 lists a balance. */
export function linesFor(
  facts: SettlementFacts,
  proRataRule: ProRataRule = THE_RULE_IN_FORCE,
): LeaverSettlementLine[] {
  const byType = new Map(
    facts.balances
      .filter((balance) => balance.leaveYearId === facts.year.id)
      .map((balance) => [balance.leaveTypeId, balance] as const),
  );

  return [...facts.entitlements]
    .filter(
      (entitlement) =>
        accruesOverTheYear(entitlement) && isEligible(entitlement.type, facts.employee.gender),
    )
    .sort((one, other) => byDisplayOrder(one.type, other.type))
    .map((entitlement) =>
      lineFor(
        {
          ...entitlement,
          year: facts.year,
          portion: portionOf(facts),
          balance:
            byType.get(entitlement.type.id) ??
            noMovementsYet({
              employeeId: facts.employee.id,
              leaveTypeId: entitlement.type.id,
              leaveYearId: facts.year.id,
            }),
        },
        proRataRule,
      ),
    );
}

/** One line: the accrual, the stored figures, and the working that joins them. */
export function lineFor(
  input: TypeAndRule & {
    year: LeaveYear;
    portion: EmployedPortion;
    balance: LeaveBalance;
  },
  proRataRule: ProRataRule = THE_RULE_IN_FORCE,
): LeaverSettlementLine {
  const { type, year, portion, balance } = input;
  const fullYearDays = input.rule?.entitlementDays ?? 0;

  const accrued = proRataDaysFor(
    { fullYearDays, year: { startsOn: year.startDate, endsOn: year.endDate }, portion },
    proRataRule,
  );

  const owed = round(accrued + balance.carriedOver + balance.adjustment - balance.taken);

  return {
    leaveTypeId: type.id,
    code: type.code,
    name: type.name,
    countingBasis: type.countingBasis,
    countingBasisLabel: countingBasisLabel(type.countingBasis),
    fullYearDays,
    accrued,
    granted: balance.entitled,
    grantedAhead: round(balance.entitled - accrued),
    carriedOver: balance.carriedOver,
    adjustment: balance.adjustment,
    taken: balance.taken,
    pending: balance.pending,
    owed,
    availableOnTheBalance: availableOn(balance),
    working: workingFor({ type, year, portion, balance, fullYearDays, accrued, owed }, proRataRule),
  };
}

/** The steps, in the order the sum is performed. */
export function workingFor(
  figures: {
    type: LeaveType;
    year: LeaveYear;
    portion: EmployedPortion;
    balance: LeaveBalance;
    fullYearDays: number;
    accrued: number;
    owed: number;
  },
  proRataRule: ProRataRule = THE_RULE_IN_FORCE,
): SettlementStep[] {
  const { type, year, portion, balance, fullYearDays, accrued, owed } = figures;

  const employedDays = calendarDaysBetween(portion.from, portion.to);
  const yearDays = calendarDaysBetween(year.startDate, year.endDate);
  const grantedAhead = round(balance.entitled - accrued);

  const steps: SettlementStep[] = [
    {
      label: `A whole year of ${type.name}`,
      days: fullYearDays,
      part: 'EXPLAINS',
      says:
        `${inDays(fullYearDays)} for a whole leave year, under the entitlement figure in ` +
        `force on ${portion.to}. FR 32h.`,
    },
    {
      label: `Accrued to ${portion.to}`,
      days: accrued,
      part: 'ADDS',
      says:
        `Employed ${portion.from} to ${portion.to}, ${count(employedDays, 'day')} of the ` +
        `year's ${count(yearDays, 'day')}. ${inDays(fullYearDays)} ${proRataRule.says} ` +
        `gives ${inDays(accrued)}. §8.6d.`,
    },
    {
      label: `Granted in ${year.label}`,
      days: balance.entitled,
      part: 'EXPLAINS',
      says:
        grantedAhead === 0
          ? `${inDays(balance.entitled)} granted, which is exactly what was accrued.`
          : grantedAhead > 0
            ? `${inDays(balance.entitled)} granted at the start of the year, ` +
              `${inDays(grantedAhead)} of it ahead of an accrual that stopped on ` +
              `${portion.to}. The figure settled is the accrual, not the grant. FR 37a.`
            : `${inDays(balance.entitled)} granted, ${inDays(-grantedAhead)} less than was ` +
              `accrued. A year granted short is the figure to check first.`,
    },
    {
      label: 'Carried over from the year before',
      days: balance.carriedOver,
      part: 'ADDS',
      says:
        balance.carriedOver === 0
          ? 'Nothing was carried into this year. FR 36.'
          : `${inDays(balance.carriedOver)} came in from the year before and is owed in ` +
            `full — it was accrued then, not now. FR 36.`,
    },
  ];

  if (balance.adjustment !== 0) {
    steps.push({
      label: 'Adjusted by hand',
      days: balance.adjustment,
      part: balance.adjustment > 0 ? 'ADDS' : 'TAKES',
      says:
        `${inDays(Math.abs(balance.adjustment))} ${balance.adjustment > 0 ? 'added' : 'taken'} ` +
        `by HR. The reason for each is in the ledger on the adjustments screen. FR 37.`,
    });
  }

  steps.push({
    label: 'Taken',
    days: -balance.taken,
    part: 'TAKES',
    says:
      balance.taken === 0
        ? 'No leave of this kind was taken in this year.'
        : `${inDays(balance.taken)} of approved leave, counted in ` +
          `${countingBasisLabel(type.countingBasis).toLowerCase()}. FR 21.`,
  });

  if (balance.pending !== 0) {
    steps.push({
      label: 'Still being decided',
      days: balance.pending,
      part: 'EXPLAINS',
      says:
        `${inDays(balance.pending)} are still held for leave nobody has decided. Requests ` +
        `not yet decided are cancelled when the exit is recorded, so this should be ` +
        `nothing — a figure here is a request that was made afterwards. FR 46.`,
    });
  }

  steps.push({
    label: 'Owed on exit',
    days: owed,
    part: 'EXPLAINS',
    says: owedInWords(owed, type),
  });

  return steps;
}

/** The answer, said rather than left as a signed number. */
export function owedInWords(owed: number, type: LeaveType): string {
  if (owed > 0) {
    return (
      `${inDays(owed)} of ${type.name} are owed and fall to the final payment. ` +
      `This is a figure to pay, not days to book. FR 37a.`
    );
  }

  if (owed < 0) {
    return (
      `${inDays(-owed)} more ${type.name} were taken than were accrued to the exit date. ` +
      `What happens to them — recovered, or written off — is payroll's, not this system's.`
    );
  }

  return `Nothing is owed and nothing was overtaken. ${type.name} settles at nought.`;
}

/** The settlement, from the facts the service gathered. */
export function settlementFor(
  facts: SettlementFacts,
  proRataRule: ProRataRule = THE_RULE_IN_FORCE,
): LeaverSettlement {
  const { employee } = facts;

  return {
    employeeId: employee.id,
    employeeNumber: employee.employeeNumber,
    name: `${employee.firstName} ${employee.lastName}`,
    jobTitle: employee.jobTitle,
    startDate: employee.startDate,
    exitDate: facts.exitDate,
    year: facts.year,
    portion: portionOf(facts),
    proRataRule: { name: proRataRule.name, says: proRataRule.says },
    lines: linesFor(facts, proRataRule),
  };
}

/**
 * The part of the settled year they were employed for.
 *
 * Never undefined: the year is the one the exit date falls in, so the exit date is in it.
 * The fallback is for the type rather than for a case that occurs.
 */
function portionOf(facts: SettlementFacts): EmployedPortion {
  return (
    employedPortionOf(
      { startsOn: facts.year.startDate, endsOn: facts.year.endDate },
      { startedOn: facts.employee.startDate, leftOn: facts.exitDate },
    ) ?? { from: facts.exitDate, to: facts.exitDate }
  );
}

function inDays(figure: number): string {
  return count(figure, 'day');
}

function count(figure: number, noun: string): string {
  return `${String(figure)} ${figure === 1 ? noun : `${noun}s`}`;
}

/** Two decimal places, which is what the ledger's `days` column holds. FR 24, §8.6. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
