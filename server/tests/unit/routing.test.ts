import { describe, expect, it } from 'vitest';
import { APPROVER_ROLES, type ApproverRole } from '../../src/features/leave-type/approval-chain.js';
import {
  canDecide,
  type DeskDecision,
  type DeskOccupants,
  DESK_STANDINGS,
  type DesksAvailable,
  desksAsked,
  desksAvailable,
  type DeskStanding,
  NO_OCCUPANTS_NAMED,
  routeFrom,
  type SkippedStage,
  STAND_IN_FOR,
  standingOf,
  stagesSkipped,
  whatWouldRouteIt,
} from '../../src/features/leave-request/routing.js';

/**
 * A request goes to somebody who can actually decide it. FR 48, FR 48b, §8.6a. LMS 320.
 *
 * The walk is pure, so the whole of the story is provable here: which desk a request goes
 * to, which stages were skipped on the way, and — the one that matters most — that running
 * out of people to ask never approves anything.
 *
 * The chains are written out rather than read off a leave type, for the reason
 * ./state-machine.test.ts writes its own out: the routing is a function of a list of desks
 * and what each of them amounts to, and nothing in it knows which leave type is which.
 */

/** The ordinary chain: manager then HR. Every type but the two unpaid ones. */
const ORDINARY: readonly ApproverRole[] = ['MANAGER', 'HR'];

/** HR then the Chief Executive, and no manager stage at all. FR 32h, §4.3.1. */
const UNPAID: readonly ApproverRole[] = ['HR', 'CEO'];

/** Every desk staffed by somebody who is not the requester. */
const ANYBODY: DesksAvailable = { MANAGER: 'CAN_DECIDE', HR: 'CAN_DECIDE', CEO: 'CAN_DECIDE' };

function withDesks(overrides: Partial<DesksAvailable>): DesksAvailable {
  return { ...ANYBODY, ...overrides };
}

/** Who signs at a desk, where the three desks are three different people. FR 48d. */
function officerAt(desk: ApproverRole): string {
  return `${desk.toLowerCase()}-officer`;
}

function route(
  chain: readonly ApproverRole[],
  available: DesksAvailable,
  decided: readonly ApproverRole[] = [],
  skipped: readonly SkippedStage[] = [],
) {
  return routeFrom({
    chain,
    decided: decided.map((desk) => ({ desk, by: officerAt(desk) })),
    skipped,
    available,
    /* FR 48d. No names, which is what LMS 320's walk had: who is at a desk changes nothing
       until somebody at it has decided. LMS 322. */
    occupants: NO_OCCUPANTS_NAMED,
  });
}

/** The same walk with people at the desks, which is what FR 48d turns on. LMS 322. */
function routeAmong(input: {
  chain: readonly ApproverRole[];
  occupants: DeskOccupants;
  decided?: readonly DeskDecision[];
  available?: DesksAvailable;
  skipped?: readonly SkippedStage[];
}) {
  return routeFrom({
    chain: input.chain,
    decided: input.decided ?? [],
    skipped: input.skipped ?? [],
    available: input.available ?? ANYBODY,
    occupants: input.occupants,
  });
}

/* -------------------------------------------------------------- nothing to route around */

describe('a chain every desk can answer', () => {
  it('goes to its first stage, skipping nothing', () => {
    expect(route(ORDINARY, ANYBODY)).toEqual({ kind: 'DESK', desk: 'MANAGER', skips: [] });
  });

  it('and to the next stage once that one has decided', () => {
    expect(route(ORDINARY, ANYBODY, ['MANAGER'])).toEqual({
      kind: 'DESK',
      desk: 'HR',
      skips: [],
    });
  });

  it('and is decided once every stage has had its say', () => {
    expect(route(ORDINARY, ANYBODY, ['MANAGER', 'HR'])).toEqual({
      kind: 'DECIDED',
      skips: [],
      /** FR 48d. Two desks, two officers. LMS 322. */
      singleApprover: false,
    });
  });
});

/* ------------------------------------------- the manager stage, which is skipped to HR */

/**
 * The Chief Executive's own annual leave. FR 04, FR 48b's first criterion.
 *
 * The case the story is named for: FR 04 leaves exactly one employee without a line manager,
 * so their ordinary requests have a first stage nobody staffs.
 */
