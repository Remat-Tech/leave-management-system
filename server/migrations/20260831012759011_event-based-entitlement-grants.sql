-- Up Migration

-- Event based entitlement grants. FR 32g, FR 32e, §8.6aa. LMS 218.
--
-- Every grant this system has posted so far arrives on the first of January.
-- `entitlement_basis` has said since LMS 201 that some types do not work that way —
-- "EVENT is granted per qualifying occurrence, does not reset on 1 January and does
-- not accumulate" — and until now that column has only ever been read to decide what
-- to *skip*: the annual grant filters event types out, and so does the rollover.
--
-- This is the story that reads it the other way round. A child is born, and a hundred
-- and twenty days of maternity leave or fourteen of paternity arrive because of that
-- rather than because of the date.
--
-- ## Two things, and the second is the awkward one
--
--   **An event is a row.** `leave_entitlement_event` below. A grant made because of
--   something that happened has to name the thing that happened, or the figure is
--   unexplainable in exactly the way design principle 1 refuses — "why have I got a
--   hundred and twenty days" answered by a date and an amount and nothing else.
--
--   **An unused grant lapses.** FR 32e: paternity's fourteen days are "usable within
--   six months". That needs a ninth kind of ledger entry, and the reason is the
--   surprising half of this migration.
--
-- ## Why LAPSE is a ninth type rather than the EXPIRY already here
--
-- `EXPIRY` exists and means days lapsing, which is what this is. It cannot be used,
-- and the reason is which bucket it moves rather than what it is called.
--
-- The cached-balance migration put `EXPIRY` into `carried_over` and said why: "FR 36
-- and FR 36a: CARRY_FORWARD adds, EXPIRY takes away, and they share a column because
-- carried days and the expiry of carried days are the same days." That is exactly
-- right for the clock it was written for. It is exactly wrong for this one. A
-- paternity grant was never carried over — an event type has nothing to carry, which
-- is the whole of `entitlement_basis` — so an `EXPIRY` against it would leave a
-- balance reading `carried_over: -14` on a type that cannot carry a single day.
-- Available would come out right and the column would be a lie, which is the failure
-- design principle 1 exists to prevent: every figure explains itself, or none of them
-- does.
--
-- ../src/domain/leave-type.ts named this collision before there was anything to
-- collide: "**Not carry over** — unused annual days rolling into the next year is
-- FR 36 and lives on the entitlement rule with the effective dates. Two clocks with
-- similar names." Two clocks, two entry types, two buckets.
--
-- So `LAPSE` takes days out of `entitled`, which is where the grant put them. A
-- paternity balance that lapses reads twenty granted, six taken, fourteen lapsed,
-- nought left — and every one of those four numbers is a row.
--
-- The immutable-leave-ledger migration anticipated this precisely: "a ninth would be
-- days moving for a reason no reader of a balance knows how to describe", and
-- "adding a ninth is a migration, because the database holds the same list". This is
-- that migration, and the reason a reader can describe it is the paragraph above.

-- ------------------------------------------------------ the ninth kind of movement

/* Both CHECKs are dropped and recreated rather than added beside. A second
   constraint saying "or LAPSE" would leave the original still refusing it, and two
   constraints on one column that have to be read together is how a rule stops being
   findable. */

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_type_known;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_type_known CHECK (
    entry_type IN (
        'GRANT', 'CARRY_FORWARD', 'ADJUSTMENT', 'EXPIRY', 'LAPSE',
        'RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'));

/* LAPSE beside EXPIRY, because they are the same shape — days going away because a
   clock ran out — and consumes for the same reason. What differs is the bucket, and
   that is the view further down rather than anything here.

   It is deliberately *not* added to `leave_ledger_entry_requests_move_whole_days`.
   That constraint names the four request-shaped types and exempts the entitlement
   ones, and a lapse is an entitlement movement: what lapses is whatever is left of a
   grant, and a grant may be fractional. §8.6d. */

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_sign_matches_the_type;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_sign_matches_the_type CHECK (
    CASE entry_type
        WHEN 'GRANT'         THEN days > 0
        WHEN 'CARRY_FORWARD' THEN days > 0
        WHEN 'RELEASE'       THEN days > 0
        WHEN 'RECALCULATION' THEN days > 0
        WHEN 'RESERVATION'   THEN days < 0
        WHEN 'DEDUCTION'     THEN days < 0
        WHEN 'EXPIRY'        THEN days < 0
        WHEN 'LAPSE'         THEN days < 0
        WHEN 'ADJUSTMENT'    THEN days <> 0
    END
);

-- ------------------------------------------------ the projection, in its one place

