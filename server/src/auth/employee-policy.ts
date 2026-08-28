/**
 * Who may see and change an employee record. NFR SEC 02. §10. LMS 112.
 *
 * The story's own resource. "A colleague cannot reach them by guessing a web
 * address" is about this file, and everything in it is the answer to one
 * question: what standing does this actor have towards this record?
 *
 * Three kinds of standing, and they are three different sorts of fact.
 *
 *   **It is your own record.** Not a role, not a grant — an identity. It is what
 *   lets everybody in the company use the system without anybody granting them
 *   anything, and it is the reason {@link Actor.employeeId} exists at all.
 *
 *   **You are their line manager.** Not a role either, and this is where LMS 111
 *   is cashed in: `employee.managerId` is read off the record in hand, so the
 *   answer moves the instant a reporting line moves and there is nothing to keep
 *   in step. The policy asks "is this person one of my reports?", never "do they
 *   have the manager role?", which is exactly what the README promised and what
 *   {@link Authority} was shaped to make possible.
 *
 *   **You hold a role.** HR and administrators, from ./roles.ts.
 *
 * ## Direct reports, and not the whole subtree
 *
 * A manager sees the people who report to them. Not their reports' reports.
 *
 * That is a decision rather than a simplification, and there are two reasons.
 * The honest one is that a skip level read is a different power that nobody has
 * asked for: FR 03's approval chain routes a request to the line above, one
 * step, and a department head who needs the whole team's leave is asking a
 * reporting question that Phase 4's team calendar answers with figures rather
 * than with everybody's records. The mechanical one is that this file is a pure
 * function of the record in hand, and a subtree is a recursive query — putting
 * one behind an authorisation check would mean a walk up the organisation on
 * every read of every record, which is the sort of cost that gets noticed once
 * and cached wrongly forever.
 *
 * ## Nobody edits their own record
 *
 * Reading yours is the point of the system. Writing yours is what HR is for. A
 * start date, a department, a working pattern and an exit date are all figures
 * somebody's entitlement is calculated from, and a system where the person the
 * figure is about can change it is not a system anybody can settle a dispute
 * with. Being your own record buys a read and nothing else, and the absence of
 * any self case in {@link employeePolicy.update} is that rule.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';
import type { Employee } from '../domain/employee.js';

const about = policyFor('employee');

/**
 * Whether this actor has any business seeing this record at all.
 *
 * The gate that decides which of the two kinds of refusal a write gets — see the
 * note at the top of ./policy.ts. Somebody who can already read the record is
 * told which rule refused their edit; somebody who cannot is told nothing, so
 * that a refusal never confirms that a guessed id is somebody.
 */
function canSee(actor: Actor, employee: Employee): boolean {
  return (
    isSelf(actor, employee.id) ||
    isSelf(actor, employee.managerId) ||
    holdsAny(actor, ...READS_EVERY_RECORD)
  );
}

