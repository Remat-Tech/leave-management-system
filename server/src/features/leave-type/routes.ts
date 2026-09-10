/** The leave type configuration screen, over HTTP. FR 31, FR 32, LMS 501. */

import { type Request, type Response, Router } from 'express';
import {
  ALLOWANCE_UNITS,
  allowanceUnitLabel,
  approvalChainInWords,
  COUNTING_BASES,
  countingBasisInWords,
  countingBasisLabel,
  DOCUMENTATION_RULES,
  documentationRuleLabel,
  ENTITLEMENT_BASES,
  entitlementBasisLabel,
  genderRestrictionLabel,
  LEAVE_TYPE_DEFAULTS,
  type LeaveType,
  type LeaveTypeChanges,
  type NewLeaveType,
} from './leave-type.js';
import { APPROVER_ROLES, chainLabel, deskLabel } from './approval-chain.js';
import { GENDERS } from '../employee/employee.js';
import type { LeaveTypeService } from './leave-type.service.js';
import { actorOf } from '../../http/identify.js';

export interface LeaveTypeRoutes {
  types: LeaveTypeService;
}

/** The fields a change may name. FR 32, FR 33. */
const CHANGEABLE = [
  'code',
  'name',
  'description',
  'countingBasis',
  'entitlementBasis',
  'isPaid',
  'unit',
  'documentation',
  'documentationAfterDays',
  'exceedableWithDocument',
  'entitlementExpiryMonths',
  'mayBeSplit',
  'minNoticeCalendarDays',
  'maxBackdateCalendarDays',
  'genderRestriction',
  'reasonRequired',
  'displayOrder',
] as const;

export function leaveTypeRoutes({ types }: LeaveTypeRoutes): Router {
  const routes = Router();

  /**
   * Every type, retired ones included, with the vocabulary a form needs. FR 31.
   *
   * Retired ones are in by default because this is the screen they are reinstated from.
   * `?offeredOnly=true` narrows it to what a request form would show.
   */
  routes.get('/leave-types', (request: Request, response: Response, next) => {
    void types
      .list(actorOf(response), { offeredOnly: request.query.offeredOnly === 'true' })
      .then((found) => {
        response.json({
          types: found.map(typeAsJson),
          choices: CHOICES,
          defaults: LEAVE_TYPE_DEFAULTS,
        });
      })
      .catch(next);
  });

  routes.get('/leave-types/:id', (request: Request, response: Response, next) => {
    void types
      .byId(actorOf(response), asString(request.params.id))
      .then((type) => {
        response.json(typeAsJson(type));
      })
      .catch(next);
  });

  /** Creates one. FR 31, FR 32. The story's first criterion. */
  routes.post('/leave-types', (request: Request, response: Response, next) => {
    void types
      .create(actorOf(response), newTypeIn(request))
      .then((created) => {
        response.status(201).json(typeAsJson(created));
      })
      .catch(next);
  });

  /**
   * Changes one. FR 32, FR 33. The story's second criterion.
   *
   * A PATCH, and only the fields actually sent are changed: two administrators with the
   * form open should not overwrite each other's untouched fields.
   */
  routes.patch('/leave-types/:id', (request: Request, response: Response, next) => {
    void types
      .update(actorOf(response), asString(request.params.id), changesIn(request))
      .then((updated) => {
        response.json(typeAsJson(updated));
      })
      .catch(next);
  });

  /** Says who approves leave of this kind, in order. FR 38a. Its own door, as the service has. */
  routes.put('/leave-types/:id/approval-chain', (request: Request, response: Response, next) => {
    const sent = bodyOf(request);

    void types
      .setApprovalChain(
        actorOf(response),
        asString(request.params.id),
        Array.isArray(sent.approvalChain) ? (sent.approvalChain as string[]) : [],
      )
      .then((updated) => {
        response.json(typeAsJson(updated));
      })
      .catch(next);
  });

  /** Takes it out of use. Never a DELETE: the type heads every report it ever headed. */
  routes.post('/leave-types/:id/retire', (request: Request, response: Response, next) => {
    void types
      .retire(actorOf(response), asString(request.params.id))
      .then((retired) => {
        response.json(typeAsJson(retired));
      })
      .catch(next);
  });

  routes.post('/leave-types/:id/reinstate', (request: Request, response: Response, next) => {
    void types
      .reinstate(actorOf(response), asString(request.params.id))
      .then((offered) => {
        response.json(typeAsJson(offered));
      })
      .catch(next);
  });

  return routes;
}