/* `what_the_ledger_says` is the only statement of which bucket each kind of movement
   moves. LMS 213 lifted it out of `rebuild_one_balance_from_the_ledger()` for exactly
   this moment: a ninth entry type is one view replaced rather than two copies of an
   aggregate that could disagree about it.

   `LAPSE` joins `GRANT` in `entitled`. It is the only line that changes. */

CREATE OR REPLACE VIEW what_the_ledger_says AS
SELECT
    employee_id,
    leave_type_id,
    leave_year_id,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('GRANT', 'LAPSE')), 0) AS entitled,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
        AS carried_over,
    coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
    coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0) AS taken,
    coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
        FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0) AS pending
FROM leave_ledger_entry
GROUP BY employee_id, leave_type_id, leave_year_id;

-- --------------------------------------------------------------------- the event

/* What happened, and when. FR 32g.

   The record a grant is made *against*, and the reason this is a table rather than
   two columns on the ledger entry. The immutable-leave-ledger migration refused a
   `leave_request_id` on that table and said why — "a field nothing can populate and
   nothing can check is the switch with nothing behind it" — and the symmetric answer
   to a pointer with nothing behind it is to put something behind it.

   Three things live here that are not facts about a movement in a balance:

     **When it happened**, which is not when it was recorded. FR 18 lets an absence be
     entered a week late and a birth is told to HR later than that; `created_at` on the
     grant is the day somebody typed it, and six months from *that* is six months from
     the wrong day.

     **When the grant lapses**, which follows from the first and from
     `leave_type.entitlement_expiry_months`. Stored rather than derived on every read,
     because the figure that matters is the one that was true when the event was
     recorded: a type whose expiry months are changed next year must not silently move
     the deadline on a grant already made. That is FR 31's argument about closed years,
     applied to a clock instead of a figure.

     **Whether it has lapsed yet**, which is what makes the expiry job re-runnable
     without it remembering anything. */