describe('a manager stage nobody can answer', () => {
  const noManager = withDesks({ MANAGER: 'NOBODY_STAFFS_IT' });

  it('skips to HR, and records the skip', () => {
    expect(route(ORDINARY, noManager)).toEqual({
      kind: 'DESK',
      desk: 'HR',
      skips: [
        {
          stage: 'MANAGER',
          routedTo: 'HR',
          because: expect.stringContaining('no line manager') as string,
        },
      ],
    });
  });

  /* And HR's own stage is then answered by the same signature rather than asked twice. */
  it('and HR deciding once settles both stages', () => {
    const skips = route(ORDINARY, noManager).skips;

    expect(route(ORDINARY, noManager, ['HR'], skips)).toEqual({
      kind: 'DECIDED',
      skips: [],
      /** FR 48d. One signature settled both stages, so the request says so. LMS 322. */
      singleApprover: true,
    });
  });

  /* Nothing is approved by the stage being empty: HR still has to say yes. */
  it('and nothing is decided by the manager stage being empty', () => {
    expect(route(ORDINARY, noManager).kind).not.toBe('DECIDED');
  });
});

/* --------------------------------------- the HR stage, which falls to the Chief Executive */

/**
 * The lone HR officer's own leave. FR 48b's second criterion, and the `lone-hr` scenario.
 *
 * "Another HR officer" is not a fallback: the HR desk is staffed by a role, so a second
 * officer already fills it. This branch is reached only once there is nobody in HR but the
 * person who asked.
 */
describe('an HR stage only the requester staffs', () => {
  const loneHr = withDesks({ HR: 'ONLY_THE_REQUESTER' });

  it('is still answered by HR while somebody else holds the role', () => {
    expect(route(UNPAID, ANYBODY)).toEqual({ kind: 'DESK', desk: 'HR', skips: [] });
  });

  it('and falls to the Chief Executive when nobody else does', () => {
    expect(route(UNPAID, loneHr)).toEqual({
      kind: 'DESK',
      desk: 'CEO',
      skips: [
        {
          stage: 'HR',
          routedTo: 'CEO',
          because: expect.stringContaining('nobody decides their own request') as string,
        },
      ],
    });
  });

  /* Their unpaid leave is HR then the Chief Executive, and one signature settles both. */
  it('and the Chief Executive deciding once settles both stages of unpaid leave', () => {
    const skips = route(UNPAID, loneHr).skips;

    expect(route(UNPAID, loneHr, ['CEO'], skips)).toEqual({
      kind: 'DECIDED',
      skips: [],
      /** FR 48d, LMS 322. */
      singleApprover: true,
    });
  });

  /* Their annual leave still goes to their own line manager first: only the empty stage moves. */
  it('and their annual leave still starts with their line manager', () => {
    expect(route(ORDINARY, loneHr)).toEqual({ kind: 'DESK', desk: 'MANAGER', skips: [] });
    expect(route(ORDINARY, loneHr, ['MANAGER'])).toMatchObject({ kind: 'DESK', desk: 'CEO' });
  });
});

/* ------------------------------------------ the CEO stage, which falls back to HR */

/**
 * The Chief Executive's own unpaid leave. FR 48b's third criterion.
 *
 * The one rung that points downwards, and the reason {@link STAND_IN_FOR} is written out
 * rather than derived from an ordering: there is nothing above FR 04's root.
 */
describe('a CEO stage the requester holds', () => {
  const theyAreTheCeo = withDesks({ MANAGER: 'NOBODY_STAFFS_IT', CEO: 'ONLY_THE_REQUESTER' });

  /* Their unpaid leave is HR then the Chief Executive; HR takes the first stage as usual,
     and the second falls back to the desk that has already answered it. */
  it('falls to HR, and HR deciding once settles it', () => {
    expect(route(UNPAID, theyAreTheCeo)).toEqual({ kind: 'DESK', desk: 'HR', skips: [] });

    expect(route(UNPAID, theyAreTheCeo, ['HR'])).toEqual({
      kind: 'DECIDED',
      skips: [
        {
          stage: 'CEO',
          routedTo: 'HR',
          because: expect.stringContaining('nobody decides their own request') as string,
        },
      ],
      /** FR 48d, LMS 322. */
      singleApprover: true,
    });
  });

  /* And with no HR at all it stops, rather than being agreed by the person who asked. */
  it('and stops rather than approving itself where HR is empty too', () => {
    const alone = withDesks({ HR: 'NOBODY_STAFFS_IT', CEO: 'ONLY_THE_REQUESTER' });

    expect(route(UNPAID, alone)).toMatchObject({ kind: 'UNROUTABLE', stranded: 'HR' });
  });

  /* And their own annual leave: no manager, so HR takes both stages. */
  it('and their annual leave goes to HR for both stages', () => {
    const first = route(ORDINARY, theyAreTheCeo);

    expect(first).toMatchObject({ kind: 'DESK', desk: 'HR' });
    expect(route(ORDINARY, theyAreTheCeo, ['HR'], first.skips)).toMatchObject({ kind: 'DECIDED' });
  });
});

