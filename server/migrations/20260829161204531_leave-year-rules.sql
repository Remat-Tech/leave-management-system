-- Up Migration

-- The leave year, and what closing one means. §5.4. LMS 205.
--
-- Every balance in this system is per person, per leave type, per leave year.
-- The first two have had tables since LMS 201; this is the third, and until now
-- "the leave year" has been an idea that several files referred to and nothing
-- held. The entitlement-rule migration said so in as many words: "The closed
-- leave year is LMS 205. `leave_year` and its closed flag do not exist yet."
--
-- The story is closing one. An HR Administrator settles 2026 — every request
-- decided, every leaver's final figure paid out, every late entry made — and then
-- says so, and after that the year's numbers are what they were on the day it was
-- said. Not by anybody remembering, but because there is no arrangement of rows
-- that could move them.
--
-- ## Two rules, and both are about the same question
--
-- "Which leave year is this day in?" has to have exactly one answer, always.
--
--   **No two years may overlap.** A day in two years is a day whose balance is
--   drawn from two allowances, and every report of it is a choice of which one to
--   believe. Held as an exclusion constraint, which is the tool the README names
--   Postgres for: "range exclusion constraints for overlapping leave".
--
--   **No two years may leave a gap between them.** A day in no year is worse,
--   because it fails quietly: a request lands on it, the balance it should draw
--   from does not exist, and nothing refuses anything. The rollover of FR 36
--   carries unused days from one year into the next, and a gap is a year with
--   nothing to carry into.
--
-- A gap *after* the last year is not a gap, it is a year nobody has defined yet,
-- and this database ships with exactly one of those — 2028 onwards. The rule is
-- about the space between two years that both exist.
--
-- ## What closing does today, and what it will do
--
-- Today it does two things. The row itself becomes history — the flag cannot go
-- back, the dates cannot move, and the row cannot be deleted, by any writer on
-- any connection. And it moves the boundary `EarliestOpenDay` reads in
-- ../src/domain/entitlement-rule.ts, so that no entitlement figure can be dated
-- back into a year that has been settled. That second one is the whole of what
-- LMS 203 left for this story, and it said so: "the caller brings
-- NOTHING_IS_CLOSED_YET, which is a truthful statement rather than a stub".
-- It is no longer the truthful statement, so it is no longer what the caller
-- brings.
--
-- What it will do is refuse a ledger entry and a balance write against a closed
-- year, and that is LMS 210 and LMS 214 rather than anything here: the tables do
-- not exist, and a flag that guards nothing is a flag nobody trusts. What this
-- file gives those stories is a row to point a foreign key at and a boolean to
-- read — see the note at the foot.

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_year (
    id         BIGSERIAL PRIMARY KEY,

    /* What HR calls it. '2026' today, and deliberately not derived from
       start_date: that arithmetic is right for a year that runs January to
       December and wrong the moment somebody runs April to March, where the year
       everybody says out loud is '2026/27'. A leave year that has to be renamed
       by a deployment is the thing FR 31 exists to prevent. */
    label      VARCHAR(40) NOT NULL,

    /* The first and last day the year covers, inclusive both ends.

       DATE and not TIMESTAMPTZ, for the reason every leave date in this schema is
       one: a year begins on a day, not at an instant, and a moment would carry a
       zone that moves it. NFR DAT 03. Inclusive at both ends because that is how
       a person says it — 2026 runs from the first of January to the thirty first
       of December, not to "the first of January 2027, exclusive". */
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,

    /* Settled. The one column this story is about.

       FALSE for a year that is still running or still being tidied up, TRUE for
       one whose figures are final. It never goes back: see
       keep_a_closed_leave_year_closed() below, which holds that against every
       writer rather than against the ones who come through the service. */
    is_closed  BOOLEAN NOT NULL DEFAULT FALSE,

    /* When it was closed, stamped by the trigger rather than by a writer — the
       same arrangement updated_at has, and for the same reason: a year closed
       from a psql prompt gets the stamp too, rather than only the writer who
       remembered.

       Who closed it is not a column. That is the audit log, by the argument
       LMS 111 made when it left user_role.granted_by out: "the place for who did
       what is the audit log rather than a column beside every row". */
    closed_at  TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT leave_year_label_not_blank CHECK (btrim(label) <> ''),

    /* A year that ends before it starts covers no day at all, so every reading of
       it is "this year is nothing" — which is never what somebody typing it
       meant. Strictly greater, because a leave year of one day is a typo in the
       same family rather than a policy. */
    CONSTRAINT leave_year_runs_forwards CHECK (end_date > start_date),

    /* The stamp and the flag stand or fall together, the same shape as
       leave_type_documentation_agrees and leave_entitlement_rule_carryover_agrees.
       A closed year with no closing date is a lock nobody can date; a closing
       date on an open year is a fact about an event that has not happened. */
    CONSTRAINT leave_year_closed_at_agrees
        CHECK (is_closed = (closed_at IS NOT NULL))
);

