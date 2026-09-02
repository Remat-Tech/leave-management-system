/**
 * Telling somebody what happened to their leave. FR 59, §7.1. LMS 329.
 *
 * The story is "so that I am not refreshing a screen to find out whether I can book a
 * flight", and this is the file that decides *when* a person finds out. What they are told
 * is ../domain/notification.ts; who may read it afterwards is
 * ../auth/notification-policy.ts; this is the seam between a thing that happened and a
 * person hearing about it.
 *
 * ## After the transaction commits, never inside it
 *
 * The story says so and it is the one rule about this feature that a wrong answer to cannot
 * be recovered from. Two failures follow from getting it backwards, and they are different
 * sizes.
 *
 * **The unrecoverable one.** An email sent inside the transaction that approves leave is an
 * email that goes out and can then be rolled back. A serialisation failure, a deferred
 * constraint firing at COMMIT — `leave_request_takes_its_days` and
 * `leave_request_records_its_decision` both judge there — a connection dropped between the
 * last statement and the commit: any of them leaves the row saying `SUBMITTED` and the
 * person holding a message saying their leave is agreed. There is nothing to send that
 * unsends it, and the person acts on the one they were given.
 *
 * **The one that arrives sooner.** `BalanceService` runs every movement inside
 * `holdStill`, which is a row lock held for the length of the transaction. An SMTP
 * handshake inside it is every other movement on that balance queued behind a mail server,
 * and a mail server that stops answering is a leave system that stops accepting requests.
 *
 * So {@link NotificationService.tell} is called by `LeaveRequestService` **after** the door
 * has returned, from facts on the committed rows, and it holds no transaction of its own —
 * ../repositories/notification-repository.ts declines `recording()` for that reason among
 * others.
 *
 * **The price, stated rather than mitigated.** A process that dies between the COMMIT and
 * the notice loses the notice. That is the right side to be wrong on: the leave record is
 * the truth and the screen shows it, so losing a courtesy is recoverable and telling
 * somebody their leave was approved when it was not is not. The version with a delivery
 * guarantee is an outbox row written *inside* the transaction and drained by a job in
 * `/jobs` — which is a table, a job and a story of its own, and it does not change a line
 * of the composition or the policy when it arrives.
 *
 * ## Nothing here can fail the thing it is describing
 *
 * Every failure is caught, and the method has no throwing path at all. That is the same
 * arrangement `BalanceReconciliation.alert` makes — "caught, because one address that
 * bounces must not stop the other three people being told; carried rather than swallowed,
 * because a discrepancy nobody was told about is the exact situation this job exists to
 * prevent" — and the argument is sharper here.
 *
 * By the time this is called the leave has already been approved. The days are taken, the
 * decision is on the record, the transaction is closed. An exception thrown from here would
 * travel out of `LeaveRequestService.approve` and reach the approver as a failure — for an
 * approval that succeeded, and that no retry can undo. A mail server being down would
 * become leave that appears not to have been decided.
 *
 * So the outcome is **returned** and **logged**, and never raised. {@link Told} is what a
 * caller gets, {@link NoticeLog} is where an operator finds it, and the callers in
 * `LeaveRequestService` deliberately ignore the return value — which is why the log is not
 * optional in the way a return value would be.
 *
 * ## The row first, then the email
 *
 * The in-app notice is the record and the email is a delivery of it, so the row is written
 * first and `emailed_at` is stamped afterwards. Written the other way round, a mail server
 * that accepted the message and a database that then refused the row would leave somebody
 * holding an email about leave their account cannot show them — and no way to answer "what
 * were they actually told" from inside the system.
 *
 * It also means there is an honest moment where a notice exists with a null `emailed_at`,
 * which is exactly what that column has to be able to say.
 *
 * ## Writing a notice is not an authorised act, and reading one is
 *
 * There is no `Actor` on {@link NotificationService.tell} and no policy in front of it,
 * which is the only method in `/services` that can say that. Every other service method
 * takes one because it is somebody making a request of the system; this is the system
 * reporting something it has already done, to the person it happened to, and there is no
 * question for a policy to answer — the act was authorised when it was performed, by the
 * policy that let it happen.
 *
 * Passing an actor in anyway would be worse than useless. It would suggest the notice is
 * sent *by* the approver, which is a thing a future change could act on: an email that
 * appeared to come from a manager is a phishing template with the company's own wording.
 * The system tells you; a person decided.
 *
 * What *is* authorised is reading them afterwards, and
 * {@link notificationPolicy} is deliberately the narrowest rule in `/auth` — see that file
 * for why no role and no reporting line is on it.
 *
 * ## Who is told, and who is not yet
 *
 * FR 59 is what the **requester** is told, which is every method here. The approver whose
 * queue a request lands in is FR 60, is a different recipient, and needs the desk resolved
 * to a person — `leaveRequestPolicy` knows how and this file deliberately does not ask.
 * When it arrives it is another {@link NotificationService.tell} at the same three call
 * sites, with a different employee id, and nothing here changes shape.
 */

