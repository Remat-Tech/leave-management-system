-- Up Migration

-- The balance ledger. FR 27, §5.7, and design principle 1. LMS 210.
--
-- Four migrations have named this table before it existed. The
-- entitlement-rule-effective-dates one put it plainest: "A resolved figure becomes
-- days somebody actually has only when the ledger records it." This is that table,
-- and it is the one the whole of Phase 2 was ordered to arrive at.
--
-- The story is somebody asking why they have twelve days rather than fifteen. The
-- answer is not a number and not a recalculation: it is a list of rows, each with a
-- date, an amount, a reason and a name against it, that add up to twelve. Design
-- principle 1 says the same thing from the other end — "the ledger is the truth;
-- balances are a cache" — and the practical consequence is that nothing in this
-- system may ever move a balance without leaving a row here first.
--
-- ## Three properties, and each is a different way of being trusted
--
--   **Every movement is a row.** Not a column that goes up and down. A running
--   total can only ever say what it is now; a ledger says how it got there, which
--   is the whole difference between answering a dispute and asserting a figure.
--
--   **No row ever changes.** FR 27's "immutable", held by two triggers and by the
--   privileges, exactly as `audit_log` holds it. The audit-log migration wrote
--   `refuse_update()` for this table before this table existed and said so: "the
--   ledger of Phase 2 wants exactly this and should attach to it rather than
--   declaring its own RAISE." It does.
--
--   **A mistake is a new row.** The fourth acceptance criterion, and the one that
--   needs a column rather than a rule: `corrects_id`. A compensating entry that
--   does not say what it compensates is an unexplained credit sitting beside an
--   unexplained debit, which is the situation §8.6c warns about by name.
--
-- ## What this table is not
--
-- It is **not the audit log**, and there is no audit trigger on it below. The two
-- answer different questions and the difference is worth being exact about:
-- `audit_log` records that a row changed, and exists because rows change. This
-- records that days moved, and exists because they cannot be moved any other way.
-- Auditing it would write one CREATE entry per ledger row carrying the same facts
-- the row already carries — a second copy of an account whose entire value is that
-- there is one — and the copy could disagree with the original.
--
-- It is **not the balance**. `leave_balance` is LMS 214: a cached running total,
-- rebuildable from these rows, and the reconciliation job that proves the two agree
-- is §7.4. Nothing here computes a total, because a total computed in two places is
-- the drift the cache exists to be checked against.

-- ------------------------------------------------- refuse_delete() grows a hint

/* `refuse_update()` takes the hint from its caller and `refuse_delete()` does not,
   which was right when the only table that refused a delete was `employee`. It is
   not right now, and it has already gone slightly wrong once: `audit_log` attached
   to `refuse_delete()` in LMS 113 and has been telling anybody who tries to remove
   an audit entry to "deactivate the record instead. An employee who has left is
   employment_status = 'TERMINATED'". Harmless, and exactly the sort of thing that
   stops being harmless when a third table copies it.

   So the hint becomes TG_ARGV[0] with the employee sentence as its default, which
   is the shape `refuse_update()` has had since it was written for this table. Every
   existing caller passing nothing keeps the message it has today; `audit_log` is
   given the one it should have had, below.

   Replaced rather than added beside, because two functions differing only in
   whether the hint is a parameter is the drift the argument exists to prevent. */

CREATE OR REPLACE FUNCTION refuse_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Rows in % are never deleted.', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation',
              HINT = coalesce(
                  TG_ARGV[0],
                  'Deactivate the record instead. An employee who has left is '
                  'employment_status = ''TERMINATED'' with an exit_date, which '
                  'keeps their leave history answerable. FR 06.'
              );
END
$$;

/* And the entry that was getting the employee's hint. NFR AUD 02's own sentence,
   which is the one the audit-log migration wrote for `refuse_update()` beside it
   and could not pass here. */

DROP TRIGGER IF EXISTS audit_log_is_never_deleted ON audit_log;

