/**
 * Creating, editing and choosing working patterns. FR 23, LMS 106.
 *
 * A pattern is the week somebody works, and this exists so that leave is counted
 * against the days they actually work rather than against a Monday to Friday
 * assumption. Everything here serves that: a pattern is only useful if it names a
 * whole week, if one of them is the week most people work, and if an employee can
 * be put on a different one.
 *
 * A route will sit in front of this when Phase 1 has an authorisation layer to
 * put behind it (LMS 112); until then this is the whole of the story's surface,
 * and it is deliberately the same surface a route would call.
 *
 * What this service does not do:
 *
 *   No assigning. Which pattern a person works is a field of their record, so it
 *   is {@link EmployeeService.update} with a workPatternId, exactly as moving
 *   somebody between teams is. This service knows how many people are on a
 *   pattern, because deleting one turns on it, and moves none of them itself.
 *
 *   No counting. {@link worksOn} answers "is this weekday worked" and that is as
 *   far as this story goes. Turning a date range into a number of days needs the
 *   public holiday calendar and the counting basis of the leave type, and belongs
 *   to the leave calculator of Phase 2 — Technical Design Document section 7.3.
 *
 *   No deactivation. A pattern has no is_active and wants none: it is not part of
 *   anybody's history the way a department heading is, so the ending it has is
 *   {@link remove}, refused for the default and for one anybody is on. The
 *   working-pattern-rules migration sets out why that differs from a department.
 *
 *   No authorisation. "As an HR Officer" is enforced by the policy layer of
 *   LMS 112, from this layer, when it exists.
 */

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
  constructor(private readonly patterns: WorkPatternRepository) {}

  /**
   * Creates one, as a whole week.
   *
   * Throws {@link InvalidWorkPattern} for a name or a set of days that is wrong,
   * and {@link DuplicateWorkPatternName} when the name already belongs to a
   * pattern.
   *
   * A new pattern is never the default. Making one the default unmakes another,
   * which is a decision about the whole table rather than a property of the row
   * being created, and doing it silently on create would change which week every
   * future joiner is given. It is {@link makeDefault}, said deliberately.
   */
  async create(input: NewWorkPattern): Promise<WorkPattern> {
    return this.patterns.create(validateNewWorkPattern(input));
  }

  /**
   * Renames one, or replaces its week.
   *
   * The id every employee record points at does not move, which is the point of
   * editing rather than replacing: when a team's half day moves from Wednesday to
   * Friday, everybody on the pattern moves with it and nobody is reassigned.
   *
   * That is also the thing to think twice about. A pattern is a current fact
   * rather than a record of one, so changing the week changes what a day count
   * would produce for leave already taken against it. Until the ledger exists
   * there is nothing to be inconsistent with; when it does, an entry records the
   * days it cost at the time it was written, which is the other half of why the
   * ledger is the truth.
   */
  async update(id: string, changes: WorkPatternChanges): Promise<WorkPattern> {
    return this.change(id, () => validateWorkPatternChanges(changes));
  }

  /**
   * Makes this the pattern a new employee gets when nobody says otherwise.
   *
   * Exactly one pattern is the default at a time, so this unmakes whichever was.
   * Both halves are one transaction in the repository, because the database
   * refuses two defaults immediately and permits none only until COMMIT.
   *
   * Doing it twice is allowed and does nothing, like closing an already closed
   * department: the second attempt writes the boolean that is already there.
   */
  async makeDefault(id: string): Promise<WorkPattern> {
    await this.byId(id);

    const updated = await this.patterns.makeDefault(id);
    if (updated === undefined) {
      throw new WorkPatternNotFound(id);
    }

    return updated;
  }

  /**
   * Deletes one. The ending a pattern has.
   *
   * Refused for the default, because a database without one is a database where
   * no employee can be created, and refused while anybody is on it, with
   * {@link WorkPatternInUse} and the number of them. Leavers count: FR 37a
   * settles a leaver's final figure against the week they worked, so their
   * pattern is still load bearing after they have gone.
   *
   * That leaves exactly the pattern nobody works, which is the one worth being
   * able to remove — the one created by a typo on a Tuesday afternoon. The
   * foreign key and the deferred trigger hold the other two cases against every
   * connection, whatever this method does.
   */
  async remove(id: string): Promise<void> {
    const pattern = await this.byId(id);

    assertCanDelete(pattern, await this.patterns.headcount(id));

    if (!(await this.patterns.remove(id))) {
      throw new WorkPatternNotFound(id);
    }
  }

  async byId(id: string): Promise<WorkPattern> {
    const pattern = await this.patterns.findById(id);
    if (pattern === undefined) {
      throw new WorkPatternNotFound(id);
    }
    return pattern;
  }

  /** Undefined rather than a throw: asking whether a name is taken is a fair question. */
  async byName(name: string): Promise<WorkPattern | undefined> {
    return this.patterns.findByName(name);
  }

  /**
   * The pattern a joiner is given when nobody names one. FR 23.
   *
   * Throws rather than returning undefined, because there is no sensible
   * behaviour for a database that has none: the employee record cannot be
   * written without a pattern, and guessing one here would put somebody on a week
   * nobody chose. The working-pattern-rules migration inserts the standard
   * Monday to Friday week, so this is a real condition only where that migration
   * has been rolled back or the row deleted around the trigger that protects it.
   */
  async standard(): Promise<WorkPattern> {
    const pattern = await this.patterns.findDefault();
    if (pattern === undefined) {
      throw new DefaultWorkPatternRequired();
    }
    return pattern;
  }

  /** Every pattern, the default first. */
  async list(): Promise<WorkPattern[]> {
    return this.patterns.list();
  }

  /** How many employee records are on one, leavers included. */
  async headcount(id: string): Promise<number> {
    await this.byId(id);
    return this.patterns.headcount(id);
  }

  /**
   * Read, decide, write. The same shape as the other two services, and here for
   * the same reason: one place establishes that the record exists, and one place
   * reports it if it stops existing between the read and the write.
   */
  private async change(
    id: string,
    decide: (current: WorkPattern) => Partial<ValidatedWorkPattern>,
  ): Promise<WorkPattern> {
    const current = await this.byId(id);

    const updated = await this.patterns.update(id, decide(current));
    if (updated === undefined) {
      throw new WorkPatternNotFound(id);
    }

    return updated;
  }
}