import type { Actor } from '../auth/actor.js';
import { notificationPolicy } from '../auth/notification-policy.js';
import type { Guard } from '../auth/policy.js';
import type { ApproverRole } from '../domain/approval-chain.js';
import type { Employee } from '../domain/employee.js';
import type { LeaveRequest } from '../domain/leave-request.js';
import {
  type NewNotice,
  type Notice,
  type NoticeEvent,
  NoticeNotFound,
  noticeOf,
} from '../domain/notification.js';
import type { Mailer } from '../mail/mailer.js';
import type { Mail } from '../mail/transport.js';
import type {
  NoticeListOptions,
  NotificationRepository,
} from '../repositories/notification-repository.js';

/**
 * Everything the system needs to tell one person about one thing that happened.
 *
 * The employee record rather than an id, because two different fields of it are wanted —
 * the first name the message opens with and the work address it goes to — and a caller that
 * had to supply both separately is a caller that can supply a name and somebody else's
 * address.
 *
 * Every other field is a fact read off what the door gave back. See
 * `LeaveRequestService`, which fills these in from the returned request, decision and
 * balance rather than from what it expected them to be.
 */
export interface Telling {
  event: NoticeEvent;
  /** Whose leave it is, which for FR 59 is also who is told. */
  employee: Employee;
  /** The request **as it stands committed**, which is where the desk and status come from. */
  request: LeaveRequest;
  typeName: string;
  /** FR 52. The desk that just decided, or null where nobody did. */
  decidedBy: ApproverRole | null;
  /** FR 39. What the approver said, where they said anything. */
  comment: string | null;
  /** What the person may book now, from the transaction that moved it. */
  availableAfter: number;
}

/**
 * What became of one telling.
 *
 * Three states and all of them are ordinary: the notice was written and the email went, the
 * notice was written and the email did not, or nothing was written at all. A caller that
 * cares reads it; the callers in `LeaveRequestService` do not, and the log is why that is
 * safe.
 */
