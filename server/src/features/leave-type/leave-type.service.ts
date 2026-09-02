/**
 * Creating, changing and retiring leave types. FR 21, FR 31, FR 32, §5.5., LMS 201, LMS 204, FR 48, FR 06.
 */

import type { Actor } from '../../auth/actor.js';
import { leaveTypePolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import { validateApprovalChain } from './approval-chain.js';
import type { Employee } from '../employee/employee.js';
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
} from './leave-type.js';
import type { LeaveTypeListOptions, LeaveTypeRepository } from './leave-type.db.js';

export class LeaveTypeService {
  constructor(
    private readonly types: LeaveTypeRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Creates one. */
  async create(actor: Actor, input: NewLeaveType): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.create(actor));

    return this.types.create(actor, validateNewLeaveType(input));
  }

  /** Changes one. NFR AUD 01. */
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

  /** Takes a type out of use. */
  async retire(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.retire(actor, id));

    return this.setActive(actor, id, false);
  }

  /** Says who approves leave of this kind, in order. FR 38a. */
  async setApprovalChain(actor: Actor, id: string, chain: readonly string[]): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.setApprovalChain(actor, id));

    await this.require(id);

    const updated = await this.types.setApprovalChain(actor, id, validateApprovalChain(chain));
    if (updated === undefined) {
      throw new LeaveTypeNotFound(id);
    }

    return updated;
  }

  /** Offers it again. */
  async reinstate(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.reinstate(actor, id));

    return this.setActive(actor, id, true);
  }

  async byId(actor: Actor, id: string): Promise<LeaveType> {
    this.guard.enforce(leaveTypePolicy.read(actor, id));

    return this.require(id);
  }

  /** By code. */
  async byCode(actor: Actor, code: string): Promise<LeaveType | undefined> {
    this.guard.enforce(leaveTypePolicy.read(actor));

    return this.types.findByCode(code);
  }

  async byName(actor: Actor, name: string): Promise<LeaveType | undefined> {
    this.guard.enforce(leaveTypePolicy.read(actor));

    return this.types.findByName(name);
  }

  /** Every type, by name. */
  async list(actor: Actor, options: LeaveTypeListOptions = {}): Promise<LeaveType[]> {
    this.guard.enforce(leaveTypePolicy.list(actor));

    return this.types.list(options);
  }

  /** The types this person could actually request, given the record they have. FR 05, FR 21. */
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

  /** The type, checked as somewhere new leave may be filed. FR 21. */
  async requestable(actor: Actor, id: string, employee: Employee): Promise<LeaveType> {
    const type = await this.byId(actor, id);

    assertStillOffered(type);
    assertSomebodyApprovesIt(type);
    assertEligible(type, employee.gender);

    return type;
  }

  /** The record, or LeaveTypeNotFound. */
  private async require(id: string): Promise<LeaveType> {
    const type = await this.types.findById(id);
    if (type === undefined) {
      throw new LeaveTypeNotFound(id);
    }
    return type;
  }

  /** Read, decide, write. */
  private async setActive(actor: Actor, id: string, isActive: boolean): Promise<LeaveType> {
    await this.require(id);

    const updated = await this.types.setActive(actor, id, isActive);
    if (updated === undefined) {
      throw new LeaveTypeNotFound(id);
    }

    return updated;
  }
}
