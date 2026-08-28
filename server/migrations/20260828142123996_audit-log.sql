-- Up Migration

-- The audit log. NFR AUD 01 and NFR AUD 02. Technical Design Document §4.
-- LMS 113.
--
-- The story is a dispute two years from now: somebody's balance is wrong, or is
-- said to be, and the question is how it got that way. Nobody remembers. The
-- answer has to be a row somebody wrote at the time and nobody has been able to
-- touch since.
--
-- Four decisions carry the whole of this migration, and each of them is the
-- difference between an audit log and a table called audit_log.
--
--   **The database writes the entries, not the application.** A trigger on every
--   audited table, so that an entry is not something a service remembers to
--   write. It covers the seed, a bulk import, a migration correcting data and
--   somebody in psql on a Friday afternoon — and it is in the same transaction
--   as the change it records, so there is no window in which the change happened
--   and the record of it did not.
--
--   **The application names who.** That is the one thing the database cannot
--   know, so it is read from a transaction-local setting the repositories set —
--   see server/src/repositories/recording.ts. Nothing set means nobody said, and
--   that is recorded as such rather than guessed at.
--
--   **Nothing may be updated or deleted, by anybody, loudly.** NFR AUD 02. See
--   the three layers below.
--
--   **No secret is ever in here.** A password hash in an audit row is a password
--   hash in a table the application can SELECT, which would make this table the
--   easiest way to steal the credentials it exists to protect.
--
-- What this migration deliberately does not add is user_role.granted_by. LMS 111
-- left that column out and said why: it wants an authenticated actor, and the
-- place for "who did what" is the audit log rather than a column beside every
-- row. This is that audit log, and a grant now has a name against it here.

-- ------------------------------------------------------- rewriting is refused

/* The sibling of refuse_delete(), named for the job in the same way and for the
   same reason: the ledger of Phase 2 wants exactly this and should attach to it
   rather than declaring its own RAISE.

   refuse_delete() reads TG_TABLE_NAME for its message and gives a hint about
   deactivating instead, which is right for employee and wrong here — there is no
   deactivating an audit entry. So the hint is the caller's, passed as the
   trigger's argument, and the message says which table and which row.

   restrict_violation, class 23, as refuse_delete() raises, so that a caller can
   tell a refused write from a genuine fault by SQLSTATE rather than by reading
   the message. */

CREATE FUNCTION refuse_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Rows in % are never changed once written.', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation',
              HINT = coalesce(
                  TG_ARGV[0],
                  'The table is append only. Write a new row rather than editing this one.'
              );
END
$$;

-- ------------------------------------------------------------------ the table

/* One row per change to a record anybody could later dispute.

   `entity` and `entity_id` are the handle. Together they answer "show me
   everything that ever happened to this", which is the only question anybody
   arrives with. `entity` is the table name, taken from TG_TABLE_NAME so it
   cannot drift from the table it is about.

   `entity_id` is the row's own identifier, except for a child table, where it is
   the parent's — work_pattern_day carries the pattern's id, because nobody
   searches for the Wednesday of a week, they search for the week. The trigger is
   told which column to read; see below.

   `before` and `after` are the record either side of the change, as jsonb. Both
   are nullable and which of them is null says what happened as reliably as
   `action` does: nothing before a CREATE, nothing after a DELETE. Keeping the
   whole record rather than a list of changed fields is the decision that makes
   this answer a dispute — "her start date says 2023" is settled by a snapshot
   and is not settled by knowing that somebody changed some fields in March.
   jsonb rather than a per-table shadow table, because the shape of `employee`
   in March 2026 is not the shape it will have in 2028 and history has to survive
   the schema moving.

   `actor` and `actor_employee_id` are who. Two columns because they answer
   different questions: the id is what you join on, the description is what you
   read when the id belongs to nobody — a migration, the seed, a job. See the
   trigger for what happens when nothing was set.

   `occurred_at` is when, defaulted rather than supplied, so that no writer can
   date an entry.

   No foreign key on actor_employee_id, deliberately. History does not depend on
   the present: an audit entry has to stay true and readable whatever happens to
   the row it names, and a foreign key would invert that — it would also mean
   TRUNCATE employee CASCADE quietly took the history with it. The id is a handle
   for a join somebody chooses to make, not a promise that the join finds
   anything.

   No updated_at, and no set_updated_at trigger. A row that is never updated has
   no such thing, and putting the column here would be a claim that it might be. */