CREATE TABLE leave_entitlement_event (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The same three columns a balance is keyed by, and the same three the grant
       carries, so an event and the movement it caused are filed identically. Real
       foreign keys for the reason the ledger's are: an event in nobody's balance is
       an event nothing can be rebuilt from. */
    employee_id BIGINT NOT NULL REFERENCES employee(id),
    leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
    leave_year_id BIGINT NOT NULL REFERENCES leave_year(id),

    /* The day the thing happened. A DATE and not a timestamp: a birth is a day, and
       NFR DAT 03 keeps every calendar date in this schema a `date` so that no zone
       can move one across midnight. Held inside its leave year by
       `refuse_an_event_outside_its_leave_year()` below. */
    occurred_on DATE NOT NULL,

    /* The day after which whatever is left of the grant lapses. FR 32e.

       Null where the type does not lapse, which is every event type but paternity
       today: maternity's hundred and twenty days, compassionate leave and the two
       unpaid types all have `entitlement_expiry_months` unset, and null here says
       "this never runs out" rather than "nobody has worked it out". */
    expires_on DATE,

    /* What happened, in HR's words, for the person reading their own history. FR 27's
       argument applied to the event rather than to the movement.

       Optional, unlike a ledger entry's reason, and the difference is real: the grant
       this event causes carries a mandatory reason naming the event and its date, so
       the account already explains itself. This is where "second child" or "recorded
       from the certificate on 4 March" goes, and forcing it would produce a column
       full of the word "birth". */
    note TEXT,

    /* The grant this event caused. §8.6aa, and the story's first criterion said as a
       foreign key.

       NOT NULL, because an event that granted nothing is not an event this table has
       any business holding: the whole reason to record a birth here is the
       entitlement it produces. The two rows are written in one transaction by
       `BalanceService.grantForAnEvent`, which is the one door that posts a movement. */
    granted_entry_id BIGINT NOT NULL UNIQUE REFERENCES leave_ledger_entry(id),

    /* The LAPSE that closed it off, once the expiry job has run. Null until then, and
       the whole of that job's idempotency: an event with this set is done, and the
       job asks the row rather than remembering. */
    lapsed_entry_id BIGINT UNIQUE REFERENCES leave_ledger_entry(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* A deadline before the thing it is a deadline for is a month count with its sign
       the wrong way round, which is the one arithmetic mistake this table can hold. */
    CONSTRAINT leave_entitlement_event_expires_after_it_happened CHECK (
        expires_on IS NULL OR expires_on > occurred_on),

    /* Nothing lapses that was never going to. A lapse against an event with no expiry
       date is the expiry job having run on a row it should not have seen. */
    CONSTRAINT leave_entitlement_event_lapse_needs_an_expiry CHECK (
        lapsed_entry_id IS NULL OR expires_on IS NOT NULL),

    CONSTRAINT leave_entitlement_event_note_not_blank CHECK (note IS NULL OR btrim(note) <> ''),

    /* One event of one kind per person per day. FR 32g grants "per qualifying
       occurrence", and two occurrences of the same kind on the same day is somebody
       recording a birth twice — which is the duplicate that actually happens, because
       the second person to hear about it does not know the first already entered it.

       Twins are one birth and one grant. Two births ten months apart are two rows,
       correctly, and the rollover and the annual grant both leave them alone. */
    CONSTRAINT leave_entitlement_event_one_per_day UNIQUE (employee_id, leave_type_id, occurred_on)
);

/* The expiry job's own read: everything past its deadline that has not been closed
   off. Partial on both halves, because the rows it wants are a vanishing fraction of
   the table — most events never lapse at all, and of those that can, most have
   already been dealt with. */
CREATE INDEX leave_entitlement_event_still_to_lapse
    ON leave_entitlement_event (expires_on)
    WHERE expires_on IS NOT NULL AND lapsed_entry_id IS NULL;

/* One balance's events, which is what the expiry job asks when it needs to know
   whether another grant in the same balance is still live, and what a history screen
   asks to put a date beside a figure. */
CREATE INDEX leave_entitlement_event_by_balance
    ON leave_entitlement_event (employee_id, leave_type_id, leave_year_id, occurred_on);

-- --------------------------------------------- an event belongs to one leave year

/* `leave_year_id` is not free to disagree with `occurred_on`.

   A fact about another row, so a trigger rather than a CHECK, which is the same class
   of rule as `refuse_a_correction_across_balances()`. It matters because the whole
   point of the column is that the grant lands in the balance for the year the event
   fell in: an event dated in December filed under next year's balance would put
   somebody's maternity leave in a year they were not pregnant, and every figure
   afterwards would be internally consistent and wrong.

   Not refused where the leave year has since been closed — that is the ledger's rule
   about the *grant*, held by `refuse_a_recalculation_of_a_settled_year()`, and saying
   it twice in two places is how the two come to disagree. */

CREATE FUNCTION refuse_an_event_outside_its_leave_year() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    year leave_year%ROWTYPE;
BEGIN
    SELECT * INTO year FROM leave_year WHERE id = NEW.leave_year_id;

    /* Unreachable: the foreign key has already found it. Answered rather than
       assumed, because the alternative is a NULL comparison below quietly permitting
       what this function exists to refuse. */
    IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no leave year %.', NEW.leave_year_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_event_falls_in_its_leave_year';
    END IF;

    IF NEW.occurred_on < year.start_date OR NEW.occurred_on > year.end_date THEN
        RAISE EXCEPTION
            'An event on % does not fall in leave year % (% to %).',
            NEW.occurred_on, year.label, year.start_date, year.end_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_event_falls_in_its_leave_year',
                  HINT = 'The grant an event causes lands in the balance for the year '
                         'the event fell in. File it under the year that covers the '
                         'day it happened. FR 32g.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_entitlement_event_falls_in_its_leave_year
    BEFORE INSERT OR UPDATE ON leave_entitlement_event
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_event_outside_its_leave_year();

-- ------------------------------------------------- what may be changed, and what not

/* An event that happened, happened. The three facts that made the grant — who, what
   kind, and when — are what the figure was calculated from, so changing one after the
   fact would move a balance with nothing in the ledger to say why. That is the same
   argument `refuse_rewriting_an_applied_entitlement_rule()` makes and the same one
   FR 27 makes about a ledger entry, and the honest correction for a birth recorded
   against the wrong person is an ADJUSTMENT on each balance with a reason on it.

   `expires_on` is held for the same reason and one of its own: it is the deadline the
   grant was made under, and a system where the deadline can be moved is one where
   "usable within six months" is usable within however long somebody decided this
   morning.

   What is left editable is `note` — which explains rather than decides, exactly as an
   entitlement rule's note stays editable once the rule is in effect — and
   `lapsed_entry_id`, which is the expiry job closing the row off and is the only
   reason this table has an UPDATE grant at all. */

CREATE FUNCTION refuse_rewriting_an_entitlement_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id      IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id    IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id    IS DISTINCT FROM OLD.leave_year_id
    OR NEW.occurred_on      IS DISTINCT FROM OLD.occurred_on
    OR NEW.expires_on       IS DISTINCT FROM OLD.expires_on
    OR NEW.granted_entry_id IS DISTINCT FROM OLD.granted_entry_id
    THEN
        RAISE EXCEPTION
            'Entitlement event % records something that happened and cannot be rewritten.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_event_is_what_happened',
                  HINT = 'The grant was calculated from these, so changing one moves a '
                         'balance with nothing to show for it. Post a compensating '
                         'ADJUSTMENT with a reason instead. FR 27.';
    END IF;

    /* And a lapse, once posted, is not un-posted. The ledger entry it names can never
       be removed, so clearing this would leave the days gone and the row saying they
       are still there — which is the one state that would make the expiry job lapse
       them a second time. */
    IF OLD.lapsed_entry_id IS NOT NULL AND NEW.lapsed_entry_id IS DISTINCT FROM OLD.lapsed_entry_id
    THEN
        RAISE EXCEPTION 'Entitlement event % has already lapsed.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_event_lapses_once',
                  HINT = 'The LAPSE entry it names is in the ledger and cannot be '
                         'removed. Post a compensating ADJUSTMENT with a reason.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_entitlement_event_is_what_happened
    BEFORE UPDATE ON leave_entitlement_event
    FOR EACH ROW
    EXECUTE FUNCTION refuse_rewriting_an_entitlement_event();

/* And nothing is removed. An event heads a grant that is in the ledger forever, so
   deleting the row would leave a hundred and twenty days in somebody's balance with
   nothing to say where they came from — which is design principle 1 read backwards.

   `refuse_delete()` with a hint of its own, the arrangement the immutable-leave-ledger
   migration made the function take an argument for. */

CREATE TRIGGER leave_entitlement_event_is_never_deleted
    BEFORE DELETE ON leave_entitlement_event
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'The grant this event caused is in the ledger and cannot be removed, so '
        'removing the event would leave days in a balance with nothing to explain '
        'them. Post a compensating ADJUSTMENT with a reason instead. FR 27.'
    );

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the
   department rules has reused them.

   The audit trigger earns its place here more than on most tables. An event grant is
   the largest single figure this system puts into anybody's balance — a hundred and
   twenty days — and it is put there because one person said a thing had happened.
   "Who recorded this birth, and when" is the first question asked if it turns out not
   to have, and the row cannot answer it: `created_at` says when, and nothing says who. */