/* ---------------------------------------------- neither one nor the other. FR 48b */

describe('a stage with neither its desk nor its stand-in', () => {
  it('leaves the request unroutable, naming the stage it stopped at', () => {
    const nobody = withDesks({ MANAGER: 'NOBODY_STAFFS_IT', HR: 'NOBODY_STAFFS_IT' });

    /* HR is the manager stage's stand-in and is empty too, so the walk stops at MANAGER. */
    expect(route(ORDINARY, nobody)).toMatchObject({ kind: 'UNROUTABLE', stranded: 'MANAGER' });
  });

  it('and says why, in words that name both empty desks', () => {
    const nobody = withDesks({ HR: 'ONLY_THE_REQUESTER', CEO: 'ONLY_THE_REQUESTER' });
    const stopped = route(UNPAID, nobody);

    expect(stopped.kind).toBe('UNROUTABLE');
    expect(stopped.kind === 'UNROUTABLE' && stopped.because).toContain('nobody left to ask');
  });

  /**
   * And the stranded stage is not recorded as a skip. FR 48b.
   *
   * A skip is never reconsidered, so recording one for a stage nobody answered would make
   * the request unroutable for ever — an HR officer hired next week could not unstick it.
   */
  it('and records no skip for it, so re-routing can reconsider the stage', () => {
    const nobody = withDesks({ HR: 'NOBODY_STAFFS_IT', CEO: 'NOBODY_STAFFS_IT' });
    const stopped = route(UNPAID, nobody);

    expect(stopped.skips).toEqual([]);
    expect(route(UNPAID, ANYBODY, [], stopped.skips)).toMatchObject({ kind: 'DESK', desk: 'HR' });
  });

  /* The whole of the last criterion, said as the thing that must never happen. */
  it('and never comes back decided', () => {
    for (const desk of APPROVER_ROLES) {
      const empty = desksAvailable(() => 'NOBODY_STAFFS_IT');

      expect(route([desk], empty).kind).toBe('UNROUTABLE');
      expect(route([desk], empty).kind).not.toBe('DECIDED');
    }
  });
});

/* ------------------------------------------- two stages that resolve to one person */

/**
 * The single approver exception. FR 48d, LMS 322.
 *
 * Ama is Kofi's line manager and holds an HR role, so his annual leave has two stages with
 * one person at both. LMS 320 asked her twice; this asks somebody else, and where the company
 * has nobody else it says on the record that one approver decided it.
 */
