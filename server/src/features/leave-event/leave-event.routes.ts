/** Recording an event that grants leave, over HTTP. FR 32g, FR 32e, LMS 218. */

import { type Request, type Response, Router } from 'express';
import type { Guard } from '../../auth/policy.js';
import type { Employee } from '../employee/employee.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import { employeePolicy } from '../employee/policy.js';
import { hasRunningBalance, type LeaveType } from '../leave-type/leave-type.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { EventGranted } from '../balance/balance.service.js';
import type { LeaveEvent } from './leave-event.js';
import type { LeaveEventService } from './leave-event.service.js';
import type { CalendarDate } from '../../shared/time.js';
import { actorOf } from '../../http/identify.js';

export interface LeaveEventRoutes {
  events: LeaveEventService;
  guard: Guard;
  employees: EmployeeRepository;
  types: LeaveTypeRepository;
}

export function leaveEventRoutes(parts: LeaveEventRoutes): Router {
  const routes = Router();

  /** The picker: everybody, and the kinds of leave that arrive with an event. */
  routes.get('/leave-events', (_request: Request, response: Response, next) => {
    void (async () => {
      parts.guard.enforce(employeePolicy.list(actorOf(response)));

      const [employees, types] = await Promise.all([parts.employees.list(), parts.types.list()]);

      response.json({
        employees: employees.map(personAsJson),
        types: types.filter((type) => !hasRunningBalance(type) && type.isActive).map(typeAsJson),
      });
    })().catch(next);
  });

  /** One person's recorded events, oldest first. */
  routes.get('/leave-events/:employeeId', (request: Request, response: Response, next) => {
    void (async () => {
      const [events, types] = await Promise.all([
        parts.events.forEmployee(actorOf(response), asString(request.params.employeeId)),
        parts.types.list(),
      ]);
      const names = new Map(types.map((type) => [type.id, type.name]));

      response.json({
        events: events.map((event) => ({
          ...eventAsJson(event),
          typeName: names.get(event.leaveTypeId) ?? event.leaveTypeId,
        })),
      });
    })().catch(next);
  });

  /** Records one and grants its days. */
  routes.post('/leave-events', (request: Request, response: Response, next) => {
    const sent = bodyOf(request);

    void parts.events
      .record(actorOf(response), {
        employeeId: asString(sent.employeeId),
        leaveTypeId: asString(sent.leaveTypeId),
        occurredOn: sent.occurredOn as CalendarDate,
        note: typeof sent.note === 'string' ? sent.note : null,
      })
      .then((granted) => {
        response.status(201).json(grantedAsJson(granted));
      })
      .catch(next);
  });

  return routes;
}

function personAsJson(employee: Employee): unknown {
  return {
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`,
    employeeNumber: employee.employeeNumber,
    hasLeft: employee.employmentStatus === 'TERMINATED',
  };
}

function typeAsJson(type: LeaveType): unknown {
  return {
    id: type.id,
    name: type.name,
    genderRestriction: type.genderRestriction,
    entitlementExpiryMonths: type.entitlementExpiryMonths,
  };
}

function eventAsJson(event: LeaveEvent): Record<string, unknown> {
  return {
    id: event.id,
    employeeId: event.employeeId,
    leaveTypeId: event.leaveTypeId,
    leaveYearId: event.leaveYearId,
    occurredOn: event.occurredOn,
    expiresOn: event.expiresOn,
    note: event.note,
    hasLapsed: event.lapsedEntryId !== null,
    createdAt: event.createdAt.toISOString(),
  };
}

function grantedAsJson(granted: EventGranted): unknown {
  return {
    event: eventAsJson(granted.event),
    days: granted.entry.days,
    available: granted.balance.available,
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
