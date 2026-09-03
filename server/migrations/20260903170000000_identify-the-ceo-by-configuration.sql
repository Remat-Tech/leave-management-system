-- Up Migration

-- Who the Chief Executive is, as a setting. FR 48c, FR 04, FR 38a, §4.3.1, §6, §8. LMS 321.
--
-- The `CEO` desk has to resolve to a person. Since LMS 314 it resolved to FR 04's root — the
-- one employee with no line manager — which is a shape of the reporting lines standing in for
-- a fact nobody wrote down. It fails the way a job title fails: quietly, from a screen with
-- nothing to do with leave.
--
--   | What somebody does | What routing did |
--   |---|---|
--   | gives the outgoing head a manager before clearing the incoming one's | goes to whoever is rootless in between, or nobody |
--   | hires a chairman above the Chief Executive | goes to the chairman, for ever |
--   | corrects a reporting line at the top of the tree | moves, silently |
--
-- So it becomes `ceo_employee_id`: a foreign key to a real employee, named by an HR
-- Administrator. Not a job title, and not text of any kind.
--
-- FR 04 keeps its single root and `employee_one_root` keeps holding it. What stops is the
-- inference from it — the head of the reporting lines and the Chief Executive are now two
-- separately answerable questions.

-- ---------------------------------------------- what the organisation is set up as

/* One row, holding what the company is configured as rather than what any employee, type or
   year is. `ceo_employee_id` is the whole of it today.

   A column rather than a key/value store, and the foreign key is the reason: ('ceo_employee_id',
   '17') is a string that means something by convention, which is this story's failure wearing
   a different hat. Nothing would refuse ('ceo_employee_id', 'Kwame'). The next setting is a
   column and a migration. */

CREATE TABLE organisation_setting (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* Nullable, because a database is migrated before anybody is hired into it. Empty is not
       a resting state — it is what "must be set before go live" is about — and until it is
       set the `CEO` desk is one nobody staffs, which FR 48b routes round and explains. */
    ceo_employee_id BIGINT REFERENCES employee(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* And there is one of it. The same constant-expression index as `employee_one_root`: "at most
   one row in the table" is a statement about the table, and a CHECK sees one row. */

CREATE UNIQUE INDEX organisation_setting_is_one_row ON organisation_setting ((true));

-- ------------------------------------------- the two rules about who may be named

/* Nobody who has left, and — once there is one — never nobody at all.

   Both refuse at the moment of writing rather than claiming an invariant. The line-manager
   rules migration argues why: "a constraint that can be falsified without touching the row it
   guards is a constraint that lies". Whoever is named today resigns in March without this row
   being touched, and FR 48b already routes round a desk held only by a leaver. */

CREATE FUNCTION refuse_a_chief_executive_nobody_could_ask() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    named employee%ROWTYPE;
BEGIN
    IF NEW.ceo_employee_id IS NULL THEN
        /* Only a move at all if there was somebody there. */
        IF TG_OP = 'UPDATE' AND OLD.ceo_employee_id IS NOT NULL THEN
            RAISE EXCEPTION
                'The organisation would be left with no Chief Executive named.'
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'organisation_setting_keeps_a_chief_executive',
                      HINT = 'Unpaid leave is decided by HR and the Chief Executive, so a '
                             'seat nobody is named in is a stage no request can be sent to. '
                             'Name their successor instead — one who has left is already '
                             'routed round, and clearing the setting routes nothing '
                             'anywhere. FR 48c, §4.3.1.';
        END IF;

        RETURN NEW;
    END IF;

    SELECT * INTO named FROM employee WHERE id = NEW.ceo_employee_id;

    IF named.employment_status = 'TERMINATED' THEN
        RAISE EXCEPTION
            '% % left the company on %.', named.first_name, named.last_name, named.exit_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'organisation_setting_names_somebody_who_is_here',
                  HINT = 'The Chief Executive decides unpaid leave, and somebody who has '
                         'left cannot sign in to decide anything. Name whoever holds the '
                         'post now. FR 48c, FR 06.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER organisation_setting_names_somebody_who_is_here
    BEFORE INSERT OR UPDATE ON organisation_setting
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_chief_executive_nobody_could_ask();

/* And the row is never deleted, which is the other way to end up with no setting at all. */

CREATE TRIGGER organisation_setting_is_never_deleted
    BEFORE DELETE ON organisation_setting
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'The organisation''s settings are one row that is edited, never one that is removed '
        'and written again. Deleting it would take the Chief Executive with it, and unpaid '
        'leave routes to that seat. FR 48c.'
    );

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the department
   rules has reused them.

   "Who moved the Chief Executive, and when" had no answer before this: it lived in
   `employee.manager_id`, filed under a reporting-line edit that said nothing about leave. */

CREATE TRIGGER organisation_setting_set_updated_at
    BEFORE UPDATE ON organisation_setting
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER organisation_setting_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON organisation_setting
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the restricted-application-role
   migration. UPDATE is granted because naming a successor is an edit of the one row. DELETE
   is not: the trigger stops the honest mistake at a psql prompt, the privilege stops the
   rest. */

GRANT UPDATE ON organisation_setting TO lms_app;

-- ------------------------------------- the answer this database already had

/* The row, seeded with whatever the reporting lines were being asked for.

   A one-time carry-over, not a rule. A database migrated this afternoon must route unpaid
   leave where it routed this morning; leaving the setting empty would make every unpaid
   request unroutable at the moment of deploy. Nothing reads `manager_id` for this again.

   `SELECT (subquery)` rather than `INSERT ... SELECT FROM employee`, so the row is written on
   a fresh database too — one with no employees is filled in by HR before go live. */

INSERT INTO organisation_setting (ceo_employee_id)
SELECT (
    SELECT id
      FROM employee
     WHERE manager_id IS NULL
       AND employment_status <> 'TERMINATED'
);


-- Down Migration

-- The setting goes and the `CEO` desk goes back to FR 04's root, which is the same person on
-- any database nobody has reconfigured — the reason the up section seeded the row from there.
-- The audit entries stay, about a table that no longer exists, which is what an append-only
-- log looks like after a rollback.

DROP TRIGGER IF EXISTS organisation_setting_is_audited ON organisation_setting;
DROP TRIGGER IF EXISTS organisation_setting_set_updated_at ON organisation_setting;
DROP TRIGGER IF EXISTS organisation_setting_is_never_deleted ON organisation_setting;
DROP TRIGGER IF EXISTS organisation_setting_names_somebody_who_is_here ON organisation_setting;

DROP INDEX IF EXISTS organisation_setting_is_one_row;

DROP TABLE IF EXISTS organisation_setting;

DROP FUNCTION IF EXISTS refuse_a_chief_executive_nobody_could_ask();