/**
 * A whole new type, untouched. FR 31, FR 32.
 *
 * Nothing is coerced and nothing is defaulted here: `validateNewLeaveType` applies every
 * default and refuses every bad field with the field named, so a missing `countingBasis`
 * arrives at the domain as missing rather than as something this file guessed.
 */
function newTypeIn(request: Request): NewLeaveType {
  return bodyOf(request) as unknown as NewLeaveType;
}

/**
 * The fields a change named, untouched.
 *
 * Passed through rather than coerced, because `validateLeaveTypeChanges` refuses each one
 * with the field named — NFR USA 03 — and checks here would be a second set of messages
 * that eventually disagree. What this decides is only *which* fields were named: clearing
 * an expiry and leaving it alone are different instructions all the way down.
 */
function changesIn(request: Request): LeaveTypeChanges {
  const sent = bodyOf(request);
  const changes: Record<string, unknown> = {};

  for (const field of CHANGEABLE) {
    if (field in sent) {
      changes[field] = sent[field];
    }
  }

  return changes as LeaveTypeChanges;
}

/** Every closed set a form draws a control from, named as a person reads them. LMS 501. */
const CHOICES = {
  countingBases: COUNTING_BASES.map((value) => ({
    value,
    label: countingBasisLabel(value),
    /** FR 22. What the basis costs, for the help text beside the control. */
    inWords: countingBasisInWords(value),
  })),
  entitlementBases: ENTITLEMENT_BASES.map((value) => ({
    value,
    label: entitlementBasisLabel(value),
  })),
  units: ALLOWANCE_UNITS.map((value) => ({ value, label: allowanceUnitLabel(value) })),
  documentationRules: DOCUMENTATION_RULES.map((value) => ({
    value,
    label: documentationRuleLabel(value),
  })),
  /** FR 05. Null is everybody, and is sent as a choice so the control has one. */
  genderRestrictions: [
    { value: null, label: genderRestrictionLabel(null) },
    ...GENDERS.map((value) => ({ value, label: genderRestrictionLabel(value) })),
  ],
  /** FR 38a. */
  approvers: APPROVER_ROLES.map((value) => ({ value, label: deskLabel(value) })),
};

/**
 * One type, as the screen that edits it needs it. NFR DAT 03.
 *
 * Both halves of every closed set: the token a control is bound to, and the words beside
 * it. A browser that named a basis itself would be a second answer to what one is called.
 */
function typeAsJson(type: LeaveType): unknown {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    description: type.description,

    countingBasis: type.countingBasis,
    countingBasisLabel: countingBasisLabel(type.countingBasis),
    countingBasisInWords: countingBasisInWords(type.countingBasis),

    entitlementBasis: type.entitlementBasis,
    entitlementBasisLabel: entitlementBasisLabel(type.entitlementBasis),

    isPaid: type.isPaid,
    unit: type.unit,
    unitLabel: allowanceUnitLabel(type.unit),

    /** FR 13. */
    documentation: type.documentation,
    documentationLabel: documentationRuleLabel(type.documentation),
    documentationAfterDays: type.documentationAfterDays,
    /** FR 32a. */
    exceedableWithDocument: type.exceedableWithDocument,
    /** FR 32e. */
    entitlementExpiryMonths: type.entitlementExpiryMonths,

    mayBeSplit: type.mayBeSplit,
    /** FR 17, FR 18. */
    minNoticeCalendarDays: type.minNoticeCalendarDays,
    maxBackdateCalendarDays: type.maxBackdateCalendarDays,
    /** FR 05. */
    genderRestriction: type.genderRestriction,
    genderRestrictionLabel: genderRestrictionLabel(type.genderRestriction),
    /** FR 10. */
    reasonRequired: type.reasonRequired,
    /** FR 33. Read only, and false forever. */
    deductsFromAnnual: type.deductsFromAnnual,

    /** FR 38a. */
    approvalChain: type.approvalChain,
    approvedBy: approvalChainInWords(type),
    /** FR 38a, LMS 503. The same chain in the voice a configuration screen reads in. */
    approvedByLabel: chainLabel(type.approvalChain),

    displayOrder: type.displayOrder,
    isActive: type.isActive,
    createdAt: type.createdAt.toISOString(),
    updatedAt: type.updatedAt.toISOString(),
  };
}

/** One string from whatever arrived, and the empty string for anything else. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The parsed body, where something object shaped arrived. */
function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
