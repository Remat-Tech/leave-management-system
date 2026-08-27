/**
 * Database access for the employee record.
 *
 * Queries and row mapping, nothing else. The rules about what a valid record
 * looks like are in ../domain/employee.ts and the decisions about when to apply
 * them are in ../services/employee-service.ts.
 *
 * The one piece of judgement here is turning a constraint violation back into
 * something a caller can act on. Checking for a duplicate first and inserting
 * afterwards would be a race — two HR officers creating the same joiner at the
 * same moment both find nothing and both insert — so the insert is attempted and
 * the database's answer is translated. The unique index is what actually decides
 * it, which means the answer is right even under concurrency.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { EmployeeTable } from '../db/schema.js';
import {
  DuplicateEmployeeNumber,
  DuplicateWorkEmail,
  type Employee,
  type EmploymentStatus,
  type EmploymentType,
  type Gender,
  type ReportingLines,
  SecondRootEmployee,
  type ValidatedEmployee,
} from '../domain/employee.js';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** The indexes created by the employee-record-rules migration. */
const NUMBER_INDEX = 'employee_number_unique';
const EMAIL_INDEX = 'employee_work_email_unique';

/** The index created by the line-manager-rules migration. FR 04. */
const ROOT_INDEX = 'employee_one_root';

/** A row as it comes back from a SELECT, with the Generated wrappers resolved. */
type EmployeeRow = Selectable<EmployeeTable>;

export class EmployeeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(record: ValidatedEmployee): Promise<Employee> {
    /* The column is NOT NULL, because everybody works some pattern and counting
       a working day needs to know which. When the caller has not said, the
       default pattern stands in. LMS 106 owns patterns proper; this is only
       enough of it to be able to create an employee at all. */
    const workPatternId = record.workPatternId ?? (await this.defaultWorkPatternId());

