/** The daily chase: every pending request, every approver, until somebody decides. FR 50, FR 60, LMS 330. */

import type { Actor } from '../../auth/actor.js';
import { alreadyReminded, daysWaiting } from './reminder.js';
import type {
  AwaitingADecision,
  LeaveRequestService,
} from '../leave-request/leave-request.service.js';
import type { NotificationService } from './notification.service.js';
import { type CalendarDate, calendarDateIn } from '../../shared/time.js';

/** One approver chased about one request. FR 50. */
export interface Reminded {
  leaveRequestId: string;
  /** The approver, not the person whose leave it is. FR 60. */
  employeeId: string;
  /** How long the requester has been waiting for an answer. */
  daysWaiting: number;
  /** FR 59's second channel, false where the mail server refused it. */
  emailed: boolean;
}

/** Why one was not sent. FR 50. */
export type NotRemindedBecause = 'ALREADY_REMINDED_TODAY' | 'NOBODY_IS_AT_THE_DESK';

/** One reminder that did not go, and why. */
export interface NotReminded {
  leaveRequestId: string;
  /** Null where there was nobody to name. */
  employeeId: string | null;
  because: NotRemindedBecause;
}

/** What one run did. */
export interface ApproverReminderRun {
  /** The day the waiting was measured against. NFR DAT 03. */
  asAt: CalendarDate;
  ranAt: Date;
  /** Every request sitting at a desk when the run started. */
  requestsWaiting: number;
  reminded: readonly Reminded[];
  notReminded: readonly NotReminded[];
}

export class DailyApproverReminders {
  constructor(
    /** FR 48, FR 49. What is waiting, and whose answer each is waiting for. */
    private readonly requests: LeaveRequestService,
    /** FR 59. The one thing that writes a notice and sends an email. */
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Reminds every approver of everything still sitting on them. FR 50, the story's first criterion.
   *
   * It decides nothing and moves no day: the only writes are the notice and the email, which
   * is the story's third criterion and is why nothing here reaches `BalanceService`.
   *
   * Once per approver per request per day. A second run in the same day tells nobody twice —
   * `remindersSince` is what makes the job safe to retry after it has half finished.
   */
  async run(actor: Actor, asAt: CalendarDate = this.today()): Promise<ApproverReminderRun> {
    const ranAt = new Date();

    const waiting = await this.requests.everythingAwaitingADecision(actor);
    const sent = await this.notifications.remindersSince(actor, startOfDay(asAt));

    const reminded: Reminded[] = [];
    const notReminded: NotReminded[] = [];

    for (const item of waiting) {
      /* FR 48b. Nobody is at the desk, so this is LMS 320's alert rather than a chase, and a
         reminder addressed to nobody is not written. */
      if (item.approvers.length === 0) {
        notReminded.push({
          leaveRequestId: item.request.id,
          employeeId: null,
          because: 'NOBODY_IS_AT_THE_DESK',
        });
        continue;
      }

      for (const approver of item.approvers) {
        if (alreadyReminded(sent, approver.id, item.request.id)) {
          notReminded.push({
            leaveRequestId: item.request.id,
            employeeId: approver.id,
            because: 'ALREADY_REMINDED_TODAY',
          });
          continue;
        }

        reminded.push(await this.chase(actor, item, approver, asAt));
      }
    }

    return { asAt, ranAt, requestsWaiting: waiting.length, reminded, notReminded };
  }

  /** One reminder, whose failure to send is somebody's quiet morning rather than the run's. */
  private async chase(
    actor: Actor,
    item: AwaitingADecision,
    approver: AwaitingADecision['approvers'][number],
    asAt: CalendarDate,
  ): Promise<Reminded> {
    const told = await this.notifications.remind(actor, {
      approver,
      employee: item.employee,
      request: item.request,
      typeName: item.typeName,
      asAt,
    });

    return {
      leaveRequestId: item.request.id,
      employeeId: approver.id,
      daysWaiting: daysWaiting(item.request, asAt),
      emailed: told.emailed,
    };
  }

  /** The same clock every job here reads. NFR DAT 03. */
  private today(): CalendarDate {
    return calendarDateIn(new Date(), 'UTC');
  }
}

/** Midnight UTC on that day, which is where "already reminded today" starts. NFR DAT 03. */
function startOfDay(day: CalendarDate): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** What one run did, in a sentence, for the log. NFR USA 03. */
export function summaryOf(run: ApproverReminderRun): string {
  const chased = run.reminded.length;
  const quiet = run.notReminded.filter((one) => one.because === 'NOBODY_IS_AT_THE_DESK').length;

  const said =
    `${String(run.requestsWaiting)} requests waiting on ${String(run.asAt)}, ` +
    `${String(chased)} ${chased === 1 ? 'reminder' : 'reminders'} sent.`;

  return quiet === 0
    ? said
    : `${said} ${String(quiet)} ${quiet === 1 ? 'has' : 'have'} nobody at the desk. FR 48b.`;
}
