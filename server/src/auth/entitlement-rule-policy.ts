/**
 * Who may see and change what a leave type is worth. NFR SEC 02. §10. LMS 112.
 * FR 31, LMS 203.
 *
 * The fourth policy about the shape of the organisation, and the first one that
 * is not simply "read is open, write is an HR Administrator's" — because this is
 * the first configuration table with a person-shaped field on it.
 *
 * ## A company figure is policy; a personal one is somebody's terms
 *
 * "Annual leave is twenty days" is a rule everybody plans against, and refusing to
 * say it would be the same mistake ./leave-type-policy.ts declined to make about
 * a notice window. "Kwame gets twenty five" is a fact about Kwame's contract, and
 * a colleague who can read it has read something they were not given.
 *
 * Both are rows in the same table, so the policy reads the row rather than the
 * table: a rule naming an employee is that employee's, and everything else is
 * open. A rule naming a *department* is open too, deliberately — "the field staff
 * get twenty five days" is a policy about a job, is on the noticeboard, and is
 * the kind of thing somebody transferring between teams is entitled to know.
 *
 * The refusal on a personal rule says nothing, which is the reading
 * ./policy.ts calls a quiet refusal. Being told "you may not read rule 41" is
 * being told rule 41 is somebody's, and the two people it could plausibly be are
 * a short list.
 *
 * ## Listing is not reading
 *
 * {@link entitlementRulePolicy.list} is the whole table, exceptions included, so
 * it belongs to the roles that read every record. An employee does not need it:
 * what they actually want is their own figure, which is
 * {@link entitlementRulePolicy.entitlementOf} and is theirs by right.
 *
 * A manager may ask for a report's, on the same argument ./employee-policy.ts
 * uses for the record itself — they approve that person's leave, and approving it
 * without being able to see what they are entitled to is deciding blind. Direct
 * reports only, as everywhere else.
 *
 * ## Writing is an HR Administrator's, and correcting is not the same as adding
 *
 * Adding a rule is how a figure changes and is the story. Correcting one is only
 * ever possible before it has taken effect, and withdrawing one likewise — FR 31
 * and ../domain/entitlement-rule.ts. All three are the same role and they are
 * three decisions, so the denial log says which was attempted: "added a rule",
 * "corrected next January's figure" and "withdrew it" are three different
 * sentences about somebody's pay.
 */

import { type Actor, holdsAny, isSelf } from './actor.js';
import { type Decision, policyFor } from './policy.js';
import { READS_EVERY_RECORD, SETS_UP_THE_ORGANISATION } from './roles.js';
import type { Employee } from '../domain/employee.js';
import { type EntitlementRule, scopeOf } from '../domain/entitlement-rule.js';

const about = policyFor('entitlement rule');

/** Said openly, because anybody who reaches it can already read the company figures. */
const WRITES_ARE_ADMINISTRATIVE =
  'Entitlement figures are set by an HR Administrator, because changing one changes ' +
  'what people are owed. Ask one.';

export const entitlementRulePolicy = {
  resource: about.resource,

  /**
   * One rule. Open unless it names a person, and then theirs and HR's.
   *
   * Refused quietly when it is somebody else's, so that an id which exists and an
   * id which does not give the same answer.
   */
  read(actor: Actor, rule: EntitlementRule): Decision {
    if (scopeOf(rule) !== 'EMPLOYEE') {
      return about.allow(actor, 'read', rule.id);
    }

    if (isSelf(actor, rule.employeeId)) {
      return about.allow(actor, 'read', rule.id);
    }

    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'read', rule.id)
      : about.refuse(actor, 'read', rule.id, 'the rule names another employee');
  },

  /**
   * Every rule there is, which includes every personal exception there is.
   *
   * A list of exceptions is a list of the people who have one, so it is not open
   * the way the leave type list is.
   */
  list(actor: Actor): Decision {
    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'list')
      : about.refuseOpenly(
          actor,
          'list',
          null,
          'holds no role that reads every record',
          'Entitlement rules include personal arrangements, so the whole list belongs to ' +
            'HR. Your own figures are on your balance.',
        );
  },

  /**
   * What one person is entitled to. Theirs, their manager's, and HR's.
   *
   * The employee record is passed in rather than an id, for the same reason
   * ./employee-policy.ts takes one: the manager check is "is this person one of my
   * reports", and answering it from an id would mean this file reading the table
   * that says so.
   */
  entitlementOf(actor: Actor, employee: Employee): Decision {
    if (isSelf(actor, employee.id) || isSelf(actor, employee.managerId)) {
      return about.allow(actor, 'resolve', employee.id);
    }

    return holdsAny(actor, ...READS_EVERY_RECORD)
      ? about.allow(actor, 'resolve', employee.id)
      : about.refuse(
          actor,
          'resolve',
          employee.id,
          'is neither the employee, their manager, nor a role that reads every record',
        );
  },

  /** Adding a rule, which is how every figure changes. */
  create(actor: Actor): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'create')
      : about.refuseOpenly(
          actor,
          'create',
          null,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Changing a rule that has not taken effect yet. Named apart, so the log is. */
  correct(actor: Actor, entitlementRuleId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'correct', entitlementRuleId)
      : about.refuseOpenly(
          actor,
          'correct',
          entitlementRuleId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },

  /** Removing one that never applied to anybody. */
  withdraw(actor: Actor, entitlementRuleId: string): Decision {
    return holdsAny(actor, ...SETS_UP_THE_ORGANISATION)
      ? about.allow(actor, 'withdraw', entitlementRuleId)
      : about.refuseOpenly(
          actor,
          'withdraw',
          entitlementRuleId,
          'holds no role that sets up the organisation',
          WRITES_ARE_ADMINISTRATIVE,
        );
  },
};