CREATE TRIGGER audit_log_is_never_deleted
    BEFORE DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'The audit log is the account of what happened. Removing an entry would make '
        'it an account of what somebody wishes had happened. NFR AUD 02.'
    );

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_ledger_entry (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* Whose balance moved, of what kind, in which year. The three columns every
       balance in this system is keyed by — §5.7's `leave_balance` has exactly the
       same three — because "how many days do I have" is not a question until all
       three are named.

       Real foreign keys, unlike `audit_log.actor_employee_id` which deliberately
       has none. The distinction is what the id is for. There it is a handle for a
       join somebody may choose to make, and history has to stay readable whatever
       happens to the row it names. Here it is the filing: an entry whose employee
       does not exist is not a hard-to-read entry, it is days that moved in nobody's
       balance, and a balance that cannot be attributed cannot be reconstructed.

       This is also the reason `employee`, `leave_type` and `leave_year` are rows
       nobody may delete. Each of those migrations said a year or a type is a
       heading things are filed under; this is the table doing the filing. */
    employee_id BIGINT NOT NULL REFERENCES employee(id),
    leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
    leave_year_id BIGINT NOT NULL REFERENCES leave_year(id),

    /* What kind of movement. The eight of §5.7, held closed, because a ninth would
       be days moving for a reason no reader of a balance knows how to describe.

       They divide into two families and the division runs through everything
       below — the sign rule, the whole-days rule and the settled-year rule each
       cut along it:

         **Four are about what somebody is owed.** GRANT, CARRY_FORWARD,
         ADJUSTMENT, EXPIRY. Entitlement arriving, surviving a year end, being
         corrected by hand, or lapsing.

         **Four are about a request.** RESERVATION, DEDUCTION, RELEASE,
         RECALCULATION. Days held when leave is asked for, taken when it is
         approved, given back when it is not, and credited back when a holiday is
         declared inside leave already approved. */
    entry_type TEXT NOT NULL,

    /* How many days, signed. FR 27.

       Positive adds to what the person is owed, negative consumes it, and the sign
       is fixed per type by `leave_ledger_entry_sign_matches_the_type` below rather
       than left to each writer to remember.

       **This column does not sum to the available balance, and nothing should ever
       write a query that assumes it does.** A RESERVATION of −5 and the DEDUCTION
       of −5 that follows it on approval are not ten days: the second finalises what
       the first held. Available is `entitled + carried + adjustment − taken −
       pending`, five buckets, and which bucket an entry moves follows from its
       type. That projection is LMS 214's and is deliberately not written here,
       because a total computed in two places is the drift the cached balance exists
       to be checked against.

       NUMERIC(6,2) rather than the INTEGER every other count in this schema is,
       and it is the one place a fraction is permitted. §8.6d: entitlement is pro
       rated by calendar days, so a joiner on 1 July is owed 20 × 184/365 = 10.08
       days, and "FR 24 governs how leave is requested, not how entitlement is
       held". LMS 209 wrote the rule that made this the exception it now is, and
       named the condition: every column that is not an accrued figure stays whole,
       so that the day somebody makes a request's day count fractional it still
       fails. The four request-shaped entry types are held to whole days below, by
       constraint, which is that condition met rather than promised. */
    days NUMERIC(6,2) NOT NULL,

    /* Why. FR 27 lists it among the four things every entry records, and it is the
       one a person actually reads.

       Mandatory and not blank, with no default anywhere in the tree, because a
       reason that can be omitted is a reason that is omitted by the writer with the
       most to explain. The other three — amount, actor, timestamp — the database
       can supply or check; this one only a writer knows, so the schema's only
       contribution is to refuse to hold a row without it. */
    reason TEXT NOT NULL,

    /* The entry this one puts right, and the whole of "corrections are compensating
       entries, never edits".

       Only an ADJUSTMENT may carry one — see
       `leave_ledger_entry_only_an_adjustment_corrects`. That is not tidiness: a
       correction is the one movement whose sign cannot be predicted from its type,
       because putting right an erroneous GRANT of +20 means −20 and putting right
       an erroneous EXPIRY of −5 means +5. ADJUSTMENT is the only type free in its
       sign, so routing every correction through it is what lets the other seven
       keep a fixed one. It also means a correction is always findable as a
       correction rather than disguised as an ordinary grant.

       Nullable, and null is the ordinary case: most entries put nothing right. */
    corrects_id BIGINT REFERENCES leave_ledger_entry(id),

    /* Who, in the two forms `audit_log` keeps them and for the same reason: the id
       is what you join on, the description is what you read when the id belongs to
       nobody. A year rollover posts a GRANT for every employee in the company and
       has no person behind it, and "granted by the year rollover" is an answer
       where a null is a question.

       Both are stamped by `stamp_the_writer_on_a_ledger_entry()` from the setting
       the repositories set, and both are overwritten rather than defaulted, so no
       writer can post an entry under somebody else's name. See the trigger. */
    created_by TEXT NOT NULL,
    created_by_employee_id BIGINT REFERENCES employee(id),

    /* When. Stamped by the same trigger, so no writer can date an entry either.

       A DEFAULT would not be enough here, though it is elsewhere: a default is only
       used by a writer who omits the column, and a balance is rebuilt from these
       rows in the order they were written. An entry dated into last December would
       rewrite a figure that was settled without changing a single existing row,
       which is precisely the failure the immutability triggers exist to prevent,
       arriving by the one door they do not cover. */
    created_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_ledger_entry_type_known CHECK (entry_type IN (
        'GRANT', 'CARRY_FORWARD', 'ADJUSTMENT', 'EXPIRY',
        'RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION')),

    CONSTRAINT leave_ledger_entry_reason_not_blank CHECK (btrim(reason) <> ''),
    CONSTRAINT leave_ledger_entry_created_by_not_blank CHECK (btrim(created_by) <> ''),

    /* Which way each kind of movement goes, held rather than described.

       §5.7 gives the table and this is it as a constraint. An entry of zero days is
       refused by every branch, which is deliberate and is why there is no separate
       rule for it: a movement of no days is not a movement, and a row saying so
       would be a line in somebody's history that explains nothing and has to be
       skipped by every reader forever.

       ADJUSTMENT is the only type free in its sign, because FR 37 says so — HR
       posts "a manual balance adjustment (positive or negative)" — and because
       every correction is one. See `corrects_id` above.

       An unknown `entry_type` makes this CASE return NULL and a NULL CHECK passes;
       `leave_ledger_entry_type_known` is what stops that, and the two constraints
       are load bearing together rather than separately. */
    CONSTRAINT leave_ledger_entry_sign_matches_the_type CHECK (
        CASE entry_type
            WHEN 'GRANT'         THEN days > 0
            WHEN 'CARRY_FORWARD' THEN days > 0
            WHEN 'RELEASE'       THEN days > 0
            WHEN 'RECALCULATION' THEN days > 0
            WHEN 'RESERVATION'   THEN days < 0
            WHEN 'DEDUCTION'     THEN days < 0
            WHEN 'EXPIRY'        THEN days < 0
            WHEN 'ADJUSTMENT'    THEN days <> 0
        END
    ),

    /* FR 24, on the four types that mirror a leave request.

       A request is whole days — LMS 209 put that beyond argument everywhere a day
       count is entered — so a RESERVATION of half a day is not a policy this system
       has, it is a caller that has miscounted. The entitlement four are exempt
       because §8.6d says they are: what somebody has accrued is divisible even
       though what they may ask for is not.

       This is the condition LMS 210 was told to meet in exchange for the column
       being NUMERIC at all. Without it "the ledger holds fractions" would spread to
       mean "leave can be half a day", one query at a time. */
    CONSTRAINT leave_ledger_entry_requests_move_whole_days CHECK (
        entry_type NOT IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION')
        OR days = trunc(days)
    ),

    /* A correction is an ADJUSTMENT, and nothing corrects itself.

       The self-reference is reachable: `id` is assigned before constraints are
       checked, so a writer supplying its own id would otherwise make an entry that
       is its own explanation. */
    CONSTRAINT leave_ledger_entry_only_an_adjustment_corrects CHECK (
        corrects_id IS NULL OR entry_type = 'ADJUSTMENT'),
    CONSTRAINT leave_ledger_entry_corrects_another CHECK (
        corrects_id IS NULL OR corrects_id <> id)
);