describe('a stage its own people have already decided', () => {
  /** Ama is the manager and in HR; Efua is the other officer; Kwesi is the Chief Executive. */
  const decidedByAma: readonly DeskDecision[] = [{ desk: 'MANAGER', by: 'ama' }];

  it('is still asked where a second officer is at the desk', () => {
    const routed = routeAmong({
      chain: ORDINARY,
      decided: decidedByAma,
      occupants: { MANAGER: ['ama'], HR: ['ama', 'efua'], CEO: ['kwesi'] },
    });

    expect(routed).toEqual({ kind: 'DESK', desk: 'HR', skips: [] });
  });

  /* The story's first criterion: two stages, two different officers. */
  it('and goes to the stand-in where the desk is that one person alone', () => {
    const routed = routeAmong({
      chain: ORDINARY,
      decided: decidedByAma,
      occupants: { MANAGER: ['ama'], HR: ['ama'], CEO: ['kwesi'] },
    });

    expect(routed).toEqual({
      kind: 'DESK',
      desk: 'CEO',
      skips: [
        {
          stage: 'HR',
          routedTo: 'CEO',
          because: expect.stringContaining('already decided this request') as string,
        },
      ],
    });
  });

  /* And the second criterion: with nobody else, it is stamped rather than signed twice, and
     the stage is recorded against the desk that hand did sign at. */
  it('and is decided by a single approver where the company has nobody else', () => {
    const routed = routeAmong({
      chain: ORDINARY,
      decided: decidedByAma,
      available: withDesks({ CEO: 'NOBODY_STAFFS_IT' }),
      occupants: { MANAGER: ['ama'], HR: ['ama'], CEO: [] },
    });

    expect(routed).toEqual({
      kind: 'DECIDED',
      singleApprover: true,
      skips: [{ stage: 'HR', routedTo: 'MANAGER', because: expect.any(String) as string }],
    });
  });

  /* Two people is the ordinary case, and is not stamped. */
  it('and a chain two people answered is not a single approver', () => {
    const routed = routeAmong({
      chain: ORDINARY,
      decided: [
        { desk: 'MANAGER', by: 'ama' },
        { desk: 'HR', by: 'efua' },
      ],
      occupants: { MANAGER: ['ama'], HR: ['ama', 'efua'], CEO: ['kwesi'] },
    });

    expect(routed).toMatchObject({ kind: 'DECIDED', singleApprover: false });
  });

  /* Nor is a chain that only ever asked for one signature: that is not an exception. */
  it('and a chain of one stage is not an exception', () => {
    const routed = routeAmong({
      chain: ['HR'],
      decided: [{ desk: 'HR', by: 'ama' }],
      occupants: { MANAGER: [], HR: ['ama'], CEO: [] },
    });

    expect(routed).toMatchObject({ kind: 'DECIDED', singleApprover: false });
  });

  /* And an unnamed writer is nobody, so two of its decisions are not one person's. */
  it('and decisions nothing named are not one approver', () => {
    const routed = routeAmong({
      chain: ORDINARY,
      decided: [
        { desk: 'MANAGER', by: null },
        { desk: 'HR', by: null },
      ],
      occupants: { MANAGER: ['ama'], HR: ['efua'], CEO: ['kwesi'] },
    });

    expect(routed).toMatchObject({ kind: 'DECIDED', singleApprover: false });
  });

  /* A stage nobody staffs still stops the request rather than collapsing onto a hand. */
  it('and a stage with nobody at either desk still stops the request', () => {
    const routed = routeAmong({
      chain: UNPAID,
      available: withDesks({ HR: 'NOBODY_STAFFS_IT', CEO: 'NOBODY_STAFFS_IT' }),
      occupants: { MANAGER: ['ama'], HR: [], CEO: [] },
    });

    expect(routed).toMatchObject({ kind: 'UNROUTABLE', stranded: 'HR' });
  });
});

/* ------------------------------------------------ a recorded skip is never reconsidered */

/**
 * The one thing carried rather than recomputed. FR 48b, LMS 316's discipline.
 *
 * A manager's stage skipped on Monday because the requester had no line manager is a stage
 * that has had its turn. Somebody appointed on Wednesday does not send a request that is
 * already with HR back down.
 */
describe('a skip already recorded', () => {
  const skipped: SkippedStage[] = [
    { stage: 'MANAGER', routedTo: 'HR', because: 'they had no line manager' },
  ];

  it('is not undone by the desk being staffed afterwards', () => {
    expect(route(ORDINARY, ANYBODY, [], skipped)).toEqual({
      kind: 'DESK',
      desk: 'HR',
      skips: [],
    });
  });

  it('and is not written a second time', () => {
    expect(route(ORDINARY, withDesks({ MANAGER: 'NOBODY_STAFFS_IT' }), [], skipped).skips).toEqual(
      [],
    );
  });
});

/* --------------------------------------------------------- the desks actually asked */

