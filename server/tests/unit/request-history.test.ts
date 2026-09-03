import { describe, expect, it } from 'vitest';
import { UNATTRIBUTED } from '../../src/features/audit/audit.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  desksThatApproved,
  type LeaveDecision,
} from '../../src/features/leave-request/leave-decision.js';
import {
  type LeaveRequest,
  progressOf,
  REQUEST_STATUSES,
} from '../../src/features/leave-request/leave-request.js';
import {
  type LeaveType,
  type NewLeaveType,
  validateNewLeaveType,
} from '../../src/features/leave-type/leave-type.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import {
  byMostRecentlyAsked,
  type Deciders,
  entryFor,
  historyFor,
  type RequestHistory,
  type RequestHistoryEntry,
  type RequestHistoryFacts,
  statusInWords,
  type TrailStep,
  trailFor,
  yearsWithRequests,
} from '../../src/features/leave-request/request-history.js';

/**
 * My request history, as rules rather than as a screen. FR 54, §7.4. LMS 402.
 *
 * Every decision this story makes is a pure function of rows somebody else read, so nearly
 * all of it is here rather than in ../integration/requests-api.test.ts. What that suite is
 * for is the half this one cannot claim: that the rows are the ones a real approval produced,
 * that a comment survives the round trip verbatim, and that somebody else's history is
 * refused.
 *
 * Five claims, and they are the story's two criteria plus the three ways a correct list could
 * still mislead:
 *
 *   **Every request is on it, with the status it actually has.** Including the ones that were
 *   withdrawn and cancelled, which are the ones somebody is most likely to be checking on.
 *
 *   **The trail is the whole account, comments included.** Each decision, in the order it was
 *   made, with the desk it was made at and what was said — and a refusal's reason is never
 *   dropped.
 *
 *   **And it says what has *not* happened.** The stages nobody has been asked yet are on the
 *   trail, because "approved by your line manager" shown as the last word is the exact
 *   misreading FR 41 exists to prevent.
 *
 *   **Newest first**, which is the reverse of the calendar order the repository hands back.
 *
 *   **Nothing is re-priced.** The day count and the counting basis come off the request as it
 *   was submitted, never off the type as it stands now. FR 11.
 */

const YEAR_2025 = year('2025', '2025-01-01', '2025-12-31');
const YEAR_2026 = year('2026', '2026-01-01', '2026-12-31');
const YEAR_2027 = year('2027', '2027-01-01', '2027-12-31');

const YEARS = [YEAR_2025, YEAR_2026, YEAR_2027];

/** Manager then HR, which is what five of the seven types have. */
const ANNUAL = leaveType({ code: 'ANNUAL', name: 'Annual Leave' });

/** HR then the Chief Executive. §4.3.1, and the reason a manager is not always a stage. */
const UNPAID = leaveType({
  code: 'UNPAID',
  name: 'Unpaid Leave',
  isPaid: false,
  approvalChain: ['HR', 'CEO'],
});

