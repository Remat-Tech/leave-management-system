/** Database access for the organisation's own settings. FR 48c, §4.3.1, LMS 321. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { OrganisationSettingTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import type { Employee } from '../employee/employee.js';
import {
  ChiefExecutiveCannotBeCleared,
  ChiefExecutiveHasLeft,
  ChiefExecutiveNotFound,
  type OrganisationSettings,
} from './organisation.js';
import { recording } from '../../db/recording.js';

/** Postgres `foreign_key_violation`, which an id that is nobody's raises. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Postgres `restrict_violation`, which both of this table's triggers raise. */
const RESTRICT_VIOLATION = '23001';

const IS_HERE = 'organisation_setting_names_somebody_who_is_here';
const KEEPS_ONE = 'organisation_setting_keeps_a_chief_executive';

type SettingRow = Selectable<OrganisationSettingTable>;

export class OrganisationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Who the `CEO` desk resolves to, or null. FR 48c, FR 38a.
   *
   * The one read both `LeaveRequestService` and `ApproverQueueService` go through, so the
   * queue and the approve door cannot disagree. It was `EmployeeRepository.findRoot` until
   * LMS 321. Null covers both nobody named and no row at all.
   */
  async chiefExecutiveId(): Promise<string | null> {
    const row = await this.db
      .selectFrom('organisation_setting')
      .select('ceo_employee_id')
      .executeTakeFirst();

    return row?.ceo_employee_id ?? null;
  }

  /** The settings as they stand, or undefined on a database nothing has configured. */
  async settings(): Promise<OrganisationSettings | undefined> {
    const row = await this.db.selectFrom('organisation_setting').selectAll().executeTakeFirst();

    return row === undefined ? undefined : toSettings(row);
  }

  /**
   * Names the Chief Executive. FR 48c.
   *
   * An update of the one row the migration writes. The insert is the unreachable case
   * answered rather than assumed: a database restored from before this migration would
   * otherwise refuse every attempt to configure it.
   *
   * It takes the record rather than an id so a refusal can name the person.
   */
  async nameTheChiefExecutive(by: Attribution, employee: Employee): Promise<OrganisationSettings> {
    return this.catchRefusals(employee, async () => {
      const updated = await recording(this.db, by, (on) =>
        on
          .updateTable('organisation_setting')
          .set({ ceo_employee_id: employee.id })
          .returningAll()
          .executeTakeFirst(),
      );

      if (updated !== undefined) {
        return toSettings(updated);
      }

      const inserted = await recording(this.db, by, (on) =>
        on
          .insertInto('organisation_setting')
          .values({ ceo_employee_id: employee.id })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toSettings(inserted);
    });
  }

  /** Turns what the database refused a write for into the domain error for that refusal. */
  private async catchRefusals<T>(employee: Employee, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);

      if (violation?.code === FOREIGN_KEY_VIOLATION) {
        throw new ChiefExecutiveNotFound(employee.id);
      }

      if (violation?.code === RESTRICT_VIOLATION && violation.constraint === IS_HERE) {
        throw new ChiefExecutiveHasLeft(employee);
      }

      if (violation?.code === RESTRICT_VIOLATION && violation.constraint === KEEPS_ONE) {
        throw new ChiefExecutiveCannotBeCleared();
      }

      throw error;
    }
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the other repositories', and separate for the same reason: no repository
 * imports another.
 */
function violationOf(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return typeof code === 'string' && typeof constraint === 'string'
    ? { code, constraint }
    : undefined;
}

function toSettings(row: SettingRow): OrganisationSettings {
  return {
    chiefExecutiveId: row.ceo_employee_id,
    updatedAt: row.updated_at,
  };
}
