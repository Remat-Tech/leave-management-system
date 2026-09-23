/** The audit log, searched over HTTP. Read only. NFR AUD 01, NFR AUD 02. */

import { type Request, type Response, Router } from 'express';
import { actorOf } from '../../http/identify.js';
import {
  AUDITED_ENTITIES,
  AUDITED_ENTITY_LABELS,
  changedFields,
  isPickableEntity,
  LONGEST_SEARCH,
  type NamedAuditEntry,
} from './audit.js';
import type { AuditQuery, AuditService } from './audit.service.js';

export interface AuditRoutes {
  audit: AuditService;
}

export function auditRoutes({ audit }: AuditRoutes): Router {
  const routes = Router();

  /** Entries matching the search, newest first. No other verb is mounted. */
  routes.get('/audit', (request: Request, response: Response, next) => {
    void audit
      .search(actorOf(response), auditQueryOf(request))
      .then(({ entries, moreThanShown }) => {
        response.json({
          entries: entries.map(entryAsJson),
          entities: AUDITED_ENTITIES.map((name) => ({
            name,
            label: AUDITED_ENTITY_LABELS[name],
            /* So the screen knows which kinds it can offer a list for, rather than holding a
               second copy of that decision. */
            pickable: isPickableEntity(name),
          })),
          longestSearch: LONGEST_SEARCH,
          moreThanShown,
        });
      })
      .catch(next);
  });

  /** The records of one kind, to choose from instead of typing an id. */
  routes.get('/audit/records', (request: Request, response: Response, next) => {
    void audit
      .recordsOf(actorOf(response), oneStringIn(request, 'entity'))
      .then((records) => {
        response.json({ records });
      })
      .catch(next);
  });

  return routes;
}

function entryAsJson(entry: NamedAuditEntry): unknown {
  return {
    id: entry.id,
    occurredAt: entry.occurredAt.toISOString(),
    action: entry.action,
    entity: entry.entity,
    entityLabel: AUDITED_ENTITY_LABELS[entry.entity],
    entityId: entry.entityId,
    actor: entry.actorName ?? entry.actor,
    actorEmployeeId: entry.actorEmployeeId,
    changes: changedFields(entry),
  };
}

function auditQueryOf(request: Request): AuditQuery {
  return {
    entity: oneStringIn(request, 'entity'),
    entityId: oneStringIn(request, 'entityId'),
    from: oneStringIn(request, 'from'),
    to: oneStringIn(request, 'to'),
  };
}

/** A query parameter, where one string was sent. */
function oneStringIn(request: Request, name: string): string | undefined {
  const value = request.query[name];

  return typeof value === 'string' ? value : undefined;
}
