-- Up Migration

-- The cached balance. §5.7, design principle 1. LMS 211.
--
-- "The ledger is the truth; balances are a cache." LMS 210 built the first half of
-- that sentence and said, four times and in four files, that this table was the
-- second. Those files call this story LMS 214, which is what the backlog called it
-- when they were written. A merged migration is never edited, so they still say so;
-- this is that table.
--
-- The story is somebody opening the system on a Monday morning and seeing what they
-- have left. `leave_ledger_entry` can answer that question — it is the only thing
-- that can answer it *correctly* — but answering it means adding up every movement
-- in every balance the person has, every time any screen mentions a figure. This
-- table is that sum, kept.
--
-- ## Five columns, and they are not one number
--
-- `entitled + carried_over + adjustment − taken − pending`. Available is a
-- subtraction of five figures rather than a running total, and §5.7 keeps them
-- apart for a reason the ledger migration already had to state: a RESERVATION of
-- −5 and the DEDUCTION of −5 that follows it on approval are five days gone once,
-- not ten. The second does not consume days a second time, it moves them from held
-- to taken. Any cache that added signed days into a single column would get that
-- wrong, silently, in the direction that lets somebody book leave twice.
--
-- So the five buckets are the whole of the projection, and which one each kind of
-- movement moves is `BUCKETS` in ../src/domain/ledger.ts — written there, by LMS
-- 210, as the statement of what this story had to implement. The implementation is
-- `rebuild_one_balance_from_the_ledger()` below, and
-- ../tests/integration/balance.test.ts asserts the two agree by posting one entry
-- of each of the eight kinds and checking that exactly the named columns moved.
--
-- ## The cache is a function of the ledger, recomputed rather than nudged
--
-- The obvious implementation adds the new entry's days to the affected columns.
-- This one throws the five figures away and adds up that balance's ledger rows
-- again, on every entry.
--
-- It costs an aggregate over a few dozen rows — `leave_ledger_entry_balance` is
-- exactly this key — and it buys the property the story is named after: the cache
-- cannot drift. Not "does not drift if every writer remembers": there is no
-- arithmetic anywhere that could be wrong by a day, because nothing is carried
-- forward from the previous value. A row that was wrong is corrected by the next
-- entry posted against it, and §7.4's reconciliation job becomes a call to this
-- function for every balance rather than a second implementation of the sum.
--
-- A nudge would also have to be exactly right at 3am during a year rollover. This
-- has to be exactly right once.
--
-- ## Nothing above the database may write it
--
-- `lms_app` holds SELECT and no INSERT — the one table in this schema to give the
-- default privileges back — and the trigger below is SECURITY DEFINER so that the
-- ledger can still keep the cache in step. `refuse_a_balance_written_by_hand()`
-- says the same thing to the owner.
--
-- That is the acceptance criterion "updated in the same transaction as the ledger
-- entry", held as a property rather than as a convention. A balance changes because
-- a ledger entry was posted, in that entry's transaction, or it does not change:
-- there is no service to forget, no job to get wrong, and no psql prompt that can
-- move somebody's figures without leaving the row that explains them.

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_balance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The three columns every balance in this system is keyed by, the same three
       `leave_ledger_entry` carries, and the story's third criterion: unique per
       employee, leave type and leave year. `leave_balance_one_per_year` below is
       what makes that literal.

       Real foreign keys, for the reason the ledger gives: a cached figure filed
       under an employee who does not exist is not a hard-to-read row, it is days
       nobody has. */
    employee_id BIGINT NOT NULL REFERENCES employee(id),
    leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
    leave_year_id BIGINT NOT NULL REFERENCES leave_year(id),

    /* What the year granted. GRANT entries, and nothing else.

       Never corrected in place: putting right a wrong grant is an ADJUSTMENT, which
       lands in `adjustment` below and stays visible as a correction rather than
       disappearing into the figure it corrects. That is the ledger's rule and this
       column inherits it by having no other kind of entry feeding it. */
    entitled NUMERIC(8,2) NOT NULL DEFAULT 0,

    /* What survived last year end, less whatever has lapsed since. FR 36 and FR
       36a: CARRY_FORWARD adds, EXPIRY takes away, and they share a column because
       carried days and the expiry of carried days are the same days. Splitting them
       would make "how many carried days are left" a subtraction somebody has to
       know to perform. */
    carried_over NUMERIC(8,2) NOT NULL DEFAULT 0,

    /* What HR moved by hand. FR 37, and the only bucket that goes either way.

       Kept apart from `entitled` deliberately, and this is the column an employee
       looking at a surprising figure reads first: it is the difference between "the
       policy gave me this" and "somebody decided this", and merging the two would
       make every manual movement indistinguishable from an entitlement rule. */
    adjustment NUMERIC(8,2) NOT NULL DEFAULT 0,

    /* Days actually consumed by approved leave, held as a positive count. DEDUCTION
       adds to it and RECALCULATION gives days back — FR 25, when a holiday is
       gazetted inside leave already approved.

       INTEGER, and the three columns above are not. §8.6d pro rates a mid year
       joiner to 20 × 184/365 = 10.08 days, so what somebody is *owed* may carry a
       fraction; what they have *taken* may not, because FR 24 says a request is
       whole days and `leave_ledger_entry_requests_move_whole_days` refuses one that
       is not. LMS 209 asked for exactly this line and LMS 210 drew it inside the
       ledger's own column; this is the same line drawn between two columns, where
       it is visible in the schema rather than in a constraint.

       That constraint is also what makes the assignment below exact. The four
       request-shaped kinds cannot be fractional, so a sum of them cannot be, and
       the numeric total that lands here loses nothing on the way. */
    taken INTEGER NOT NULL DEFAULT 0,

    /* Days held for leave that has been asked for and not yet decided, as a
       positive count. RESERVATION adds, RELEASE gives back when a request is
       refused or withdrawn, and DEDUCTION moves them into `taken` on approval.

       Held apart from `taken` because they are not the same fact and a screen has
       to say both: five days pending is leave somebody may still be told they
       cannot have. Subtracted from available all the same — days spoken for are not
       days to spend twice, which is the double booking §7.4 exists to prevent. */
    pending INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Maintained by the leave_balance_set_updated_at trigger, which attaches to the
       same set_updated_at() every other table uses. Never supplied by a writer —
       and here that is not a convention, since no writer supplies anything. */
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* The story's third criterion, and the thing `ON CONFLICT` needs to exist.

       One row per person per type per year. Two rows for one balance would be two
       answers to "what do I have left", and the screen would show whichever the
       query happened to reach first. */
    CONSTRAINT leave_balance_one_per_year UNIQUE (employee_id, leave_type_id, leave_year_id)
);

