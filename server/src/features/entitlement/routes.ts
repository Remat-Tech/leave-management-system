/** The entitlement rule screen, over HTTP. FR 31, LMS 502. */

import { type Request, type Response, Router } from 'express';
import type { Actor } from '../../auth/actor.js';
import type { DepartmentRepository } from '../department/department.db.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { EntitlementRuleService } from './entitlement-rule.service.js';
import type { LeaveTypeService } from '../leave-type/leave-type.service.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import {
  type EntitlementRule,
  type EntitlementRuleChanges,
  type NewEntitlementRule,
  RULE_SCOPES,
  scopeOf,
} from './entitlement-rule.js';
import {
  carryoverInWords,
  closedYearsInWords,
  periodInWords,
  type RuleNames,
  ruleInWords,
  scopeLabel,
  whoInWords,
  whyItIsFixed,
} from './entitlement-words.js';
import { earliestOpenDayOf } from '../leave-year/leave-year.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';
import { actorOf } from '../../http/identify.js';

export interface EntitlementRuleRoutes {
  rules: EntitlementRuleService;
  types: LeaveTypeService;
  /** For the names beside a rule and for the two scope pickers. */
  employees: EmployeeRepository;
  departments: DepartmentRepository;
  /** FR 31. Where the closed years end. */
  years: LeaveYearRepository;
}

/** The fields a change may name. */
const CHANGEABLE = [
  'leaveTypeId',
  'employeeId',
  'departmentId',
  'entitlementDays',
  'prorateOnJoin',
  'carriesOver',
  'carryoverMaxDays',
  'carryoverExpiryMonth',
  'effectiveFrom',
  'effectiveTo',
  'note',
] as const;

/** What a new rule is unless the person says otherwise. */
const DEFAULTS = {
  entitlementDays: 0,
  prorateOnJoin: false,
  carriesOver: false,
  carryoverMaxDays: null,
  carryoverExpiryMonth: null,
  effectiveTo: null,
  note: null,
};

export function entitlementRuleRoutes(parts: EntitlementRuleRoutes): Router {
  const routes = Router();

  /**
   * Every rule, with the vocabulary a form needs. FR 31.
   *
   * The rule list is refused for anybody who does not read every record, and that
   * refusal happens first — so the names and pickers below are read behind the same
   * gate `employeePolicy.list` would apply.
   */
  routes.get('/entitlement-rules', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.rules
      .list(actor, {
        leaveTypeId: optional(request.query.leaveTypeId),
        employeeId: optional(request.query.employeeId),
        departmentId: optional(request.query.departmentId),
        draftsOnly: request.query.draftsOnly === 'true',
      })
      .then(async (found) => {
        const [types, employees, departments, years] = await Promise.all([
          parts.types.list(actor),
          parts.employees.list(),
          parts.departments.list(),
          parts.years.list(),
        ]);

        const names = namesFrom(types, employees, departments);
        const today = calendarDateIn(new Date(), 'UTC');
        const earliestOpenDay = earliestOpenDayOf(years);

        response.json({
          rules: found.map((rule) => ruleAsJson(rule, names(rule), today)),
          leaveTypes: types.map((type) => ({
            id: type.id,
            code: type.code,
            name: type.name,
            isActive: type.isActive,
          })),
          departments: departments.map((department) => ({
            id: department.id,
            name: department.name,
          })),
          employees: employees.map((employee) => ({
            id: employee.id,
            name: `${employee.firstName} ${employee.lastName}`,
            departmentId: employee.departmentId,
          })),
          scopes: RULE_SCOPES.map((value) => ({ value, label: scopeLabel(value) })),
          defaults: DEFAULTS,
          today,
          /** FR 31. Null where nothing has been closed, which is not the same as no check. */
          earliestOpenDay,
          closedYearsInWords: closedYearsInWords(earliestOpenDay),
        });
      })
      .catch(next);
  });

  /** Adds a rule. Changing a figure is always this, never an edit to a rule in force. */
  routes.post('/entitlement-rules', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.rules
      .create(actor, bodyOf(request) as unknown as NewEntitlementRule)
      .then(async (created) => {
        response.status(201).json(await withNames(parts, actor, created));
      })
      .catch(next);
  });

  /** Corrects a rule that has not started yet. FR 31. Only what is sent changes. */
  routes.patch('/entitlement-rules/:id', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.rules
      .correct(actor, asString(request.params.id), changesIn(request))
      .then(async (updated) => {
        response.json(await withNames(parts, actor, updated));
      })
      .catch(next);
  });

  /** Removes a rule that never applied to anybody. */
  routes.delete('/entitlement-rules/:id', (request: Request, response: Response, next) => {
    void parts.rules
      .withdraw(actorOf(response), asString(request.params.id))
      .then(() => {
        response.status(204).end();
      })
      .catch(next);
  });

  return routes;
}