describe('what a history says happened', () => {
  it('carries every status, including the ones that gave the days back', () => {
    const history = historyOf({
      employeeId: '1',
      year: null,
      years: YEARS,
      types: [ANNUAL],
      decisions: [],
      requests: REQUEST_STATUSES.map((status, index) =>
        request({
          id: String(index + 1),
          status,
          awaitingApprovalFrom: status === 'SUBMITTED' ? 'MANAGER' : null,
          submittedAt: new Date(`2026-03-0${String(index + 1)}T09:00:00Z`),
        }),
      ),
    });

    expect(history.entries.map((entry) => entry.status).sort()).toEqual(
      [...REQUEST_STATUSES].sort(),
    );
  });

  /* The word rather than the constant, and the same word the ledger's own sentence uses —
     `inWordsSettled` is shared for that reason. `SUBMITTED` is the one status that file
     deliberately does not answer, because a request being decided has not had anything
     happen to it yet. */
  it('says where each has got to in a word a person says', () => {
    expect(statusInWords('SUBMITTED')).toBe('waiting to be decided');
    expect(statusInWords('APPROVED')).toBe('approved');
    expect(statusInWords('REFUSED')).toBe('refused');
    expect(statusInWords('WITHDRAWN')).toBe('withdrawn');
    expect(statusInWords('CANCELLED')).toBe('cancelled');
  });

  /* FR 11. The whole reason `leave_request.counting_basis` and `days` are columns: an HR
     Administrator moving annual leave to calendar days must not restate last March's
     fortnight, and a history is where that would be most visible. */
  it('prices nothing again, whatever the type says now', () => {
    const movedToCalendarDays = leaveType({
      code: 'ANNUAL',
      name: 'Annual Leave',
      countingBasis: 'CALENDAR_DAYS',
    });

    const [entry] = historyOf({
      employeeId: '1',
      year: null,
      years: YEARS,
      types: [movedToCalendarDays],
      decisions: [],
      requests: [request({ countingBasis: 'WORKING_DAYS', days: 10, calendarDays: 14 })],
    }).entries;

    expect(entry.countingBasis).toBe('WORKING_DAYS');
    expect(entry.countingBasisLabel).toBe('Working days');
    expect(entry.days).toBe(10);
    expect(entry.calendarDays).toBe(14);
  });

  /* A type that has gone is unreachable — the column is NOT NULL with a key behind it — and
     the answer is a name rather than a throw, because a history that showed nothing at all
     because one row of configuration was missing is the worse failure. */
  it('names the leave even where the type cannot be found', () => {
    const entry = entryOf({ request: request({}), type: undefined, decisions: [] });

    expect(entry.typeName).toBe('leave');
    expect(entry.progress.chain).toEqual([]);
  });
});

