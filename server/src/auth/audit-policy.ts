/** Who may read the account of what happened. NFR AUD 01, NFR SEC 02, §10., LMS 113, LMS 112. */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { ADMINISTERS_ACCESS, READS_EVERY_RECORD } from './roles.js';
import type { Employee } from '../domain/employee.js';

const about = policyFor('audit log');

export const auditPolicy = {
  resource: about.resource,

  /** The history of one employee record. */
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

  /** The history of somebody's login and roles. */
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

  /** The history of a department or a working pattern. */
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
