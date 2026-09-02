/** Telling somebody what happened to their leave. FR 59, §7.1., LMS 329, FR 60. */

import type { Actor } from '../../auth/actor.js';
import { notificationPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { ApproverRole } from '../leave-type/approval-chain.js';
import type { Employee } from '../employee/employee.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import {
  type NewNotice,
  type Notice,
  type NoticeEvent,
  NoticeNotFound,
  noticeOf,
} from './notification.js';
import type { Mailer } from '../../mail/mailer.js';
import type { Mail } from '../../mail/transport.js';
import type { NoticeListOptions, NotificationRepository } from './notification.db.js';

/** Everything the system needs to tell one person about one thing that happened. */
export interface Telling {
  event: NoticeEvent;
  /** Whose leave it is, which for FR 59 is also who is told. */
  employee: Employee;
  /** The request **as it stands committed**, which is where the desk and status come from. */
  request: LeaveRequest;
  typeName: string;
  /** FR 52. */
  decidedBy: ApproverRole | null;
  /** FR 39. */
  comment: string | null;
  /** What the person may book now, from the transaction that moved it. */
  availableAfter: number;
}

/** What became of one telling. */
export interface Told {
  /** The notice as written, or null where even that failed. */
  notice: Notice | null;
  /** FR 59's other channel. */
  emailed: boolean;
  /** What went wrong, in the failing component's own words. */
  couldNotTell: string | null;
}

/** A notice that could not be delivered, as the log wants it. */
export interface UndeliveredNotice {
  at: Date;
  employeeId: string;
  leaveRequestId: string;
  event: NoticeEvent;
  /** Which half failed: writing the notice down, or sending the email. */
  stage: 'write' | 'email';
  because: string;
}

/** Where a notice that did not arrive is recorded. */
export interface NoticeLog {
  record(failure: UndeliveredNotice): void;
}

/** The default. */
export function undeliveredToStderr(): NoticeLog {
  return {
    record(failure) {
      console.error(
        JSON.stringify({
          event: 'notification.undelivered',
          at: failure.at.toISOString(),
          employeeId: failure.employeeId,
          leaveRequestId: failure.leaveRequestId,
          notice: failure.event,
          stage: failure.stage,
          because: failure.because,
        }),
      );
    },
  };
}

export class NotificationService {
  constructor(
    private readonly notices: NotificationRepository,
    /** FR 59's second channel. */
    private readonly mailer: Mailer,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** Where an undelivered notice goes. */
    private readonly log: NoticeLog = undeliveredToStderr(),
  ) {}

  /** Tells somebody what happened to their leave, on both channels. FR 59. */
  async tell(telling: Telling): Promise<Told> {
    const { employee } = telling;

    const composed = noticeOf({
      event: telling.event,
      employee: { id: employee.id, firstName: employee.firstName },
      request: telling.request,
      typeName: telling.typeName,
      decidedBy: telling.decidedBy,
      comment: telling.comment,
      availableAfter: telling.availableAfter,
    });

    const notice = await this.write(composed);

    if (notice === null) {
      return { notice: null, emailed: false, couldNotTell: 'the notice could not be written' };
    }

    return this.email(notice, employee.workEmail);
  }

  /** One person's notifications, newest first. FR 59. */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: NoticeListOptions = {},
  ): Promise<Notice[]> {
    this.guard.enforce(notificationPolicy.read(actor, { employeeId }));

    return this.notices.forEmployee(employeeId, options);
  }

  /** How many they have not seen. */
  async unreadCountFor(actor: Actor, employeeId: string): Promise<number> {
    this.guard.enforce(notificationPolicy.read(actor, { employeeId }));

    return this.notices.unreadCountFor(employeeId);
  }

  /** One notice, if it is the actor's own. */
  async byId(actor: Actor, id: string): Promise<Notice> {
    const notice = await this.notices.findById(id);

    if (notice === undefined) {
      throw new NoticeNotFound(id);
    }

    this.guard.enforce(notificationPolicy.read(actor, { employeeId: notice.employeeId }));

    return notice;
  }

  /** Marks one read, or puts it back to unread. FR 59. */
  async markRead(actor: Actor, id: string, at: Date | null = new Date()): Promise<Notice> {
    const notice = await this.notices.findById(id);

    if (notice === undefined) {
      throw new NoticeNotFound(id);
    }

    this.guard.enforce(notificationPolicy.markRead(actor, { employeeId: notice.employeeId }));

    const written = await this.notices.markRead(id, at);

    if (written === undefined) {
      throw new NoticeNotFound(id);
    }

    return written;
  }

  /** Everything one request's owner has been told about it, oldest first. */
  async forRequest(actor: Actor, employeeId: string, leaveRequestId: string): Promise<Notice[]> {
    this.guard.enforce(notificationPolicy.read(actor, { employeeId }));

    return (await this.notices.forRequest(leaveRequestId)).filter(
      (notice) => notice.employeeId === employeeId,
    );
  }

  /** Writes the notice down, or records that it could not be. */
  private async write(composed: NewNotice): Promise<Notice | null> {
    try {
      return await this.notices.write(composed);
    } catch (error) {
      this.log.record({
        at: new Date(),
        employeeId: composed.employeeId,
        leaveRequestId: composed.leaveRequestId,
        event: composed.event,
        stage: 'write',
        because: becauseOf(error),
      });

      return null;
    }
  }

  /** Sends it, and stamps what became of that on the row either way. */
  private async email(notice: Notice, to: string): Promise<Told> {
    try {
      await this.mailer.send(noticeEmail(to, notice));
    } catch (error) {
      const because = becauseOf(error);

      this.log.record({
        at: new Date(),
        employeeId: notice.employeeId,
        leaveRequestId: notice.leaveRequestId,
        event: notice.event,
        stage: 'email',
        because,
      });

      return {
        notice: await this.stamp(notice, { failedBecause: because }),
        emailed: false,
        couldNotTell: because,
      };
    }

    return {
      notice: await this.stamp(notice, { sentAt: new Date() }),
      emailed: true,
      couldNotTell: null,
    };
  }

  /** Records the send's outcome, and gives the notice back whether or not that worked. */
  private async stamp(
    notice: Notice,
    outcome: { sentAt: Date } | { failedBecause: string },
  ): Promise<Notice> {
    try {
      return (await this.notices.recordTheEmail(notice.id, outcome)) ?? notice;
    } catch {
      return notice;
    }
  }
}

/** The notice, as an envelope round the message. */
export function noticeEmail(to: string, notice: Notice): Mail {
  return { to, subject: notice.subject, text: notice.body };
}

/** What went wrong, in words, from something that may not be an `Error`. */
function becauseOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
