/**
 * Who approves a kind of leave, and in what order. FR 38a, §5.5. LMS 204.
 *
 * The second of the two things design principle 5 of the Technical Design
 * Document says vary by leave type: "Two things vary by leave type, and both used
 * to be global... If either is written as an `if` on a type code, every future
 * leave type becomes a code change." The counting basis was the first and is
 * ./leave-type.ts. This is the other, and the README states it in the plainest
 * terms the document has: "Most types go manager then HR; unpaid leave goes HR
 * then CEO. Both are configuration. If either appears as an `if` on a type code,
 * that is a bug."
 *
 * So there is no maternity chain and no unpaid chain in this file. There is a
 * chain, it is a list of approver roles in order, it arrives from the database,
 * and everything here is a function of that list.
 *
 * ## The three approver roles are not the four role codes
 *
 * {@link APPROVER_ROLES} is MANAGER, HR and CEO. {@link RoleCode} in
 * ../auth/roles.ts is EMPLOYEE, HR_OFFICER, HR_ADMIN and SYS_ADMIN. The two sets
 * are disjoint, on purpose, and the fact that both could be called "roles" is the
 * trap this note exists to spring first.
 *
 * A chain names **a desk**. How the person at that desk is found is three
 * different questions with three different answers:
 *
 *   **MANAGER is a relationship.** You are one if some employee has your id as
 *   their manager_id, and ../auth/roles.ts refuses to make it a grant: "Holding
 *   it as a role too would create two sources of truth that drift the moment
 *   somebody changes team." {@link Authority} keeps `isManager` apart from
 *   `roles` for the same reason.
 *
 *   **HR is a granted role**, and in fact two of them — HR_OFFICER and HR_ADMIN
 *   both staff that desk. The chain says HR because that is what the policy says;
 *   which of the two codes the person on duty holds is not something an HR
 *   Administrator should have to encode to configure a leave type.
 *
 *   **CEO is a position.** FR 04: exactly one employee has no line manager, and
 *   `employee_one_root` is what makes that "exactly one" rather than "as many as
 *   anybody types". Nobody grants it.
 *
 * Nothing here resolves any of them to a person. That is FR 48, needs the request
 * and the reporting line in hand, and belongs to Phase 3; see the note at the
 * foot of this file.
 *
 * ## The walk asks which desk has not signed, rather than which comes next
 *
 * LMS 316, and it is the one thing in this file that has changed since it was
 * written. `approverAfter(chain, theDeskItWasAt)` was the walk from LMS 314 and
 * it is gone: it answers correctly only while the chain stands still, and FR 31
 * says it need not. {@link nextUnapproved} and {@link everyStageApproved} are
 * what replaced it, and the argument is in full on the first of them.
 *
 * `isFinalApprover` went with it, for the same reason and one worth stating on
 * its own: being last in the list is not the same as being the last to sign once
 * a stage can be added in front of a request in flight. Whether an approval was
 * the last word is `isTheLastWord()` in ./leave-request.ts, which reads the
 * outcome of the walk rather than the shape of the list.
 *
 * ## The default is data, and is here too
 *
 * {@link DEFAULT_APPROVAL_CHAIN} is manager then HR — the story's second
 * criterion — and it is stated twice on purpose: here, for the type somebody
 * creates without saying, and in the leave-type-approval-chain migration, for the
 * type an operator restores without saying. That is the same arrangement
 * {@link READS_EVERY_RECORD} has with `MANDATORY_ROLES` in ../auth/mfa.ts, and
 * it is held together the same way — the integration suite asserts that what the
 * database writes and what this file defaults to are the same two roles.
 *
 * What it is emphatically not is a fallback read. An empty chain does not quietly
 * become manager then HR when somebody asks who approves; a type whose chain is
 * missing is a type nobody approves, and it says so. The difference matters
 * because a fallback would make the configuration screen show nothing for annual
 * leave while the system routed it somewhere, which is the state in which nobody
 * can answer "who has to sign this off" without reading the source.
 */