-- ------------------------------------------- one leave year per day, and no more

/* The overlap rule, as the exclusion constraint the README bought Postgres for.

   `daterange(start_date, end_date, '[]')` is the year as the days it actually
   covers — inclusive at both ends, which is what the two columns mean — and `&&`
   is "shares at least one day with". So the constraint reads as the sentence it
   is: no two leave years may share a day.

   A unique index cannot say it. Uniqueness is about equal values, and the pair
   this refuses is 2026 against a "2026" somebody typed as running to the thirty
   first of January 2027 — two different rows, eleven months apart, overlapping by
   a month.

   DEFERRABLE INITIALLY DEFERRED, and it is worth being clear that this is not the
   usual reason. The intermediate state it permits is moving the boundary *between*
   two years: taking 2027 from a January start to an April one means moving 2026's
   end as well, and whichever of the two statements runs first overlaps the other
   for the length of it. Nothing in this story performs that operation — see the
   note at the foot — and the constraint is deferrable so that the story which does
   is a service method rather than a migration. */

/* No `btree_gist`. One range column compared with one operator is what plain gist
   is for; the extension is what you need to put a scalar equality beside a range
   overlap in the same constraint, which is the shape the overlapping *leave
   request* rule of §8 will want — one employee, and their dates. That story
   brings it. */

ALTER TABLE leave_year
    ADD CONSTRAINT leave_year_never_overlaps
    EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
    DEFERRABLE INITIALLY DEFERRED;

/* And the other half, which no constraint can express because it is a statement
   about the row beside this one rather than about this one.

   A day in no leave year is the failure that does not announce itself. An overlap
   is caught the first time two reports disagree; a gap is a request in March 2028
   drawing down a balance that was never opened, and the first person to notice is
   somebody whose days do not add up in the following January.

   Checked from both sides of the row being written, which is what makes the order
   years are created in irrelevant: a year inserted before an existing one is
   judged against the year that now follows it, and one inserted after against the
   year that now precedes it. Inserting 2030 while 2029 does not exist is refused
   and says to define 2029 first, which is the answer.

   The year at each end of the table has no neighbour on one side and is judged on
   the other only. That is the difference between "a gap" and "a year nobody has
   defined yet": this database ships with 2026 and 2027 and nothing after, and
   2028 is not missing, it is next year's decision.

   Deferred, for the ordinary reason: moving a boundary is two statements and the
   state between them is nobody's business. */

CREATE FUNCTION refuse_a_gap_between_leave_years() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    ends_before   DATE;
    starts_after  DATE;
