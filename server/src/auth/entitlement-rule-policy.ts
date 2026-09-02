/** Who may see and change what a leave type is worth. NFR SEC 02, §10., LMS 112, FR 31, LMS 203. */

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

  /** One rule. */
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

  /** Every rule there is, which includes every personal exception there is. */
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

  /** What one person is entitled to. */
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

  /** Changing a rule that has not taken effect yet. */
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