CREATE TABLE audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* CREATE | UPDATE | DELETE. Held closed, because a fourth value would be a
       kind of change nothing in the reader knows how to display. */
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before JSONB,
    after JSONB,
    actor TEXT NOT NULL,
    actor_employee_id BIGINT,

    CONSTRAINT audit_log_action_known CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
    CONSTRAINT audit_log_entity_not_blank CHECK (btrim(entity) <> ''),
    CONSTRAINT audit_log_entity_id_not_blank CHECK (btrim(entity_id) <> ''),
    CONSTRAINT audit_log_actor_not_blank CHECK (btrim(actor) <> ''),

    /* What each action means, held rather than described. A CREATE with a
       `before` is a record of something that did not happen, and it is the kind
       of wrong that is invisible until somebody is relying on it. */
    CONSTRAINT audit_log_states_match_the_action CHECK (
        CASE action
            WHEN 'CREATE' THEN before IS NULL AND after IS NOT NULL
            WHEN 'UPDATE' THEN before IS NOT NULL AND after IS NOT NULL
            WHEN 'DELETE' THEN before IS NOT NULL AND after IS NULL
        END
    )
);

/* The question everybody arrives with: everything that happened to this record,
   oldest first. */
CREATE INDEX audit_log_entity ON audit_log (entity, entity_id, occurred_at);

/* And the two an administrator arrives with: what did this person do, and what
   happened on the day the balance went wrong. */
CREATE INDEX audit_log_actor ON audit_log (actor_employee_id, occurred_at)
    WHERE actor_employee_id IS NOT NULL;
CREATE INDEX audit_log_occurred_at ON audit_log (occurred_at);

-- ------------------------------------------------------------ writing an entry

/* One function for every audited table.

   Written once rather than per table for the reason set_updated_at() and
   refuse_delete() are written once: six copies of this would be six places for
   the redaction rule to be got right five times.

   The arguments, in order:

     TG_ARGV[0]  the column holding the id this entry should be filed under.
                 Usually `id`; for a child table, the parent's key.
     TG_ARGV[1]  columns that are noise — dropped from the snapshot entirely and
                 therefore not compared. A change to nothing but these writes no
                 entry at all.
     TG_ARGV[2]  columns that are secret — compared as they are, stored as a
                 marker. See below.

   Three rules in here are worth reading before changing anything.

   **Secrets are compared and not kept.** password_hash is what this is for. The
   fact that somebody's password changed, when, and who did it is exactly what an
   audit log is for; the hash itself in a table lms_app can SELECT would make this
   the cheapest way to steal every credential in the building. So the comparison
   happens on the real values — a reset from one hash to another is a real change
   and is recorded — and what is stored says only whether there was one. Both
   sides of a reset therefore read "[set]", and that is the whole truth an audit
   trail should tell about a secret: that it changed, not what to.

   **Noise is dropped, and a change to nothing but noise writes nothing.** Signing
   in stamps last_login_at and clears a one time code. Those are an access log,
   which this is not and which does not exist — see server/src/auth/denials.ts for
   the same distinction drawn about refusals. An audit log filled with one row per
   sign in is an audit log nobody scrolls to the bottom of.

   **updated_at is always noise**, in every table, without being named. It is
   maintained by a trigger and moves on every update by definition, so comparing
   it would make every change look material and keeping it would duplicate
   occurred_at.

   The entry is written by the same statement that made the change, inside
   whatever transaction the writer opened. There is no window. If the change rolls
   back so does its record, which is the only correct behaviour: an audit log
   that records what did not happen is worse than one that misses what did. */

