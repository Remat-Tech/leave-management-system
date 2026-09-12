/** Reading and changing the wording of the emails. FR 61, LMS 512. */

import type { Actor } from '../../auth/actor.js';
import type { Guard } from '../../auth/policy.js';
import { notificationPolicy } from './policy.js';
import {
  ABOUT_EACH_EMAIL,
  EMAILS,
  type EmailName,
  ORIGINAL_WORDING,
  type Placeholder,
  PLACEHOLDER_MEANINGS,
  placeholdersOffered,
  readEmailName,
  validateWording,
  type Wording,
} from './wording.js';
import { previewOf } from './wording-preview.js';
import type { EmailWordingRepository, SavedWording } from './wording.db.js';

/** One email as the screen needs it. */
export interface EmailWording {
  name: EmailName;
  label: string;
  readBy: string;
  /** What is sent now. */
  wording: Wording;
  original: Wording;
  isReworded: boolean;
  /** When HR last changed it, null where it is the original. */
  updatedAt: Date | null;
  placeholders: { name: Placeholder; meaning: string }[];
}

export class EmailWordingService {
  constructor(
    private readonly saved: EmailWordingRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** Every email, in the words it is sent in. */
  async list(actor: Actor): Promise<EmailWording[]> {
    this.guard.enforce(notificationPolicy.readWording(actor));

    const reworded = await this.saved.all();

    return EMAILS.map((name) =>
      emailWordingOf(
        name,
        reworded.find((one) => one.name === name),
      ),
    );
  }

  /** Rewords one email. The next one sent uses it; nothing already sent changes. */
  async reword(
    actor: Actor,
    name: unknown,
    wording: { subject?: unknown; body?: unknown },
  ): Promise<EmailWording> {
    const email = readEmailName(name);

    this.guard.enforce(notificationPolicy.changeWording(actor, email));

    return emailWordingOf(
      email,
      await this.saved.save(actor, email, validateWording(email, wording)),
    );
  }

  /** Puts one email back to its original wording. */
  async putBack(actor: Actor, name: unknown): Promise<EmailWording> {
    const email = readEmailName(name);

    this.guard.enforce(notificationPolicy.changeWording(actor, email));

    await this.saved.putBack(actor, email);

    return emailWordingOf(email, undefined);
  }

  /** What the email would say on a made up request, without saving anything. */
  async preview(
    actor: Actor,
    name: unknown,
    wording: { subject?: unknown; body?: unknown },
  ): Promise<Wording> {
    const email = readEmailName(name);

    this.guard.enforce(notificationPolicy.readWording(actor));

    return previewOf(email, validateWording(email, wording));
  }
}

function emailWordingOf(name: EmailName, saved: SavedWording | undefined): EmailWording {
  return {
    name,
    ...ABOUT_EACH_EMAIL[name],
    wording:
      saved === undefined ? ORIGINAL_WORDING[name] : { subject: saved.subject, body: saved.body },
    original: ORIGINAL_WORDING[name],
    isReworded: saved !== undefined,
    updatedAt: saved?.updatedAt ?? null,
    placeholders: placeholdersOffered(name).map((placeholder) => ({
      name: placeholder,
      meaning: PLACEHOLDER_MEANINGS[placeholder],
    })),
  };
}