BEGIN
    SELECT max(end_date) INTO ends_before
      FROM leave_year
     WHERE end_date < NEW.start_date;

    IF ends_before IS NOT NULL AND ends_before <> NEW.start_date - 1 THEN
        RAISE EXCEPTION
            'Leave year "%" starts on %, leaving the days after % in no leave year.',
            NEW.label, NEW.start_date, ends_before
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'leave_year_leaves_no_gap',
                  HINT = 'Leave years run one after another with no day between '
                         'them. A day in no year is a day whose leave draws on a '
                         'balance that was never opened. §5.4.';
    END IF;

    SELECT min(start_date) INTO starts_after
      FROM leave_year
     WHERE start_date > NEW.end_date;

    IF starts_after IS NOT NULL AND starts_after <> NEW.end_date + 1 THEN
        RAISE EXCEPTION
            'Leave year "%" ends on %, leaving the days before % in no leave year.',
            NEW.label, NEW.end_date, starts_after
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'leave_year_leaves_no_gap',
                  HINT = 'Leave years run one after another with no day between '
                         'them. Define the year that fills the gap first. §5.4.';
    END IF;

    -- AFTER trigger. The return value is discarded; this either lets the
    -- transaction stand or has raised above.
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_year_leaves_no_gap
    AFTER INSERT OR UPDATE ON leave_year
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_gap_between_leave_years();

-- ------------------------------------------------ a closed year is history

/* The lock the story is about, and the reason it is a trigger rather than a rule
   in the service: the service is not the only writer. A correction applied from a
   psql prompt at half past six is exactly the way a settled year gets reopened,
   adjusted and closed again with nobody the wiser, and the whole value of "these
   figures are final" is that it is true of every connection.

   Four things this refuses and one it does.

     **Closing a year that has not ended.** The mistake that actually happens: it
     is the third of January, somebody is tidying up, and the year they close is
     the one that started two days ago. A year still running has requests in
     flight, and closing it would freeze figures that everybody expects to move.
     The refusal is on the date rather than on anybody's judgement about whether
     the year is settled — that part is HR's, and FR 18's backdating window means
     they will wait a week after the end whatever this says.

     **Reopening a closed year.** The lock, said plainly. There is no service
     method for it and no privilege that reaches it: reopening a settled year is a
     migration with an argument attached, which is the right price for undoing a
     decision of this size, and it is the same price the audit log charges for its
     own immutability.

     **Moving a closed year's dates.** Reopening by another route. Every figure in
     that year was calculated against those days, and a year that quietly grew a
     month is every balance in it being wrong by however many days that month
     held.

     **Deleting a closed year.** lms_app holds no DELETE on this table at all, so
     this is aimed at the owner connection, and it is the same argument the
     audit log makes: the row is the heading a year of history is filed under.

   What it does is stamp `closed_at`. That is here rather than in a maintenance
   trigger of its own because the stamp and the refusals are one event seen from
   two sides — a writer that could set the flag without the stamp could close a
   year without recording when, and the CHECK above would then refuse the write
   with a message about a column nobody set on purpose.

   A year that is still open may be corrected freely: its label, its dates, all of
   it. It has settled nothing, and the honest fix for a year typed wrong in
   January is to fix it. */

CREATE FUNCTION keep_a_closed_leave_year_closed() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.is_closed THEN
            RAISE EXCEPTION
                'Leave year "%" was closed on % and cannot be deleted.',
                OLD.label, OLD.closed_at
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_year_closed_is_final',
                      HINT = 'A closed year is the heading a year of balances and '
                             'ledger entries is filed under. §5.4.';
        END IF;

        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_closed THEN
            IF NEW.end_date >= current_date THEN
                RAISE EXCEPTION
                    'Leave year "%" ends on % and has not finished yet, so it cannot be closed.',
                    NEW.label, NEW.end_date
                    USING ERRCODE = 'check_violation',
                          CONSTRAINT = 'leave_year_closed_is_final',
                          HINT = 'Close a year once it has ended and its requests '
                                 'have been settled. §5.4.';
            END IF;

            NEW.closed_at := coalesce(NEW.closed_at, now());
        END IF;

        RETURN NEW;
    END IF;

    IF NOT OLD.is_closed AND NEW.is_closed THEN
        IF NEW.end_date >= current_date THEN
            RAISE EXCEPTION
                'Leave year "%" ends on % and has not finished yet, so it cannot be closed.',
                NEW.label, NEW.end_date
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'leave_year_closed_is_final',
                      HINT = 'Close a year once it has ended and its requests '
                             'have been settled. Nothing is settled about a year '
                             'people are still taking leave in. §5.4.';
        END IF;

        NEW.closed_at := coalesce(NEW.closed_at, now());

        RETURN NEW;
    END IF;

    IF NOT OLD.is_closed THEN
        -- Still open, and staying open. Correct it freely.
        RETURN NEW;
    END IF;

    IF NOT NEW.is_closed THEN
        RAISE EXCEPTION
            'Leave year "%" was closed on % and cannot be reopened.',
            OLD.label, OLD.closed_at
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_year_closed_is_final',
                  HINT = 'Its balances are what they were on the day it was '
                         'closed, and reopening it would let them move. §5.4.';
    END IF;

    IF NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.end_date IS DISTINCT FROM OLD.end_date
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
    THEN
        RAISE EXCEPTION
            'Leave year "%" was closed on %, so the days it covers cannot be changed.',
            OLD.label, OLD.closed_at
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_year_closed_is_final',
                  HINT = 'Every figure in that year was calculated against those '
                         'days. Moving them is reopening it by another route. §5.4.';
    END IF;

    /* The label may still be improved, exactly as the note on an entitlement rule
       in effect may. Calling a year by a better name does not change which days
       it covered or what anybody was owed in it. */
    RETURN NEW;
