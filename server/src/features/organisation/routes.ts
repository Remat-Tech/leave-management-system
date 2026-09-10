/** The policy settings screen, over HTTP. FR 44, FR 48c, NFR SEC 06, LMS 505. */

import { type Request, type Response, Router } from 'express';
import type { LeaveTypeService } from '../leave-type/leave-type.service.js';
import type { OrganisationService } from './organisation.service.js';
import type { LeaveType } from '../leave-type/leave-type.js';
import { actorOf } from '../../http/identify.js';
import {
  isReadyForGoLive,
  LONGEST_RETENTION_MONTHS,
  type OrganisationSettings,
  overrideRuleInWords,
  type PolicyChanges,
  retentionInWords,
} from './organisation.js';

export interface OrganisationRoutes {
  organisation: OrganisationService;
  /** FR 17, FR 18. The windows, which live on the type rather than on the company. */
  types: LeaveTypeService;
}

/** The fields a change may name. The Chief Executive has its own door. */
const CHANGEABLE = ['overridesAreAllowed', 'attachmentRetentionMonths'] as const;

export function organisationRoutes(parts: OrganisationRoutes): Router {
  const routes = Router();

  /**
   * Every policy setting on one answer. FR 44, FR 48c, NFR SEC 06.
   *
   * The windows are read here and written through `PATCH /leave-types/:id`, which stays the
   * one door onto a type. `employees` is the picker, and is empty for anybody who cannot use
   * it: a route that read the directory for everybody would be a way round
   * `employeePolicy.list`.
   */
  routes.get('/policy-settings', (_request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void Promise.all([
      parts.organisation.settings(actor),
      parts.organisation.chiefExecutiveOrNobody(actor),
      parts.organisation.whoCouldBeNamed(actor),
      parts.types.list(actor),
    ])
      .then(([settings, named, employees, types]) => {
        response.json({
          settings: settingsAsJson(settings, named),
          windows: types.filter((type) => type.isActive).map(windowAsJson),
          employees: employees.map(personAsJson),
          longestRetentionMonths: LONGEST_RETENTION_MONTHS,
        });
      })
      .catch(next);
  });

  /** Changes the override rule, the retention window, or both. Only what is sent changes. */
  routes.patch('/policy-settings', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.organisation
      .changePolicy(actor, changesIn(request))
      .then(async (settings) => {
        response.json(
          settingsAsJson(settings, await parts.organisation.chiefExecutiveOrNobody(actor)),
        );
      })
      .catch(next);
  });

  /**
   * Names the Chief Executive. FR 48c.
   *
   * Its own door because it is its own three refusals: nobody, somebody who has left, and an
   * empty box. None of them is about a number.
   */
  routes.put('/policy-settings/chief-executive', (request: Request, response: Response, next) => {
    const actor = actorOf(response);

    void parts.organisation
      .nameTheChiefExecutive(actor, bodyOf(request).employeeId)
      .then(async (settings) => {
        response.json(
          settingsAsJson(settings, await parts.organisation.chiefExecutiveOrNobody(actor)),
        );
      })
      .catch(next);
  });

  return routes;
}

/** Somebody a setting can name. */
interface Person {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  employmentStatus: string;
}

/** The settings as the screen needs them: the values, and the sentences they add up to. */
function settingsAsJson(settings: OrganisationSettings, named: Person | null): unknown {
  return {
    chiefExecutiveId: settings.chiefExecutiveId,
    chiefExecutiveName: named === null ? null : `${named.firstName} ${named.lastName}`,
    chiefExecutiveJobTitle: named?.jobTitle ?? null,
    /** FR 48c. The one setting that has to be answered before go live. */
    isReadyForGoLive: isReadyForGoLive(settings),

    /** FR 44. */
    overridesAreAllowed: settings.overridesAreAllowed,
    overrideRuleInWords: overrideRuleInWords(settings.overridesAreAllowed),

    /** NFR SEC 06. */
    attachmentRetentionMonths: settings.attachmentRetentionMonths,
    retentionInWords: retentionInWords(settings.attachmentRetentionMonths),

    updatedAt: settings.updatedAt.toISOString(),
  };
}

/** One type's two windows. FR 17, FR 18. */
function windowAsJson(type: LeaveType): unknown {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    minNoticeCalendarDays: type.minNoticeCalendarDays,
    maxBackdateCalendarDays: type.maxBackdateCalendarDays,
    displayOrder: type.displayOrder,
  };
}

/** FR 06. A leaver is in the list and marked, so the picker says why it refuses them. */
function personAsJson(employee: Person): unknown {
  return {
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`,
    jobTitle: employee.jobTitle,
    hasLeft: employee.employmentStatus === 'TERMINATED',
  };
}

/** The fields a change named, untouched. `in` rather than truthiness: null clears a window. */
function changesIn(request: Request): PolicyChanges {
  const sent = bodyOf(request);
  const changes: Record<string, unknown> = {};

  for (const field of CHANGEABLE) {
    if (field in sent) {
      changes[field] = sent[field];
    }
  }

  return changes as PolicyChanges;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
