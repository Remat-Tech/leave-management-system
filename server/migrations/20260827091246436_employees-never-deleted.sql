-- Up Migration

-- Employees are deactivated, never deleted. FR 06.
--
-- Somebody leaving is a status of TERMINATED and an exit date, not a missing
-- row. The reason is not tidiness: their leave history hangs off their id, and a
-- dispute about a balance settled two years ago is answered by the ledger rows
-- that point at them. Delete the employee and either those rows go too or they
-- point at nobody, and in both cases the answer to "how many days did I actually
-- take in 2026" is gone.
--
-- Two things already made that hard, and both stop short.
--
-- lms_app holds no DELETE on employee, granted that way by the
-- organisation-and-roles migration. That covers the running application and
-- nothing else.
--
-- app_user.employee_id references employee(id) with no cascade, so a person with
-- a login cannot be deleted. That covers only the people who have one, and stops
-- covering them the moment somebody deletes the app_user row first.
--
-- Neither covers the owner connection, which is what migrations, the seed and a
-- person in psql at four in the afternoon all connect as. This migration closes
-- that: a DELETE against employee fails whoever issues it.

-- ------------------------------------------------------------------ the guard

/* Named for the job rather than for this table, the same reasoning as
   set_updated_at(). The Phase 2 ledger and audit tables are append only for the
   same reason this table is, and should attach to this function rather than each
   declaring their own copy of a RAISE. TG_TABLE_NAME is what makes it reusable:
   the message names whichever table the trigger was attached to.

   restrict_violation rather than raise_exception, because that is what this is —
   a delete refused to protect rows that reference it — and a class 23 code lets
   a caller tell it apart from a genuine fault by SQLSTATE instead of by reading
   the message text. */

CREATE FUNCTION refuse_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Rows in % are never deleted.', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation',
              HINT = 'Deactivate the record instead. An employee who has left is '
                     'employment_status = ''TERMINATED'' with an exit_date, which '
                     'keeps their leave history answerable. FR 06.';
END
$$;

CREATE TRIGGER employee_never_deleted
    BEFORE DELETE ON employee
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete();

-- ---------------------------------------------------------------- what is not
--                                                                     blocked

/* TRUNCATE. A row level trigger does not fire on it, and that is left alone
   deliberately rather than overlooked.

   The seed truncates employee to reload the fixture organisation, and blocking
   that would mean the seed could never run twice. It is safe to leave because
   TRUNCATE is a privilege in its own right and lms_app was never granted it: the
   application cannot reach it at all, and the only writers who can are the seed
   and a migration, both of which are deliberate acts by somebody holding the
   owner connection.

   The distinction being drawn is between emptying the table on purpose and
   losing one person's history by accident. It is the second that FR 06 is about.

   Should a hard delete ever genuinely be needed — a record created by a typo on
   its first day, with nothing referencing it — drop this trigger in a migration,
   delete the row, and put the trigger back in the same migration. That is a
   deliberate act with a written reason, which is the whole point. */

-- ---------------------------------------------------------------- privileges

/* No new table and no new grant. The trigger function runs as part of the
   caller's statement and needs no privilege of its own; a DELETE that lms_app
   could not have issued in the first place still fails at the privilege check,
   before this trigger is ever reached. */

-- Down Migration

DROP TRIGGER IF EXISTS employee_never_deleted ON employee;
DROP FUNCTION IF EXISTS refuse_delete();
