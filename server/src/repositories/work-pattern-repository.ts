/**
 * Database access for the working pattern. FR 23.
 *
 * Queries and row mapping, nothing else. The rules about what a valid pattern
 * looks like are in ../domain/work-pattern.ts and the decisions about when to
 * apply them are in ../services/work-pattern-service.ts.
 *
 * Two pieces of judgement live here rather than above.
 *
 * A pattern is two tables and is written as one thing. Every write that touches
 * the week opens a transaction, because a pattern row without its seven day rows
 * is not a half written pattern, it is a pattern that answers "is this Saturday
 * worked" with nothing. The work_pattern_week_complete trigger is deferred so
 * that the intermediate state inside those transactions is nobody's business,
 * which is the whole reason it can be deferred and the whole reason this is safe.
 *
 * Refusals are translated rather than allowed to surface. Checking first and
 * writing afterwards would be a race — two HR admins making two different
 * patterns the default at the same moment both find the old one and both set
 * theirs — so the write is attempted and the database's answer is turned back
 * into the domain error for it. The index and the triggers are what actually
 * decide, which makes the answer right even under concurrency.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { WorkPatternDayTable, WorkPatternTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import { recording } from './recording.js';
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
} from '../domain/work-pattern.js';

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

  /**
   * Applies a change. Returns undefined if there is no such pattern, which the
   * service turns into {@link WorkPatternNotFound}.
   *
   * A new week replaces the old one outright — seven rows deleted, seven
   * written — rather than being reconciled day by day. There is nothing to
   * preserve in a day row and no history kept in one; the pattern's history is
   * `updated_at` on the row above it, which the trigger maintains.
   *
   * updated_at is not set here for the same reason it is not set in the other
   * repositories: the trigger does it, so the seed and a data fixing migration
   * get the same treatment as the application rather than only the writer who
   * remembered. A change to the week alone still moves it, because the pattern
   * row is touched deliberately below.
   */
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
        /* Touched even when only the week changed, so that updated_at moves: the
           question "when did this pattern last change" is asked of a pattern
           producing a day count somebody disputes, and the days are the part
           most likely to be behind it. */
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

  /**
   * Makes one pattern the default, and unmakes whichever was.
   *
   * The order is forced by the database and is worth knowing before it is needed:
   * work_pattern_one_default is an immediate unique index, so two defaults are
   * refused the moment the second is written, and the old one has to be cleared
   * first. That leaves the table with no default at all for the length of one
   * statement, which the work_pattern_always_has_a_default trigger permits only
   * because it is deferred to COMMIT. Both halves therefore have to be one
   * transaction; run as two statements they fail whichever way round they are put.
   *
   * Returns undefined if there is no such pattern.
   */
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

  /**
   * Deletes one. The day rows go with it, by the cascade on the foreign key.
   *
   * Deleting rather than deactivating is the ending a pattern has, and the
   * working-pattern-rules migration says why it differs from a department there.
   * What is reachable is the pattern nobody works: the foreign key holds every
   * pattern somebody is on, leavers included, and the trigger holds the default.
   *
   * Returns false if there was no such pattern, so that deleting one twice is
   * answered rather than mistaken for success.
   */
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
        /* Somebody was moved onto it between the service's check and this
           statement. Both facts are read back so the message can say whose
           pattern it now is, which is the answer the check would have given a
           moment earlier. */
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
   * By name, compared without regard to case, so that a lookup finds the same
   * single record the unique index would have refused a second of.
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

  /**
   * The default pattern, which every database has exactly one of.
   *
   * Still written as "the first of them, ordered" rather than assuming, for the
   * reason {@link EmployeeRepository.findRoot} is: an ordered read of a table
   * that momentarily holds two is at least deterministic, and an unordered one is
   * not.
   */
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

    /* One statement for every pattern's days rather than one per pattern. The
       database is usually a Neon branch at the end of a network, where the round
       trip costs far more than the work. */
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

  /**
   * How many employee records are on a pattern.
   *
   * Leavers included, deliberately, unlike a department's headcount. FR 37a
   * settles a leaver's final figure by counting days against the week they
   * worked, so their pattern is still load bearing after they have gone — and the
   * foreign key counts them too, whatever this says.
   */
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
   * Runs a write and turns whatever the database refused it for into the domain
   * error for that refusal.
   *
   * The constraint name is read from the driver's error rather than guessed from
   * the message text, so a violation of some future constraint is re-thrown
   * rather than reported as a duplicate name. The two triggers name themselves in
   * what they raise, which is what makes them tellable apart here.
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
        /* Two admins making two different patterns the default at once. The
           loser's transaction cleared nothing — the row it meant to clear was
           already the winner's to clear — and then wrote a second default. */
        return new SecondDefaultWorkPattern();
      }
    }

    if (violation?.code === CHECK_VIOLATION) {
      if (violation.constraint === DEFAULT_EXISTS) {
        return new DefaultWorkPatternRequired();
      }
      if (violation.constraint === WEEK_COMPLETE) {
        /* Reachable only from outside this repository — every write here sends a
           whole week — so it is reported as what it is rather than dressed up. */
        return new InvalidWorkPattern(
          'workingDays',
          error instanceof Error ? error.message : 'The pattern does not name a whole week.',
        );
      }
    }

    return error;
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the employee repository's, and separate from it for the same
 * reason the two repositories are separate: neither imports the other, and a
 * shared copy of six lines would be the first thing to grow a parameter.
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

function toWorkingDays(days: readonly WorkPatternDayRow[]): Weekday[] {
  return workingDaysOf(
    days.map((day) => ({ dayOfWeek: day.day_of_week, isWorkingDay: day.is_working_day })),
  );
}

/** The pattern row itself. The week is read separately and merged by the caller. */
function toWorkPattern(row: WorkPatternRow): Omit<WorkPattern, 'workingDays'> {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