export interface Told {
  /** The notice as written, or null where even that failed. */
  notice: Notice | null;
  /** FR 59's other channel. False where the message did not leave. */
  emailed: boolean;
  /** What went wrong, in the failing component's own words. Null where nothing did. */
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

/**
 * Where a notice that did not arrive is recorded.
 *
 * The same shape {@link DenialLog} has and for the same reason: the thing that must not
 * happen is a failure disappearing, and the interface is what lets a test read one back
 * rather than watch stderr.
 */
export interface NoticeLog {
  record(failure: UndeliveredNotice): void;
}

/**
 * The default. One JSON line per failure, on stderr.
 *
 * The same form `denialsToStderr` writes and for the same three reasons — JSON because the
 * thing anybody does with these is search them, stderr so it survives a pipe that only
 * takes stdout, and `console.error` because there is no logging library in this tree and
 * choosing one on behalf of the application is not this story's decision.
 */
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
    /**
     * FR 59's second channel.
     *
     * The interface rather than a transport, so this service neither opens an SMTP
     * connection nor knows that nodemailer exists — the same arrangement
     * `SignInService` has for the sign in code and `BalanceReconciliation` for its alert.
     */
    private readonly mailer: Mailer,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * Where an undelivered notice goes.
     *
     * Defaulted, unlike the guard, and the difference is what forgetting costs. A service
     * built without a guard refuses nothing and logs nothing, silently, which is a security
     * hole; a service built without this still writes the notice and still sends the email,
     * and what is lost is visibility of the failures. That is worth a default so the wiring
     * of a new caller cannot be the reason somebody is not told.
     */
    private readonly log: NoticeLog = undeliveredToStderr(),
  ) {}

  /**
   * Tells somebody what happened to their leave, on both channels. FR 59.
   *
   * **Called after the transaction that moved the request has committed, and never inside
   * one.** See the module note, which is the whole argument.
   *
   * **It cannot throw.** Every failure is caught, recorded and returned. By the time this
   * runs the leave has already been approved, refused or withdrawn; an exception from here
   * would surface as a failure of an act that succeeded, and no retry could undo it.
   *
   * The order is the record first and the delivery second: the row is written, then the
   * email is attempted, then what became of it is stamped on the row. A failure at the
   * first stage means nothing was recorded and nothing was sent — {@link Told.notice} is
   * null and the log has it. A failure at the second means the in-app notice is there and
   * the mailbox one is not, which is a person who finds out when they next open the system
   * rather than a person who never finds out.
   *
   * **A failure to stamp the outcome is not a third failure.** It is caught and reported
   * against the send it was describing, because the interesting fact — whether the person
   * was told — is already settled by then, and a message that went out and could not be
   * ticked off is not a message that did not go out.
   */
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

  /**
   * One person's notifications, newest first. FR 59's in-app half.
   *
   * Theirs alone — see ../auth/notification-policy.ts, which is the narrowest rule in
   * `/auth` and argues at length why no role and no reporting line is on it. Refused
   * silently, so a guessed id confirms nothing.
   */
  async forEmployee(
    actor: Actor,
    employeeId: string,
    options: NoticeListOptions = {},
  ): Promise<Notice[]> {
    this.guard.enforce(notificationPolicy.read(actor, { employeeId }));

    return this.notices.forEmployee(employeeId, options);
  }

  /** How many they have not seen. The number on the bell. */
  async unreadCountFor(actor: Actor, employeeId: string): Promise<number> {
    this.guard.enforce(notificationPolicy.read(actor, { employeeId }));

    return this.notices.unreadCountFor(employeeId);
  }

  /**
   * One notice, if it is the actor's own.
   *
   * The notice is read **before** the policy is asked, which is the one place in this
   * system that order is safe and it is worth saying why rather than leaving it to look
   * like a slip. Every other read resolves an owner from a *different* record — an employee
   * row says who the manager is — and the standing can be worked out without touching the
   * thing being protected. A notice carries its own owner and nothing else does, so there
   * is no way to ask the question without the row in hand.
   *
   * Nothing is disclosed by that: the row is read and then either returned or discarded
   * without being described, and {@link NoticeNotFound} and the refusal are both silent
   * about whose it was.
   */
  async byId(actor: Actor, id: string): Promise<Notice> {
    const notice = await this.notices.findById(id);

    if (notice === undefined) {
      throw new NoticeNotFound(id);
    }

    this.guard.enforce(notificationPolicy.read(actor, { employeeId: notice.employeeId }));

    return notice;
  }

  /**
   * Marks one read, or puts it back to unread. FR 59.
   *
   * Only the person it was sent to, which is the same rule as reading it and is asked as
   * its own decision so the denial log says which was attempted.
   *
   * `at` defaults to now and may be null, which is "I have not dealt with this after all" —
   * an ordinary thing to want, and the reason `refuse_rewriting_a_notice()` lets this one
   * column move in both directions.
   */
  async markRead(actor: Actor, id: string, at: Date | null = new Date()): Promise<Notice> {
    const notice = await this.notices.findById(id);

    if (notice === undefined) {
      throw new NoticeNotFound(id);
    }

    this.guard.enforce(notificationPolicy.markRead(actor, { employeeId: notice.employeeId }));

    const written = await this.notices.markRead(id, at);

    /* Unreachable: the row was read a statement ago and `notification_is_never_deleted`
       refuses to remove one on any connection. Answered rather than asserted, because the
       alternative is returning undefined from a method whose type says it does not. */
    if (written === undefined) {
      throw new NoticeNotFound(id);
    }

    return written;
  }

  /**
   * Everything one request's owner has been told about it, oldest first.
   *
   * Decided by the same rule as everything else here — the person's own — rather than by
   * `leaveRequestPolicy.read`, which would admit the line manager and HR. A request's
   * *decisions* are readable by all three, because a decision is the explanation of a
   * status; the messages sent to somebody about it are not, because they carry whether that
   * person has opened them. See ../auth/notification-policy.ts.
   */
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

  /**
   * Records the send's outcome, and gives the notice back whether or not that worked.
   *
   * The one failure in this file that is deliberately not reported anywhere. What it would
   * say is "the message went and the tick did not", and that is a stamp missing from a row
   * rather than a person who was not told — the situation the log exists for. Reporting it
   * would put a line in an operator's stream that reads exactly like a failure to deliver.
   */
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

/**
 * The notice, as an envelope round the message.
 *
 * A pure function beside the service, exactly as `codeEmail` sits beside the code rules in
 * ../auth/mfa.ts and `discrepancyEmail` beside the reconciliation job. Exported so the
 * suite can read what was sent rather than only that something was.
 *
 * **It adds nothing.** The subject and the body are the notice's own, verbatim, which is
 * the property the whole story turns on: the message in the mailbox and the message in the
 * bell are one composition, so they cannot come to disagree about whether leave is agreed.
 * A template here would be the second copy ../domain/notification.ts exists to prevent.
 *
 * No HTML, and no link. Plain text for the reason `codeEmail` gives about links — an email
 * about leave that trains staff to click through to a login page is the template every
 * phishing attempt against this company will use — and because a message whose whole value
 * is one sentence gains nothing from being laid out.
 */
export function noticeEmail(to: string, notice: Notice): Mail {
  return { to, subject: notice.subject, text: notice.body };
}

/** What went wrong, in words, from something that may not be an `Error`. */
function becauseOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