CREATE FUNCTION record_in_audit_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    key_column TEXT := coalesce(TG_ARGV[0], 'id');
    noise TEXT[] := string_to_array(coalesce(TG_ARGV[1], ''), ',') || ARRAY['updated_at'];
    secrets TEXT[] := string_to_array(coalesce(TG_ARGV[2], ''), ',');

    was JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    now_is JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

    subject TEXT;
    column_name TEXT;
BEGIN
    /* Noise first, on both sides, so that the comparison below never sees it. */
    FOREACH column_name IN ARRAY noise LOOP
        IF btrim(column_name) <> '' THEN
            was := was - btrim(column_name);
            now_is := now_is - btrim(column_name);
        END IF;
    END LOOP;

    /* An update that changed nothing anybody could dispute. Two HR officers
       saving the same form, or a sign in touching only the columns above. */
    IF TG_OP = 'UPDATE' AND was = now_is THEN
        RETURN NULL;
    END IF;

    /* And only now the secrets, after they have been compared as they are. */
    FOREACH column_name IN ARRAY secrets LOOP
        column_name := btrim(column_name);

        IF column_name <> '' THEN
            IF was ? column_name AND was ->> column_name IS NOT NULL THEN
                was := jsonb_set(was, ARRAY[column_name], '"[set]"'::jsonb);
            END IF;
            IF now_is ? column_name AND now_is ->> column_name IS NOT NULL THEN
                now_is := jsonb_set(now_is, ARRAY[column_name], '"[set]"'::jsonb);
            END IF;
        END IF;
    END LOOP;

    subject := coalesce(now_is, was) ->> key_column;

    /* Unreachable: every audited table has the column its trigger names. Answered
       rather than assumed, because the alternative is a NOT NULL violation on the
       audit table taking down an ordinary edit, and an audit log that can stop
       somebody working is an audit log somebody switches off. */
    IF subject IS NULL THEN
        subject := 'unidentified';
    END IF;

    INSERT INTO audit_log (action, entity, entity_id, before, after, actor, actor_employee_id)
    VALUES (
        CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE TG_OP END,
        TG_TABLE_NAME,
        subject,
        was,
        now_is,
        /* Who, as the application said. Nothing set is a writer that did not say
           who it was — a migration, the seed, somebody at a psql prompt — and
           that is a fact worth recording plainly rather than a null every reader
           has to guard. */
        coalesce(
            nullif(btrim(current_setting('lms.audit.actor', true)), ''),
            'not named by the writer'
        ),
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT
    );

    -- AFTER trigger. The return value is discarded.
    RETURN NULL;
END
$$;

-- --------------------------------------------------------- what is audited

/* Everything the application can change, and nothing it cannot.

   AFTER rather than BEFORE, so that an entry is only written for a change that
   every other constraint has already accepted. A BEFORE trigger would record the
   reporting line loop that the deferred cycle trigger is about to refuse.

   `role` is deliberately absent. lms_app holds no INSERT, UPDATE or DELETE on it
   since the role-assignment-rules migration, so the only writer is a migration —
   which is a file in git, with an author, a date and a review on it. That is a
   better audit record than a row, and duplicating it here would suggest the table
   is editable at runtime when the whole point is that it is not.

   `audit_log` is absent for the obvious reason and the important one: it is never
   updated or deleted, and a trigger recording inserts into itself is a loop. */

CREATE TRIGGER employee_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON employee
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

CREATE TRIGGER department_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON department
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

CREATE TRIGGER work_pattern_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON work_pattern
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

/* Filed under the pattern rather than under the day. Changing a week is seven
   deletes and seven inserts inside one transaction — see the working-pattern
   rules — so fourteen entries land together, and they are only legible if they
   are all filed under the week somebody was asking about. */
CREATE TRIGGER work_pattern_day_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON work_pattern_day
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log('work_pattern_id');

