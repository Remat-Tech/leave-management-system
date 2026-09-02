/** Creating, editing and choosing working patterns. FR 23, LMS 106, LMS 112. */

import type { Actor } from '../auth/actor.js';
import type { Guard } from '../auth/policy.js';
import { workPatternPolicy } from '../auth/work-pattern-policy.js';
import {
  assertCanDelete,
  DefaultWorkPatternRequired,
  type NewWorkPattern,
  type ValidatedWorkPattern,
  type WorkPattern,
  type WorkPatternChanges,
  WorkPatternNotFound,
  validateNewWorkPattern,
  validateWorkPatternChanges,
} from '../domain/work-pattern.js';
import type { WorkPatternRepository } from '../repositories/work-pattern-repository.js';

export class WorkPatternService {
  constructor(
    private readonly patterns: WorkPatternRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Creates one, as a whole week. */
  async create(actor: Actor, input: NewWorkPattern): Promise<WorkPattern> {
    this.guard.enforce(workPatternPolicy.create(actor));

    return this.patterns.create(actor, validateNewWorkPattern(input));
  }

  /** Renames one, or replaces its week. */
  async update(actor: Actor, id: string, changes: WorkPatternChanges): Promise<WorkPattern> {
    this.guard.enforce(workPatternPolicy.update(actor, id));

    return this.change(actor, id, () => validateWorkPatternChanges(changes));
  }

  /** Makes this the pattern a new employee gets when nobody says otherwise. */
  async makeDefault(actor: Actor, id: string): Promise<WorkPattern> {
    this.guard.enforce(workPatternPolicy.makeDefault(actor, id));

    await this.require(id);

    const updated = await this.patterns.makeDefault(actor, id);
    if (updated === undefined) {
      throw new WorkPatternNotFound(id);
    }

    return updated;
  }

  /** Deletes one. FR 37a. */
  async remove(actor: Actor, id: string): Promise<void> {
    this.guard.enforce(workPatternPolicy.remove(actor, id));

    const pattern = await this.require(id);

    assertCanDelete(pattern, await this.patterns.headcount(id));

    if (!(await this.patterns.remove(actor, id))) {
      throw new WorkPatternNotFound(id);
    }
  }

  async byId(actor: Actor, id: string): Promise<WorkPattern> {
    this.guard.enforce(workPatternPolicy.read(actor, id));

    return this.require(id);
  }

  /** Undefined rather than a throw: asking whether a name is taken is a fair question. */
  async byName(actor: Actor, name: string): Promise<WorkPattern | undefined> {
    this.guard.enforce(workPatternPolicy.read(actor));

    return this.patterns.findByName(name);
  }

  /** The pattern a joiner is given when nobody names one. FR 23. */
  async standard(actor: Actor): Promise<WorkPattern> {
    this.guard.enforce(workPatternPolicy.read(actor));

    const pattern = await this.patterns.findDefault();
    if (pattern === undefined) {
      throw new DefaultWorkPatternRequired();
    }
    return pattern;
  }

  /** Every pattern, the default first. */
  async list(actor: Actor): Promise<WorkPattern[]> {
    this.guard.enforce(workPatternPolicy.list(actor));

    return this.patterns.list();
  }

  /** How many employee records are on one, leavers included. */
  async headcount(actor: Actor, id: string): Promise<number> {
    this.guard.enforce(workPatternPolicy.headcount(actor, id));

    await this.require(id);
    return this.patterns.headcount(id);
  }

  /** The record, or WorkPatternNotFound. */
  private async require(id: string): Promise<WorkPattern> {
    const pattern = await this.patterns.findById(id);
    if (pattern === undefined) {
      throw new WorkPatternNotFound(id);
    }
    return pattern;
  }

  /** Read, decide, write. */
  private async change(
    actor: Actor,
    id: string,
    decide: (current: WorkPattern) => Partial<ValidatedWorkPattern>,
  ): Promise<WorkPattern> {
    const current = await this.require(id);

    const updated = await this.patterns.update(actor, id, decide(current));
    if (updated === undefined) {
      throw new WorkPatternNotFound(id);
    }

    return updated;
  }
}
