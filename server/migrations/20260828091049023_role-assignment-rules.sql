-- Up Migration

-- Roles, and what may be done with them. Technical Design Document §5.3.
-- LMS 111.
--
-- The two tables arrived with the organisation migration: `role`, seeded with
-- the four the story names, and `user_role` joining them to logins. What was
-- missing is every rule about them. The set of roles was a list of rows anybody
-- could add to, a grant recorded nothing about when it happened, and the two
-- states that must never occur — a login with no roles at all, a system with no
-- System Administrator — were nobody's business to prevent.
--
-- Three things are settled here.
--
--   The set of roles is closed. Four, named in a CHECK, and MANAGER is not among
--   them and cannot be added.
--
--   A grant is a dated fact rather than a bare pair of ids, because "who has HR
--   powers and since when" is the question this story exists to be able to
--   answer.
--
--   The last System Administrator cannot be removed, held the way FR 04 holds the
--   single root: by the database, because it is a shape the whole organisation
--   depends on and the application is not the only writer.

-- ------------------------------------------------------------- the four roles

/* The closed set, matching ROLE_CODES in server/src/auth/roles.ts. The
   integration tests assert that this constraint, that constant and the rows the
   organisation migration seeded all agree, so adding a role in one place and
   forgetting the others fails the suite rather than production.

   A fifth role is a migration and not a row, and that is the point rather than
   an inconvenience. A role the authorisation layer has never heard of grants
   nothing; a row that silently grants nothing is a worse failure than a
   constraint refusing to store it, because somebody will believe they have given
   a colleague access and nobody will find out until the colleague needs it.

   MANAGER is deliberately absent, as the organisation migration said when it
   created the table. Being a manager is a relationship — you are one if some
   employee has your id as their manager_id — and holding it here as well would
   be two sources of truth that disagree the moment somebody changes team. This
   constraint is what turns that comment into a rule: nothing can now insert it,
   including a migration written by somebody who has not read the comment. */

ALTER TABLE role
    ADD CONSTRAINT role_code_known
        CHECK (code IN ('EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN')),
    ADD CONSTRAINT role_name_not_blank CHECK (btrim(name) <> '');

-- --------------------------------------------------------- when it was granted

/* A grant is a fact with a date on it.

   The table held two ids and nothing else, which answers "does she have it" and
   not "since when", and the second is most of what somebody reviewing access
   actually asks. It is the difference between a list of who holds HR powers and
   an account of how they came to.

   Defaulted, so the rows already there get an honest value — the moment this
   migration runs, which is the truth available — rather than a NULL every reader
   has to guard.

   Who granted it is deliberately not here. It wants an authenticated actor, and
   there is none until LMS 112 puts a session in front of this; a nullable
   granted_by that is null on every row would be a column pretending to hold
   something. The audit log of LMS 113 is where "who did what" belongs, and it
   can carry this one when it arrives. */

ALTER TABLE user_role
    ADD COLUMN granted_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ------------------------------------------------- every login is an employee

/* EMPLOYEE arrives with the login, and arrives in the same transaction.

   Until now the only thing that granted it was the seed, which meant it was true
   of every development database and of no production one: a production database
   is migrated and never seeded, so the first login SignInService provisioned
   would have held no roles at all — not an administrator, not an employee,
   nothing. Somebody who can sign in and then do nothing.

   Here rather than in the service for the reason it is a trigger and not two
   statements: a login and its baseline role have to arrive together or not at
   all. A service doing it in two writes has a window in which a crash leaves an
   account nobody can use and nobody can fix through the interface, and closing
   that window from the service means opening a transaction, which means the
   service layer knowing what the query layer is. The database is already inside
   the transaction.

   And it covers every writer, which the service could not: the seed, a future
   import, a migration correcting data. Whatever creates a login creates an
   employee.

   ON CONFLICT DO NOTHING so that a writer which grants it explicitly — the seed
   used to, and something may again — is not punished for agreeing with us. */

CREATE FUNCTION grant_baseline_role() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO user_role (user_id, role_id)
    SELECT NEW.id, r.id FROM role r WHERE r.code = 'EMPLOYEE'
    ON CONFLICT DO NOTHING;

    -- AFTER trigger. The return value is discarded.
    RETURN NULL;
END
$$;

CREATE TRIGGER app_user_holds_the_baseline_role
    AFTER INSERT ON app_user
    FOR EACH ROW
    EXECUTE FUNCTION grant_baseline_role();

/* And for the logins that already exist, which on a development database is all
   of them and on a production one is none. Written so that running it twice
   changes nothing. */

INSERT INTO user_role (user_id, role_id)
SELECT u.id, r.id FROM app_user u CROSS JOIN role r WHERE r.code = 'EMPLOYEE'
ON CONFLICT DO NOTHING;

-- ----------------------------------------------- the baseline cannot be removed

