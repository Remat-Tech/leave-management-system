/** HR's reports, over HTTP. FR 63, LMS 510, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { ReportService } from './report.service.js';
import { actorOf } from '../../http/identify.js';

export interface ReportRoutes {
  reports: ReportService;
}

export function reportRoutes({ reports }: ReportRoutes): Router {
  const routes = Router();

  routes.get('/reports/liability', (request: Request, response: Response, next) => {
    void reports
      .liability(actorOf(response), oneStringIn(request, 'leaveYearId'))
      .then((report) => response.json(report))
      .catch(next);
  });

  routes.get('/reports/leave-taken', (request: Request, response: Response, next) => {
    void reports
      .leaveTaken(actorOf(response), {
        from: oneStringIn(request, 'from'),
        to: oneStringIn(request, 'to'),
      })
      .then((report) => response.json(report))
      .catch(next);
  });

  routes.get('/reports/overdue-requests', (request: Request, response: Response, next) => {
    void reports
      .overdueRequests(actorOf(response), oneStringIn(request, 'turnaroundDays'))
      .then((report) => response.json(report))
      .catch(next);
  });

  routes.get('/reports/usage', (request: Request, response: Response, next) => {
    void reports
      .usage(actorOf(response), oneStringIn(request, 'leaveYearId'))
      .then((report) => response.json(report))
      .catch(next);
  });

  routes.get('/reports/carried-over', (request: Request, response: Response, next) => {
    void reports
      .carriedOver(actorOf(response), oneStringIn(request, 'leaveYearId'))
      .then((report) => response.json(report))
      .catch(next);
  });

  return routes;
}

/** A query parameter, where one non-empty string was sent. */
function oneStringIn(request: Request, name: string): string | undefined {
  const value = request.query[name];

  return typeof value === 'string' && value !== '' ? value : undefined;
}
