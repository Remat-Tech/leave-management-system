/** Database access for the working pattern. FR 23. */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../../db/index.js';
import type { WorkPatternDayTable, WorkPatternTable } from '../../db/schema.js';
import type { Attribution } from '../audit/audit.js';
import { recording } from '../../db/recording.js';
import {
  DefaultWorkPatternRequired,
  DuplicateWorkPatternName,
  InvalidWorkPattern,
  SecondDefaultWorkPattern,
  type ValidatedWorkPattern,
  type Weekday,
  type WorkPattern,
  WorkPatternInUse,
  weekOf,
  workingDaysOf,
} from './work-pattern.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Postgres `foreign_key_violation`, which is what an employee on the pattern raises. */
const FOREIGN_KEY_VIOLATION = '23503';

/** Postgres `check_violation`, which is what both deferred triggers raise. */
const CHECK_VIOLATION = '23514';

/** The index and constraints created by the working-pattern-rules migration. */
const NAME_INDEX = 'work_pattern_name_unique';
const DEFAULT_INDEX = 'work_pattern_one_default';
const DEFAULT_EXISTS = 'work_pattern_always_has_a_default';
const WEEK_COMPLETE = 'work_pattern_week_complete';

/** The key from the organisation migration, which employee rows hold this pattern by. */
const EMPLOYEE_PATTERN_KEY = 'employee_work_pattern_id_fkey';

type WorkPatternRow = Selectable<WorkPatternTable>;
type WorkPatternDayRow = Selectable<WorkPatternDayTable>;

