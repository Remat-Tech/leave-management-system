/**
 * Who may read the account of what happened. NFR AUD 01, NFR SEC 02. §10.
 * LMS 113.
 *
 * The audit log holds a snapshot of every record either side of every change, so
 * reading it is reading the records — every version of them. A policy that let
 * anybody browse it would undo LMS 112 entirely: a colleague refused an employee
 * record could ask the history of that record instead and be handed several
 * copies of it.
 *
 * So the rule is the same rule, one step removed: **the history of a record goes
 * to whoever may read the record.** Not a looser rule and not a tighter one.
 *
 * ## Your own history is yours
 *
 * This is the part the story actually asks for. "So that if a balance is ever
 * disputed there is an account of how it got there" is written from the point of
 * view of the person disputing it, and an account they cannot see is not an
 * account, it is a reassurance. Somebody may read the history of their own
 * record for the same reason they may read the record.
 *
 * Their line manager may too, on the same footing as reading the record — the
 * fields are the same fields, in older versions.
 *
 * ## Access history is narrower than record history
 *
 * The login and the roles are a different question with a different answer. When
 * somebody's password was reset and by whom, and when they were given HR powers,
 * is what somebody investigating an incident reads; it is not what a line manager
 * needs to approve leave. So it is yours, or an administrator's — the same
 * standing ../auth/role-policy.ts and ../auth/sign-in-policy.ts give to reading
 * the current state of both.
 *
 * ## Browsing the whole log is HR's
 *
 * Reading the log without naming a record — the last hundred changes, everything
 * one person did — is the most powerful read in the system, because it is
 * every record at once. It goes to the people who may read every record anyway,
 * which is {@link READS_EVERY_RECORD}, and no lower.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { ADMINISTERS_ACCESS, READS_EVERY_RECORD } from './roles.js';
import type { Employee } from '../domain/employee.js';

const about = policyFor('audit log');

export const auditPolicy = {
  resource: about.resource,

  /**
   * The history of one employee record.
   *
   * The same three standings ../auth/employee-policy.ts grants for reading the
   * record itself, and written out here rather than delegating to it. Two
   * reasons: the decision has to name this resource and this action, or the
   * denial log says somebody was refused an employee record when they were
   * refused its history; and the day these two rules diverge, they should
   * diverge by an edit rather than by a delegation quietly meaning something
   * else.
   */
  forEmployee(actor: Actor, employee: Employee): Decision {
    if (isSelf(actor, employee.id)) {
      return about.allow(actor, 'readEmployeeHistory', employee.id);
    }
    if (isSelf(actor, employee.managerId)) {
      return about.allow(actor, 'readEmployeeHistory', employee.id);
    }
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'readEmployeeHistory', employee.id);
    }

    return about.refuse(
      actor,
      'readEmployeeHistory',
      employee.id,
      'not their record, not their line manager, and holds no role that reads everybody',
    );
  },

  /**
   * The history of somebody's login and roles.
   *
   * Yours, or an administrator's. A line manager is deliberately not here: they
   * may read a report's record and its history, and whether that report has ever
   * held HR_ADMIN is none of their business — which is the same line
   * ../auth/role-policy.ts draws about the present.
   */
  forAccess(actor: Actor, employeeId: string): Decision {
    if (isSelf(actor, employeeId)) {
      return about.allow(actor, 'readAccessHistory', employeeId);
    }

    return holdsAny(actor, ...ADMINISTERS_ACCESS)
      ? about.allow(actor, 'readAccessHistory', employeeId)
      : about.refuse(
          actor,
          'readAccessHistory',
          employeeId,
          'not their own access, and holds no role that administers access',
        );
  },

  /**
   * The history of a department or a working pattern.
   *
   * Reading a team or a week is open to anybody signed in; reading who changed
   * one and when is not. That is not an inconsistency — the current name of a
   * team is on every screen, and "Yaw renamed Operations on 3 March" is an
   * administrative fact about a colleague. It goes to HR.
   *
   * Refused openly, because anybody who reaches it can already see the record it
   * is about, so naming the rule discloses nothing.
   */
  forOrganisation(actor: Actor, entity: string, entityId: string): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, `read${entity}History`, entityId)
      : about.refuseOpenly(
          actor,
          `read${entity}History`,
          entityId,
          'holds no role that reads everybody',
          'Who changed this and when is something HR can tell you.',
        );
  },

  /**
   * Reading the log without naming a record.
   *
   * The whole log is every record at once, so this is the read that has to match
   * the broadest read anybody has of the records themselves. It is also what the
   * services consult before saying that a record is not there — the same rule
   * ../auth/employee-policy.ts explains at {@link employeePolicy.search}, for the
   * same reason: "no such employee" and "not yours to see" must be one answer to
   * anybody who could not have seen it either way.
   */
  browse(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'browse')
      : about.refuse(actor, 'browse', null, 'holds no role that reads everybody');
  },
};
