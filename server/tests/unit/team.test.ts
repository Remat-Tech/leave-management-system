import { describe, expect, it } from 'vitest';
import { type Actor, signedInAs } from '../../src/auth/actor.js';
import type { LeaveBalance } from '../../src/features/balance/balance.js';
import type { Employee } from '../../src/features/employee/employee.js';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import {
  type LeaveType,
  type NewLeaveType,
  validateNewLeaveType,
} from '../../src/features/leave-type/leave-type.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { teamPolicy } from '../../src/features/team/policy.js';
import { type TeamFacts, type TeamView, teamViewFor } from '../../src/features/team/team.js';

/** A manager's view of their direct reports, as rules. FR 55, FR 56, LMS 405. */

const YEAR_2026 = year('2026', '2026-01-01', '2026-12-31');

const ANNUAL = leaveType({ code: 'ANNUAL', name: 'Annual Leave' });
const SICK = leaveType({ code: 'SICK', name: 'Sick Leave', displayOrder: 1 });
const MATERNITY = leaveType({
  code: 'MATERNITY',
  name: 'Maternity Leave',
  genderRestriction: 'FEMALE',
  displayOrder: 2,
});

const KOFI = person({ id: 'kofi', firstName: 'Kofi', lastName: 'Boateng', managerId: 'akosua' });

/** Kofi's three direct reports. */
const ADWOA = person({ id: 'adwoa', firstName: 'Adwoa', lastName: 'Frimpong', managerId: 'kofi' });
const ABENA = person({ id: 'abena', firstName: 'Abena', lastName: 'Sarpong', managerId: 'kofi' });
const KOJO = person({ id: 'kojo', firstName: 'Kojo', lastName: 'Antwi', managerId: 'kofi' });

/** Adwoa's own report, two levels below Kofi. FR 55 stops above this one. */
const YAA = person({ id: 'yaa', firstName: 'Yaa', lastName: 'Owusu', managerId: 'adwoa' });

describe('who may look at a team', () => {
  it('admits somebody with a report', () => {
    expect(teamPolicy.read(asManager(), 3).allowed).toBe(true);
  });

  /* Openly, because whether somebody has a report is a fact about themselves. */
  it('and refuses somebody with none, saying why', () => {
    const decision = teamPolicy.read(asEmployee(), 0);

    expect(decision.allowed).toBe(false);
    expect(decision.told).toContain('nobody reports to you');
  });
});

describe('who is on the screen', () => {
  it('is the direct reports, surname first', () => {
    expect(teamOf({}).members.map((one) => one.name)).toEqual([
      'Kojo Antwi',
      'Adwoa Frimpong',
      'Abena Sarpong',
    ]);
  });

  /* FR 55. The wider structure is not filtered out here — it is never read. Yaa reports to
     Adwoa, and the only thing that keeps her off this screen is the one-level query. */
  it('and never somebody a report manages', () => {
    const team = teamOf({ reports: [ADWOA, ABENA, KOJO] });

    expect(team.members.map((one) => one.employeeId)).not.toContain(YAA.id);
    expect(team.size).toBe(3);
  });

  /* FR 06. Still on the line until HR moves it, and the record says what stands. */
  it('and keeps a leaver, marked', () => {
    const kojo = memberOf(teamOf({ reports: [left(KOJO)] }), KOJO.id);

    expect(kojo.employmentStatus).toBe('TERMINATED');
    expect(kojo.inWords).toContain('They have left');
  });

  it('says so when nobody reports to this person', () => {
    expect(teamOf({ reports: [] }).inWords).toBe('Nobody reports to you.');
  });
});

describe('what each of them has left, FR 55', () => {
  it('is the same lines their own balance screen shows', () => {
    const adwoa = memberOf(
      teamOf({ balances: [balance({ employeeId: ADWOA.id, entitled: 20, taken: 4, pending: 2 })] }),
      ADWOA.id,
    );

    const annual = adwoa.balances.find((line) => line.code === 'ANNUAL');

    expect(annual?.owed).toBe(20);
    expect(annual?.taken).toBe(4);
    expect(annual?.pending).toBe(2);
    expect(annual?.available).toBe(14);
  });

  /* FR 05. A line reading nought against a type somebody can never ask for is worse than no
     line, and this screen is bound by the same rule as the person's own. */
  it('and leaves off a type this person is not eligible for', () => {
    const adwoa = memberOf(teamOf({ reports: [female(ADWOA)] }), ADWOA.id);
    const abena = memberOf(teamOf({ reports: [male(ABENA)] }), ABENA.id);

    expect(adwoa.balances.map((line) => line.code)).toContain('MATERNITY');
    expect(abena.balances.map((line) => line.code)).not.toContain('MATERNITY');
  });

  /* §7.4. Twenty annual days and three sick days are not twenty-three of anything. */
  it('and totals nothing across leave types', () => {
    const adwoa = memberOf(teamOf({}), ADWOA.id);

    expect(Object.keys(adwoa)).not.toContain('available');
    expect(Object.keys(adwoa)).not.toContain('owed');
  });
});