describe('the desks a request is asked at', () => {
  it('is the chain itself where nothing was skipped', () => {
    expect(desksAsked(ORDINARY, [])).toEqual(['MANAGER', 'HR']);
  });

  /**
   * And a skipped stage is replaced by the desk that took it, deduplicated.
   *
   * What `ApprovalChainChanged` reads: a request that fell to a stand-in is standing at a
   * desk its type's chain does not name, and refusing it there would refuse every request
   * FR 48b exists to move.
   */
  it('and a skipped stage is replaced by the desk that took it, once', () => {
    expect(
      desksAsked(ORDINARY, [{ stage: 'MANAGER', routedTo: 'HR', because: 'no manager' }]),
    ).toEqual(['HR']);

    expect(desksAsked(UNPAID, [{ stage: 'HR', routedTo: 'CEO', because: 'lone officer' }])).toEqual(
      ['CEO'],
    );
  });

  it('and the skipped stages come back in chain order', () => {
    const skips: SkippedStage[] = [
      { stage: 'HR', routedTo: 'CEO', because: 'lone officer' },
      { stage: 'MANAGER', routedTo: 'HR', because: 'no manager' },
    ];

    expect(stagesSkipped(ORDINARY, skips).map((skip) => skip.stage)).toEqual(['MANAGER', 'HR']);
  });
});

/* ----------------------------------------------------------------- the vocabulary */

describe('what a desk amounts to', () => {
  it('is one of three answers, and only the first can decide', () => {
    expect([...DESK_STANDINGS]).toEqual(['CAN_DECIDE', 'ONLY_THE_REQUESTER', 'NOBODY_STAFFS_IT']);

    for (const standing of DESK_STANDINGS) {
      const desks = desksAvailable(() => standing);

      expect(canDecide(desks, 'HR')).toBe(standing === 'CAN_DECIDE');
    }
  });

  /* Nobody at the desk, and only the requester at it, are different news. FR 48, FR 48b. */
  it('and tells an empty desk from one only the requester staffs', () => {
    expect(standingOf([], 'ama')).toBe('NOBODY_STAFFS_IT');
    expect(standingOf(['ama'], 'ama')).toBe('ONLY_THE_REQUESTER');
    expect(standingOf(['ama', 'efua'], 'ama')).toBe('CAN_DECIDE');
    expect(standingOf(['efua'], 'ama')).toBe('CAN_DECIDE');
  });

  /* Every desk answered, so one added to APPROVER_ROLES cannot be quietly left out. */
  it('and every desk gets an answer', () => {
    const desks = desksAvailable((desk) => (desk === 'HR' ? 'CAN_DECIDE' : 'NOBODY_STAFFS_IT'));

    expect(Object.keys(desks).sort()).toEqual([...APPROVER_ROLES].sort());
  });

  /**
   * And every desk has exactly one stand-in, which is not itself.
   *
   * The ladder is one deep on purpose: a stand-in for a stand-in is a chain of substitutions
   * nobody configured and nobody could read off a screen.
   */
  it('and every desk has one stand-in, which is a different desk', () => {
    for (const desk of APPROVER_ROLES) {
      const standIn = STAND_IN_FOR[desk];

      expect(APPROVER_ROLES).toContain(standIn);
      expect(standIn).not.toBe(desk);
    }
  });
});

/* ------------------------------------------------------------------- the alert */

describe('what would route it', () => {
  it('names a change to the organisation for each empty desk', () => {
    const nobody = withDesks({ HR: 'NOBODY_STAFFS_IT', CEO: 'NOBODY_STAFFS_IT' });

    const said = whatWouldRouteIt('HR', nobody);

    expect(said).toContain('granting somebody an HR role');
    /** FR 48c. A setting somebody writes, not a shape of the reporting lines. LMS 321. */
    expect(said).toContain('naming a current employee as the Chief Executive');
  });

  /* And where the desk is the requester's own, it says so rather than claiming it is empty. */
  it('and says a desk is the requester’s rather than pretending it is empty', () => {
    const theirs: DesksAvailable = {
      MANAGER: 'NOBODY_STAFFS_IT',
      HR: 'ONLY_THE_REQUESTER',
      CEO: 'ONLY_THE_REQUESTER',
    };

    expect(whatWouldRouteIt('HR', theirs)).toContain('other than the person who asked');
  });
});

/* -------------------------------------------------------------- a chain of three */

/**
 * And a chain longer than two routes the same way, because nothing here counts stages.
 *
 * FR 31 gives the chain to an HR Administrator, so the walk has to be right for a chain
 * nobody has configured yet.
 */
