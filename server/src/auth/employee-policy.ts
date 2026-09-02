/** Who may see and change an employee record. NFR SEC 02, §10., LMS 112, LMS 111, FR 03. */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { MAINTAINS_EMPLOYEE_RECORDS, READS_EVERY_RECORD } from './roles.js';
import type { Employee } from '../domain/employee.js';

const about = policyFor('employee');

/** Whether this actor has any business seeing this record at all. */
function canSee(actor: Actor, employee: Employee): boolean {
  return (
    isSelf(actor, employee.id) ||
    isSelf(actor, employee.managerId) ||
    holdsAny(actor, ...READS_EVERY_RECORD)
  );
}

export const employeePolicy = {
  resource: about.resource,

  /** Reading one record, which the service already has in hand. */
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
   * Asking about a record the actor does not have in hand: by employee number, by work address, or by an id that turned out to be nobody.
   */
  search(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'search')
      : about.refuse(actor, 'search', null, 'holds no role that reads everybody');
  },

  /** Everybody, or everybody still employed. */
  list(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'list')
      : about.refuse(actor, 'list', null, 'holds no role that reads everybody');
  },

  /** The reporting structure, drawn. FR 09, LMS 107. */
  chart(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'chart')
      : about.refuse(actor, 'chart', null, 'holds no role that reads everybody');
  },

  /** The standing check on the reporting lines. FR 02, FR 04. */
  warnings(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'warnings')
      : about.refuse(actor, 'warnings', null, 'holds no role that reads everybody');
  },

  /** Creating a record. */
  create(actor: Actor): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'create')
      : about.refuse(actor, 'create', null, 'holds no role that maintains employee records');
  },

  /** Changing one. */
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

  /** Recording that somebody has left. FR 06. */
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

  /** Loading staff from a spreadsheet. FR 08. */
  importStaff(actor: Actor): Decision {
    return holdsAny(actor, ...MAINTAINS_EMPLOYEE_RECORDS)
      ? about.allow(actor, 'import')
      : about.refuse(actor, 'import', null, 'holds no role that maintains employee records');
  },
};
