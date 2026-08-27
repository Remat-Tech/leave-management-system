-- Up Migration

-- Working patterns, and the standard week every database starts with. FR 23.
--
-- The two tables arrived with the organisation migration carrying a comment —
-- "Which weekdays this pattern works. Drives working day counts for annual, sick
-- and compassionate leave" — and nothing else. No pattern was created by
-- anything but the seed, no rule said what a pattern had to contain, and the
-- default the employee record needs existed only in fixture data.
--
-- That last part is the one that bites. employee.work_pattern_id is NOT NULL, so
-- creating an employee has to resolve a pattern, and the only one on offer came
-- from `npm run seed`. A production database is migrated and never seeded, which
-- made "create the first employee" fail on an empty work_pattern table. The
-- standard Monday to Friday week is therefore reference data and is inserted
-- here, next to `role`, rather than in the fixture set.
--
-- The rest of this migration is what a pattern has to be for a day count to mean
-- anything: a name that identifies it, all seven days named, at least one of them
-- worked, and exactly one pattern marked as the default.

-- ------------------------------------------------------------------ the name

/* A pattern is picked out of a list by its name, so it carries the same two
   rules the department name carries and for the same reasons: not blank, because
   NOT NULL says a value arrived and not that it means anything, and unique
   without regard to case, because 'Standard Mon-Fri' and 'standard mon-fri' are
   one pattern to everybody except a byte comparison.

   Stored as typed, compared folded, so 'Part time, Wednesdays off' keeps its
   shape on the screen where somebody picks it.

   Dropping the original constraint drops its index with it, so the replacement
   is created first and the table is never left without one. */

ALTER TABLE work_pattern
    ADD CONSTRAINT work_pattern_name_not_blank CHECK (btrim(name) <> '');

CREATE UNIQUE INDEX work_pattern_name_unique ON work_pattern (lower(name));
ALTER TABLE work_pattern DROP CONSTRAINT work_pattern_name_key;

-- --------------------------------------------------------------- maintenance

/* The table had neither timestamp, which was right while nothing wrote to it but
   the seed. Editing a pattern is part of this story — a team moves its half day
   from Wednesday to Friday and the pattern is corrected rather than replaced, so
   that the employees pointing at it move with it — and "when did this last
   change" is the first question asked of a pattern that is producing a day count
   somebody disputes.

   set_updated_at() is reused rather than copied, as the department-rules
   migration reused it. Both columns are added with a default, so the rows already
   there get an honest value rather than a NULL every reader has to guard.

   work_pattern_day gets neither. A day row is not edited in its own right: it is
   half of a week, replaced wholesale when the week changes, and its history is
   the pattern's. */

ALTER TABLE work_pattern
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TRIGGER work_pattern_set_updated_at
    BEFORE UPDATE ON work_pattern
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------ exactly one default

/* At most one pattern may be the default, held the same way FR 04 holds the one
   employee with no line manager: a unique index whose key is the constant true,
   so every row marked default indexes under the same key and the second collides
   with the first, and whose partial predicate keeps that from applying to any
   other row.

   A CHECK cannot express it. "At most one row in the table" is a statement about
   the table, and a CHECK sees one row.

   The index is immediate rather than deferrable, which makes changing the default
   an ordered pair of statements exactly as succession is: clear the old one
   first, taking the table to no default at all, and set the new one second.
   Doing it the other way round means two defaults for the length of a statement
   and is refused. The trigger below is what makes the intermediate state
   survivable — it is deferred, so "no default" is nobody's business until
   COMMIT. */

CREATE UNIQUE INDEX work_pattern_one_default ON work_pattern ((true)) WHERE is_default;

