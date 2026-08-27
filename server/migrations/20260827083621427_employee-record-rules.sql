-- Up Migration

-- The employee record. FR 01 and FR 05.
--
-- The columns arrived with the organisation migration, which listed the values
-- each enumerated one may hold in a trailing comment. A comment is a note to the
-- next reader, not a constraint: nothing stopped an employment_status of
-- 'Active', 'active' or 'Marseille' being written and then quietly failing every
-- comparison against 'ACTIVE' thereafter. This migration turns those comments
-- into rules the database keeps.
--
-- Everything here is a tightening of an existing column. No column is added and
-- none changes type, so the fixture set and anything already written continue to
-- apply.

-- ---------------------------------------------------------------- the values

/* Permitted values, matching the unions in server/src/domain/employee.ts. The
   two lists are asserted against each other in the integration tests, so adding
   a value in one place and forgetting the other fails the build rather than
   production. */

ALTER TABLE employee
    ADD CONSTRAINT employee_employment_type_known
        CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN')),

    ADD CONSTRAINT employee_employment_status_known
        CHECK (employment_status IN ('ACTIVE', 'SUSPENDED', 'TERMINATED')),

    /* FR 05. Optional, and read by exactly one thing: the eligibility check for
       the leave types that differ by it, which today means maternity and
       paternity. NULL is "not recorded" and is the resting state of the column;
       nobody is required to declare one to be paid or to book annual leave. */
    ADD CONSTRAINT employee_gender_known
        CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE'));

-- ----------------------------------------------------------------- the dates

/* A terminated record has to say when. FR 06 keeps the record rather than
   deleting it, and FR 37a calculates a leaver's final figure from the exit date,
   so a status of TERMINATED with no date is a record that cannot be settled.

   The converse is deliberately not enforced. An exit date on an ACTIVE record is
   somebody serving notice, which is a normal thing to have recorded in advance.

   employee_exit_after_start already forbids leaving before arriving. */

ALTER TABLE employee
    ADD CONSTRAINT employee_terminated_has_exit_date
        CHECK (employment_status <> 'TERMINATED' OR exit_date IS NOT NULL);

-- ------------------------------------------------------------- the text bits

/* NOT NULL says a value was supplied. It does not say the value means anything,
   and an empty string satisfies it: a first_name of '' is a record that has a
   name everywhere in the code and shows nothing on every screen. Blank is
   forbidden rather than silently converted, because a caller sending one has a
   bug and should hear about it.

   job_title stays nullable. FR 01 lists it as a field of the record, not as
   something that must be known the moment the record is created. */

ALTER TABLE employee
    ADD CONSTRAINT employee_number_not_blank      CHECK (btrim(employee_number) <> ''),
    ADD CONSTRAINT employee_first_name_not_blank  CHECK (btrim(first_name) <> ''),
    ADD CONSTRAINT employee_last_name_not_blank   CHECK (btrim(last_name) <> ''),
    ADD CONSTRAINT employee_work_email_not_blank  CHECK (btrim(work_email) <> ''),
    ADD CONSTRAINT employee_job_title_not_blank   CHECK (job_title IS NULL OR btrim(job_title) <> '');

-- ----------------------------------------------------------- the identifiers

/* Employee number and work email are unique, and unique without regard to case.
   A plain UNIQUE compares byte for byte, which makes RH-0007 and rh-0007 two
   different employees and kwame.asante@ and Kwame.Asante@ two different people.
   Neither is true of the things being recorded: nobody has ever been issued a
   second staff number that differs from their first only in capitals, and no
   mail server treats those two addresses as separate mailboxes.

   The value is stored as it was typed and compared folded, rather than folded on
   the way in, so that a staff number keeps the shape HR uses on paper.

   Dropping the original constraint drops its index with it, so the replacement
   is created first and the table is never left without one. */

CREATE UNIQUE INDEX employee_number_unique ON employee (lower(employee_number));
ALTER TABLE employee DROP CONSTRAINT employee_employee_number_key;

CREATE UNIQUE INDEX employee_work_email_unique ON employee (lower(work_email));
ALTER TABLE employee DROP CONSTRAINT employee_work_email_key;

-- -------------------------------------------------------------- maintenance

/* updated_at defaulted to now() on insert and then never moved again, so every
   record claimed to have been last touched when it was created. Maintaining a
   record is half of what this story is for, and "when did this last change" is
   the first question asked of a record that looks wrong.

   The trigger rather than the application, because there is more than one writer:
   the application, the seed, and a migration correcting data are all capable of
   an UPDATE, and only one of them would have remembered.

   Named for the job rather than for this table. The leave tables of Phase 2 want
   the same behaviour and should reuse this function rather than each declaring
   their own copy of two lines of plpgsql. */

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$$;

CREATE TRIGGER employee_set_updated_at
    BEFORE UPDATE ON employee
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. lms_app already holds SELECT and INSERT from
   the default privileges and the UPDATE that the organisation migration granted
   explicitly, and still holds no DELETE on employee, which is what makes FR 06's
   "deactivated, never deleted" a fact about the database rather than a promise
   about the code. */

-- Down Migration

DROP TRIGGER IF EXISTS employee_set_updated_at ON employee;
DROP FUNCTION IF EXISTS set_updated_at();

ALTER TABLE employee ADD CONSTRAINT employee_work_email_key UNIQUE (work_email);
DROP INDEX IF EXISTS employee_work_email_unique;

ALTER TABLE employee ADD CONSTRAINT employee_employee_number_key UNIQUE (employee_number);
DROP INDEX IF EXISTS employee_number_unique;

ALTER TABLE employee
    DROP CONSTRAINT IF EXISTS employee_job_title_not_blank,
    DROP CONSTRAINT IF EXISTS employee_work_email_not_blank,
    DROP CONSTRAINT IF EXISTS employee_last_name_not_blank,
    DROP CONSTRAINT IF EXISTS employee_first_name_not_blank,
    DROP CONSTRAINT IF EXISTS employee_number_not_blank,
    DROP CONSTRAINT IF EXISTS employee_terminated_has_exit_date,
    DROP CONSTRAINT IF EXISTS employee_gender_known,
    DROP CONSTRAINT IF EXISTS employee_employment_status_known,
    DROP CONSTRAINT IF EXISTS employee_employment_type_known;