/* The one read this table exists to serve: every movement in one balance, oldest
   first. §7.4's reconciliation walks it, a balance screen shows it, and a dispute
   is settled by reading it.

   `id` last, and it is not decoration. A rollover posts a CARRY_FORWARD and a GRANT
   in the same transaction, so `created_at` — which is `now()`, the transaction's
   start — is identical on both, and a sort on the timestamp alone would order them
   differently on different runs. A balance rebuilt in a different order is a
   balance that can disagree with itself. */
CREATE INDEX leave_ledger_entry_balance
    ON leave_ledger_entry (employee_id, leave_type_id, leave_year_id, created_at, id);

/* Everything posted against a leave year, for the rollover and for FR 63's
   liability report. */
CREATE INDEX leave_ledger_entry_by_year ON leave_ledger_entry (leave_year_id, created_at);

/* Corrections, from the corrected end. "Has this entry been put right, and by
   what" is the question somebody asks looking at the wrong figure rather than at
   the row that fixed it, and without this it is a sequential scan of the whole
   history. Partial, because almost every row corrects nothing. */
CREATE INDEX leave_ledger_entry_corrections ON leave_ledger_entry (corrects_id)
    WHERE corrects_id IS NOT NULL;

-- --------------------------------------------------- who wrote it, and when