export const employeePolicy = {
  resource: about.resource,

  /**
   * Reading one record, which the service already has in hand.
   *
   * The order of the three cases is the order they are most often true in and
   * has no other significance: they are alternatives, and any one of them is
   * enough.
   */
  read(actor: Actor, employee: Employee): Decision {
    if (isSelf(actor, employee.id)) {
      return about.allow(actor, 'read', employee.id);
    }
    if (isSelf(actor, employee.managerId)) {
      return about.allow(actor, 'read', employee.id);
    }
    if (holdsAny(actor, ...READS_EVERY_RECORD)) {
      return about.allow(actor, 'read', employee.id);
    }

    return about.refuse(
      actor,
      'read',
      employee.id,
      'not their record, not their line manager, and holds no role that reads everybody',
    );
  },

  /**
   * Asking about a record the actor does not have in hand: by employee number,
   * by work address, or by an id that turned out to be nobody.
   *
   * HR and administrators only, and the reason is the story's. A lookup by
   * number or address is a directory search, and a directory search that
   * anybody may run is a staff list — the same disclosure the sign in box is
   * deliberately vague to avoid, reached from inside instead.
   *
   * This is also what the services consult **before** reporting a record
   * missing. Both halves are needed for the guarantee to hold: refusing a read
   * of somebody else's record is worth nothing if `EmployeeNotFound` for a
   * guessed id and `NotAuthorised` for a real one are different answers, because
   * the pair of them is a working existence oracle. Anybody who may search is
   * told plainly that there is no such record; anybody who may not gets the one
   * sentence that covers both cases.
   */
  search(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'search')
      : about.refuse(actor, 'search', null, 'holds no role that reads everybody');
  },

  /** Everybody, or everybody still employed. The staff list itself. */
  list(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'list')
      : about.refuse(actor, 'list', null, 'holds no role that reads everybody');
  },

  /**
   * The standing check on the reporting lines. FR 02 and FR 04.
   *
   * It names records — whose manager has left, who has none — so it is a read of
   * the organisation and goes to the people who may read the organisation. A
   * dashboard or a nightly job asking this runs as {@link theSystem}.
   */
  warnings(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'warnings')
      : about.refuse(actor, 'warnings', null, 'holds no role that reads everybody');
  },

  /** Creating a record. There is nothing yet to have standing towards. */
  create(actor: Actor): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'create')
      : about.refuse(actor, 'create', null, 'holds no role that maintains employee records');
  },

  /**
   * Changing one.
   *
   * No self case, deliberately: see the note at the top of this file. A person
   * correcting their own name is a fair thing to want and is not this — it is a
   * self service screen with its own much narrower list of fields, and it does
   * not exist. When it does, it is a method of its own and a decision of its
   * own, not a hole in this one.
   */
  update(actor: Actor, employee: Employee): Decision {
    if (holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'update', employee.id);
    }

    return canSee(actor, employee)
      ? about.refuseOpenly(
          actor,
          'update',
          employee.id,
          'can see the record but holds no role that maintains employee records',
          'Employee records are changed by HR. Ask them to make the correction — ' +
            'this includes your own record, which is why the figures on it can be ' +
            'relied on.',
        )
      : about.refuse(
          actor,
          'update',
          employee.id,
          'cannot see the record and holds no role that maintains employee records',
        );
  },

  /**
   * Recording that somebody has left. FR 06.
   *
   * The same standing as any other change, and that is a considered answer
   * rather than a shrug. Termination is consequential — it closes the person's
   * access the next time they knock — but it is the ordinary work of an HR
   * officer on the day somebody leaves, and putting it a rank higher would mean
   * either an administrator on hand for every leaver or, far more likely,
   * everybody in HR holding HR_ADMIN so that leavers can be recorded at all.
   * A rule that is routinely worked around is worse than the rule below it.
   */
  terminate(actor: Actor, employee: Employee): Decision {
    if (holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)) {
      return about.allow(actor, 'terminate', employee.id);
    }

    return canSee(actor, employee)
      ? about.refuseOpenly(
          actor,
          'terminate',
          employee.id,
          'can see the record but holds no role that maintains employee records',
          'Recording that somebody has left is for HR. Ask them to do it.',
        )
      : about.refuse(
          actor,
          'terminate',
          employee.id,
          'cannot see the record and holds no role that maintains employee records',
        );
  },

  /**
   * Loading staff from a spreadsheet. FR 08.
   *
   * The same standing as creating and changing records one at a time, because
   * that is exactly what it does — {@link StaffImportService} writes every row
   * through {@link EmployeeService}, so a caller who may not create one employee
   * may not create four hundred. Checked at the import's own door as well, and
   * not only row by row, so that a dry run — which writes nothing and therefore
   * reaches no write check — is refused before it reads the organisation and
   * hands back a report naming everybody in it.
   */
  importStaff(actor: Actor): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'import')
      : about.refuse(actor, 'import', null, 'holds no role that maintains employee records');
  },
};
