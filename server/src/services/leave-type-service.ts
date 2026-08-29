/**
 * Creating, changing and retiring leave types. FR 21, FR 31, FR 32, §5.5.
 * LMS 201.
 *
 * The story's "so that" is the whole specification of this file: adding or
 * changing a type never waits on a developer. So every rule that differs between
 * annual leave and maternity leave is a field somebody can set here — the
 * counting basis, whether there is a quota at all, the documentation rule and its
 * threshold, the expiry, whether it may be split, the two windows, and the gender
 * restriction — and there is nothing else to change. No release, no migration, no
 * branch on a type code anywhere in the tree.
 *
 * A route will sit in front of this when there is a route layer; until then this
 * is the whole of the story's surface, and it is deliberately the surface a route
 * would call.
 *
 * What this service does not do:
 *
 *   **No counting.** Whether a Saturday inside a request costs a day follows from
 *   {@link countsWorkingDays} and the working pattern, and turning a date range
 *   into a number is the leave calculator of Phase 2 — Technical Design Document
 *   section 7.3. This service says what the rule is; that one applies it.
 *
 *   **No entitlement figures.** How many days a quota grants is a number with an
 *   effective date, and belongs to the table that carries the dates. Storing
 *   fifteen here would mean raising the allowance next January silently rewrote
 *   what last year's requests were counted against.
 *
 *   **No approval routing.** Since LMS 204 a type says *who* approves it — an
 *   ordered list of desks, {@link setApprovalChain} — and that is as far as this
 *   file goes. Which person a desk resolves to, and what happens when the
 *   request reaches them, is FR 48 and the request workflow of Phase 3.
 *
 *   **No deleting.** A type is the heading every request, ledger entry and report
 *   of either is filed under, so removing the row would rewrite history in the
 *   way FR 06 refuses for an employee. {@link retire} is the ending it has, and
 *   lms_app holds no DELETE on the table, which is what makes that true for every
 *   writer rather than only for callers of this file.
 *
 *   **No authorisation rules.** Every method takes an {@link Actor} and asks
 *   ../auth/leave-type-policy.ts; the rules themselves are there. Reading is open
 *   to anybody signed in — the person who most needs to know a notice window is
 *   the one about to miss it — and writing is an HR Administrator's.
 */

import type { Actor } from '../auth/actor.js';
import { leaveTypePolicy } from '../auth/leave-type-policy.js';
import type { Guard } from '../auth/policy.js';
import { validateApprovalChain } from '../domain/approval-chain.js';
import type { Employee } from '../domain/employee.js';
import {
  assertEligible,
  assertSomebodyApprovesIt,
  assertStillOffered,
  type LeaveType,
  type LeaveTypeChanges,
  LeaveTypeNotFound,
  type NewLeaveType,
  validateLeaveTypeChanges,
  validateNewLeaveType,
} from '../domain/leave-type.js';
import type {
  LeaveTypeListOptions,
  LeaveTypeRepository,
} from '../repositories/leave-type-repository.js';

export class LeaveTypeService {
  constructor(
    private readonly types: LeaveTypeRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
  ) {}