/**
 * The desks a stage of a chain can name. FR 38a.
 *
 * Ordered as a chain usually runs — the nearest approver first, the furthest
 * last — which is the order they read in a sentence and the order a screen offers
 * them. It is not a precedence: a chain is whatever order HR puts it in, and
 * nothing here sorts one.
 *
 * A closed set, held again as a CHECK on `leave_type_approval_step`. Adding a
 * fourth is a migration *and* a change to whatever resolves a desk to a person,
 * so it is deliberately not a row somebody can add — a desk nothing knows how to
 * find is a queue no request ever leaves.
 */
export const APPROVER_ROLES = ['MANAGER', 'HR', 'CEO'] as const;

export type ApproverRole = (typeof APPROVER_ROLES)[number];

/**
 * Manager then HR. The story's second criterion, and what a type gets when
 * nobody says otherwise.
 *
 * Two stages rather than one because that is the policy, and the shape of it is
 * worth reading off: the manager knows whether the team can spare them and HR
 * knows whether the days are there. Neither question answers the other, which is
 * why almost every type asks both.
 */
export const DEFAULT_APPROVAL_CHAIN: readonly ApproverRole[] = ['MANAGER', 'HR'];

/**
 * The longest a chain can be, which follows from there being three desks rather
 * than from anybody's view about how many approvals are sensible.
 *
 * `leave_type_approval_step_role_once` is what actually holds it: one position
 * per desk, so a fourth stage would have to ask somebody who has already
 * answered.
 */
export const LONGEST_CHAIN = APPROVER_ROLES.length;

/** One stage of a chain, as it is stored: a position and the desk at it. */
export interface ApprovalStep {
  /** 1 is the first approver. Contiguous from there; a chain with a gap stops at it. */
  stepOrder: number;
  approverRole: ApproverRole;
}

/**
 * A chain that was refused, and the field that caused it.
 *
 * Its own error rather than an {@link InvalidLeaveType}, because a chain is its
 * own thing: it is set by its own service method, guarded by its own policy
 * decision, and shown on its own part of the form. The field is carried
 * separately for the reason every refusal in this layer carries one — NFR USA 03
 * wants the message next to the input it is about.
 */
export class InvalidApprovalChain extends Error {
  readonly field: string;

  constructor(message: string, field = 'approvalChain') {
    super(message);
    this.name = 'InvalidApprovalChain';
    this.field = field;
  }
}

/**
 * Reads a chain, or refuses it.
 *
 * Tolerant about case and spacing, because this arrives from a form and `hr` is
 * not a different desk from `HR`. Strict about everything else, and each refusal
 * says what to do instead:
 *
 *   **An unknown desk is refused rather than dropped.** A chain quietly shortened
 *   by one is a chain missing an approval nobody will notice is missing.
 *   'MANAGER' spelled 'LINE_MANAGER', and the four role codes — 'HR_ADMIN' is the
 *   one somebody will actually type — all land here.
 *
 *   **An empty chain is refused.** A type nobody approves is a type whose
 *   requests are either approved by nobody or by everybody, and neither is a
 *   decision anybody made. Retiring the type is what "nobody may ask for this" is
 *   called.
 *
 *   **A repeated desk is refused.** Asking the same approver twice is either a
 *   mistake or a request waiting for somebody to approve what they have already
 *   approved, and §8 has no state for the second.
 *
 * Order is otherwise none of this function's business. HR then the manager is an
 * unusual chain and a legitimate one, and a rule about which desk may come first
 * would be a policy invented here rather than one the SRS asks for.
 */