    const row = await this.catchCollisions(record, () =>
      this.db
        .insertInto('employee')
        .values({
          employee_number: record.employeeNumber,
          first_name: record.firstName,
          last_name: record.lastName,
          work_email: record.workEmail,
          job_title: record.jobTitle,
          department_id: record.departmentId,
          manager_id: record.managerId,
          work_pattern_id: workPatternId,
          start_date: record.startDate,
          exit_date: record.exitDate,
          employment_type: record.employmentType,
          employment_status: record.employmentStatus,
          gender: record.gender,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );

    return toEmployee(row);
  }

  /**
   * Applies a change. Returns undefined if there is no such employee, which the
   * service turns into {@link EmployeeNotFound}.
   *
   * updated_at is not set here. The trigger does it, so that the seed and a data
   * fixing migration get the same treatment as the application rather than only
   * the writer who remembered.
   */
  async update(id: string, changes: Partial<ValidatedEmployee>): Promise<Employee | undefined> {
    const values = toColumns(changes);

    // Kysely refuses an UPDATE with no columns, and rightly. Nothing to change
    // is not an error, though, so the record is returned as it stands.
    if (Object.keys(values).length === 0) {
      return this.findById(id);
    }

    const row = await this.catchCollisions(changes, () =>
      this.db
        .updateTable('employee')
        .set(values)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst(),
    );

    return row === undefined ? undefined : toEmployee(row);
  }

  async findById(id: string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('employee')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toEmployee(row);
  }

  /**
   * By employee number, compared without regard to case, so that a lookup finds
   * the same single record the unique index would have refused a second of.
   */
  async findByNumber(employeeNumber: string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('employee')
      .selectAll()
      .where((eb) =>
        eb(eb.fn('lower', ['employee_number']), '=', employeeNumber.trim().toLowerCase()),
      )
      .executeTakeFirst();

    return row === undefined ? undefined : toEmployee(row);
  }

  async findByWorkEmail(workEmail: string): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('employee')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['work_email']), '=', workEmail.trim().toLowerCase()))
      .executeTakeFirst();

    return row === undefined ? undefined : toEmployee(row);
  }

  /**
   * Everybody, leavers included.
   *
   * A leaver is still an employee record: FR 06 keeps it, and the leaver figure
   * of FR 37a is calculated from it. Filtering them out by default here would
   * make every caller that genuinely wants them ask specially, which is the
   * wrong way round for a table that is the system's account of who has ever
   * worked here.
   */
  async list(options: { activeOnly?: boolean } = {}): Promise<Employee[]> {
    let query = this.db.selectFrom('employee').selectAll();

    if (options.activeOnly) {
      query = query.where('employment_status', '=', 'ACTIVE');
    }

    const rows = await query.orderBy('employee_number').execute();
    return rows.map(toEmployee);
  }

  /**
   * The employee with no line manager, if there is one. FR 04.
   *
   * Singular because the employee_one_root index makes it so. It is still
   * written as "the first of them, ordered", rather than assuming: an ordered
   * read of a table that momentarily holds two is at least deterministic, which
   * an unordered one is not.
   */
  async findRoot(): Promise<Employee | undefined> {
    const row = await this.db
      .selectFrom('employee')
      .selectAll()
      .where('manager_id', 'is', null)
      .orderBy('employee_number')
      .executeTakeFirst();

    return row === undefined ? undefined : toEmployee(row);
  }

  /**
   * The facts the standing reporting line check is judged from. FR 02 and FR 04.
   *
   * Facts only. What counts as a warning is
   * {@link warnAboutReportingLines} in the domain, so that the judging can be
   * read and tested without a database.
   *
   * A leaver reporting to a leaver is left out deliberately. The warning is
   * about requests having nowhere to go, and somebody who has left is not going
   * to raise one.
   */
  async reportingLines(): Promise<ReportingLines> {
    const [totals, rootless, reports] = await Promise.all([
      this.db
        .selectFrom('employee')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow(),

      this.db
        .selectFrom('employee')
        .selectAll()
        .where('manager_id', 'is', null)
        .orderBy('employee_number')
        .execute(),

      this.db
        .selectFrom('employee as e')
        .innerJoin('employee as m', 'm.id', 'e.manager_id')
        .where('m.employment_status', '=', 'TERMINATED')
        .where('e.employment_status', '<>', 'TERMINATED')
        .selectAll('e')
        .orderBy('e.employee_number')
        .execute(),
    ]);

    /* The managers themselves, in one further statement rather than as a dozen
       aliased columns on the join above. The join has already established that
       every one of these ids is somebody. */
    const managerIds = [
      ...new Set(reports.map((row) => row.manager_id).filter((id) => id !== null)),
    ];

    const managers =
      managerIds.length === 0
        ? []
        : await this.db.selectFrom('employee').selectAll().where('id', 'in', managerIds).execute();

    const byId = new Map(managers.map((row) => [row.id, toEmployee(row)]));

    return {
      // count() comes back as a string, because a count can exceed 2^53 in
      // principle. It cannot here, and a length is a number.
      total: Number(totals.total),
      rootless: rootless.map(toEmployee),
      reportingToLeavers: reports.flatMap((row) => {
        const manager = row.manager_id === null ? undefined : byId.get(row.manager_id);
        return manager === undefined ? [] : [{ employee: toEmployee(row), manager }];
      }),
    };
  }

  private async defaultWorkPatternId(): Promise<string> {
    const pattern = await this.db
      .selectFrom('work_pattern')
      .select('id')
      .where('is_default', '=', true)
      .executeTakeFirst();

    if (pattern === undefined) {
      throw new Error(
        'No default working pattern exists, so a new employee has no week to be ' +
          'measured against. Seed the standard Monday to Friday pattern, or give ' +
          'the employee a pattern explicitly. FR 23.',
      );
    }

    return pattern.id;
  }

  /**
   * Runs a write and turns a unique violation into the domain error for whatever
   * collided.
   *
   * The index name is read from the driver's error rather than guessed from the
   * message text, so the cases are told apart reliably and a violation of some
   * future constraint is re-thrown rather than reported as a duplicate email.
   */
  private async catchCollisions<T>(
    attempted: { employeeNumber?: string; workEmail?: string },
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const constraint = uniqueViolationOn(error);

      if (constraint === NUMBER_INDEX) {
        throw new DuplicateEmployeeNumber(attempted.employeeNumber ?? '');
      }
      if (constraint === EMAIL_INDEX) {
        throw new DuplicateWorkEmail(attempted.workEmail ?? '');
      }
      if (constraint === ROOT_INDEX) {
        /* The service asks before writing, so getting here means two HR officers
           were making a head of the organisation at the same moment and this one
           lost. That is the same race as the two identifiers, answered the same
           way: the index decides, which is what makes the service's earlier check
           safe rather than wishful. Who won is read back so the message can name
           them, which is the answer that check would have given a moment
           earlier. */
        throw new SecondRootEmployee(await this.findRoot());
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

/** Only the fields actually being changed, so an absent one is left alone. */
function toColumns(changes: Partial<ValidatedEmployee>) {
  const values: Record<string, unknown> = {};

  if ('employeeNumber' in changes) values.employee_number = changes.employeeNumber;
  if ('firstName' in changes) values.first_name = changes.firstName;
  if ('lastName' in changes) values.last_name = changes.lastName;
  if ('workEmail' in changes) values.work_email = changes.workEmail;
  if ('jobTitle' in changes) values.job_title = changes.jobTitle;
  if ('departmentId' in changes) values.department_id = changes.departmentId;
  if ('managerId' in changes) values.manager_id = changes.managerId;
  if ('workPatternId' in changes) values.work_pattern_id = changes.workPatternId;
  if ('startDate' in changes) values.start_date = changes.startDate;
  if ('exitDate' in changes) values.exit_date = changes.exitDate;
  if ('employmentType' in changes) values.employment_type = changes.employmentType;
  if ('employmentStatus' in changes) values.employment_status = changes.employmentStatus;
  if ('gender' in changes) values.gender = changes.gender;

  return values;
}

/**
 * A row as the rest of the application wants it.
 *
 * The enumerated columns are `varchar` with a CHECK constraint rather than a
 * Postgres enum type, so the driver hands them back as plain strings. The cast
 * is safe because the constraint is what makes it so: nothing outside those
 * lists can be in the column, whoever wrote it.
 */
function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    employeeNumber: row.employee_number,
    firstName: row.first_name,
    lastName: row.last_name,
    workEmail: row.work_email,
    jobTitle: row.job_title,
    departmentId: row.department_id,
    managerId: row.manager_id,
    workPatternId: row.work_pattern_id,
    startDate: row.start_date,
    exitDate: row.exit_date,
    employmentType: row.employment_type as EmploymentType,
    employmentStatus: row.employment_status as EmploymentStatus,
    gender: row.gender as Gender | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