/* **There is no CHECK on any of the five figures, and that is the decision this
   comment exists to defend.**

   `pending >= 0` is true of every correct history, and so is `entitled >= 0`. Both
   are tempting and both would be wrong here, because of what a cache refusing a
   value would actually do: the write that violated it would be the trigger's, the
   trigger's failure would roll back the INSERT that fired it, and the thing refused
   would be a *ledger entry*. A movement that genuinely happened would be
   unrecordable because the cache of it looked wrong.

   That is exactly backwards. The ledger is the truth; a figure here that looks
   impossible is this table saying so, and the answer is §7.4's reconciliation
   report — not a constraint that makes the account unwritable. §8.6b already needs
   the latitude anyway: sick leave balances go negative on purpose, and "that is
   correct".

   The keys, the uniqueness and the foreign keys are constrained, because those are
   facts about filing rather than about arithmetic. */

/* Everybody's figures for one year, for FR 63's liability report and for the
   rollover. The unique constraint's index already serves a read of one person's
   balances, which is the read a screen does. */
CREATE INDEX leave_balance_by_year ON leave_balance (leave_year_id, leave_type_id);

-- ------------------------------------------------- the sum, in exactly one place

/* Adds up one balance from the ledger and writes it down.

   The whole of the projection. Every figure in this table comes from this function
   and there is no other statement anywhere — in the schema or above it — that
   computes a balance. That is the rule the ledger migration set when it declined to
   write one ("a total computed in two places is the drift the cached balance exists
   to be checked against"), kept by there being one place rather than by everybody
   agreeing.

   ## Which entries move which column

   §5.7's second table, and `BUCKETS` in ../src/domain/ledger.ts is the same
   statement in the language the screens are written in. Two things about it are
   worth reading slowly:

     **`taken` and `pending` are positive counts of negative movements.** A
     RESERVATION is −5 days in the ledger and +5 pending here. The ledger records
     which way the balance moved; this table records how many days are in each
     bucket, and available subtracts. Getting this backwards produces a system that
     adds days to somebody every time they ask for leave.

     **DEDUCTION appears twice, and is the only kind that does.** Approval does not
     consume days again — the reservation already did — so it takes five days out of
     `pending` and puts five into `taken`, leaving available unmoved. This is the
     case to get right first and the one every ad hoc balance query gets wrong.

   ## Two statements, and the order is the concurrency argument

   The first is an upsert that writes no figures. Its only job is to make the row
   exist and to hold its lock: `ON CONFLICT DO UPDATE` locks the conflicting row,
   where `DO NOTHING` would not, and a second transaction posting against the same
   balance waits here rather than further down.

   The second computes the sums and stores them. It is a separate statement on
   purpose, because a statement in READ COMMITTED takes its snapshot when it starts
   — and this one starts after the wait above, so it sees the entry the other
   transaction committed. Written as one statement with the aggregate inside the
   upsert, both transactions would read the ledger before either took the lock, and
   the second would overwrite the first's total with a sum that was missing a row.
   The cache would be short by a day, with nothing in the ledger to say why.

   SECURITY DEFINER because `lms_app` holds no INSERT or UPDATE on this table and
   must never hold one, and the ledger still has to keep the cache in step. Safe to
   leave callable by anybody, which is unusual for a privileged function and is a
   property of what it does rather than of who calls it: the only thing it can write
   is what the ledger already says. Calling it spuriously wastes an aggregate. */