export function validateApprovalChain(value: unknown): ApproverRole[] {
  if (!Array.isArray(value)) {
    throw new InvalidApprovalChain(
      'An approval chain is the list of approvers a request goes to, in order — ' +
        `${APPROVER_ROLES.join(', ')}.`,
    );
  }

  const chain = value.map((role) => readApproverRole(role));

  if (chain.length === 0) {
    throw new InvalidApprovalChain(
      'A leave type needs at least one approver. A type nobody approves is one ' +
        'whose requests sit in no queue at all; if it should not be asked for at ' +
        'all, retire it instead.',
    );
  }

  const seen = new Set<ApproverRole>();
  for (const role of chain) {
    if (seen.has(role)) {
      throw new InvalidApprovalChain(
        `${inWords(role)} is in this chain twice. An approver is asked once; a ` +
          'second stage naming the same desk waits for somebody to approve what ' +
          'they have already approved.',
      );
    }
    seen.add(role);
  }

  return chain;
}

/** Reads one desk, or refuses it. Case and spacing are forgiven; nothing else is. */
export function readApproverRole(value: unknown): ApproverRole {
  if (typeof value !== 'string') {
    throw new InvalidApprovalChain(
      `${String(value)} is not an approver. Approvers are ${APPROVER_ROLES.join(', ')}.`,
    );
  }

  const role = value.trim().toUpperCase();

  if (!(APPROVER_ROLES as readonly string[]).includes(role)) {
    throw new InvalidApprovalChain(
      `${value.trim()} is not an approver. Approvers are ${APPROVER_ROLES.join(', ')} — ` +
        'the desk a request goes to, rather than the role somebody holds, so HR ' +
        'covers an HR Officer and an HR Administrator alike.',
    );
  }

  return role as ApproverRole;
}

/**
 * A chain as the rows it is stored as, numbered from one.
 *
 * The numbering is produced here rather than supplied by a caller, which is what
 * makes a gap impossible from this side: a chain is a list, and its positions are
 * where its members are. `leave_type_approval_chain_is_whole` is the same rule for
 * every other writer.
 */
export function stepsOf(chain: readonly ApproverRole[]): ApprovalStep[] {
  return chain.map((approverRole, index) => ({ stepOrder: index + 1, approverRole }));
}

/**
 * A chain read back out of its rows, in order.
 *
 * Sorted here rather than trusted to arrive sorted, so that the one query that
 * forgot an ORDER BY cannot silently reverse who signs off first.
 */
export function chainOf(steps: readonly ApprovalStep[]): ApproverRole[] {
  return [...steps]
    .sort((left, right) => left.stepOrder - right.stepOrder)
    .map((step) => step.approverRole);
}

/** Whether anybody at all is set up to approve this. */
export function isApprovable(chain: readonly ApproverRole[]): boolean {
  return chain.length > 0;
}

/**
 * The desk a request goes to first, or undefined where nobody approves this.
 *
 * Undefined rather than a throw, because "is there anybody" is a fair question
 * with an answer; the refusal belongs where somebody is actually trying to raise
 * a request, which is {@link assertSomebodyApprovesIt} in ./leave-type.ts.
 *
 * It is the front of the list, which is a question about the *chain*, where
 * {@link nextUnapproved} is a question about a chain and what has happened to a
 * request. They give the same answer for a request nobody has decided yet —
 * which every new one is — and the unit suite asserts as much, so the two cannot
 * come apart while a submission goes through this one.
 */
export function firstApprover(chain: readonly ApproverRole[]): ApproverRole | undefined {
  return chain[0];
}

