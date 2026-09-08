import { describe, expect, it } from 'vitest';
import { type Actor, signedInAs } from '../../src/auth/actor.js';
import type { Department } from '../../src/features/department/department.js';
import type { Employee } from '../../src/features/employee/employee.js';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { teamPolicy } from '../../src/features/team/policy.js';
import {
  type TeamCalendarFacts,
  type TeamCalendarView,
  teamCalendarFor,
} from '../../src/features/team/team-calendar.js';

/** Who is away and when, as rules. FR 57, LMS 406, LMS 409. */

const YEAR_2026 = year('2026', '2026-01-01', '2026-12-31');

const OPERATIONS = department('ops', 'Operations');
const FINANCE = department('finance', 'Finance');

/** Operations. Kofi leads it; Adwoa, Abena and Kojo report to him, and Adwoa is reading. */
const KOFI = person({ id: 'kofi', firstName: 'Kofi', lastName: 'Boateng', managerId: 'akosua' });
const ADWOA = person({ id: 'adwoa', firstName: 'Adwoa', lastName: 'Frimpong', managerId: 'kofi' });
const ABENA = person({ id: 'abena', firstName: 'Abena', lastName: 'Sarpong', managerId: 'kofi' });
const KOJO = person({ id: 'kojo', firstName: 'Kojo', lastName: 'Antwi', managerId: 'kofi' });

/** Finance, and so on nobody's calendar but Finance's — and on HR's, which is every one. */
const EFE = person({
  id: 'efe',
  firstName: 'Efe',
  lastName: 'Danquah',
  managerId: 'kwame',
  departmentId: FINANCE.id,
});

describe('who may look at a team calendar', () => {
  it('admits somebody with a department to draw', () => {
    expect(teamPolicy.calendar(asAdwoa(), 4).allowed).toBe(true);
  });

  /* `employee.department_id` is NOT NULL, so this refuses nobody in practice. It is here so
     that a query coming back empty says what went wrong rather than drawing nothing. */
  it('and refuses an empty department, saying why', () => {
    const decision = teamPolicy.calendar(asAdwoa(), 0);

    expect(decision.allowed).toBe(false);
    expect(decision.told).toContain('the people in your department');
  });

  /* LMS 409. HR reads every record, so HR reads every department. */
  it('and lets HR look past their own department', () => {
    expect(teamPolicy.everyDepartment(asEfua()).allowed).toBe(true);
  });

  it('and refuses everybody else, saying whose it is', () => {
    const decision = teamPolicy.everyDepartment(asAdwoa());

    expect(decision.allowed).toBe(false);
    expect(decision.told).toContain('Looking across departments is for HR');
  });
});

describe('who is on the calendar, FR 57, LMS 409', () => {
  it('is everybody in the department, the reader included', () => {
    expect(calendarOf({}).colleagues.map((one) => one.name)).toEqual([
      'Kofi Boateng',
      'Kojo Antwi',
      'Adwoa Frimpong',
      'Abena Sarpong',
    ]);
  });

  it('and marks the reader and their manager rather than leaving either off', () => {
    const calendar = calendarOf({});

    expect(colleague(calendar, ADWOA.id).isMe).toBe(true);
    expect(colleague(calendar, KOFI.id).isTheManager).toBe(true);
    expect(calendar.size).toBe(4);
  });

  /* The scope is the department, so the screen says which one it is drawing. */
  it('and names the department it is showing', () => {
    const calendar = calendarOf({});

    expect(calendar.department?.name).toBe('Operations');
    expect(calendar.inWords).toContain('4 people in Operations, your department');
  });

  /* LMS 409. HR reading every department at once, which is the one case with no department. */
  it('and says so where every department is being shown at once', () => {
    const calendar = calendarOf({
      team: [KOFI, ADWOA, ABENA, KOJO, EFE],
      showing: null,
      departments: [OPERATIONS, FINANCE],
      canChooseDepartment: true,
    });

    expect(calendar.department).toBeNull();
    expect(calendar.inWords).toContain('5 people in every department');
    expect(colleague(calendar, EFE.id).department?.name).toBe('Finance');
  });

  /* Somebody in another department is never read rather than filtered out here. */
  it('and never somebody in another department', () => {
    expect(calendarOf({}).colleagues.map((one) => one.employeeId)).not.toContain(EFE.id);
  });

  /* FR 06. Still on the line until HR moves it, and hiding the person while showing the
     absence would be the worse half of both answers. */
  it('and keeps a leaver, marked', () => {
    const kojo = colleague(calendarOf({ team: [KOFI, ADWOA, ABENA, left(KOJO)] }), KOJO.id);

    expect(kojo.employmentStatus).toBe('TERMINATED');
    expect(kojo.inWords).toContain('They have left');
  });
});

