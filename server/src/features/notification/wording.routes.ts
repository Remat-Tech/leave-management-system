/** The email wording screen, over HTTP. FR 61, LMS 512. */

import { type Request, type Response, Router } from 'express';
import { actorOf } from '../../http/identify.js';
import { LONGEST_BODY, LONGEST_SUBJECT } from './wording.js';
import type { EmailWording, EmailWordingService } from './wording.service.js';

export interface EmailWordingRoutes {
  wording: EmailWordingService;
}

export function emailWordingRoutes(parts: EmailWordingRoutes): Router {
  const routes = Router();

  /** Every email, in the words it is sent in. */
  routes.get('/email-wording', (_request: Request, response: Response, next) => {
    void parts.wording
      .list(actorOf(response))
      .then((emails) => {
        response.json({
          emails: emails.map(emailAsJson),
          longestSubject: LONGEST_SUBJECT,
          longestBody: LONGEST_BODY,
        });
      })
      .catch(next);
  });

  /** Rewords one email. */
  routes.put('/email-wording/:name', (request: Request, response: Response, next) => {
    void parts.wording
      .reword(actorOf(response), request.params.name, bodyOf(request))
      .then((email) => {
        response.json(emailAsJson(email));
      })
      .catch(next);
  });

  /** Puts one email back to its original wording. */
  routes.delete('/email-wording/:name', (request: Request, response: Response, next) => {
    void parts.wording
      .putBack(actorOf(response), request.params.name)
      .then((email) => {
        response.json(emailAsJson(email));
      })
      .catch(next);
  });

  /** Fills the wording in on a made up request. Saves nothing. */
  routes.post('/email-wording/:name/preview', (request: Request, response: Response, next) => {
    void parts.wording
      .preview(actorOf(response), request.params.name, bodyOf(request))
      .then((filled) => {
        response.json(filled);
      })
      .catch(next);
  });

  return routes;
}

function emailAsJson(email: EmailWording): unknown {
  return {
    name: email.name,
    label: email.label,
    readBy: email.readBy,
    subject: email.wording.subject,
    body: email.wording.body,
    original: email.original,
    isReworded: email.isReworded,
    updatedAt: email.updatedAt?.toISOString() ?? null,
    placeholders: email.placeholders,
  };
}

function bodyOf(request: Request): { subject?: unknown; body?: unknown } {
  const body: unknown = request.body;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}