/* And never fewer than one, which the index cannot say.

   A database with no default pattern is one where no employee can be created:
   the column is NOT NULL and the caller does not have to name a pattern, so
   something has to stand in, and the standard week is what stands in. Losing it
   is not noticed by whoever deleted the row; it is noticed by the HR officer
   adding a joiner on a Monday morning.

   Deferred, and for the same reason the cycle trigger is: the legitimate change
   this rule would otherwise refuse is the ordinary one. Making a different
   pattern the default passes through zero defaults for one statement, and a rule
   checked per statement would refuse the very operation it exists to protect.
   Checked at commit, only the state that will actually be stored is judged.

   TRUNCATE is not covered, as with employee_never_deleted, because a row trigger
   does not fire on it. That is left alone rather than overlooked: lms_app holds
   no TRUNCATE, so the only writer who can reach it holds the owner connection
   and is emptying the table on purpose. */

CREATE FUNCTION refuse_default_work_pattern_loss() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM work_pattern WHERE is_default) THEN
        RAISE EXCEPTION 'No working pattern is marked as the default.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'work_pattern_always_has_a_default',
                  HINT = 'Every employee record needs a working pattern and a caller '
                         'need not name one, so one pattern has to stand in. Mark '
                         'another pattern as the default in the same transaction. FR 23.';
    END IF;

    -- AFTER trigger. The return value is discarded; this either lets the
    -- transaction stand or has raised above.
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER work_pattern_always_has_a_default
    AFTER INSERT OR UPDATE OF is_default OR DELETE ON work_pattern
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_default_work_pattern_loss();

-- ----------------------------------------------------------- a complete week

/* Every pattern names all seven days, and works at least one of them.

   The first is about the shape of the count that Phase 2 will do. A pattern
   holding rows for Monday to Friday and nothing for Saturday and Sunday looks
   complete and is not: whether a Saturday inside a leave request costs a day
   then depends on whether the query counting them uses a join or an outer join,
   which is a decision nobody made on purpose. Seven rows means the answer is in
   the data rather than in the query, and is_working_day carries it.

   The second is about entitlement rather than counting. A pattern with no
   working day at all is somebody whose leave costs nothing, whose pro rated
   entitlement divides by zero, and who appears on no team calendar. It is not a
   working pattern; it is somebody who has left, and that is employment_status.

   Deferred, because the operation this would otherwise refuse is the ordinary
   one. Changing a week is a delete of the seven day rows and an insert of seven
   more, and between those two statements the pattern names no days at all. The
   final state is what matters, and at COMMIT that is the only state there is.

   The check fires from both tables, because either can break it: dropping a day
   row leaves six, and inserting a pattern with no day rows leaves none. */

CREATE FUNCTION refuse_incomplete_work_pattern() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    pattern_id BIGINT;
    pattern    TEXT;
    named      INT;
    worked     INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        pattern_id := OLD.work_pattern_id;
    ELSIF TG_TABLE_NAME = 'work_pattern' THEN
        pattern_id := NEW.id;
    ELSE
        pattern_id := NEW.work_pattern_id;
    END IF;

    /* The pattern itself was deleted and its day rows cascaded with it. There is
       no incomplete week here, only an absent one. */
    SELECT name INTO pattern FROM work_pattern WHERE id = pattern_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT count(*), count(*) FILTER (WHERE is_working_day)
      INTO named, worked
      FROM work_pattern_day
     WHERE work_pattern_id = pattern_id;

    IF named <> 7 THEN
        RAISE EXCEPTION 'Working pattern "%" names % of the seven days of the week.',
                        pattern, named
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'work_pattern_week_complete',
                  HINT = 'Give the pattern a row for every day, 1 (Monday) to 7 '
                         '(Sunday), saying whether it is worked. A day with no row '
                         'is a day whose answer depends on how the counting query '
                         'was written. FR 23.';
    END IF;

    IF worked = 0 THEN
        RAISE EXCEPTION 'Working pattern "%" works none of the seven days.', pattern
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'work_pattern_week_complete',
                  HINT = 'Somebody who works no day at all takes no leave, has no '
                         'entitlement to pro rate and appears on no team calendar. '
                         'That is employment_status, not a working pattern.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER work_pattern_week_complete
    AFTER INSERT OR UPDATE ON work_pattern
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_incomplete_work_pattern();