/* The three columns no writer supplies.

   `record_in_audit_log()` reads the same two settings for the same reason, and this
   is deliberately not that function: that one writes a row in another table, this
   one fills in columns of the row being written. What they share is the setting,
   which is ../src/repositories/recording.ts, so an entry posted inside an audited
   write is attributed to the same person as the write.

   Overwritten rather than defaulted, and the difference is the whole point. A
   DEFAULT applies only when the writer says nothing; a writer that supplies
   `created_by` would then be posting an entry under a name of its own choosing, and
   a writer that supplies `created_at` would be dating one. Neither is a power any
   caller of a ledger should have, including an honest one — the value of "who
   posted this" is that nobody could have chosen it. */

CREATE FUNCTION stamp_the_writer_on_a_ledger_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.created_at := now();

    NEW.created_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.created_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_ledger_entry_records_its_writer
    BEFORE INSERT ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_writer_on_a_ledger_entry();

-- ------------------------------------------- a correction stays in one balance

/* What `corrects_id` may point at, which no CHECK can express because the answer
   is in another row.

   The entry being put right has to be the same person's, the same leave type's and
   the same leave year's. A correction that crossed any of the three would be days
   appearing in one balance because of a mistake in another — the two would each be
   internally consistent, both would be wrong, and the row that explains it says
   "correction" in a way that makes it look explained.

   This is the same class of rule as `refuse_a_holiday_in_a_settled_year()`: a fact
   about another row, so a trigger rather than a constraint, and held for every
   connection rather than for the service alone. */

CREATE FUNCTION refuse_a_correction_across_balances() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    corrected leave_ledger_entry%ROWTYPE;
BEGIN
    IF NEW.corrects_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO corrected FROM leave_ledger_entry WHERE id = NEW.corrects_id;

    /* Unreachable: the foreign key has already found it. Answered rather than
       assumed, because the alternative is a NULL comparison below quietly
       permitting what this function exists to refuse. */
    IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no ledger entry % to correct.', NEW.corrects_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_corrects_the_same_balance';
    END IF;

    IF corrected.employee_id <> NEW.employee_id
       OR corrected.leave_type_id <> NEW.leave_type_id
       OR corrected.leave_year_id <> NEW.leave_year_id
    THEN
        RAISE EXCEPTION
            'Ledger entry % is in a different balance from the correction for it.',
            NEW.corrects_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_corrects_the_same_balance',
                  HINT = 'A correction puts right the balance it is posted in. Days '
                         'moving from one person, leave type or leave year to another '
                         'is two entries and two reasons, not one. FR 27.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_ledger_entry_corrects_the_same_balance
    BEFORE INSERT ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_correction_across_balances();

