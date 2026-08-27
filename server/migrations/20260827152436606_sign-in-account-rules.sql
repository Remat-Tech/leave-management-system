-- Up Migration

-- The sign in account. NFR SEC 01, and the door half of it.
--
-- app_user arrived with the organisation migration as five columns and one
-- comment against company_email: "sign in identifier". Nothing wrote a row but
-- the seed, no rule said what a login had to be, and the identifier it is named
-- for was an ordinary VARCHAR that could hold anybody's address, including one
-- belonging to nobody who works here.
--
-- This migration says what a login is: it belongs to exactly one employee, it is
-- their work address and not some other address, and it is stored in a form the
-- lookup at sign in can rely on.
--
-- What is deliberately not here is the list of accepted domains. That list is
-- configuration — ALLOWED_EMAIL_DOMAINS, so that a subsidiary's domain is an
-- environment change rather than a release — and a CHECK constraint cannot read
-- it. The database holds the rules that do not move; the allow list is checked
-- in server/src/auth/company-email.ts at provisioning and again at login.
--
-- The MFA columns are left exactly as they are. Their pairing rule — a code hash
-- and its expiry are present together or not at all — is a decision belonging to
-- the story that writes them, LMS 110, and guessing it here would be a
-- constraint written by somebody who had not yet met the problem.

-- ----------------------------------------------------------- the identifier

/* The address somebody types into the sign in box. It carries the same two
   rules employee.work_email carries, for the same reasons.

   Not blank, because NOT NULL says a value arrived and not that it means
   anything. A company_email of '' is a login that exists, matches no address
   anybody could type, and would sit in the table forever looking like access
   somebody has.

   Unique without regard to case, because no mail server treats Ama.Mensah@ and
   ama.mensah@ as separate mailboxes and neither may this table. A plain UNIQUE
   compares byte for byte, which would let a second login be created for the same
   person by holding the shift key — two accounts, one mailbox, one of them with
   a password nobody remembers setting.

   The lookup at sign in folds the address the same way, so it finds the single
   row this index would have refused a second of.

   Dropping the original constraint drops its index with it, so the replacement
   is created first and the table is never left without one. */

ALTER TABLE app_user
    ADD CONSTRAINT app_user_company_email_not_blank CHECK (btrim(company_email) <> '');

CREATE UNIQUE INDEX app_user_company_email_unique ON app_user (lower(company_email));
ALTER TABLE app_user DROP CONSTRAINT app_user_company_email_key;

-- ------------------------------------------------------------ the credential

/* A password hash that is present is a hash. NULL is the resting state and means
   no password has been set: the seed's logins have none, and a joiner's login
   exists before anybody has chosen one.

   The distinction matters at the door. No password set is refused, and it has to
   be told apart from a wrong password, because they are different problems — one
   needs somebody to finish provisioning the account, the other needs the person
   to try again. An empty string is neither, and would be a hash that no password
   verifies against and every password fails, silently, forever. */

ALTER TABLE app_user
    ADD CONSTRAINT app_user_password_hash_not_blank
        CHECK (password_hash IS NULL OR btrim(password_hash) <> '');

-- --------------------------------------------------------------- maintenance

/* The table had no timestamps at all, which was tolerable while nothing wrote to
   it. It is not tolerable for the login table. "When was this account created"
   and "when did it last change" are the first two questions asked of an account
   that has access somebody cannot account for, and an audit log — LMS 113 — that
   starts later cannot answer them about the rows that were already there.

   last_login_at was there from the start and is a different fact: when the
   account was last *used*, written by the sign in path. Whoever is asking why an
   account is still active wants both.

   set_updated_at() is reused rather than copied, as the department-rules and
   working-pattern-rules migrations reused it. Both columns are added with a
   default, so the rows already there get an honest value rather than a NULL every
   reader has to guard. */

ALTER TABLE app_user
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TRIGGER app_user_set_updated_at
    BEFORE UPDATE ON app_user
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------ the login is the work address