/* The login. The noise list is the whole of the sign in path — the stamp and the
   one time code columns — and the secret list is the two things in this schema
   that must never leave the table they are in.

   mfa_code_hash is in both lists in spirit and is put in the noise one, because a
   code that lives ten minutes and is consumed by the sign in that answers it is
   not a decision anybody disputes. Recording it as secret would mean one entry
   per sign in saying a code changed, which is the flood the noise rule exists to
   prevent. */
CREATE TRIGGER app_user_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON app_user
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log(
        'id',
        'last_login_at,mfa_code_hash,mfa_code_expires_at,mfa_code_attempts',
        'password_hash'
    );

/* Who holds which role, filed under the login. This is what LMS 111 meant when
   it left granted_by out: a grant already had a date on it, and now it has a name
   beside it, in the place where "who did what" belongs. */
CREATE TRIGGER user_role_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON user_role
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log('user_id');

-- ------------------------------------------------------ nothing is ever changed

/* NFR AUD 02, in three layers, and it is worth knowing which covers what.

   | | Covers | Does not cover |
   |---|---|---|
   | lms_app holds no UPDATE or DELETE | the application, which is the writer an attacker reaches | the owner connection |
   | these two triggers | every connection, owner included | TRUNCATE, and a superuser who disables triggers |
   | the application never running as the owner | the whole of the above being worth anything | nothing |

   The first is the one that actually matters and it is the one nobody had to
   write: the default privileges grant SELECT and INSERT on a new table and
   nothing else, so this table is append only to the application because nobody
   ever granted it more. That is the arrangement the README argues for, and this
   is the table it was arguing about.

   The triggers are the loud half. A rule — DO INSTEAD NOTHING, which is what the
   README first proposed — would make an UPDATE succeed while changing nothing,
   and a silent success is the worst possible answer to somebody trying to rewrite
   history: they believe they have, and nobody finds out either way. A refusal
   with a SQLSTATE on it is an error in a log and a question somebody asks.

   TRUNCATE is not covered, as everywhere else in this schema, because a row
   trigger does not fire on it. lms_app was never granted it. The seed reaches it
   on the owner connection, on purpose, to reload the fixtures. */

CREATE TRIGGER audit_log_is_never_changed
    BEFORE UPDATE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'The audit log is the account of what happened. Correcting it would make '
        'it an account of what somebody wishes had happened. Record the correction '
        'as a new change instead. NFR AUD 02.'
    );

CREATE TRIGGER audit_log_is_never_deleted
    BEFORE DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete();

-- ---------------------------------------------------------------- privileges

/* Restated rather than left to the default privileges, which already grant
   exactly this. The default is what makes the table append only and it is
   invisible at the point somebody is reading this file asking "can the
   application delete these" — so the answer is written down where the question
   gets asked.

   SELECT, because the whole point is that somebody can read the account.
   INSERT, because the trigger runs as the caller and the caller is lms_app.
   No UPDATE and no DELETE, ever, and adding either is a decision this comment
   exists to make somebody argue for. */

GRANT SELECT, INSERT ON audit_log TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS user_role_is_audited ON user_role;
DROP TRIGGER IF EXISTS app_user_is_audited ON app_user;
DROP TRIGGER IF EXISTS work_pattern_day_is_audited ON work_pattern_day;
DROP TRIGGER IF EXISTS work_pattern_is_audited ON work_pattern;
DROP TRIGGER IF EXISTS department_is_audited ON department;
DROP TRIGGER IF EXISTS employee_is_audited ON employee;

DROP FUNCTION IF EXISTS record_in_audit_log();

DROP TRIGGER IF EXISTS audit_log_is_never_deleted ON audit_log;
DROP TRIGGER IF EXISTS audit_log_is_never_changed ON audit_log;

DROP TABLE IF EXISTS audit_log;

/* refuse_update() goes with the table it was written for. refuse_delete() does
   not: it belongs to the employees-never-deleted migration and employee still
   uses it. */
DROP FUNCTION IF EXISTS refuse_update();
