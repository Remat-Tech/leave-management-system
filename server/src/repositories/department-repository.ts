/** Database access for the department record. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { DepartmentTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import { recording } from './recording.js';
import {
  type Department,
  DuplicateDepartmentName,
  type ValidatedDepartment,
} from '../domain/department.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The index created by the department-rules migration. */
const NAME_INDEX = 'department_name_unique';

type DepartmentRow = Selectable<DepartmentTable>;

export class DepartmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(by: Attribution, record: ValidatedDepartment): Promise<Department> {
    const row = await this.catchRefusals(record, () =>
      recording(this.db, by, (on) =>
        on
          .insertInto('department')
          .values({ name: record.name })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
    );

    return toDepartment(row);
  }

  /** Applies a change. */
  async update(
    by: Attribution,
    id: string,
    changes: Partial<ValidatedDepartment>,
  ): Promise<Department | undefined> {
    // Kysely refuses an UPDATE with no columns, and rightly. Nothing to change
    // is not an error, though, so the record is returned as it stands — and
    // nothing is audited, because nothing happened.
    if (changes.name === undefined) {
      return this.findById(id);
    }

    const row = await this.catchRefusals(changes, () =>
      recording(this.db, by, (on) =>
        on
          .updateTable('department')
          .set({ name: changes.name })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst(),
      ),
    );

    return row === undefined ? undefined : toDepartment(row);
  }

  /** Opens or closes one. */
  async setActive(by: Attribution, id: string, isActive: boolean): Promise<Department | undefined> {
    const row = await recording(this.db, by, (on) =>
      on
        .updateTable('department')
        .set({ is_active: isActive })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toDepartment(row);
  }

  async findById(id: string): Promise<Department | undefined> {
    const row = await this.db
      .selectFrom('department')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toDepartment(row);
  }

  /**
   * By name, compared without regard to case, so that a lookup finds the same single record the unique index would have refused a second of.
   */
  async findByName(name: string): Promise<Department | undefined> {
    const row = await this.db
      .selectFrom('department')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['name']), '=', name.trim().toLowerCase()))
      .executeTakeFirst();

    return row === undefined ? undefined : toDepartment(row);
  }

  /** Every department, closed ones included. */
  async list(options: { openOnly?: boolean } = {}): Promise<Department[]> {
    let query = this.db.selectFrom('department').selectAll();

    if (options.openOnly) {
      query = query.where('is_active', '=', true);
    }

    const rows = await query.orderBy('name').execute();
    return rows.map(toDepartment);
  }

  /** How many people are still employed in a department. FR 06. */
  async activeHeadcount(id: string): Promise<number> {
    const { headcount } = await this.db
      .selectFrom('employee')
      .select((eb) => eb.fn.countAll<string>().as('headcount'))
      .where('department_id', '=', id)
      .where('employment_status', '<>', 'TERMINATED')
      .executeTakeFirstOrThrow();

    // count() comes back as a string, because a count can exceed 2^53 in
    // principle. It cannot here, and a headcount is a number.
    return Number(headcount);
  }

  /** Runs a write and turns the name collision into the domain error for it. */
  private async catchRefusals<T>(
    attempted: { name?: string },
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (uniqueViolationOn(error) === NAME_INDEX) {
        throw new DuplicateDepartmentName(attempted.name ?? '');
      }

      throw error;
    }
  }
}

function uniqueViolationOn(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return code === UNIQUE_VIOLATION && typeof constraint === 'string' ? constraint : undefined;
}

function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