END
$$;

CREATE TRIGGER leave_year_closed_is_final
    BEFORE INSERT OR UPDATE OR DELETE ON leave_year
    FOR EACH ROW
    EXECUTE FUNCTION keep_a_closed_leave_year_closed();

-- ---------------------------------------------------------- how it is read

/* Both reads this table gets, and neither of them is by id.

   "Which year is this day in" is every balance question there is, and it is a
   containment search on the two dates. "Which years have been closed" is the
   boundary EarliestOpenDay reads, and it wants the latest of them. */

CREATE INDEX leave_year_by_day ON leave_year (start_date, end_date);

CREATE INDEX leave_year_closed ON leave_year (end_date DESC) WHERE is_closed;

/* One year to a name, without regard to case, the same way a department and a
   working pattern are named. Two years called '2026' is a screen where somebody
   picks the wrong one, and the overlap constraint would not catch it — '2026' and
   '2026' covering different decades are two perfectly disjoint rows. */

CREATE UNIQUE INDEX leave_year_label_unique ON leave_year (lower(label));

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the
   department rules has reused them.

   The audit trigger is the record of the one act this story is about. NFR AUD 01
   names configuration changes, and closing a leave year is the largest of them:
   `closed_at` says when and this says who, which is the pair a dispute about a
   settled balance is answered with. */

CREATE TRIGGER leave_year_set_updated_at
    BEFORE UPDATE ON leave_year
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_year_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_year
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration. UPDATE is granted because closing a year
   is an update and is the story.

   DELETE is not, and it is the same load bearing omission `leave_type` carries. A
   leave year is the heading every balance, every ledger entry and every report of
   either is filed under, so a deleted row takes a year of history with it. A year
   nobody has used yet is a typo worth being able to remove, and the owner can —
   the trigger above stops at closed years — but the application never needs to
   and so never may. */

GRANT UPDATE ON leave_year TO lms_app;

-- ------------------------------------------------------- 2026 and 2027

/* The two years the system goes live with, as reference data with an owner.

   Reference data by the same argument as the seven leave types and the standard
   Monday to Friday week: a production database is migrated and never seeded, and
   a leave system with no leave year is one where no balance can be opened at all.
   The entitlement-rule migration already dated the statutory figures from the
   first of January 2026 and called it "the first of the two LMS 205 seeds", so
   these two dates are not a new decision — they are the one already made, written
   down where it belongs.

   Owned by a function for the reason LMS 202 gave, and it earns it here for a
   reason of its own: 2026 will be closed one day, and a database restored from a
   backup taken before that is a database where the *year* is missing rather than
   merely its flag. Putting it back is a call.

   Two years rather than one because the rollover of FR 36 needs somewhere to
   carry into on the thirty first of December 2026, and a company that has to
   define next year in the last week of this one will define it in January. */