CREATE CONSTRAINT TRIGGER work_pattern_day_week_complete
    AFTER INSERT OR UPDATE OR DELETE ON work_pattern_day
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_incomplete_work_pattern();

-- ---------------------------------------------------------- the standard week

/* Monday to Friday, marked as the default. The story's first acceptance
   criterion, and the row without which no employee can be created at all.

   Reference data, like `role` and unlike the fixture organisation. The seed used
   to own this row and no longer does: a production database is migrated and
   never seeded, and a rule that only holds in development is not a rule. What
   the seed still owns is the *second* pattern — the part timer with Wednesdays
   off — because that one exists to make the counting tests honest rather than to
   make the system work.

   Written so that a database which already holds a default keeps it. Every
   machine that has run the seed already has this exact pattern, and inserting a
   second would collide with work_pattern_one_default and stop the migration on
   every developer's database at once. The NOT EXISTS is what makes this file
   safe to apply to a database with history, which is the only kind there will be
   after today. */

INSERT INTO work_pattern (name, is_default)
SELECT 'Standard Mon-Fri', TRUE
 WHERE NOT EXISTS (SELECT 1 FROM work_pattern WHERE is_default);

INSERT INTO work_pattern_day (work_pattern_id, day_of_week, is_working_day)
SELECT p.id, d, d <= 5
  FROM work_pattern p
 CROSS JOIN generate_series(1, 7) AS d
 WHERE p.is_default
   AND NOT EXISTS (SELECT 1 FROM work_pattern_day existing WHERE existing.work_pattern_id = p.id);

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. lms_app already holds SELECT, INSERT, UPDATE
   and DELETE on both tables from the organisation migration, and the trigger
   functions run inside the caller's own statement and need no privilege of their
   own.

   The DELETE is deliberately kept, which is the opposite of what the
   department-rules migration decided about departments, and the difference is
   worth being exact about. A department has an ending of its own — deactivation,
   with is_active and a headcount rule behind it — so a live delete path beside it
   would have given the application two endings, one of them undocumented. A
   pattern has no such ending and does not want one: an unused pattern is not part
   of anybody's history, it heads no column on last year's report, and nothing
   points at it. Deleting it is the ending it has.

   What that leaves reachable is exactly the pattern nobody works, because the
   two things that matter are already held elsewhere. employee.work_pattern_id
   references work_pattern(id) with no cascade, so a pattern anybody is on cannot
   be deleted by anyone at all, leaver or not. And the trigger above refuses the
   removal of the default whether or not anybody is on it. */

-- Down Migration

DROP TRIGGER IF EXISTS work_pattern_day_week_complete ON work_pattern_day;
DROP TRIGGER IF EXISTS work_pattern_week_complete ON work_pattern;
DROP FUNCTION IF EXISTS refuse_incomplete_work_pattern();

DROP TRIGGER IF EXISTS work_pattern_always_has_a_default ON work_pattern;
DROP FUNCTION IF EXISTS refuse_default_work_pattern_loss();

DROP INDEX IF EXISTS work_pattern_one_default;

DROP TRIGGER IF EXISTS work_pattern_set_updated_at ON work_pattern;
ALTER TABLE work_pattern
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS created_at;

ALTER TABLE work_pattern ADD CONSTRAINT work_pattern_name_key UNIQUE (name);
DROP INDEX IF EXISTS work_pattern_name_unique;

ALTER TABLE work_pattern DROP CONSTRAINT IF EXISTS work_pattern_name_not_blank;

/* The standard week itself stays. It is data rather than schema, employee
   records reference it, and a DELETE that the foreign key refuses would leave
   this section unable to run — which is the one thing a down migration may not
   do. Re-applying the up section finds it already there and inserts nothing. */