describe('what an absence says, and what it cannot, FR 57', () => {
  it('carries the dates, how long, and whether it stands', () => {
    const abena = colleague(
      calendarOf({
        leave: [booking({ employeeId: ABENA.id, from: '2026-03-02', to: '2026-03-06' })],
      }),
      ABENA.id,
    );

    expect(abena.absences).toHaveLength(1);
    expect(abena.absences[0].from).toBe('2026-03-02');
    expect(abena.absences[0].to).toBe('2026-03-06');
    expect(abena.absences[0].calendarDays).toBe(5);
    expect(abena.absences[0].agreed).toBe(false);
  });

  /**
   * The story's second criterion, and the claim this file exists for.
   *
   * The field list is asserted whole rather than field by field: a leave type, a reason or a
   * request id added to the projection has to fail here before it can reach a colleague.
   */
  it('and holds no leave type, no reason and no handle on the request', () => {
    const abena = colleague(
      calendarOf({
        leave: [
          booking({ employeeId: ABENA.id, reason: 'A funeral', leaveTypeId: 'type-COMPASSIONATE' }),
        ],
      }),
      ABENA.id,
    );

    expect(Object.keys(abena.absences[0])).toEqual([
      'from',
      'to',
      'calendarDays',
      'agreed',
      'inWords',
    ]);
    expect(JSON.stringify(abena)).not.toContain('funeral');
    expect(JSON.stringify(abena)).not.toContain('COMPASSIONATE');
  });

  /* FR 24. Days off the calendar, never the days it costs them — that is their balance. */
  it('and counts calendar days rather than what the leave was charged', () => {
    const abena = colleague(
      calendarOf({
        leave: [
          booking({
            employeeId: ABENA.id,
            from: '2026-03-02',
            to: '2026-03-08',
            days: 4,
            calendarDays: 7,
          }),
        ],
      }),
      ABENA.id,
    );

    expect(abena.absences[0].calendarDays).toBe(7);
    expect(abena.absences[0].inWords).toContain('7 days away');
    expect(JSON.stringify(abena.absences[0])).not.toContain('"days"');
  });

  /* FR 41. A date that is not yet agreed is a different fact to plan around. */
  it('and says which dates stand and which are still being decided', () => {
    const abena = colleague(
      calendarOf({ leave: [booking({ employeeId: ABENA.id, status: 'APPROVED' })] }),
      ABENA.id,
    );

    expect(abena.absences[0].agreed).toBe(true);
    expect(abena.absences[0].inWords).toContain('agreed');
  });
});