describe('a chain of three desks', () => {
  const LONG: readonly ApproverRole[] = ['MANAGER', 'HR', 'CEO'];

  it('walks all three when everybody can be asked', () => {
    expect(route(LONG, ANYBODY)).toMatchObject({ desk: 'MANAGER' });
    expect(route(LONG, ANYBODY, ['MANAGER'])).toMatchObject({ desk: 'HR' });
    expect(route(LONG, ANYBODY, ['MANAGER', 'HR'])).toMatchObject({ desk: 'CEO' });
    expect(route(LONG, ANYBODY, ['MANAGER', 'HR', 'CEO'])).toMatchObject({ kind: 'DECIDED' });
  });

  /* And a middle stage that empties mid-flight hands on rather than stopping the request. */
  it('and skips a middle stage that has emptied, without asking the Chief Executive twice', () => {
    const noHr = withDesks({ HR: 'NOBODY_STAFFS_IT' });

    const next = route(LONG, noHr, ['MANAGER']);

    expect(next).toMatchObject({ kind: 'DESK', desk: 'CEO' });
    expect(next.skips.map((skip) => skip.stage)).toEqual(['HR']);

    expect(route(LONG, noHr, ['MANAGER', 'CEO'], next.skips)).toMatchObject({ kind: 'DECIDED' });
  });
});

/* --------------------------------------------------- every shape, for the last criterion */

/**
 * The story's last criterion said over every combination there is. FR 48b.
 *
 * Twenty-seven states of the organisation against three chains, and the claim is one
 * sentence: the walk never reports a request decided by desks being empty. Written as an
 * exhaustive sweep rather than as examples because the failure it guards against is leave
 * somebody is told is agreed when nobody looked at it.
 */
describe('over every state the three desks can be in', () => {
  const chains = [ORDINARY, UNPAID, ['MANAGER', 'HR', 'CEO'] as const];

  function everyCombination(): DesksAvailable[] {
    const combinations: DesksAvailable[] = [];

    for (const manager of DESK_STANDINGS) {
      for (const hr of DESK_STANDINGS) {
        for (const ceo of DESK_STANDINGS) {
          combinations.push({ MANAGER: manager, HR: hr, CEO: ceo });
        }
      }
    }

    return combinations;
  }

  it('nothing is ever decided by running out of desks that could be filled', () => {
    for (const chain of chains) {
      for (const available of everyCombination()) {
        const routed = route(chain, available);

        /* Nothing has decided anything, so `DECIDED` would be leave agreed by nobody. */
        expect(routed.kind).not.toBe('DECIDED');

        if (routed.kind === 'DESK') {
          expect(canDecide(available, routed.desk)).toBe(true);
        }
      }
    }
  });

  /* And every skip goes to a desk that can actually be asked. */
  it('and every skip goes somewhere that can be asked', () => {
    for (const chain of chains) {
      for (const available of everyCombination()) {
        for (const skip of route(chain, available).skips) {
          expect(canDecide(available, skip.routedTo)).toBe(true);
          expect(skip.routedTo).toBe(STAND_IN_FOR[skip.stage]);
          expect(skip.because.length).toBeGreaterThan(0);
        }
      }
    }
  });

  /* And a request is only ever unroutable where the stage it reached truly has nobody. */
  it('and is unroutable only where the stage it reached has neither desk', () => {
    for (const chain of chains) {
      for (const available of everyCombination()) {
        const routed = route(chain, available);

        if (routed.kind !== 'UNROUTABLE') {
          continue;
        }

        const standIn = STAND_IN_FOR[routed.stranded] as ApproverRole;

        expect(canDecide(available, routed.stranded)).toBe(false);
        expect(canDecide(available, standIn)).toBe(false);
      }
    }
  });

  /* And where every desk is fillable, nothing is ever skipped. */
  it('and nothing is skipped when everybody can be asked', () => {
    for (const chain of chains) {
      expect(route(chain, ANYBODY).skips).toEqual([]);
    }
  });
});

/* ------------------------------------- the standing a desk has is not a role code */

/* `DeskStanding` is a fact about this request, not a grant. Pinned so the two do not drift
   into each other: LMS 319's rule is what makes `ONLY_THE_REQUESTER` different from
   `CAN_DECIDE`, and it is about who asked rather than about who holds what. */
it('is a fact about this request rather than about a role', () => {
  const standings: DeskStanding[] = [...DESK_STANDINGS];

  expect(standings).not.toContain('HR_OFFICER');
  expect(standings).not.toContain('HR_ADMIN');
});
