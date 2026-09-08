import { describe, expect, it } from 'vitest';
import { APPROVER_ROLES } from '../../src/features/leave-type/approval-chain.js';
import type { Actor } from '../../src/auth/actor.js';
import {
  AlreadyDelegated,
  type ApprovalDelegation,
  DelegateIsTheApprover,
  delegatedAuthorityFrom,
  delegatesOf,
  delegationsThatBearOn,
  InvalidDelegation,
  validateNewDelegation,
} from '../../src/features/leave-request/delegation.js';
import {
  answeredOnBehalfOf,
  desksHandedTo,
  desksStaffedBy,
  leaveRequestPolicy,
} from '../../src/features/leave-request/policy.js';
import type { RoleCode } from '../../src/features/role/roles.js';

/**
 * An approver hands their approvals to a colleague. FR 49, §8.6a, LMS 327.
 *
 * The pure half: what a nomination has to be, which days it covers, which desks it reaches
 * and whose name a decision made under it carries. Whether the rows are actually there is
 * ../integration/delegation.test.ts's.
 *
 * Kofi manages Adwoa. Ama is an HR Officer. Yaw is the Chief Executive. Esi is nobody in
 * particular, which is what makes her a delegate worth testing: she staffs nothing herself.
 */

const KOFI = 'kofi';
const AMA = 'ama';
const YAW = 'yaw';
const ESI = 'esi';
const ADWOA = 'adwoa';

function person(employeeId: string, roles: RoleCode[] = ['EMPLOYEE'], isManager = false): Actor {
  return { employeeId, roles, isManager, description: `employee ${employeeId}` };
}

function delegation(fields: Partial<ApprovalDelegation> = {}): ApprovalDelegation {
  return {
    id: 'delegation-1',
    approverId: KOFI,
    delegateId: ESI,
    from: '2026-03-02',
    to: '2026-03-13',
    because: 'On leave myself',
    revokedAt: null,
    revokedBy: null,
    nominatedBy: `employee ${KOFI}`,
    nominatedAt: new Date('2026-02-20T09:00:00Z'),
    ...fields,
  };
}

/* ----------------------------------------------------------------- the nomination */

describe('nominating a delegate', () => {
  it('takes a colleague and a date range', () => {
    const written = validateNewDelegation({
      approverId: KOFI,
      delegateId: ESI,
      from: '2026-03-02',
      to: '2026-03-13',
      because: '  Annual leave  ',
    });

    expect(written).toEqual({
      approverId: KOFI,
      delegateId: ESI,
      from: '2026-03-02',
      to: '2026-03-13',
      because: 'Annual leave',
    });
  });

  /** A reason is optional, and blank is nothing — as a decision's comment is. */
  it('and a reason it need not have', () => {
    expect(validateNewDelegation({ ...aNomination(), because: '   ' }).because).toBeNull();
    expect(validateNewDelegation({ ...aNomination(), because: undefined }).because).toBeNull();
  });

  it('refuses one somebody made to themselves', () => {
    expect(() => validateNewDelegation({ ...aNomination(), delegateId: KOFI })).toThrow(
      DelegateIsTheApprover,
    );
  });

  it('refuses a range that ends before it starts', () => {
    expect(() =>
      validateNewDelegation({ ...aNomination(), from: '2026-03-13', to: '2026-03-02' }),
    ).toThrow(InvalidDelegation);
  });

  /* One day is the same date twice, which is the reading every period in this system takes. */
  it('and takes a single day, which is the same date twice', () => {
    const one = validateNewDelegation({ ...aNomination(), from: '2026-03-02', to: '2026-03-02' });

    expect(one.from).toBe(one.to);
  });

  /**
   * And it is cover rather than a standing arrangement.
   *
   * A permanent change of approver is a change to the reporting line or to a role, and both
   * of those move the desk itself. A delegation that ran for ever would be a second, quieter
   * way of granting authority that nothing in the org chart shows.
   */
  it('refuses somebody else answering for a year and more', () => {
    expect(() =>
      validateNewDelegation({ ...aNomination(), from: '2026-01-01', to: '2027-06-01' }),
    ).toThrow(InvalidDelegation);
  });

  it('refuses dates that are not dates', () => {
    expect(() => validateNewDelegation({ ...aNomination(), from: '02/03/2026' })).toThrow(
      InvalidDelegation,
    );
  });
});

/* ---------------------------------------------------------- and whose leave it never reaches */

/**
 * FR 48, LMS 319 read as a fact about the desk.
 *
 * The case is the lone HR officer's: her own unpaid leave stands at the desk she staffs, and
 * a delegate of hers answering it would be her own request decided by a standing she granted
 * this morning.
 */