export class WorkPatternRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** The pattern and its seven days, or neither. */
  async create(by: Attribution, record: ValidatedWorkPattern): Promise<WorkPattern> {
    return this.catchRefusals(record, () =>
      recording(this.db, by, async (trx) => {
        const row = await trx
          .insertInto('work_pattern')
          .values({ name: record.name })
          .returningAll()
          .executeTakeFirstOrThrow();

        await this.writeWeek(trx, row.id, record.workingDays);

        return { ...toWorkPattern(row), workingDays: [...record.workingDays] };
      }),
    );
  }

  /** Applies a change. */
  async update(
    by: Attribution,
    id: string,
    changes: Partial<ValidatedWorkPattern>,
  ): Promise<WorkPattern | undefined> {
    if (changes.name === undefined && changes.workingDays === undefined) {
      // Nothing to change is not an error. It is a form somebody submitted
      // without touching it, and the record should come back as it stands.
      return this.findById(id);
    }

    return this.catchRefusals(changes, () =>
      recording(this.db, by, async (trx) => {
        const row = await trx
          .updateTable('work_pattern')
          .set((eb) => ({ name: changes.name === undefined ? eb.ref('name') : changes.name }))
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();

        if (row === undefined) {
          return undefined;
        }

        if (changes.workingDays !== undefined) {
          await trx.deleteFrom('work_pattern_day').where('work_pattern_id', '=', id).execute();
          await this.writeWeek(trx, id, changes.workingDays);
        }

        return {
          ...toWorkPattern(row),
          workingDays: changes.workingDays ? [...changes.workingDays] : await this.weekFor(trx, id),
        };
      }),
    );
  }

  /** Makes one pattern the default, and unmakes whichever was. */
  async makeDefault(by: Attribution, id: string): Promise<WorkPattern | undefined> {
    return this.catchRefusals({}, () =>
      recording(this.db, by, async (trx) => {
        await trx
          .updateTable('work_pattern')
          .set({ is_default: false })
          .where('is_default', '=', true)
          .where('id', '<>', id)
          .execute();

        const row = await trx
          .updateTable('work_pattern')
          .set({ is_default: true })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirst();

        return row === undefined
          ? undefined
          : { ...toWorkPattern(row), workingDays: await this.weekFor(trx, id) };
      }),
    );
  }

  /** Deletes one. */
  async remove(by: Attribution, id: string): Promise<boolean> {
    try {
      const result = await recording(this.db, by, (on) =>
        on.deleteFrom('work_pattern').where('id', '=', id).executeTakeFirst(),
      );

      return (result.numDeletedRows ?? 0n) > 0n;
    } catch (error) {
      const violation = violationOf(error);

      if (
        violation?.code === FOREIGN_KEY_VIOLATION &&
        violation.constraint === EMPLOYEE_PATTERN_KEY
      ) {
        const pattern = await this.findById(id);
        if (pattern !== undefined) {
          throw new WorkPatternInUse(pattern, await this.headcount(id));
        }
      }

      throw this.translate(error, {});
    }
  }

  async findById(id: string): Promise<WorkPattern | undefined> {
    const row = await this.db
      .selectFrom('work_pattern')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { ...toWorkPattern(row), workingDays: await this.weekFor(this.db, id) };
  }

  /**
   * By name, compared without regard to case, so that a lookup finds the same single record the unique index would have refused a second of.
   */
  async findByName(name: string): Promise<WorkPattern | undefined> {
    const row = await this.db
      .selectFrom('work_pattern')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['name']), '=', name.trim().toLowerCase()))
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { ...toWorkPattern(row), workingDays: await this.weekFor(this.db, row.id) };
  }

  /** The default pattern, which every database has exactly one of. */
  async findDefault(): Promise<WorkPattern | undefined> {
    const row = await this.db
      .selectFrom('work_pattern')
      .selectAll()
      .where('is_default', '=', true)
      .orderBy('id')
      .executeTakeFirst();

    return row === undefined
      ? undefined
      : { ...toWorkPattern(row), workingDays: await this.weekFor(this.db, row.id) };
  }

  /** Every pattern, with its week, ordered so the default comes first. */
  async list(): Promise<WorkPattern[]> {
    const rows = await this.db
      .selectFrom('work_pattern')
      .selectAll()
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .execute();

    if (rows.length === 0) {
      return [];
    }

    const days = await this.db
      .selectFrom('work_pattern_day')
      .selectAll()
      .where(
        'work_pattern_id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();

    const byPattern = new Map<string, WorkPatternDayRow[]>();
    for (const day of days) {
      byPattern.set(day.work_pattern_id, [...(byPattern.get(day.work_pattern_id) ?? []), day]);
    }

    return rows.map((row) => ({
      ...toWorkPattern(row),
      workingDays: toWorkingDays(byPattern.get(row.id) ?? []),
    }));
  }

  /** How many employee records are on a pattern. FR 37a. */
  async headcount(id: string): Promise<number> {
    const { headcount } = await this.db
      .selectFrom('employee')
      .select((eb) => eb.fn.countAll<string>().as('headcount'))
      .where('work_pattern_id', '=', id)
      .executeTakeFirstOrThrow();

    // count() comes back as a string, because a count can exceed 2^53 in
    // principle. It cannot here, and a headcount is a number.
    return Number(headcount);
  }

  /** The seven rows a week is stored as. */
  private async writeWeek(
    trx: Kysely<Database>,
    id: string,
    workingDays: readonly Weekday[],
  ): Promise<void> {
    await trx
      .insertInto('work_pattern_day')
      .values(
        weekOf(workingDays).map((day) => ({
          work_pattern_id: id,
          day_of_week: day.dayOfWeek,
          is_working_day: day.isWorkingDay,
        })),
      )
      .execute();
  }

  private async weekFor(db: Kysely<Database>, id: string) {
    const days = await db
      .selectFrom('work_pattern_day')
      .selectAll()
      .where('work_pattern_id', '=', id)
      .execute();

    return toWorkingDays(days);
  }

  /**
   * Runs a write and turns whatever the database refused it for into the domain error for that refusal.
   */
  private async catchRefusals<T>(
    attempted: { name?: string },
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      throw this.translate(error, attempted);
    }
  }

  private translate(error: unknown, attempted: { name?: string }): unknown {
    const violation = violationOf(error);

    if (violation?.code === UNIQUE_VIOLATION) {
      if (violation.constraint === NAME_INDEX) {
        return new DuplicateWorkPatternName(attempted.name ?? '');
      }
      if (violation.constraint === DEFAULT_INDEX) {
        return new SecondDefaultWorkPattern();
      }
    }

    if (violation?.code === CHECK_VIOLATION) {
      if (violation.constraint === DEFAULT_EXISTS) {
        return new DefaultWorkPatternRequired();
      }
      if (violation.constraint === WEEK_COMPLETE) {
        return new InvalidWorkPattern(
          'workingDays',
          error instanceof Error ? error.message : 'The pattern does not name a whole week.',
        );
      }
    }

    return error;
  }
}

/** The SQLSTATE and constraint name of a refusal, when the error carries both. */
function violationOf(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return typeof code === 'string' && typeof constraint === 'string'
    ? { code, constraint }
    : undefined;
}

function toWorkingDays(days: readonly WorkPatternDayRow[]): Weekday[] {
  return workingDaysOf(
    days.map((day) => ({ dayOfWeek: day.day_of_week, isWorkingDay: day.is_working_day })),
  );
}

/** The pattern row itself. */
function toWorkPattern(row: WorkPatternRow): Omit<WorkPattern, 'workingDays'> {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
