import { describe, expect, it } from 'vitest';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { APPROVER_ROLES } from '../../src/features/leave-type/approval-chain.js';
import type { LeaveBalance } from '../../src/features/balance/balance.js';
import type { Employee } from '../../src/features/employee/employee.js';
import type { LeaveDecision } from '../../src/features/leave-request/leave-decision.js';
import type { LeaveRequest } from '../../src/features/leave-request/leave-request.js';
import {
  type ApproverQueue,
  bySoonestToStart,
  companyWideDesks,
  flagsFor,
  QUEUE_FLAGS,
  type QueueFacts,
  type QueueItem,
  queueFor,
  staffsAnyDesk,
} from '../../src/features/leave-request/approver-queue.js';
import { desksStaffedBy, leaveRequestPolicy } from '../../src/features/leave-request/policy.js';
import {
  type LeaveType,
  type NewLeaveType,
  validateNewLeaveType,
} from '../../src/features/leave-type/leave-type.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import type { Actor } from '../../src/auth/actor.js';

/** The approver queue, as rules. FR 20, FR 40, FR 17, FR 18, FR 48, §8.6a, LMS 404. */

const YEAR_2026 = year('2026', '2026-01-01', '2026-12-31');

const ANNUAL = leaveType({ code: 'ANNUAL', name: 'Annual Leave', minNoticeCalendarDays: 7 });

/** HR then the Chief Executive. §4.3.1. */
const UNPAID = leaveType({
  code: 'UNPAID',
  name: 'Unpaid Leave',
  isPaid: false,
  approvalChain: ['HR', 'CEO'],
});

const KOFI = person({ id: 'kofi', firstName: 'Kofi', lastName: 'Boateng', managerId: 'ama' });
const ADWOA = person({ id: 'adwoa', firstName: 'Adwoa', lastName: 'Frimpong', managerId: 'kofi' });
const KWAME = person({ id: 'kwame', firstName: 'Kwame', lastName: 'Mensah', managerId: 'kofi' });
const YAA = person({ id: 'yaa', firstName: 'Yaa', lastName: 'Owusu', managerId: 'kofi' });

/** An HR Officer, who staffs the `HR` desk and manages nobody. */
const ESI = person({ id: 'esi', firstName: 'Esi', lastName: 'Darko', managerId: 'ama' });

/** FR 04. The one employee with no line manager, which is the `CEO` desk. */
const AMA = person({ id: 'ama', firstName: 'Ama', lastName: 'Mensah', managerId: null });

const PEOPLE = [KOFI, ADWOA, KWAME, YAA, ESI, AMA];

describe('the desks somebody staffs', () => {
  it('gives a manager their own reports and nothing else', () => {
    const staffed = desksStaffedBy(asManager(), AMA.id);

    expect(staffed.desks).toEqual(['MANAGER']);
    expect(staffed.managerId).toBe(KOFI.id);
    expect(companyWideDesks(staffed)).toEqual([]);
  });

  it('gives an HR Officer the HR desk for the whole company', () => {
    const staffed = desksStaffedBy(asOfficer(ESI.id), AMA.id);

    expect(staffed.desks).toEqual(['HR']);
    expect(staffed.managerId).toBeNull();
    expect(companyWideDesks(staffed)).toEqual(['HR']);
  });

  it('gives the Chief Executive their desk, and gives it to nobody else', () => {
    expect(desksStaffedBy(asChiefExecutive(), AMA.id).desks).toEqual(['CEO']);
    expect(desksStaffedBy(asManager(), AMA.id).desks).not.toContain('CEO');
    expect(desksStaffedBy(asChiefExecutive(), null).desks).toEqual([]);
  });

  it('gives an ordinary employee nothing, and refuses them the queue', () => {
    const staffed = desksStaffedBy(asEmployee(), AMA.id);

    expect(staffsAnyDesk(staffed)).toBe(false);
    expect(leaveRequestPolicy.queue(asEmployee(), staffed).allowed).toBe(false);
  });

  /* `isAt` is not exported, so the agreement is asserted through `approve`, which asks it. */
  it('agrees with the desk the approval policy resolves, for every desk there is', () => {
    for (const desk of APPROVER_ROLES) {
      const staffs = whoStaffs(desk);
      const subject = {
        employeeId: ADWOA.id,
        managerId: KOFI.id,
        awaiting: desk,
        chiefExecutiveId: AMA.id,
      };

      expect(desksStaffedBy(staffs, AMA.id).desks).toContain(desk);
      expect(leaveRequestPolicy.approve(staffs, subject).allowed).toBe(true);

      expect(desksStaffedBy(asEmployee(), AMA.id).desks).not.toContain(desk);
      expect(leaveRequestPolicy.approve(asEmployee(), subject).allowed).toBe(false);
    }
  });

  /* The nightly jobs run as this, and it is nobody — so it never holds a seat a person holds. */
  it('gives the system actor the desks its roles staff and no seat', () => {
    const staffed = desksStaffedBy(theSystem('a scheduled job'), AMA.id);

    expect(staffed.desks).toEqual(['HR']);
    expect(staffed.managerId).toBeNull();
  });
});