CREATE TRIGGER leave_entitlement_event_set_updated_at
    BEFORE UPDATE ON leave_entitlement_event
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_entitlement_event_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_entitlement_event
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration.

   UPDATE is granted for one column's sake — `lapsed_entry_id`, the expiry job closing
   a row off — and the trigger above is what makes that safe rather than the grant
   being narrow: every other column is refused for this writer and for the owner too.
   Postgres can grant UPDATE per column and this deliberately does not, because a
   column list in a GRANT is a rule nobody reads and a trigger is a rule with its
   argument attached.

   DELETE is not granted, and the trigger refuses it for the owner as well. */

GRANT UPDATE ON leave_entitlement_event TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS leave_entitlement_event_is_audited ON leave_entitlement_event;
DROP TRIGGER IF EXISTS leave_entitlement_event_set_updated_at ON leave_entitlement_event;
DROP TRIGGER IF EXISTS leave_entitlement_event_is_never_deleted ON leave_entitlement_event;
DROP TRIGGER IF EXISTS leave_entitlement_event_is_what_happened ON leave_entitlement_event;
DROP TRIGGER IF EXISTS leave_entitlement_event_falls_in_its_leave_year ON leave_entitlement_event;

DROP TABLE IF EXISTS leave_entitlement_event;

DROP FUNCTION IF EXISTS refuse_rewriting_an_entitlement_event();
DROP FUNCTION IF EXISTS refuse_an_event_outside_its_leave_year();

/* The projection as LMS 213 left it, without LAPSE. */

CREATE OR REPLACE VIEW what_the_ledger_says AS
SELECT
    employee_id,
    leave_type_id,
    leave_year_id,
    coalesce(sum(days) FILTER (WHERE entry_type = 'GRANT'), 0) AS entitled,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
        AS carried_over,
    coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
    coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0) AS taken,
    coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
        FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0) AS pending
FROM leave_ledger_entry
GROUP BY employee_id, leave_type_id, leave_year_id;

/* And the eight kinds of movement as the immutable-leave-ledger migration left them.
   Any LAPSE entry already written would refuse to validate against these, which is
   correct: rolling this back with lapses in the ledger is rolling back days that have
   already gone, and the constraint failing is the system saying so. */

DELETE FROM leave_ledger_entry WHERE entry_type = 'LAPSE';

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_type_known;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_type_known CHECK (
    entry_type IN (
        'GRANT', 'CARRY_FORWARD', 'ADJUSTMENT', 'EXPIRY',
        'RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'));

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_sign_matches_the_type;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_sign_matches_the_type CHECK (
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
);