describe('who is away on which day, FR 57', () => {
  it('lists the days somebody is off and no others', () => {
    const calendar = calendarOf({
      leave: [booking({ employeeId: ABENA.id, from: '2026-03-02', to: '2026-03-04' })],
    });

    expect(calendar.days.map((day) => day.date)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
    expect(calendar.days[0].away.map((one) => one.name)).toEqual(['Abena Sarpong']);
  });

  it('and lists no day at all where nobody is away', () => {
    expect(calendarOf({}).days).toEqual([]);
    expect(calendarOf({}).inWords).toContain('Nobody has leave booked in 2026');
  });

  it('and stops at the ends of the year the calendar is for', () => {
    const calendar = calendarOf({
      leave: [booking({ employeeId: ABENA.id, from: '2025-12-30', to: '2026-01-02' })],
    });

    expect(calendar.days.map((day) => day.date)).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('and counts the most away on any one day', () => {
    const calendar = calendarOf({
      leave: [
        booking({ id: 'one', employeeId: ABENA.id, from: '2026-03-02', to: '2026-03-04' }),
        booking({ id: 'two', employeeId: KOJO.id, from: '2026-03-04', to: '2026-03-06' }),
      ],
    });

    expect(calendar.busiest).toBe(2);
    expect(calendar.days.find((day) => day.date === '2026-03-04')?.away).toHaveLength(2);
    expect(calendar.inWords).toContain('up to 2 at once');
  });

  it('and marks the day the whole team is off', () => {
    const everybody = ['kofi', 'adwoa', 'abena', 'kojo'].map((id) =>
      booking({ id: `r-${id}`, employeeId: id, from: '2026-12-24', to: '2026-12-24' }),
    );

    expect(calendarOf({ leave: everybody }).days[0].isEverybody).toBe(true);
  });

  it('and says who is out right now', () => {
    const calendar = calendarOf({
      leave: [booking({ employeeId: ABENA.id, from: '2026-02-28', to: '2026-03-03' })],
      today: '2026-03-01',
    });

    expect(calendar.awayToday.map((one) => one.name)).toEqual(['Abena Sarpong']);
    expect(colleague(calendar, ABENA.id).awayToday).toBe(true);
    expect(colleague(calendar, KOJO.id).awayToday).toBe(false);
    expect(calendar.inWords).toContain('1 is away today');
  });

  /* The reader's own leave is on their own calendar, marked, so it reads as a whole team. */
  it('and puts the reader’s own leave on it, marked as theirs', () => {
    const calendar = calendarOf({ leave: [booking({ employeeId: ADWOA.id })] });

    expect(calendar.days[0].away[0].isMe).toBe(true);
    expect(colleague(calendar, ADWOA.id).inWords).toContain('You have 1 absence');
  });
});

describe('what the screen says it is', () => {
  /* NFR USA 03, and the story's "without knowing anybody's private business". */
  it('says what it shows and what it deliberately does not', () => {
    expect(calendarOf({}).inWords).toContain('nothing about what kind of leave it is or why');
  });
});

/* --------------------------------------------------------------------------- fixtures */

function calendarOf(facts: Partial<TeamCalendarFacts>): TeamCalendarView {
  return teamCalendarFor({
    reader: ADWOA,
    team: [KOFI, ADWOA, ABENA, KOJO],
    year: YEAR_2026,
    years: [YEAR_2026],
    showing: OPERATIONS,
    departments: [OPERATIONS],
    canChooseDepartment: false,
    leave: [],
    today: '2026-06-01',
    ...facts,
  });
}

function department(id: string, name: string): Department {
  return {
    id,
    name,
    parentId: null,
    isActive: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  };
}

function colleague(calendar: TeamCalendarView, employeeId: string) {
  const one = calendar.colleagues.find((each) => each.employeeId === employeeId);

  if (one === undefined) {
    throw new Error(`${employeeId} is not on this calendar.`);
  }

  return one;
}

function asAdwoa(): Actor {
  return signedInAs(ADWOA.id, { roles: ['EMPLOYEE'], isManager: false });
}

/** Efua Owusu, the HR officer, who reads every record and so every department. LMS 409. */
function asEfua(): Actor {
  return signedInAs('efua', { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function booking(changes: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: 'request',
    employeeId: ABENA.id,
    leaveTypeId: 'type-ANNUAL',
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

function person(
  input: Pick<Employee, 'id' | 'firstName' | 'lastName' | 'managerId'> & { departmentId?: string },
): Employee {
  return {
    ...input,
    employeeNumber: `EMP-${input.id}`,
    workEmail: `${input.firstName.toLowerCase()}@rematholdings.com`,
    jobTitle: null,
    departmentId: input.departmentId ?? OPERATIONS.id,
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

function left(employee: Employee): Employee {
  return { ...employee, employmentStatus: 'TERMINATED', exitDate: '2026-07-31' };
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