/* The whole of "access is tied to the company account", held where it cannot
   come apart.

   employee.work_email and app_user.company_email are two columns holding one
   fact: the address this person is reachable and identifiable at. Two columns
   holding one fact drift, and the drift here is not cosmetic. HR corrects a
   misspelled work address; the login keeps the old one; the person signs in with
   an address that is no longer theirs, and the address that is theirs is now free
   for the next joiner to be issued.

   The column is kept rather than dropped in favour of reading employee.work_email
   directly, because it is the identifier the sign in path looks up and a table
   that is queried by an address wants that address indexed and unique in its own
   right. What is added is the guarantee that the two never disagree, which is the
   only thing the duplication was missing.

   Two triggers, doing two different jobs.

   The first carries a change across. Correcting somebody's work address is an
   ordinary edit through EmployeeService, which knows nothing about logins and
   should not have to: the identity follows the person automatically, whoever is
   writing — the application, the seed, the staff import, or a migration fixing
   data. This is the cascade a foreign key would give if a foreign key could
   reference a column's value rather than a row.

   The second refuses what is left. With the cascade in place the only way to
   break the tie is to write app_user.company_email directly, which lms_app holds
   the privilege to do, so it is refused rather than trusted not to happen.
   Deferred, because a login and the employee it belongs to are legitimately
   created in the same transaction and the order of two INSERTs inside one is
   nobody's business until COMMIT.

   Compared folded, because that is how the address is compared everywhere else
   in this schema and a tie that held for 'ama.mensah@' but not 'Ama.Mensah@'
   would be no tie at all.

   Neither fires on TRUNCATE, as with employee_never_deleted and the working
   pattern triggers, because a row trigger does not. That is left alone rather
   than overlooked: lms_app holds no TRUNCATE, so the only writer who can reach it
   holds the owner connection and is emptying the table on purpose. */

CREATE FUNCTION carry_work_email_to_login() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* Folded on both sides, so a change of capitals alone writes nothing. The
       login already points at the same mailbox, every comparison in this schema
       and in the sign in path is folded, and an UPDATE that changes no fact is
       still an UPDATE: it moves updated_at and, once LMS 113 lands, writes an
       audit entry saying that an address changed when none did. */
    UPDATE app_user
       SET company_email = NEW.work_email
     WHERE employee_id = NEW.id
       AND lower(company_email) IS DISTINCT FROM lower(NEW.work_email);

    -- AFTER trigger. The return value is discarded.
    RETURN NULL;
END
$$;

CREATE TRIGGER employee_work_email_reaches_the_login
    AFTER UPDATE OF work_email ON employee
    FOR EACH ROW
    WHEN (OLD.work_email IS DISTINCT FROM NEW.work_email)
    EXECUTE FUNCTION carry_work_email_to_login();

CREATE FUNCTION refuse_login_address_drift() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    work_address TEXT;
BEGIN
    SELECT work_email INTO work_address FROM employee WHERE id = NEW.employee_id;

    /* No such employee. The foreign key has already refused that, or is about to;
       it is not this trigger's refusal to make and not its message to give. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF lower(NEW.company_email) IS DISTINCT FROM lower(work_address) THEN
        RAISE EXCEPTION 'Sign in address % is not the work address on the employee record, which is %.',
                        NEW.company_email, work_address
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'app_user_email_is_the_work_email',
                  HINT = 'A login is the employee record''s work address and nothing '
                         'else, so that access is tied to the company account. Change '
                         'the work address on the employee record and the login '
                         'follows it. NFR SEC 01.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER app_user_email_is_the_work_email
    AFTER INSERT OR UPDATE OF employee_id, company_email ON app_user
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_login_address_drift();

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. lms_app already holds SELECT and INSERT from
   the default privileges and the UPDATE the organisation migration granted, which
   is what setting a password, locking an account and stamping last_login_at need.

   It still holds no DELETE on app_user, and that is worth being as explicit about
   as the employee table's absent DELETE. A login is deactivated, never deleted,
   for the same reason and one more: user_role rows point at it, LMS 113's audit
   entries will name it, and an account that was removed rather than closed leaves
   an audit trail referring to a user nobody can identify. Ending somebody's
   access is is_active, which is a fact with a date beside it in updated_at.

   The trigger functions run inside the caller's own statement and need no
   privilege of their own. */

-- Down Migration

DROP TRIGGER IF EXISTS app_user_email_is_the_work_email ON app_user;
DROP FUNCTION IF EXISTS refuse_login_address_drift();

DROP TRIGGER IF EXISTS employee_work_email_reaches_the_login ON employee;
DROP FUNCTION IF EXISTS carry_work_email_to_login();

DROP TRIGGER IF EXISTS app_user_set_updated_at ON app_user;
ALTER TABLE app_user
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS created_at;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_password_hash_not_blank;

ALTER TABLE app_user ADD CONSTRAINT app_user_company_email_key UNIQUE (company_email);
DROP INDEX IF EXISTS app_user_company_email_unique;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_company_email_not_blank;