-- ------------------------------------------ a settled year takes no new figures

/* The rule LMS 205 set and every table since has had to answer, and this is the
   first one that answers it with an exception.

   A closed leave year is final: "closed leave years are never recomputed". So a
   GRANT, a CARRY_FORWARD, an EXPIRY, or any of the four request-shaped types
   arriving in one is a figure being recomputed after it was settled, and is
   refused for the same reason a holiday cannot be added to a closed year.

   **An ADJUSTMENT is permitted, and §8.9 is why.** "If HR genuinely needs to change
   a closed year, that is a manual ADJUSTMENT entry with a reason, not a rule edit."
   The distinction is exactly right and worth keeping: what a closed year refuses is
   being *recalculated* — quietly, by a rule or a job, with nobody's name on it. A
   deliberate, attributed, permanently visible correction is not that. It is the
   only way to put right a settled year, and taking it away would leave HR with no
   way at all, which in practice means a psql prompt.

   That is why the exception is safe: an ADJUSTMENT cannot be posted without a
   reason, cannot be posted anonymously, and cannot be removed afterwards. */

CREATE FUNCTION refuse_a_recalculation_of_a_settled_year() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    settled leave_year%ROWTYPE;
BEGIN
    IF NEW.entry_type = 'ADJUSTMENT' THEN
        RETURN NEW;
    END IF;

    SELECT * INTO settled FROM leave_year WHERE id = NEW.leave_year_id AND is_closed;

    IF FOUND THEN
        RAISE EXCEPTION
            'Leave year % was closed on %, so a % entry cannot be posted against it.',
            settled.label, settled.closed_at, NEW.entry_type
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_leaves_settled_years_alone',
                  HINT = 'A closed leave year is never recalculated. Where the figure '
                         'genuinely has to change, post an ADJUSTMENT with a reason: '
                         'it is deliberate, attributed and permanent, which a '
                         'recalculation is not. §8.9.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_ledger_entry_leaves_settled_years_alone
    BEFORE INSERT ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_recalculation_of_a_settled_year();

-- ------------------------------------------------------ nothing is ever changed

/* FR 27's "immutable", in the three layers NFR AUD 02 is held in, and it is worth
   knowing which covers what:

   | | Covers | Does not cover |
   |---|---|---|
   | lms_app holds no UPDATE or DELETE | the application, which is the writer an attacker reaches | the owner connection |
   | these two triggers | every connection, owner included | TRUNCATE, and a superuser who disables triggers |
   | the application never running as the owner | the whole of the above being worth anything | nothing |

   Both functions are `audit_log`'s. The audit-log migration wrote `refuse_update()`
   for this table before this table existed — "the ledger of Phase 2 wants exactly
   this and should attach to it rather than declaring its own RAISE" — and a second
   copy here would be two places for the SQLSTATE to be got right once.

   A refusal rather than the `DO INSTEAD NOTHING` rule the Technical Design Document
   proposes in §5.7. The argument is the audit log's, and it applies here with more
   force: a rule would make an UPDATE succeed while changing nothing, so somebody
   correcting a balance by hand would see it work, believe the figure had moved, and
   find out in the reconciliation job three weeks later — or not at all. An error
   with a SQLSTATE on it is a question somebody asks the same afternoon. */

CREATE TRIGGER leave_ledger_entry_is_never_changed
    BEFORE UPDATE ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A ledger entry is what a balance is made of, so changing one changes a '
        'figure with nothing to show for it. Post a compensating entry instead: an '
        'ADJUSTMENT for the difference, with corrects_id naming this row and a '
        'reason saying what went wrong. FR 27.'
    );

