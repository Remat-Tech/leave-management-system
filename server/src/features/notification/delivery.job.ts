/** Draining the notices whose email did not send. FR 59, §7.1., LMS 331. */

import type { Actor } from '../../auth/actor.js';
import type { DeliveryRun } from './delivery.js';
import type { NotificationService } from './notification.service.js';

export class UndeliveredNotices {
  constructor(
    /** The one thing that sends a notice. It owns the backoff and the record. */
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Sends again everything that is due. FR 59, the story's first criterion.
   *
   * One dependency, which is the story's second criterion in the constructor: it cannot
   * reach a `BalanceService`, a ledger or a transition, so a run that fails every send
   * leaves every business record exactly as it found it. Safe to run again at any time —
   * a notice is claimed before it is sent, so two overlapping runs do not both send it.
   */
  async run(actor: Actor, asAt: Date = new Date()): Promise<DeliveryRun> {
    return this.notifications.retryWhatFailed(actor, asAt);
  }
}