CREATE FUNCTION ensure_the_first_leave_years() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    /* Whoever the caller said they were, kept and put back, as its two siblings
       do it. A leave year that reappeared should say where it came from. */
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_the_first_leave_years()'),
        true);

    INSERT INTO leave_year (label, start_date, end_date)
    SELECT * FROM (VALUES
        ('2026', DATE '2026-01-01', DATE '2026-12-31'),
        ('2027', DATE '2027-01-01', DATE '2027-12-31')
    ) AS first_years (label, start_date, end_date)
    /* Guarded on both identifiers, as the seven leave types are and for the same
       reason: either being taken means somebody already has this year under an
       arrangement of their own, and theirs is the one that stays. The days are
       the identifier that matters — a year covering any of them is that year,
       whatever it is called — and the label is checked as well so that a company
       running April to March, whose '2026' covers different days, is left alone
       rather than refused by leave_year_label_unique. */
    WHERE NOT EXISTS (
        SELECT 1 FROM leave_year existing
         WHERE daterange(existing.start_date, existing.end_date, '[]')
               && daterange(first_years.start_date, first_years.end_date, '[]')
            OR lower(existing.label) = lower(first_years.label)
    );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

/* Nobody but the owner may run it, as with its siblings. lms_app holds INSERT on
   the table and creates leave years through the service, so this withholds no
   power it has elsewhere; restoring reference data is an operator's job, done
   knowingly. */

REVOKE EXECUTE ON FUNCTION ensure_the_first_leave_years() FROM PUBLIC;

DO $$
DECLARE
    inserted INTEGER;
BEGIN
    inserted := ensure_the_first_leave_years();

    RAISE NOTICE 'Wrote % leave year(s).', inserted;
END
$$;

-- ------------------------------------------------------ what is not here yet

/* **The balances the flag protects.** `leave_balance` and `leave_ledger_entry`
   arrive with LMS 210 and LMS 214, each carrying a `leave_year_id` and each
   refusing a write against a year this table says is closed. That is where "its
   balances cannot drift" stops being a sentence about one row and becomes a rule
   about a year of them. It is not stubbed here, because a foreign key to a table
   that does not exist is not a thing, and a flag guarding nothing is a flag
   nobody trusts. What those stories need from this one is a row to point at and a
   boolean to read, and both are here.

   **The rollover.** Carrying unused annual leave from one year into the next is
   FR 36 and LMS 217. It reads `carries_over` on the entitlement rule and the two
   years either side of the boundary, and it is the job that will most want the
   gap rule above — a rollover with nowhere to carry into is a silent loss of
   everybody's days.

   **Moving the boundary between two years.** A company changing from a January
   start to an April one moves the end of one year and the start of the next, and
   both have to happen in one transaction. Both rules above are deferred so that
   it can, and no service method does it: the operation also has to say what
   happens to the balances in the months that changed hands, which is a question
   about the ledger rather than about this table.

   **Closing out of order.** Nothing here refuses closing 2027 while 2026 is still
   open. It would be an odd thing to do and it is not incoherent — and
   `earliestOpenDayOf` in ../src/domain/leave-year.ts reads the latest closed
   year's end whatever order they were closed in, so the boundary is the safe one
   either way. A rule refusing it would be one this story invented. */

-- Down Migration

DROP FUNCTION IF EXISTS ensure_the_first_leave_years();

DROP TRIGGER IF EXISTS leave_year_is_audited ON leave_year;
DROP TRIGGER IF EXISTS leave_year_set_updated_at ON leave_year;
DROP TRIGGER IF EXISTS leave_year_closed_is_final ON leave_year;
DROP TRIGGER IF EXISTS leave_year_leaves_no_gap ON leave_year;

DROP FUNCTION IF EXISTS keep_a_closed_leave_year_closed();
DROP FUNCTION IF EXISTS refuse_a_gap_between_leave_years();

DROP TABLE IF EXISTS leave_year;

/* btree_gist stays. It is an extension rather than a table, other stories will
   want it — the overlapping leave request constraint of §8 is the next one — and
   dropping it would fail on any database where one of them already had. */
