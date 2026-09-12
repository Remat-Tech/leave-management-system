/** HR's reports, over HTTP, and as files. FR 63, LMS 510, FR 58, FR 64, LMS 511, NFR DAT 03. */

import { type Request, type Response, Router } from 'express';
import type { Actor } from '../../auth/actor.js';
import { readExportFormat, type Table } from '../../export/table.js';
import { sendTable } from '../../http/download.js';
import { actorOf } from '../../http/identify.js';
import {
  carriedOverTable,
  leaveTakenTable,
  liabilityTable,
  overdueRequestsTable,
  usageTable,
} from './export.js';
import type { ReportQuery, ReportService } from './report.service.js';

export interface ReportRoutes {
  reports: ReportService;
}

export function reportRoutes({ reports }: ReportRoutes): Router {
  const routes = Router();

  /** The report as JSON at `/reports/<path>`, and as a file at `/reports/<path>/export`. */
  function serve<T>(
    path: string,
    read: (actor: Actor, asked: ReportQuery) => Promise<T>,
    asTable: (report: T) => Table,
  ): void {
    routes.get(`/reports/${path}`, (request: Request, response: Response, next) => {
      void read(actorOf(response), reportQueryOf(request))
        .then((report) => response.json(report))
        .catch(next);
    });

    routes.get(`/reports/${path}/export`, (request: Request, response: Response, next) => {
      void Promise.resolve()
        .then(async () => {
          const format = readExportFormat(request.query.format);
          const report = await read(actorOf(response), reportQueryOf(request));

          sendTable(response, asTable(report), format);
        })
        .catch(next);
    });
  }

  serve('liability', (actor, asked) => reports.liability(actor, asked), liabilityTable);
  serve('leave-taken', (actor, asked) => reports.leaveTaken(actor, asked), leaveTakenTable);
  serve(
    'overdue-requests',
    (actor, asked) => reports.overdueRequests(actor, asked),
    overdueRequestsTable,
  );
  serve('usage', (actor, asked) => reports.usage(actor, asked), usageTable);
  serve('carried-over', (actor, asked) => reports.carriedOver(actor, asked), carriedOverTable);

  return routes;
}

function reportQueryOf(request: Request): ReportQuery {
  return {
    leaveYearId: oneStringIn(request, 'leaveYearId'),
    from: oneStringIn(request, 'from'),
    to: oneStringIn(request, 'to'),
    turnaroundDays: oneStringIn(request, 'turnaroundDays'),
    departmentId: oneStringIn(request, 'departmentId'),
    leaveTypeId: oneStringIn(request, 'leaveTypeId'),
  };
}

/** A query parameter, where one non-empty string was sent. */
function oneStringIn(request: Request, name: string): string | undefined {
  const value = request.query[name];

  return typeof value === 'string' && value !== '' ? value : undefined;
}