describe('what is waiting', () => {
  it('puts the leave that starts soonest at the top', () => {
    const queue = queueOf({
      requests: [
        request({ id: 'august', from: '2026-08-03', to: '2026-08-07', submittedAt: at('01-05') }),
        request({ id: 'march', from: '2026-03-02', to: '2026-03-06', submittedAt: at('02-20') }),
        request({ id: 'june', from: '2026-06-01', to: '2026-06-05', submittedAt: at('01-10') }),
      ],
    });

    expect(queue.items.map((item) => item.requestId)).toEqual(['march', 'june', 'august']);
  });

  it('breaks a tie by which was asked for first', () => {
    const two = [
      request({ id: 'second', submittedAt: at('02-10') }),
      request({ id: 'first', submittedAt: at('01-10') }),
    ];

    expect(two.sort(bySoonestToStart).map((one) => one.id)).toEqual(['first', 'second']);
  });

  /* FR 11, FR 24. Off the request as it was priced, never off the type as it stands now. */
  it('prices nothing again', () => {
    const [item] = queueOf({
      types: [leaveType({ code: 'ANNUAL', name: 'Annual Leave', countingBasis: 'CALENDAR_DAYS' })],
      requests: [request({ countingBasis: 'WORKING_DAYS', days: 10, calendarDays: 14 })],
    }).items;

    expect(item.countingBasis).toBe('WORKING_DAYS');
    expect(item.countingBasisLabel).toBe('Working days');
    expect(item.days).toBe(10);
    expect(item.calendarDays).toBe(14);
  });

  it('says how many are waiting', () => {
    expect(queueOf({ requests: [] }).inWords).toBe('Nothing is waiting on you.');
    expect(queueOf({ requests: [request({})] }).inWords).toMatch(/^1 request is waiting on you/);
  });
});

describe('the balance beside each request', () => {
  /* `available` already has this request's days out of it: approving moves them from `pending`
     to `taken` and changes it by nothing. */
  it('reports what is left with this request already held out of it', () => {
    const [item] = queueOf({
      requests: [request({ days: 5 })],
      balances: [balance({ entitled: 20, taken: 6, pending: 5 })],
    }).items;

    expect(item.balance.owed).toBe(20);
    expect(item.balance.taken).toBe(6);
    expect(item.balance.pending).toBe(5);
    expect(item.balance.available).toBe(9);
    expect(item.balance.inWords).toContain('approving this leaves 9 days');
  });

  /* §8.6b, FR 32a. A negative figure with nothing beside it reads as a fault. */
  it('says a balance past its allowance is not a mistake', () => {
    const [item] = queueOf({
      requests: [request({ days: 5 })],
      balances: [balance({ entitled: 3, pending: 5 })],
    }).items;

    expect(item.balance.available).toBe(-2);
    expect(item.balance.inWords).toContain('past its allowance');
  });

  it('reads a balance nothing has moved as nought', () => {
    const [item] = queueOf({ requests: [request({})], balances: [] }).items;

    expect(item.balance.owed).toBe(0);
    expect(item.balance.available).toBe(0);
  });
});