/* EMPLOYEE is what "can see their own leave and ask for more of it" is called.
   Every login is given it at provisioning and none may have it taken away.

   An account without it is somebody who can sign in and then do nothing, which
   is not a state anybody intends. Whoever is removing it means one of two other
   things — take away their HR powers, or stop them signing in at all — and both
   of those exist already: revoke the role they actually meant, or close the
   account. Refusing here is what makes them say which.

   The NOT FOUND check is not defensive noise. user_role.user_id cascades from
   app_user, so deleting a login deletes its role rows, and without this the
   trigger would refuse a cascade that is deleting the very account the role
   belonged to. There is no baseline to protect for somebody who no longer
   exists. */

CREATE FUNCTION refuse_baseline_role_removal() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    removed TEXT;
BEGIN
    SELECT code INTO removed FROM role WHERE id = OLD.role_id;

    IF removed <> 'EMPLOYEE' THEN
        RETURN NULL;
    END IF;

    /* The login is going too. The role row is going with it, which is right. */
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = OLD.user_id) THEN
        RETURN NULL;
    END IF;

    RAISE EXCEPTION 'EMPLOYEE is held by everybody with a login and cannot be taken away.'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'user_role_keeps_the_baseline',
              HINT = 'It is what being able to see your own leave is called. To remove '
                     'somebody''s HR powers, revoke that role; to stop them signing in '
                     'at all, close their account. §5.3.';

    -- Unreachable: the RAISE above always exits. Here so that no path can fall
    -- off the end of a trigger procedure without returning.
    RETURN NULL;
END
$$;

CREATE TRIGGER user_role_keeps_the_baseline
    AFTER DELETE ON user_role
    FOR EACH ROW
    EXECUTE FUNCTION refuse_baseline_role_removal();

-- ------------------------------------------- somebody keeps the master key

/* The last System Administrator cannot be removed.

   This is the one role change nobody can undo, because the person who would undo
   it is the person who just stopped existing. Every other mistake in this table
   is repairable by somebody; this one locks the door and posts the key through
   it.

   Only on DELETE, which is what makes it safe to add to a database that has no
   System Administrator yet. A freshly migrated production database has no logins
   at all, and requiring one from the start would make it impossible to create
   the first. The rule is "do not go from some to none", not "always have one",
   and those differ exactly at the beginning.

   Deferred, because the legitimate operation this would otherwise refuse is the
   ordinary one: handing the role from one person to the next is a revoke and a
   grant, and doing them in that order passes through nobody holding it. Checked
   at COMMIT, only the state that will actually be stored is judged, and the
   order the two statements were written in stops mattering.

   TRUNCATE is not covered, as everywhere else in this schema, because a row
   trigger does not fire on it. lms_app holds no TRUNCATE; the only writer who
   can reach it is the seed on the owner connection, emptying the table on
   purpose. */

CREATE FUNCTION refuse_last_system_administrator() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* Which role was removed, asked here rather than in the trigger's WHEN
       clause: a WHEN may not contain a subquery, and the role code lives in
       another table. */
    IF NOT EXISTS (SELECT 1 FROM role WHERE id = OLD.role_id AND code = 'SYS_ADMIN') THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
         WHERE r.code = 'SYS_ADMIN'
    ) THEN
        RAISE EXCEPTION 'That would leave nobody holding SYS_ADMIN.'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'user_role_keeps_a_system_administrator',
                  HINT = 'Nobody could grant it back, including whoever removed it. '
                         'Give somebody else the role in the same transaction. §5.3.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER user_role_keeps_a_system_administrator
    AFTER DELETE ON user_role
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_last_system_administrator();

-- ---------------------------------------------------------------- privileges

/* `role` becomes read only to the application, which is what "reference data"
   has meant since the organisation migration said it. That migration left the
   INSERT the default privileges had already granted, with a comment saying the
   table is not edited at runtime — an intention rather than a rule, and one the
   role_code_known constraint now only half covers: it stops an *unknown* code
   being inserted, not a fifth row saying HR_ADMIN twice.

   Withholding the privilege is what makes the set of roles fixed. The seed and
   the migrations run as the owner and are unaffected.

   user_role keeps the INSERT and DELETE that granting and revoking need, from
   the organisation migration. Those are this story's whole surface. */

REVOKE INSERT ON role FROM lms_app;

-- Down Migration

GRANT INSERT ON role TO lms_app;

DROP TRIGGER IF EXISTS user_role_keeps_a_system_administrator ON user_role;
DROP FUNCTION IF EXISTS refuse_last_system_administrator();

DROP TRIGGER IF EXISTS user_role_keeps_the_baseline ON user_role;
DROP FUNCTION IF EXISTS refuse_baseline_role_removal();

DROP TRIGGER IF EXISTS app_user_holds_the_baseline_role ON app_user;
DROP FUNCTION IF EXISTS grant_baseline_role();

/* The EMPLOYEE grants themselves stay. They are data rather than schema, they
   were true of every seeded database before this migration ran, and removing
   them would take away access this migration did not create. */

ALTER TABLE user_role DROP COLUMN IF EXISTS granted_at;

ALTER TABLE role
    DROP CONSTRAINT IF EXISTS role_name_not_blank,
    DROP CONSTRAINT IF EXISTS role_code_known;