describe('the trail', () => {
  it('starts with the asking, which is the one instant nothing can have moved', () => {
    const asked = new Date('2026-02-01T08:30:00Z');

    const [first] = trailOf(request({ submittedAt: asked }), ANNUAL, []);

    expect(first.kind).toBe('ASKED');
    expect(first.at).toEqual(asked);
  });

  /**
   * The story's second criterion, and the comment is the half it names.
   *
   * FR 39. A refusal's reason is the only account of that decision anybody will have next
   * year, so it is asserted verbatim rather than by `toContain` — a trail that trimmed,
   * truncated or reworded it would still pass a looser check.
   */
  it('carries each decision, the desk it was made at, and what was said', () => {
    const steps = trailOf(request({ status: 'REFUSED', awaitingApprovalFrom: null }), ANNUAL, [
      decision({ id: '1', action: 'APPROVE', onBehalfOf: 'MANAGER' }),
      decision({
        id: '2',
        action: 'REFUSE',
        onBehalfOf: 'HR',
        decidedByEmployeeId: '3',
        decidedBy: 'employee 3',
        comment: 'Three of the team are already off that fortnight.\nAsk again for March.',
      }),
    ]);

    expect(steps.map((step) => step.kind)).toEqual(['ASKED', 'DECIDED', 'DECIDED']);

    expect(steps[1]).toMatchObject({
      desk: 'MANAGER',
      by: 'Ama Mensah',
      comment: null,
      inWords: 'Approved by your line manager.',
    });

    expect(steps[2]).toMatchObject({
      desk: 'HR',
      by: 'Kofi Boateng',
      comment: 'Three of the team are already off that fortnight.\nAsk again for March.',
    });
  });

  /**
   * FR 52. The name, rather than the handle the row carries.
   *
   * `decided_by` holds `Actor.description`, which `signedInAs` composes as `employee 3` — a
   * handle written for a log. "Turned down by employee 3" is not a sentence to show somebody
   * whose leave was refused, so the id is resolved against the records the caller read.
   */
  it('names the decider rather than repeating the handle the row carries', () => {
    const [, signed] = trailOf(request({}), ANNUAL, [decision({})]);

    expect(signed.by).toBe('Ama Mensah');
    expect(signed.by).not.toBe('employee 2');
  });

  /* And falls back to what was written where there is nobody to resolve — the system, or a
     decision nothing attributed. A blank would be worse than the honest sentence. */
  it('but keeps what was recorded where no person is named', () => {
    const [, signed] = trailOf(request({}), ANNUAL, [
      decision({ decidedByEmployeeId: null, decidedBy: UNATTRIBUTED }),
    ]);

    expect(signed.by).toBe(UNATTRIBUTED);
  });

  /**
   * FR 52. The desk a refusal was made *at* is not the desk the person belongs to.
   *
   * `TRANSITIONS` admits HR to the `REFUSE` row whichever desk a request is sitting on, so
   * "turned down at your line manager's stage" by an HR Officer is a real sentence — and the
   * manager reading it can see the decision was not theirs.
   */
  it('names the stage a refusal was made at rather than the person’s own desk', () => {
    const steps = trailOf(request({ status: 'REFUSED', awaitingApprovalFrom: null }), ANNUAL, [
      decision({
        action: 'REFUSE',
        onBehalfOf: 'MANAGER',
        /* Kofi is HR here, and the desk the request was standing on is the manager's. Both
           facts are on the step, which is what one column could not have said. */
        decidedByEmployeeId: '3',
        decidedBy: 'employee 3',
        comment: 'No.',
      }),
    ]);

    expect(steps[1].inWords).toBe('Turned down at your line manager’s stage.');
    expect(steps[1].by).toBe('Kofi Boateng');
  });

  /**
   * The decision this file exists to make, and the one a reasonable person would leave out.
   *
   * A trail that ended at the newest approval reads as agreement. LMS 316 is the story about
   * exactly that, and the answer here is that the stages nobody has been asked are on the
   * list, marked by having no time on them.
   */
  it('ends with the stages nobody has been asked yet', () => {
    const steps = trailOf(request({ status: 'SUBMITTED', awaitingApprovalFrom: 'HR' }), ANNUAL, [
      decision({ action: 'APPROVE', onBehalfOf: 'MANAGER' }),
    ]);

    expect(steps.map((step) => step.kind)).toEqual(['ASKED', 'DECIDED', 'STILL_TO_ASK']);
    expect(steps[2]).toMatchObject({ desk: 'HR', at: null, inWords: 'Waiting with HR now.' });
  });

  /* Two desks left, and only one of them is the one it is sitting on. The distinction is
     what stops a screen implying the Chief Executive has it this afternoon. */
  it('tells the desk it is with from the ones after it', () => {
    const steps = trailOf(request({ status: 'SUBMITTED', awaitingApprovalFrom: 'HR' }), UNPAID, []);

    expect(steps.map((step) => step.inWords)).toEqual([
      'You asked for this leave.',
      'Waiting with HR now.',
      'Then the Chief Executive, who has not been asked yet.',
    ]);
  });

  /* A request that has ended is waiting for nobody, whatever its type's chain has left in
     it. `progressOf` empties `stillToApprove` for anything that is not being decided, and
     this is that reading arriving on the screen. */
  it('offers no pending stages once a request has ended', () => {
    const steps = trailOf(request({ status: 'WITHDRAWN', awaitingApprovalFrom: null }), ANNUAL, []);

    expect(steps.some((step) => step.kind === 'STILL_TO_ASK')).toBe(false);
  });

  /**
   * The two endings nobody decided at a desk, and the one place this file reports a gap.
   *
   * There is no decision row for either — ../../src/features/leave-request/leave-decision.ts refuses to
   * record a judgement nobody made — so there is nobody to name. `updatedAt` is deliberately
   * not used as the time: a reworded reason moves it, so a withdrawn request tidied up in
   * March would report March as the day it was withdrawn.
   */
  it('says a request was taken back or cancelled without inventing who or when', () => {
    for (const status of ['WITHDRAWN', 'CANCELLED'] as const) {
      const steps = trailOf(request({ status, awaitingApprovalFrom: null }), ANNUAL, []);
      const ending = steps[steps.length - 1];

      expect(ending.kind).toBe('ENDED');
      expect(ending.by).toBeNull();
      expect(ending.at).toBeNull();
    }
  });

  /* And an approval or a refusal is not repeated as an ending. It ended the request in the
     step above, and saying it twice in two voices is a trail arguing with itself. */
  it('does not add an ending to a request a desk decided', () => {
    for (const status of ['APPROVED', 'REFUSED'] as const) {
      const steps = trailOf(request({ status, awaitingApprovalFrom: null }), ANNUAL, [
        decision({ action: status === 'APPROVED' ? 'APPROVE' : 'REFUSE', comment: 'Because.' }),
      ]);

      expect(steps.some((step) => step.kind === 'ENDED')).toBe(false);
    }
  });
});