describe('who else is away', () => {
  /* FR 20. `SUBMITTED` counts as much as `APPROVED` — both keep somebody off the desk. */
  it('names the team’s live leave over the same days, agreed or not', () => {
    const [item] = queueOf({
      requests: [request({ employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-06' })],
      teamLeave: [
        request({
          id: 'kwame',
          employeeId: KWAME.id,
          from: '2026-03-03',
          to: '2026-03-04',
          status: 'APPROVED',
          awaitingApprovalFrom: null,
        }),
        request({ id: 'yaa', employeeId: YAA.id, from: '2026-03-06', to: '2026-03-10' }),
      ],
    }).items;

    expect(item.team.size).toBe(3);
    expect(item.team.away.map((one) => one.name)).toEqual(['Kwame Mensah', 'Yaa Owusu']);
    expect(item.team.inWords).toContain('2 of the 2 others on this team are away');
    expect(item.team.inWords).toContain('agreed');
    expect(item.team.inWords).toContain('not yet decided');
  });

  /* `periodsOverlap`, inclusive at both ends, as FR 15 and the exclusion constraint state it. */
  it('leaves out leave that does not actually overlap', () => {
    const [item] = queueOf({
      requests: [request({ employeeId: ADWOA.id, from: '2026-03-02', to: '2026-03-06' })],
      teamLeave: [
        request({ id: 'before', employeeId: KWAME.id, from: '2026-02-20', to: '2026-03-01' }),
        request({ id: 'touching', employeeId: YAA.id, from: '2026-03-06', to: '2026-03-09' }),
      ],
    }).items;

    expect(item.team.away.map((one) => one.employeeId)).toEqual([YAA.id]);
  });

  it('does not count the asker’s own leave against them', () => {
    const [item] = queueOf({
      requests: [request({ id: 'this', employeeId: ADWOA.id })],
      teamLeave: [request({ id: 'also-theirs', employeeId: ADWOA.id })],
    }).items;

    expect(item.team.away).toEqual([]);
  });

  /* §4.3.1, FR 32h. The Chief Executive decides unpaid leave and is nobody's line manager. */
  it('withholds names from an approver with no standing to read that person', () => {
    const [item] = queueOf({
      approverId: AMA.id,
      staffed: desksStaffedBy(asChiefExecutive(), AMA.id),
      requests: [
        request({ employeeId: ADWOA.id, leaveTypeId: UNPAID.id, awaitingApprovalFrom: 'CEO' }),
      ],
      teamLeave: [request({ id: 'kwame', employeeId: KWAME.id })],
      mayBeNamed: (colleague: Employee) =>
        leaveRequestPolicy.read(asChiefExecutive(), {
          employeeId: colleague.id,
          managerId: colleague.managerId,
        }).allowed,
    }).items;

    expect(item.team.away).toHaveLength(1);
    expect(item.team.away[0].name).toBeNull();
    expect(item.team.inWords).toBe('1 of the 2 others on this team is away over these dates.');
  });

  /* FR 04's one employee has no line manager, so no team. */
  it('says so where the person is on no team at all', () => {
    const [item] = queueOf({
      requests: [
        request({ employeeId: AMA.id, leaveTypeId: UNPAID.id, awaitingApprovalFrom: 'HR' }),
      ],
    }).items;

    expect(item.team.size).toBe(0);
    expect(item.team.inWords).toContain('no team calendar');
  });
});

describe('what is flagged', () => {
  /* FR 17. Measured at the asking: recomputing it today would report the approver's own delay
     as the requester's short notice. */
  it('measures notice at the asking rather than at today', () => {
    const [item] = queueOf({
      today: '2026-03-01',
      requests: [request({ from: '2026-03-02', to: '2026-03-06', submittedAt: at('01-05') })],
    }).items;

    expect(item.noticeGivenDays).toBe(56);
    expect(item.shortNoticeBy).toBe(0);
    expect(item.warnings).toEqual([]);
    expect(item.startsInDays).toBe(1);
  });

  it('flags short notice, and says the judgement is the approver’s', () => {
    const [item] = queueOf({
      requests: [request({ from: '2026-03-02', to: '2026-03-06', submittedAt: at('02-28') })],
    }).items;

    expect(item.noticeGivenDays).toBe(2);
    expect(item.shortNoticeBy).toBe(5);
    expect(item.warnings.map((one) => one.code)).toEqual(['SHORT_NOTICE']);
    expect(item.warnings[0].inWords).toContain('yours to judge');
  });

  /* FR 18. Backdated implies short of notice, and is the stronger news, so it comes first. */
  it('flags a backdated request above the notice flag', () => {
    const [item] = queueOf({
      requests: [request({ from: '2026-03-02', to: '2026-03-06', submittedAt: at('03-05') })],
    }).items;

    expect(item.backdatedBy).toBe(3);
    expect(item.warnings.map((one) => one.code)).toEqual(['BACKDATED', 'SHORT_NOTICE']);
    expect(item.warnings[0].inWords).toContain('already started');
  });

  it('flags nothing on a type that asks for no notice', () => {
    expect(
      flagsFor({
        typeName: 'Sick Leave',
        shortNoticeBy: 0,
        backdatedBy: 0,
        noticeGivenDays: 0,
        type: undefined,
      }),
    ).toEqual([]);
  });

  it('has the two flags the story asks for and no others', () => {
    expect([...QUEUE_FLAGS]).toEqual(['SHORT_NOTICE', 'BACKDATED']);
  });
});

describe('an approver’s own request', () => {
  /* §8.6a. Unpaid leave goes to HR first, so an HR Officer's own starts at her own desk. */
  it('is on the queue, and is not actionable', () => {
    const queue = ownRequestQueue([
      request({
        id: 'mine',
        employeeId: ADWOA.id,
        leaveTypeId: UNPAID.id,
        awaitingApprovalFrom: 'HR',
      }),
      request({
        id: 'theirs',
        employeeId: KWAME.id,
        leaveTypeId: UNPAID.id,
        awaitingApprovalFrom: 'HR',
      }),
    ]);

    expect(queue.items.map((item) => item.requestId).sort()).toEqual(['mine', 'theirs']);

    expect(itemOf(queue, 'mine').actionable).toBe(false);
    expect(itemOf(queue, 'theirs').actionable).toBe(true);
    expect(itemOf(queue, 'theirs').notActionableBecause).toBeNull();
  });

  it('carries the policy’s sentence, which names what they can do instead', () => {
    const queue = ownRequestQueue([
      request({ employeeId: ADWOA.id, leaveTypeId: UNPAID.id, awaitingApprovalFrom: 'HR' }),
    ]);

    expect(queue.items[0].notActionableBecause).toContain('withdraw it');
  });

  it('says in the headline how many of them nobody here can move', () => {
    const queue = ownRequestQueue([
      request({ employeeId: ADWOA.id, leaveTypeId: UNPAID.id, awaitingApprovalFrom: 'HR' }),
    ]);

    expect(queue.inWords).toContain('1 of them is your own');
  });
});

describe('where each request has got to', () => {
  /* FR 41, in the approver's voice rather than the requester's. */
  it('names the stages from the approver’s side', () => {
    const [item] = queueOf({
      approverId: ESI.id,
      staffed: desksStaffedBy(asOfficer(ESI.id), AMA.id),
      requests: [request({ employeeId: ADWOA.id, awaitingApprovalFrom: 'HR' })],
      decisions: [decision({ onBehalfOf: 'MANAGER' })],
    }).items;

    expect(item.approvedBy).toEqual(['MANAGER']);
    expect(item.stageInWords).toBe(
      'Already approved by Adwoa Frimpong’s line manager. Yours is the last approval it needs.',
    );
    expect(item.stageInWords).not.toContain('your line manager');
  });

  it('says who comes after this desk where somebody does', () => {
    const [item] = queueOf({
      requests: [request({ employeeId: ADWOA.id, awaitingApprovalFrom: 'MANAGER' })],
    }).items;

    expect(item.stageInWords).toBe('Nobody has approved it yet. After you it goes to HR.');
  });
});

/* --------------------------------------------------------------------------- fixtures */

/** The default: Kofi looking at his own team's annual leave. */
function queueOf(facts: Partial<QueueFacts>): ApproverQueue {
  return queueFor({
    approverId: KOFI.id,
    staffed: desksStaffedBy(asManager(), AMA.id),
    requests: [],
    people: PEOPLE,
    types: [ANNUAL, UNPAID],
    years: [YEAR_2026],
    decisions: [],
    balances: [],
    teamLeave: [],
    today: '2026-03-01',
    mayBeNamed: () => true,
    whyNotDecidable: () => null,
    ...facts,
  });
}

/** Adwoa as an HR Officer, looking at a queue with her own unpaid leave in it. */
function ownRequestQueue(requests: LeaveRequest[]): ApproverQueue {
  const actor = asOfficer(ADWOA.id);

  return queueOf({
    approverId: ADWOA.id,
    staffed: desksStaffedBy(actor, AMA.id),
    requests,
    whyNotDecidable: (one) => {
      const asker = PEOPLE.find((who) => who.id === one.employeeId);

      const said = leaveRequestPolicy.notTheirOwn(
        actor,
        { employeeId: one.employeeId, managerId: asker?.managerId ?? null },
        'APPROVE',
      );

      return said.allowed ? null : said.told;
    },
  });
}

function itemOf(queue: ApproverQueue, requestId: string): QueueItem {
  const item = queue.items.find((one) => one.requestId === requestId);

  if (item === undefined) {
    throw new Error(`No item for request ${requestId}.`);
  }

  return item;
}

/** Somebody who staffs exactly this desk. */
function whoStaffs(desk: (typeof APPROVER_ROLES)[number]): Actor {
  switch (desk) {
    case 'MANAGER':
      return asManager();
    case 'HR':
      return asOfficer(ESI.id);
    default:
      return asChiefExecutive();
  }
}

function asManager(): Actor {
  return signedInAs(KOFI.id, { roles: ['EMPLOYEE'], isManager: true });
}

function asOfficer(employeeId: string): Actor {
  return signedInAs(employeeId, { roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false });
}

function asChiefExecutive(): Actor {
  return signedInAs(AMA.id, { roles: ['EMPLOYEE'], isManager: false });
}

function asEmployee(): Actor {
  return signedInAs(ADWOA.id, { roles: ['EMPLOYEE'], isManager: false });
}

/** An instant in 2026, said as the month and day it fell on. */
function at(monthAndDay: string): Date {
  return new Date(`2026-${monthAndDay}T09:00:00Z`);
}

function request(changes: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: '1',
    employeeId: ADWOA.id,
    leaveTypeId: ANNUAL.id,
    leaveYearId: YEAR_2026.id,
    from: '2026-03-02',
    to: '2026-03-06',
    reason: 'My sister is getting married.',
    countingBasis: 'WORKING_DAYS',
    days: 5,
    calendarDays: 5,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    submittedAt: at('01-05'),
    createdAt: at('01-05'),
    updatedAt: at('01-05'),
    ...changes,
  };
}

function decision(changes: Partial<LeaveDecision>): LeaveDecision {
  return {
    id: '1',
    leaveRequestId: '1',
    action: 'APPROVE',
    onBehalfOf: 'MANAGER',
    comment: null,
    decidedBy: 'employee kofi',
    decidedByEmployeeId: KOFI.id,
    decidedAt: at('01-06'),
    ...changes,
  };
}

/** Adwoa's annual leave in 2026, which is what the default request is priced against. */
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
    updatedAt: at('01-05'),
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