CREATE TRIGGER leave_ledger_entry_is_never_deleted
    BEFORE DELETE ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A ledger entry is never removed. Days that moved, moved; a balance that '
        'no longer explains itself is worse than one that is wrong. Post a '
        'compensating ADJUSTMENT naming this row instead. FR 27.'
    );

-- ---------------------------------------------------------------- privileges

/* Restated rather than left to the default privileges, which already grant exactly
   this, for the reason the audit log restates them: the default is what makes the
   table append only and it is invisible at the point somebody is reading this file
   asking "can the application fix a wrong entry".

   SELECT, because explaining a balance means reading the account.
   INSERT, because a correction is a new row.
   No UPDATE and no DELETE, ever. Adding either is a decision this comment exists to
   make somebody argue for out loud. */

GRANT SELECT, INSERT ON leave_ledger_entry TO lms_app;

-- ------------------------------------------------------ what is not here yet

/* **The balance.** `leave_balance`, LMS 214: the cached running total of §5.7, the
   five buckets available is computed from, and the reconciliation job of §7.4 that
   recomputes every one of them from these rows and reports any drift. It is not
   here because the cache is only meaningful once there is something to check it
   against, and because the projection — which bucket each entry type moves — is one
   rule that has to live in one place. See the note on `days`: DEDUCTION is the one
   that moves days between two buckets rather than changing their total, and it is
   the case to get right first.

   **The source request.** §5.7 has `leave_request_id` on this table and it is
   deliberately absent, because `leave_request` is §8 and does not exist. A nullable
   id with no foreign key behind it would be a column nothing could populate and
   nothing could check — the switch with nothing behind it that LMS 209 argued
   against. It arrives with the request table, as a column, a foreign key, and the
   rule that the four request-shaped entry types must carry one.

   **The writers.** Every entry type here has a story that writes it and none of
   them has arrived: the year rollover posts GRANT and CARRY_FORWARD, the request
   state machine posts RESERVATION, DEDUCTION and RELEASE, the carry over expiry job
   posts EXPIRY, and FR 25's holiday recalculation posts RECALCULATION. What this
   story ships is the table, its rules, and the one writer that needs nothing else:
   HR posting an ADJUSTMENT under FR 37, and a correction of an earlier entry.

   **The correlation of a reclassification.** §8.6c moves days between two leave
   types — sickness during approved annual leave — as four entries "under one reason
   and one correlation id". `corrects_id` is not that: it says one entry puts
   another right, within one balance, which is the trigger above. A correlation
   spans two balances on purpose and is a different column with a different rule,
   and it belongs with the story that performs the reclassification. */

-- Down Migration

DROP TRIGGER IF EXISTS leave_ledger_entry_is_never_deleted ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_ledger_entry_is_never_changed ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_ledger_entry_leaves_settled_years_alone ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_ledger_entry_corrects_the_same_balance ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_ledger_entry_records_its_writer ON leave_ledger_entry;

DROP FUNCTION IF EXISTS refuse_a_recalculation_of_a_settled_year();
DROP FUNCTION IF EXISTS refuse_a_correction_across_balances();
DROP FUNCTION IF EXISTS stamp_the_writer_on_a_ledger_entry();

DROP TABLE IF EXISTS leave_ledger_entry;

/* refuse_update() stays. It belongs to the audit-log migration and is still
   attached to the audit log.

   refuse_delete() stays too, and goes back to the shape that migration left it in:
   the employee hint, hard coded, with no argument read. Both of its callers then
   are `employee` and `audit_log`, which is where they were before this file ran —
   so the audit log goes back to its slightly wrong hint as well. A down migration
   restores the previous state rather than the state somebody would prefer. */

CREATE OR REPLACE FUNCTION refuse_delete() RETURNS trigger
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

DROP TRIGGER IF EXISTS audit_log_is_never_deleted ON audit_log;

CREATE TRIGGER audit_log_is_never_deleted
    BEFORE DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete();