describe('a delegation over the delegator’s own leave', () => {
  it('carries nothing', () => {
    const hers = delegation({ approverId: AMA });
    const somebody = delegation({ id: 'delegation-2', approverId: KOFI });

    expect(delegationsThatBearOn([hers, somebody], AMA)).toEqual([somebody]);
    expect(delegationsThatBearOn([hers, somebody], ADWOA)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ who is at a desk */

describe('who a delegation puts at a desk', () => {
  it('names the delegates of the people there', () => {
    const covering = [delegation(), delegation({ id: 'delegation-2', approverId: AMA })];

    expect(delegatesOf(covering, [KOFI])).toEqual([ESI]);
    expect(delegatesOf(covering, [AMA, KOFI])).toEqual([ESI]);
    expect(delegatesOf(covering, [YAW])).toEqual([]);
  });

  /**
   * And what each delegation amounts to is read from the delegator, never stored.
   *
   * The property the whole design rests on: a delegate's desks are whatever their delegator
   * holds *today*, so an officer who loses their HR role hands nothing on from that moment.
   */
  it('and works out its desks from what the approver holds now', () => {
    const held = new Map<string, RoleCode[]>([[AMA, ['EMPLOYEE', 'HR_OFFICER']]]);

    expect(delegatedAuthorityFrom([delegation({ approverId: AMA })], held, [KOFI])).toEqual([
      { approverId: AMA, roles: ['EMPLOYEE', 'HR_OFFICER'], isManager: false },
    ]);

    expect(delegatedAuthorityFrom([delegation()], held, [KOFI])).toEqual([
      { approverId: KOFI, roles: [], isManager: true },
    ]);
  });
});

/* -------------------------------------------------------------- the desks a delegate staffs */

describe('the desks a delegate staffs', () => {
  const coveringForKofi = [
    { approverId: KOFI, roles: ['EMPLOYEE'] as RoleCode[], isManager: true },
  ];

  it('gives them their delegator’s, and their delegator’s reports', () => {
    const staffed = desksStaffedBy(person(ESI), YAW, coveringForKofi);

    expect(staffed.desks).toEqual(['MANAGER']);
    /** Theirs is still empty: they gained a desk without gaining a report. */
    expect(staffed.own).toEqual([]);
    expect(staffed.managerIds).toEqual([KOFI]);
    expect(staffed.delegated).toEqual([{ approverId: KOFI, desks: ['MANAGER'] }]);
  });

  it('and adds them to their own rather than replacing them', () => {
    const officer = desksStaffedBy(person(ESI, ['EMPLOYEE', 'HR_OFFICER']), YAW, coveringForKofi);

    expect(officer.desks).toEqual(['MANAGER', 'HR']);
    expect(officer.own).toEqual(['HR']);
    /** Their own reports and their delegator's both reach the manager's desk. */
    expect(
      desksStaffedBy(person(ESI, ['EMPLOYEE'], true), YAW, coveringForKofi).managerIds,
    ).toEqual([ESI, KOFI]);
  });

  it('and gives them the Chief Executive’s desk where that is who they cover', () => {
    const forTheChief = [{ approverId: YAW, roles: ['EMPLOYEE'] as RoleCode[], isManager: false }];

    expect(desksStaffedBy(person(ESI), YAW, forTheChief).desks).toEqual(['CEO']);
    /* And where the setting names somebody else, the same nomination reaches nothing: the
       seat is a setting, so a delegate of yesterday's Chief Executive staffs no desk. */
    expect(desksStaffedBy(person(ESI), AMA, forTheChief).desks).toEqual([]);
  });

  /** A delegator who staffs nothing hands nothing on. */
  it('and gives them nothing where their delegator answers nowhere', () => {
    const ordinary = [{ approverId: ADWOA, roles: ['EMPLOYEE'] as RoleCode[], isManager: false }];

    expect(desksStaffedBy(person(ESI), YAW, ordinary).desks).toEqual([]);
    expect(desksStaffedBy(person(ESI), YAW, ordinary).delegated).toEqual([]);
  });
});

/* ------------------------------------------------------------------ deciding as a delegate */

describe('a delegate at the desk', () => {
  const coveringForKofi = [
    { approverId: KOFI, roles: ['EMPLOYEE'] as RoleCode[], isManager: true },
  ];

  /** Adwoa's request, standing at her manager Kofi's desk. */
  function adwoasRequest(standingIn = desksHandedTo(person(ESI), YAW, coveringForKofi)) {
    return {
      employeeId: ADWOA,
      managerId: KOFI,
      awaiting: 'MANAGER' as const,
      chiefExecutiveId: YAW,
      standingIn,
    };
  }

  it('may approve what their delegator would have', () => {
    expect(leaveRequestPolicy.approve(person(ESI), adwoasRequest()).allowed).toBe(true);
    expect(leaveRequestPolicy.refuse(person(ESI), adwoasRequest()).allowed).toBe(true);
  });

  it('and may not without one', () => {
    expect(leaveRequestPolicy.approve(person(ESI), adwoasRequest([])).allowed).toBe(false);
  });

  /**
   * And a delegate of one manager has no standing over another manager's reports.
   *
   * The `MANAGER` desk is a relationship rather than a rank, which is the whole of why the
   * queue narrows it by id. Without this a delegation would quietly widen to every team.
   */
  it('and only over the reports of the manager they cover', () => {
    const someoneElses = { ...adwoasRequest(), employeeId: 'kojo', managerId: AMA };

    expect(leaveRequestPolicy.approve(person(ESI), someoneElses).allowed).toBe(false);
  });

  /** FR 48. And never over their delegator's own leave, whichever desk it is standing at. */
  it('and never over the leave of the person who nominated them', () => {
    const hisOwn = { ...adwoasRequest(), employeeId: KOFI, managerId: AMA };

    expect(leaveRequestPolicy.approve(person(ESI), hisOwn).allowed).toBe(false);
  });
});

/* ------------------------------------------------------------- and what the decision records */

describe('whose approvals a decision answered', () => {
  const coveringForAma = [
    { approverId: AMA, roles: ['EMPLOYEE', 'HR_OFFICER'] as RoleCode[], isManager: false },
  ];

  function atTheDesk(actor: Actor, covering = coveringForAma) {
    return {
      employeeId: ADWOA,
      managerId: KOFI,
      awaiting: 'HR' as const,
      chiefExecutiveId: YAW,
      standingIn: desksHandedTo(actor, YAW, covering),
    };
  }

  /** The story's third criterion: the hand is `decided_by`, and this is whose absence it covered. */
  it('names the approver where the decider is standing in', () => {
    const esi = person(ESI);

    expect(answeredOnBehalfOf(esi, 'HR', atTheDesk(esi))).toBe(AMA);
  });

  /**
   * And names nobody where the decider staffs the desk themselves.
   *
   * A second HR officer who happens to hold a delegation is answering as HR, not as Ama —
   * recording her name would put a colleague's on a judgement she did not make.
   */
  it('and names nobody where they are at the desk in their own right', () => {
    const efua = person('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(answeredOnBehalfOf(efua, 'HR', atTheDesk(efua))).toBeNull();
  });

  /* The desk is the walk's answer rather than the request's cursor, so a delegation covering
     a desk this decision did not land on names nobody. */
  it('and is asked about the desk that was actually answered', () => {
    const esi = person(ESI);

    expect(answeredOnBehalfOf(esi, 'MANAGER', atTheDesk(esi))).toBeNull();
  });

  it('and names the manager where that is the desk being covered', () => {
    const forKofi = [{ approverId: KOFI, roles: ['EMPLOYEE'] as RoleCode[], isManager: true }];
    const esi = person(ESI);

    expect(
      answeredOnBehalfOf(esi, 'MANAGER', { ...atTheDesk(esi, forKofi), awaiting: 'MANAGER' }),
    ).toBe(KOFI);
  });

  /** Every desk there is, so one added to `APPROVER_ROLES` cannot be left unanswerable. */
  it('and answers for every desk a chain can name', () => {
    const forEverything = [
      { approverId: AMA, roles: ['EMPLOYEE', 'HR_OFFICER'] as RoleCode[], isManager: true },
      { approverId: YAW, roles: ['EMPLOYEE'] as RoleCode[], isManager: false },
    ];

    const esi = person(ESI);
    const standingIn = desksHandedTo(esi, YAW, forEverything);

    for (const desk of APPROVER_ROLES) {
      const subject = {
        employeeId: ADWOA,
        managerId: AMA,
        awaiting: desk,
        chiefExecutiveId: YAW,
        standingIn,
      };

      expect(leaveRequestPolicy.approve(esi, subject).allowed).toBe(true);
      expect(answeredOnBehalfOf(esi, desk, subject)).not.toBeNull();
    }
  });
});

/* ---------------------------------------------------------------------- the refusals */

describe('a second delegate over the same days', () => {
  it('says which days are already covered', () => {
    const refusal = new AlreadyDelegated({ from: '2026-03-02', to: '2026-03-13' });

    expect(refusal.message).toContain('2 March 2026');
    expect(refusal.message).toContain('One delegate at a time');
    expect(refusal.code).toBe('ALREADY_DELEGATED');
  });
});

function aNomination() {
  return { approverId: KOFI, delegateId: ESI, from: '2026-03-02', to: '2026-03-13' };
}