CREATE FUNCTION rebuild_one_balance_from_the_ledger(
    for_employee BIGINT,
    of_leave_type BIGINT,
    in_leave_year BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM set_config('lms.balance.from_the_ledger', 'on', true);

    INSERT INTO leave_balance (employee_id, leave_type_id, leave_year_id)
    VALUES (for_employee, of_leave_type, in_leave_year)
    ON CONFLICT ON CONSTRAINT leave_balance_one_per_year
        DO UPDATE SET employee_id = leave_balance.employee_id;

    UPDATE leave_balance SET
        entitled = totals.entitled,
        carried_over = totals.carried_over,
        adjustment = totals.adjustment,
        taken = totals.taken,
        pending = totals.pending
    FROM (
        SELECT
            coalesce(sum(days) FILTER (WHERE entry_type = 'GRANT'), 0) AS entitled,
            coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
                AS carried_over,
            coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
            coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0)
                AS taken,
            coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
                FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0)
                AS pending
        FROM leave_ledger_entry
        WHERE employee_id = for_employee
          AND leave_type_id = of_leave_type
          AND leave_year_id = in_leave_year
    ) AS totals
    WHERE leave_balance.employee_id = for_employee
      AND leave_balance.leave_type_id = of_leave_type
      AND leave_balance.leave_year_id = in_leave_year;

    PERFORM set_config('lms.balance.from_the_ledger', '', true);
END
$$;

-- ------------------------------------------ in the same transaction, or not at all

/* The story's second criterion, and the reason it is a trigger.

   A service that posted an entry and then updated the balance would meet the
   criterion for as long as every writer went through that service. Six of the eight
   entry types have no writer yet — the rollover, the request state machine, the
   expiry job, FR 25's recalculation — and each of them is a story that could
   forget. A trigger cannot be forgotten by a caller that does not know it exists,
   which is the only kind of guarantee worth having here.

   AFTER rather than BEFORE, so the entry is on the table when the sum is taken and
   the aggregate below includes the row that caused it.

   FOR EACH ROW rather than a statement trigger, because `postAll()` writes a
   rollover's CARRY_FORWARD and GRANT in one transaction and each is a different
   balance. The recompute is idempotent, so two entries in one balance recompute it
   twice and land on the same figures. */

CREATE FUNCTION keep_the_balance_in_step_with_the_ledger() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM rebuild_one_balance_from_the_ledger(
        NEW.employee_id, NEW.leave_type_id, NEW.leave_year_id);

    RETURN NULL;
END
$$;

CREATE TRIGGER leave_ledger_entry_keeps_the_balance_in_step
    AFTER INSERT ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION keep_the_balance_in_step_with_the_ledger();

-- --------------------------------------------- and no other way of moving a figure

/* Nothing writes a balance except the ledger. Held for every connection, including
   the one that ran this migration.

   The privileges below stop the application, and they are the half that matters for
   an attacker. This is the half that matters for a colleague: somebody who can see
   that a figure is wrong, has psql open, and can see the column that would fix it.
   The row they would type is a balance that no longer explains itself — the exact
   thing design principle 1 is about — and it would survive until the next entry
   posted against that balance silently reverted it, which is worse than being
   refused.

   So the refusal names the way through. It is not a locked door: posting a ledger
   entry moves the figure, in the same transaction, and leaves the row that says
   why.

   The setting is transaction-local and is set by
   `rebuild_one_balance_from_the_ledger()` alone, which is the only function that
   writes this table. It is the same mechanism `record_in_audit_log()` and
   `stamp_the_writer_on_a_ledger_entry()` read for the writer's name, used here for
   a different question — not "who is writing" but "did this come from the ledger". */

CREATE FUNCTION refuse_a_balance_written_by_hand() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* Unset reads as NULL rather than as a value, which is why this is written as a
       coalesce and not as an equality: `NULL = 'on'` is NULL, an IF on NULL does not
       branch, and the refusal below would still be reached — but by accident rather
       than by saying so, and the next person to add a condition here would not know
       that. */
    IF coalesce(current_setting('lms.balance.from_the_ledger', true), '') = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'A leave balance is a cache of the ledger, so % is not how it changes.',
        lower(TG_OP)
        USING ERRCODE = 'restrict_violation',
              CONSTRAINT = 'leave_balance_comes_only_from_the_ledger',
              HINT = 'Post a leave_ledger_entry. The balance is recomputed from the '
                     'ledger in the same transaction, and a figure written here '
                     'instead would be one nothing can explain — and would be '
                     'reverted by the next entry posted against it. §5.7.';