describe('the order', () => {
  /* The reverse of `LeaveRequestRepository.list`, which orders by the day the leave starts
     "because a leave page is read as a calendar". A history is read the other way round. */
  it('puts the most recently asked for first', () => {
    const history = historyOf({
      employeeId: '1',
      year: null,
      years: YEARS,
      types: [ANNUAL],
      decisions: [],
      requests: [
        request({ id: '1', submittedAt: new Date('2026-01-05T09:00:00Z') }),
        request({ id: '2', submittedAt: new Date('2026-06-01T09:00:00Z') }),
        request({ id: '3', submittedAt: new Date('2026-03-02T09:00:00Z') }),
      ],
    });

    expect(history.entries.map((entry) => entry.requestId)).toEqual(['2', '3', '1']);
  });

  /* Two written in one transaction share an instant, and the sort is stable, so they keep
     the order the repository gave them rather than swapping between two reads. */
  it('keeps the order it was given where two were asked for in the same instant', () => {
    const together = new Date('2026-04-01T09:00:00Z');

    const requests = [
      request({ id: '7', submittedAt: together }),
      request({ id: '8', submittedAt: together }),
    ];

    expect([...requests].sort(byMostRecentlyAsked).map((one) => one.id)).toEqual(['7', '8']);
  });
});

describe('which years may be asked for', () => {
  /* Narrower than the balance screen's picker on purpose: a year with no requests has
     nothing to show, where a year with no movements still has an allowance. */
  it('offers only the years this person has asked for leave in, oldest first', () => {
    const years = yearsWithRequests(YEARS, [
      request({ id: '1', leaveYearId: YEAR_2027.id }),
      request({ id: '2', leaveYearId: YEAR_2025.id }),
      request({ id: '3', leaveYearId: YEAR_2025.id }),
    ]);

    expect(years.map((one) => one.label)).toEqual(['2025', '2027']);
  });

  it('offers nothing at all to somebody who has never asked', () => {
    expect(yearsWithRequests(YEARS, [])).toEqual([]);
  });
});

describe('the progress it carries', () => {
  /* FR 41. `agreed` is the status and nothing cleverer — see `progressOf`, which argues why
     it is not "every stage has approved". This history carries that answer rather than a
     second one derived from the trail. */
  it('is the same answer progressOf gives, unchanged', () => {
    const raised = request({ status: 'SUBMITTED', awaitingApprovalFrom: 'HR' });
    const decisions = [decision({ action: 'APPROVE', onBehalfOf: 'MANAGER' })];

    const entry = entryOf({ request: raised, type: ANNUAL, decisions });

    expect(entry.progress).toEqual(
      progressOf({
        request: raised,
        chain: ANNUAL.approvalChain,
        approvedBy: desksThatApproved(decisions),
      }),
    );
  });

  /* The approvals count and the refusal does not, which is `desksThatApproved`'s rule. A
     refused request never reaches the walk, and filtering rather than mapping is what keeps
     that true if it ever does. */
  it('counts only approvals towards the stages that have signed', () => {
    const entry = entryOf({
      request: request({ status: 'REFUSED', awaitingApprovalFrom: null }),
      type: ANNUAL,
      decisions: [
        decision({ id: '1', action: 'APPROVE', onBehalfOf: 'MANAGER' }),
        decision({ id: '2', action: 'REFUSE', onBehalfOf: 'HR', comment: 'No.' }),
      ],
    });

    expect(entry.progress.approvedBy).toEqual(['MANAGER']);
    expect(entry.progress.agreed).toBe(false);
  });
});