/** One rule as the screen needs it: the columns, and the sentences they add up to. */
function ruleAsJson(rule: EntitlementRule, names: RuleNames, today: CalendarDate): unknown {
  const fixedBecause = whyItIsFixed(rule, today);

  return {
    id: rule.id,
    leaveTypeId: rule.leaveTypeId,
    leaveTypeName: names.leaveTypeName,

    scope: scopeOf(rule),
    scopeLabel: scopeLabel(scopeOf(rule)),
    employeeId: rule.employeeId,
    departmentId: rule.departmentId,
    who: whoInWords(rule, names),

    entitlementDays: rule.entitlementDays,
    prorateOnJoin: rule.prorateOnJoin,

    carriesOver: rule.carriesOver,
    carryoverMaxDays: rule.carryoverMaxDays,
    carryoverExpiryMonth: rule.carryoverExpiryMonth,
    carryoverInWords: carryoverInWords(rule),

    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    periodInWords: periodInWords(rule),
    note: rule.note,

    /** FR 31. Whether it is still a draft, and the sentence saying why not. */
    mayBeChanged: fixedBecause === null,
    fixedBecause,
    inForce:
      rule.effectiveFrom <= today && (rule.effectiveTo === null || today <= rule.effectiveTo),
    inWords: ruleInWords(rule, names),

    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/** One written rule, with the names its ids stand for. */
async function withNames(
  parts: EntitlementRuleRoutes,
  actor: Actor,
  rule: EntitlementRule,
): Promise<unknown> {
  const [types, employees, departments] = await Promise.all([
    parts.types.list(actor),
    parts.employees.list(),
    parts.departments.list(),
  ]);

  return ruleAsJson(
    rule,
    namesFrom(types, employees, departments)(rule),
    calendarDateIn(new Date(), 'UTC'),
  );
}

/** A lookup from the three tables a rule points at, built once per answer. */
function namesFrom(
  types: { id: string; name: string }[],
  employees: { id: string; firstName: string; lastName: string }[],
  departments: { id: string; name: string }[],
): (rule: EntitlementRule) => RuleNames {
  const typeNames = new Map(types.map((type) => [type.id, type.name]));
  const employeeNames = new Map(
    employees.map((employee) => [employee.id, `${employee.firstName} ${employee.lastName}`]),
  );
  const departmentNames = new Map(
    departments.map((department) => [department.id, department.name]),
  );

  return (rule) => ({
    leaveTypeName: typeNames.get(rule.leaveTypeId) ?? 'Leave',
    employeeName: rule.employeeId === null ? null : (employeeNames.get(rule.employeeId) ?? null),
    departmentName:
      rule.departmentId === null ? null : (departmentNames.get(rule.departmentId) ?? null),
  });
}

/**
 * The fields a change named, untouched.
 *
 * `in` rather than a truthiness check: clearing an end date and leaving it alone are
 * different instructions all the way down to the UPDATE.
 */
function changesIn(request: Request): EntitlementRuleChanges {
  const sent = bodyOf(request);
  const changes: Record<string, unknown> = {};

  for (const field of CHANGEABLE) {
    if (field in sent) {
      changes[field] = sent[field];
    }
  }

  return changes as EntitlementRuleChanges;
}

/** One query parameter, where a string arrived and it is not blank. */
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