  /**
   * Creates one.
   *
   * Throws {@link InvalidLeaveType} for a field that is wrong or a pair of fields
   * that disagree, {@link DuplicateLeaveTypeCode} and
   * {@link DuplicateLeaveTypeName} for an identifier already in use.
   *
   * A new type is offered from the moment it exists. That is the opposite of the
   * decision {@link WorkPatternService.create} makes about the default flag, and
   * the difference is that making a pattern the default *unmakes* another one,
   * while offering a type takes nothing away from any other. A type created and
   * not offered would be a row nobody could find and nobody would remember to
   * turn on.
   */
  async create(actor: Actor, input: NewLeaveType): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.create(actor));

    return this.types.create(actor, validateNewLeaveType(input));
  }

  /**
   * Changes one.
   *
   * The id every future request will point at does not move, which is the point
   * of editing rather than replacing: correcting the sick leave certificate
   * threshold from two days to three changes what the next request is asked for
   * and leaves every existing one filed where it was.
   *
   * That is also the thing to think twice about, and it is worth saying plainly
   * because this table is the one where it bites hardest. A type is a *current*
   * fact rather than a record of one, so changing a rule changes what a fresh
   * calculation would produce for leave already taken. Until the ledger exists
   * there is nothing to be inconsistent with; when it does, an entry records the
   * days it cost at the time it was written, which is the other half of why the
   * ledger is the truth and the balance is a cache.
   *
   * The audit log is the rest of the answer. Every change here is one row saying
   * which administrator moved which rule and when, which is what a disputed
   * balance is settled against. NFR AUD 01.
   */
  async update(actor: Actor, id: string, changes: LeaveTypeChanges): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.update(actor, id));

    const current = await this.require(id);

    const updated = await this.types.update(actor, id, validateLeaveTypeChanges(changes, current));
    if (updated === undefined) {
      // Gone between the read and the write. Nothing may delete a leave type —
      // lms_app holds no DELETE — but reporting it is cheaper than returning
      // undefined and making every caller wonder.
      throw new LeaveTypeNotFound(id);
    }

    return updated;
  }

  /**
   * Takes a type out of use. The ending this table has.
   *
   * Everything already raised against it still reads correctly and still heads
   * every report it ever headed; nothing new may be requested against it. That
   * is the same arrangement a closed department has, and for the same reason —
   * a heading that vanishes takes the meaning of last year's figures with it.
   *
   * Retiring one that is already retired is allowed and does nothing, like
   * closing an already closed department: the second attempt writes the boolean
   * that is already there.
   *
   * **There is no "in use" check here yet, and that is deliberate rather than
   * missed.** The rule this will want is "not while requests are in flight
   * against it", and it cannot be written before there is a request table to
   * count. Guessing at it now would mean either a check that counts nothing —
   * which reads as a rule and is not one — or a rule invented here that the
   * story bringing `leave_request` would have to unpick. It arrives with the
   * table it can count, the same way the working pattern's headcount rule
   * arrived with `employee`.
   */
  async retire(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.retire(actor, id));

    return this.setActive(actor, id, false);
  }

  /**
   * Says who approves leave of this kind, in order. FR 38a.
   *
   * The story: unpaid leave goes to HR and the Chief Executive while everything
   * else goes to the manager, and neither of those is a line of code. The chain is
   * `['HR', 'CEO']`, it is three rows away from being anything else, and no part
   * of the system reads a type code to work out where a request goes.
   *
   * Its own method rather than a field of {@link update}, for the reason
   * {@link retire} is its own method: it is a decision about every request that
   * will ever be raised against the type rather than a correction to what the type
   * is. The policy names it separately too, so the denial log and the audit log
   * both say which of the two happened — "changed the maternity type" and "changed
   * who approves maternity leave" are not the same sentence, and only one of them
   * would have somebody asking why their request never arrived.
   *
   * The chain replaces whatever was there. "HR as well" and "HR instead" are not
   * distinguishable in a list of approvers, which is the same reason a working
   * pattern's week is replaced rather than added to.
   *
   * Throws {@link InvalidApprovalChain} for a desk that is not one of the three,
   * for a chain with nobody in it, and for one that asks the same desk twice.
   *
   * **It does not re-route requests already in flight.** There are none to route
   * yet, and when there are, a request will carry the stage it has reached rather
   * than recomputing it from the type — the same arrangement that makes a ledger
   * entry the truth about what a day cost. Changing the chain decides where the
   * next request goes.
   */
  async setApprovalChain(actor: Actor, id: string, chain: readonly string[]): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.setApprovalChain(actor, id));

    await this.require(id);

    const updated = await this.types.setApprovalChain(actor, id, validateApprovalChain(chain));
    if (updated === undefined) {
      throw new LeaveTypeNotFound(id);
    }

    return updated;
  }

  /** Offers it again. The correction for a type retired by mistake. */
  async reinstate(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.reinstate(actor, id));

    return this.setActive(actor, id, true);
  }

  async byId(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.read(actor, id));

    return this.require(id);
  }

  /**
   * By code. Undefined rather than a throw, because asking whether a code is
   * taken is a fair question and every signed in caller may ask it.
   *
   * This is the join a report and a staff import make. It is not a way to ask
   * "is this the maternity type" in order to do something different: the rules
   * are the fields of the record this hands back, and reading one of them is the
   * whole of what a caller is entitled to do with it.
   */
  async byCode(actor: Actor, code: string): Promise<LeaveType | undefined> {
    this.guard.enforce(leaveTypePolicy.read(actor));

    return this.types.findByCode(code);
  }

  async byName(actor: Actor, name: string): Promise<LeaveType | undefined> {
    this.guard.enforce(leaveTypePolicy.read(actor));

    return this.types.findByName(name);
  }

  /** Every type, by name. Pass `offeredOnly` for the ones a form should show. */
  async list(actor: Actor, options: LeaveTypeListOptions = {}): Promise<LeaveType[]> {
    this.guard.enforce(leaveTypePolicy.list(actor));

    return this.types.list(options);
  }

  /**
   * The types this person could actually request, given the record they have.
   *
   * FR 05 and FR 21. Two filters, and they are different kinds of fact: a
   * retired type is closed to everybody, and a restricted type is closed to
   * this person. Both produce the same answer here — it is not on the list — so
   * that a form offers only what will be accepted rather than offering
   * everything and refusing on submission.
   *
   * **Somebody whose record has no gender on it is offered the unrestricted
   * types and not the restricted ones.** That is the cautious reading and it is
   * chosen on purpose: the alternative is offering maternity leave to everybody
   * whose record is incomplete and refusing it at the point of asking, which
   * teaches people that the form lies. Being *refused* one directly still says
   * why, and says that the record is incomplete rather than that they are
   * ineligible — see {@link NotEligibleForLeaveType}. A list cannot say that,
   * which is exactly why the direct refusal is worded the way it is.
   *
   * The employee record is passed in rather than read here, so that this service
   * never becomes a second place that decides who may read one. The caller has
   * already been through ../auth/employee-policy.ts to hold it.
   */
  async offeredTo(actor: Actor, employee: Employee): Promise<LeaveType[]> {
    const offered = await this.list(actor, { offeredOnly: true });

    return offered.filter((type) => {
      try {
        assertEligible(type, employee.gender);
        return true;
      } catch {
        return false;
      }
    });
  }

  /**
   * The type, checked as somewhere new leave may be filed. FR 21.
   *
   * What the request workflow of Phase 3 will call in place of {@link byId}: it
   * establishes that the type exists, that it is still offered, that somebody is
   * set up to approve it, and that this person is eligible for it, in that order
   * and with a different refusal for each. The rules themselves are pure functions
   * in ../domain/leave-type.ts; what is here is that all four are asked, once, in
   * one place, so that no future caller can ask three of them.
   *
   * The approval check is third rather than last, and the order is the order the
   * answers are useful in. "Nobody approves this yet" is a fact about the type and
   * is somebody's job to fix; "you are not eligible" is a fact about the person
   * asking. Telling somebody they are ineligible for a type that was never
   * finished being configured would send them away with the wrong problem.
   */
  async requestable(actor: Actor, id: string, employee: Employee): Promise<LeaveType> {
    const type = await this.byId(actor, id);

    assertStillOffered(type);
    assertSomebodyApprovesIt(type);
    assertEligible(type, employee.gender);

    return type;
  }

  /**
   * The record, or {@link LeaveTypeNotFound}.
   *
   * No policy question, as with a department or a working pattern and unlike an
   * employee record: every signed in caller may read every type, so a missing one
   * discloses nothing a present one would not.
   */
  private async require(id: string): Promise<LeaveType> {
    const type = await this.types.findById(id);
    if (type === undefined) {
      throw new LeaveTypeNotFound(id);
    }
    return type;
  }

  /**
   * Read, decide, write. The same shape as the other services, and here for the
   * same reason: one place establishes that the record exists, and one place
   * reports it if it stops existing between the read and the write.
   */
  private async setActive(actor: Actor, id: string, isActive: boolean): Promise<LeaveType> {
    await this.require(id);

    const updated = await this.types.setActive(actor, id, isActive);
    if (updated === undefined) {
      throw new LeaveTypeNotFound(id);
    }

    return updated;
  }
}