describe('grouping', () => {
  /* One query brings back every decision on the page, so the grouping has to be right or a
     manager's comment appears under somebody else's request. */
  it('files each decision under the request it decides', () => {
    const history = historyOf({
      employeeId: '1',
      year: YEAR_2026,
      years: [YEAR_2026],
      types: [ANNUAL],
      decisions: [
        decision({ id: '1', leaveRequestId: '1', action: 'APPROVE', onBehalfOf: 'MANAGER' }),
        decision({
          id: '2',
          leaveRequestId: '2',
          action: 'REFUSE',
          onBehalfOf: 'MANAGER',
          comment: 'Not that week.',
        }),
      ],
      requests: [
        request({ id: '1', status: 'SUBMITTED', awaitingApprovalFrom: 'HR' }),
        request({ id: '2', status: 'REFUSED', awaitingApprovalFrom: null }),
      ],
    });

    const refused = history.entries.find((entry) => entry.requestId === '2');

    expect(refused?.trail.map((step) => step.comment)).toContain('Not that week.');
    expect(
      history.entries.find((entry) => entry.requestId === '1')?.trail.map((step) => step.comment),
    ).not.toContain('Not that week.');
  });
});

/* --------------------------------------------------------------------------- fixtures */

/**
 * The two people who decide anything below, by the ids the fixture decisions carry.
 *
 * Every fixture's `decidedBy` is `employee 2` rather than a name, because that is what
 * `signedInAs` actually writes into the column — a suite whose fixtures carried names would
 * pass whether or not anything resolved them.
 */
const DECIDERS: Deciders = new Map([
  ['2', 'Ama Mensah'],
  ['3', 'Kofi Boateng'],
]);

/** The same two as records, which is the shape `historyFor` is handed. */
const DECIDING_PEOPLE: Employee[] = [person('2', 'Ama', 'Mensah'), person('3', 'Kofi', 'Boateng')];

/* `historyFor` and `entryFor` take the deciders as a parameter, and every test below wants
   the same two. Wrapped rather than repeated, so a test says what it is about. */
function historyOf(facts: Omit<RequestHistoryFacts, 'deciders'>): RequestHistory {
  return historyFor({ ...facts, deciders: DECIDING_PEOPLE });
}

function entryOf(input: Omit<Parameters<typeof entryFor>[0], 'deciders'>): RequestHistoryEntry {
  return entryFor({ ...input, deciders: DECIDERS });
}

function trailOf(
  one: LeaveRequest,
  type: LeaveType,
  decisions: readonly LeaveDecision[],
): TrailStep[] {
  return trailFor(
    one,
    progressOf({
      request: one,
      chain: type.approvalChain,
      approvedBy: desksThatApproved(decisions),
    }),
    decisions,
    DECIDERS,
  );
}

function request(changes: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: '1',
    employeeId: '1',
    leaveTypeId: ANNUAL.id,
    leaveYearId: YEAR_2026.id,
    from: '2026-03-02',
    to: '2026-03-13',
    reason: 'Two weeks with family.',
    countingBasis: 'WORKING_DAYS',
    days: 10,
    calendarDays: 12,
    status: 'SUBMITTED',
    awaitingApprovalFrom: 'MANAGER',
    submittedAt: new Date('2026-02-01T09:00:00Z'),
    createdAt: new Date('2026-02-01T09:00:00Z'),
    updatedAt: new Date('2026-02-01T09:00:00Z'),
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
    /** FR 44. Null on everything that is not an override. LMS 318. */
    overridesDecisionId: null,
    /* What `signedInAs` actually writes into the column — a handle for a log rather than a
       name. Fixtures carrying names would pass whether or not anything resolved them. */
    decidedBy: 'employee 2',
    decidedByEmployeeId: '2',
    decidedAt: new Date('2026-02-02T09:00:00Z'),
    ...changes,
  };
}

/** Somebody who decided something. Only the name is read; the rest is a valid record. */
function person(id: string, firstName: string, lastName: string): Employee {
  return {
    id,
    employeeNumber: `EMP-${id}`,
    firstName,
    lastName,
    workEmail: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@rematholdings.com`,
    jobTitle: null,
    departmentId: '1',
    managerId: null,
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