describe('what each of them has booked, FR 56', () => {
  it('is their live leave, soonest first, with the days totalled', () => {
    const adwoa = memberOf(
      teamOf({
        leave: [
          booking({ id: 'august', employeeId: ADWOA.id, from: '2026-08-03', to: '2026-08-07' }),
          booking({ id: 'march', employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-04' }),
        ],
      }),
      ADWOA.id,
    );

    expect(adwoa.booked.map((one) => one.requestId)).toEqual(['march', 'august']);
    expect(adwoa.daysBooked).toBe(10);
  });

  it('says which of it has been agreed and which is still to be decided', () => {
    const adwoa = memberOf(
      teamOf({
        leave: [
          booking({
            id: 'agreed',
            employeeId: ADWOA.id,
            status: 'APPROVED',
            awaitingApprovalFrom: null,
          }),
          booking({ id: 'asked', employeeId: ADWOA.id, from: '2026-04-01', to: '2026-04-02' }),
        ],
      }),
      ADWOA.id,
    );

    expect(adwoa.booked.map((one) => one.agreed)).toEqual([true, false]);
    expect(adwoa.booked[0].inWords).toContain('agreed');
    expect(adwoa.booked[1].inWords).toContain('not yet decided');
    expect(adwoa.inWords).toContain('1 of them is still to be decided');
  });

  /* FR 11, FR 24. Off the request as it was priced, never off the type as it stands now. */
  it('and prices nothing again', () => {
    const adwoa = memberOf(
      teamOf({
        leave: [booking({ employeeId: ADWOA.id, days: 3, calendarDays: 5 })],
      }),
      ADWOA.id,
    );

    expect(adwoa.booked[0].days).toBe(3);
    expect(adwoa.booked[0].calendarDays).toBe(5);
  });

  it('marks somebody who is away today', () => {
    const team = teamOf({
      leave: [booking({ employeeId: ADWOA.id, from: '2026-02-25', to: '2026-03-06' })],
      today: '2026-03-01',
    });

    expect(memberOf(team, ADWOA.id).awayToday).toBe(true);
    expect(memberOf(team, ABENA.id).awayToday).toBe(false);
    expect(team.inWords).toContain('1 of them is away today');
  });

  it('and says so where somebody has nothing booked', () => {
    expect(memberOf(teamOf({}), ADWOA.id).inWords).toContain('no leave booked in 2026');
  });
});

describe('the calendar, FR 56', () => {
  it('lists the days somebody is away and no others', () => {
    const calendar = teamOf({
      leave: [booking({ employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-04' })],
    }).calendar;

    expect(calendar.days.map((day) => day.date)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
    expect(calendar.from).toBe('2026-01-01');
    expect(calendar.to).toBe('2026-12-31');
  });

  /* The day a manager is actually looking for: two of the three off at once. */
  it('flags the days more than one of them is away', () => {
    const calendar = teamOf({
      leave: [
        booking({ id: 'one', employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-04' }),
        booking({ id: 'two', employeeId: ABENA.id, from: '2026-03-04', to: '2026-03-06' }),
      ],
    }).calendar;

    expect(calendar.days.filter((day) => day.isClash).map((day) => day.date)).toEqual([
      '2026-03-04',
    ]);
    expect(calendar.busiest).toBe(2);
    expect(calendar.clashes).toBe(1);
    expect(calendar.days.some((day) => day.isEverybody)).toBe(false);
  });

  it('and the day the whole team is away', () => {
    const calendar = teamOf({
      leave: [
        booking({ id: 'a', employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-02' }),
        booking({ id: 'b', employeeId: ABENA.id, from: '2026-03-02', to: '2026-03-02' }),
        booking({ id: 'c', employeeId: KOJO.id, from: '2026-03-02', to: '2026-03-02' }),
      ],
    }).calendar;

    expect(calendar.days[0].isEverybody).toBe(true);
    expect(calendar.busiest).toBe(3);
  });

  it('names who is away on each of them', () => {
    const calendar = teamOf({
      leave: [booking({ employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-02' })],
    }).calendar;

    expect(calendar.days[0].away).toEqual([
      {
        employeeId: ADWOA.id,
        name: 'Adwoa Frimpong',
        requestId: 'request',
        status: 'SUBMITTED',
        typeName: 'Annual Leave',
      },
    ]);
  });

  /* A request cannot leave its own leave year, so this is a backstop rather than a path —
     and a calendar with a day outside the year it is a calendar of would be worse. */
  it('and keeps to the year it is a calendar of', () => {
    const calendar = teamOf({
      year: year('2026', '2026-01-01', '2026-03-31'),
      leave: [booking({ employeeId: ADWOA.id, from: '2026-03-30', to: '2026-04-02' })],
    }).calendar;

    expect(calendar.days.map((day) => day.date)).toEqual(['2026-03-30', '2026-03-31']);
  });

  it('says nothing is booked where nothing is', () => {
    expect(teamOf({}).calendar.inWords).toBe('Nobody on your team has leave booked in 2026.');
    expect(teamOf({}).inWords).toContain('No two of them are booked off on the same day');
  });
});

/* --------------------------------------------------------------------------- fixtures */

function teamOf(facts: Partial<TeamFacts>): TeamView {
  return teamViewFor({
    managerId: KOFI.id,
    reports: [ADWOA, ABENA, KOJO],
    year: YEAR_2026,
    years: [YEAR_2026],
    types: [ANNUAL, SICK, MATERNITY],
    balances: [],
    leave: [],
    today: '2026-03-01',
    ...facts,
  });
}

function memberOf(team: TeamView, employeeId: string) {
  const member = team.members.find((one) => one.employeeId === employeeId);

  if (member === undefined) {
    throw new Error(`${employeeId} is not on this team.`);
  }

  return member;
}

function asManager(): Actor {
  return signedInAs(KOFI.id, { roles: ['EMPLOYEE'], isManager: true });
}

function asEmployee(): Actor {
  return signedInAs(ADWOA.id, { roles: ['EMPLOYEE'], isManager: false });
}

function booking(changes: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: 'request',
    employeeId: ADWOA.id,
    leaveTypeId: ANNUAL.id,
    leaveYearId: YEAR_2026.id,
    from: '2026-03-02',
    to: '2026-03-06',
    reason: null,
    lateEntryReason: null,
    evidenceRequired: false,
    certifiedDays: 0,
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    decidedBySingleApprover: false,
    submittedAt: new Date('2026-01-10T09:00:00Z'),
    createdAt: new Date('2026-01-10T09:00:00Z'),
    updatedAt: new Date('2026-01-10T09:00:00Z'),
    ...changes,
  };
}

function balance(figures: Partial<LeaveBalance>): LeaveBalance {
  return {
    employeeId: ADWOA.id,
    leaveTypeId: ANNUAL.id,
    leaveYearId: YEAR_2026.id,
    entitled: 0,
    carriedOver: 0,
    adjustment: 0,
    taken: 0,
    pending: 0,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...figures,
  };
}

function person(input: Pick<Employee, 'id' | 'firstName' | 'lastName' | 'managerId'>): Employee {
  return {
    ...input,
    employeeNumber: `EMP-${input.id}`,
    workEmail: `${input.firstName.toLowerCase()}@rematholdings.com`,
    jobTitle: null,
    departmentId: '1',
    workPatternId: '1',
    startDate: '2024-01-01',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  };
}

function female(employee: Employee): Employee {
  return { ...employee, gender: 'FEMALE' };
}

function male(employee: Employee): Employee {
  return { ...employee, gender: 'MALE' };
}

function left(employee: Employee): Employee {
  return { ...employee, employmentStatus: 'TERMINATED', exitDate: '2026-07-31' };
}

function leaveType(input: Partial<NewLeaveType> & Pick<NewLeaveType, 'code' | 'name'>): LeaveType {
  const validated = validateNewLeaveType({
    countingBasis: 'WORKING_DAYS',
    entitlementBasis: 'QUOTA',
    ...input,
  });

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
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
  };
}