/**
 * The first desk in this chain that has not approved yet, or undefined when
 * every one of them has. FR 41, FR 42. LMS 316.
 *
 * The whole of the walk, and it is here rather than in the request workflow of
 * Phase 3 for the reason {@link worksOn} is here rather than in the leave
 * calculator: it needs nothing but the chain and the desks that have signed, so
 * it can be read and tested without a request, a person or a database. What the
 * workflow adds is who the desk resolves to and what happens when nobody is
 * there.
 *
 * ## It replaced `approverAfter`, and the difference is the story
 *
 * LMS 314 walked the chain with `approverAfter(chain, theDeskItWasAt)` — "the
 * one after the one that just signed" — and kept a cursor on the request saying
 * where it had got to. That is right whenever the chain stands still, and the
 * chain does not have to: FR 31 gives it to an HR Administrator, who may edit it
 * while a request is in the queue.
 *
 * The case it gets wrong is a stage added **in front of** where a request is
 * standing. Annual leave goes manager then HR, a request is with HR because the
 * manager has signed, and the administrator changes the chain to CEO, manager,
 * HR. The cursor says HR; the desk after HR is nothing; so HR's yes approves the
 * leave and the Chief Executive — a stage the policy now names — never sees it.
 * The employee is told their leave is agreed, which is the sentence LMS 316
 * exists to make true.
 *
 * Asking instead which desk has *not* signed cannot make that mistake, because
 * it is a question about the whole chain rather than about one position in it.
 * The cursor stays — it is what an approver's queue reads, FR 40, and what the
 * policy resolves to a person — but it is a record of where the request was sent
 * rather than the thing that decides where it goes next.
 *
 * ## Order, and what it is and is not doing
 *
 * The first unapproved desk **in chain order**, so a request still travels the
 * chain the way an HR Administrator wrote it. What the order does not do is
 * decide when the request is agreed: that is "none left", which is a question
 * about a set. A chain reordered under a live request routes by the new order
 * and still collects every signature.
 *
 * A desk that has approved is never returned, which is what stops anybody being
 * asked twice — {@link approverAfter} could not promise that once the order
 * could change, and `leave_request_decision_once_per_desk` now holds it in the
 * schema.
 *
 * Approvals from desks the chain does not name are ignored rather than refused
 * here. They are refused where somebody is actually trying to approve — see
 * `ApprovalChainChanged` — and this function is a question about the chain's own
 * stages, so a signature from outside it is simply not one of them.
 */
export function nextUnapproved(
  chain: readonly ApproverRole[],
  approved: readonly ApproverRole[],
): ApproverRole | undefined {
  return stagesNotApproved(chain, approved)[0];
}

/**
 * Every stage of this chain that has not approved, in chain order. FR 41. LMS
 * 316's first criterion, as a list rather than as a verdict.
 *
 * The walk itself, and {@link nextUnapproved} is its first element — one pass
 * over the list with two readings, rather than two passes that can disagree.
 * "Every stage has approved" is this coming back empty, and it is written that
 * way at each of the two places that ask rather than given a predicate of its
 * own: both of them want the list as well, to route to or to say aloud.
 *
 * **An empty chain gives an empty list**, so a type nobody approves reads as
 * fully approved. That is not a hole for this function to plug: a request for
 * such a type is refused at submission by `assertSomebodyApprovesIt`, with the
 * type named, which is where a person can act on it. The question "is there a
 * chain at all" is {@link isApprovable} and is asked there.
 */
export function stagesNotApproved(
  chain: readonly ApproverRole[],
  approved: readonly ApproverRole[],
): ApproverRole[] {
  return chain.filter((desk) => !approved.includes(desk));
}

/** Whether that desk is asked at all. */
export function isApprovedBy(chain: readonly ApproverRole[], role: ApproverRole): boolean {
  return chain.includes(role);
}

/**
 * The chain as a person reads it: "your manager, then HR".
 *
 * On the request form beside the type, and in the refusal a retired or
 * unapprovable type produces. It is here rather than in an interface layer
 * because the same sentence is wanted in an email, in an error and on a screen,
 * and three copies of it would drift the first time somebody decided the Chief
 * Executive should be called that rather than the CEO.
 */
export function chainInWords(chain: readonly ApproverRole[]): string {
  if (chain.length === 0) {
    return 'nobody';
  }

  const named = chain.map(inWords);

  return named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(', ')} then ${named[named.length - 1]}`;
}

/** One desk, as a person says it rather than as the column holds it. */
function inWords(role: ApproverRole): string {
  switch (role) {
    case 'MANAGER':
      return 'your line manager';
    case 'HR':
      return 'HR';
    default:
      return 'the Chief Executive';
  }
}