END
$$;

CREATE TRIGGER leave_balance_comes_only_from_the_ledger
    BEFORE INSERT OR UPDATE OR DELETE ON leave_balance
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_balance_written_by_hand();

/* Reused rather than copied, as every other table's does. The employee-record-rules
   migration wrote it for exactly this: "The leave tables of Phase 2 want the same
   behaviour and should reuse this function rather than each declaring their own
   copy of two lines of plpgsql." */

CREATE TRIGGER leave_balance_set_updated_at
    BEFORE UPDATE ON leave_balance
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------- what is here already

/* Every balance the ledger already knows about.

   `leave_ledger_entry` has existed since LMS 210 and this table has not, so a
   database that has been running has movements with no cache in front of them. A
   migration that created an empty table would leave every one of those balances
   reading zero until the next entry happened to be posted against it — which for a
   settled year is never.

   The same call the trigger makes, once per distinct balance, which is what makes
   this a backfill rather than a second implementation of the sum. */

SELECT rebuild_one_balance_from_the_ledger(employee_id, leave_type_id, leave_year_id)
FROM (
    SELECT DISTINCT employee_id, leave_type_id, leave_year_id FROM leave_ledger_entry
) AS balances;

-- ---------------------------------------------------------------------- privileges

/* The one table in this schema that gives the default privileges back.

   The restricted-application-role migration grants `lms_app` SELECT and INSERT on
   every future table, and says why that is the right default: "Forgetting the
   explicit grant on an ordinary table produces a loud permission error; the reverse
   arrangement, granting everything and revoking on those two, fails silently and
   leaves the ledger writable."

   This table is neither shape. It is not written by the application at all, so the
   INSERT the default hands over is a power with no caller — and a power with no
   caller is the one a future story reaches for when a balance looks wrong at five
   on a Friday. Taking it back is three words, and the SELECT that remains is the
   whole of what the application needs: this table exists to be read. */

REVOKE INSERT ON leave_balance FROM lms_app;

GRANT SELECT ON leave_balance TO lms_app;

-- ------------------------------------------------------------- what is not here yet

/* **An `available` column.** `entitled + carried_over + adjustment − taken −
   pending` is a subtraction of the five figures rather than a sixth fact, and it is
   ../src/domain/balance.ts. A generated column would keep it in step and would put
   the formula in two languages; a report that needs it in SQL should have a view,
   and can have one on the day there is a report.

   **The reconciliation job.** §7.4 recomputes every balance from the ledger and
   reports any drift. Most of it is here already —
   `rebuild_one_balance_from_the_ledger()` is the recompute, and it is deliberately
   callable for a balance nothing has just posted against — and what is missing is
   the walk over every balance, the comparison, and somebody to tell. That is a
   story with a schedule and a report in it rather than a table.

   **The writers that fill these columns.** `entitled` and `carried_over` are the
   year rollover's, `taken` and `pending` are the request state machine's, and none
   of those exist. Today every figure here arrives through FR 37's manual
   adjustment, which is the one ledger writer LMS 210 shipped. The columns are not
   waiting on anything: an entry of any of the eight kinds lands in the right bucket
   the moment somebody writes the story that posts it.

   **Anything about a leave year that is not a balance.** The rollover of FR 36
   decides *which* days carry and how many lapse; this table records where they
   ended up. "This year is settled" and "these days move" stay two decisions, which
   is what the leave-year-rules migration asked for. */

-- Down Migration

DROP TRIGGER IF EXISTS leave_ledger_entry_keeps_the_balance_in_step ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_balance_set_updated_at ON leave_balance;
DROP TRIGGER IF EXISTS leave_balance_comes_only_from_the_ledger ON leave_balance;

DROP FUNCTION IF EXISTS keep_the_balance_in_step_with_the_ledger();
DROP FUNCTION IF EXISTS refuse_a_balance_written_by_hand();
DROP FUNCTION IF EXISTS rebuild_one_balance_from_the_ledger(BIGINT, BIGINT, BIGINT);

DROP TABLE IF EXISTS leave_balance;

/* Nothing is lost. Every figure this table held is the sum of ledger rows that are
   all still there, and running this migration again rebuilds all of it — which is
   the clearest statement there is of what a cache is. `set_updated_at()` stays: it
   belongs to the employee-record-rules migration and is attached to five other
   tables. */
