-- Up Migration

-- Days held come back when a request ends. FR 26, FR 27, §8.2. LMS 306.
--
-- The story is one sentence — "the balance I see is what I can actually still book" —
-- and its first two halves were built in create-and-submit-a-leave-request: submitting
-- writes a RESERVATION in the same transaction, and available drops the moment it does.
-- This migration is the third half, which is the one that keeps the sentence true over
-- time. A hold that is never released is a balance that only ever goes down, and after
-- a month of ordinary refusals and changes of mind it stops being a figure anybody
-- trusts.
--
-- ## The statuses, and why three rather than six
--
-- `leave_request_status_known` has held one value since LMS 301, which said why: "a
-- CHECK listing six states of which one is reachable is a promise the schema cannot
-- keep, and the approval story extends the list in its own migration exactly as
-- event-based-entitlement-grants extended `leave_ledger_entry_type_known` to admit
-- LAPSE."
--
-- This is one of those stories, and it takes the same discipline it inherited. Three
-- statuses arrive and each is reachable the day this lands, by a method that exists:
-- WITHDRAWN by the person who asked, CANCELLED by HR, REFUSED by a manager. They are
-- one movement seen from three desks — days that were held stop being held — which is
-- what `ledgerPolicy.release` has said since LMS 212 and is why they arrive together.
--
-- **APPROVED is deliberately not here.** Approval commits days rather than releasing
-- them: the hold becomes days taken and available does not move at all. It is a
-- different movement with a different entry type behind it and a chain of approvers
-- deciding who may make it — FR 38a — and it brings its own migration, extending this
-- CHECK exactly as this one extends LMS 301's.
--
-- ## What holds the pair together, in both directions
--
-- create-and-submit-a-leave-request built a two-part guarantee that a request holds
-- its days:
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_reserves_once` | a second RESERVATION against one request | a request with none |
--   | `leave_request_holds_its_days` | a request that reserved nothing, at COMMIT | TRUNCATE |
--
-- This migration builds the mirror of it, because the failure mode is the mirror. A
-- request that ends without releasing is days missing from a balance that nothing will
-- ever give back; a request that releases twice is days credited to somebody who never
-- had them. Neither is a crash and neither shows up as an inconsistent ledger — both
-- reconcile perfectly, and both are wrong.
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_releases_once` | a second RELEASE against one request, immediately, on every connection | a request that ended holding its days |
--   | `leave_request_gives_its_days_back` | a request that ended and released nothing, at COMMIT | TRUNCATE, which no row trigger sees |
--
-- **Deferred, for the same reason its twin is.** The status has to move before an entry
-- can be written against the settled row, so between the two statements there is a
-- request that has ended and released nothing — a legitimate intermediate state a
-- per-row check would refuse and a check at COMMIT judges correctly, because the only
-- state it ever sees is the one that will actually be stored.
--
-- ## And a request ends once
--
-- `refuse_an_impossible_transition()` is the third piece and the one the two above
-- cannot supply. The unique index stops a second RELEASE and the deferred trigger stops
-- an ending with no RELEASE; neither stops a WITHDRAWN request being marked REFUSED a
-- week later, which writes no entry at all and quietly rewrites what happened to
-- somebody's leave. Design principle 1: what was recorded is what happened.

-- ------------------------------------------------------- the three endings

/* One value becomes four. The list is the domain's `REQUEST_STATUSES`, and the
   integration suite reads this constraint back out of `pg_constraint` and asserts the
   two agree — so neither can be extended alone. */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (
        status IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED', 'REFUSED'));

-- --------------------------------------------- a request ends once, and one way

/* Which moves are legal, stated as the table rather than as a service's good manners.

   SUBMITTED may become any of the three endings. An ending may become nothing at all:
   it is where a request stops.

   **The `reason` edit is why this compares the two statuses rather than refusing every
   UPDATE that touches a settled row.** `leaveRequestPolicy.reword` lets the author
   improve why they needed the leave, and there is no reason that has to stop the day a
   request is refused — the record of what they asked for and why is exactly what
   somebody appealing a refusal is working from. So an UPDATE that leaves `status` where
   it is passes here, and `refuse_rewriting_what_a_request_cost()` is what stops it
   touching anything that matters.

   The three endings are written out rather than expressed as "not SUBMITTED", because
   the next status to arrive is APPROVED and "not SUBMITTED" would silently make it an
   ending. It is not one — an approved request is live, holds its days, and the story
   that brings it decides what may follow. A list is a decision somebody has to make;
   a negation is a decision that gets made for them. */

CREATE FUNCTION refuse_an_impossible_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status IN ('WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % was already %, and a request ends once.', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_ends_once',
                  HINT = 'The days this request held have already been given back. '
                         'Moving it again would either release them twice or '
                         'rewrite what happened to somebody’s leave. If the days are '
                         'wanted, ask for them again. FR 26, FR 27.';
    END IF;

    IF NEW.status NOT IN ('WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_ends_once',
                  HINT = 'A submitted request may be withdrawn, cancelled or refused. '
                         'Approval is a different movement and is not built yet.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_ends_once
    BEFORE UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_impossible_transition();

-- ------------------------------------ a request gives its days back, exactly once

/* The mirror of `leave_request_reserves_once`, and the reason it is a partial unique
   index rather than a count checked somewhere is the reason that one is: an index is
   evaluated by the database on every connection, at the moment of the write, and there
   is no window in it for two transactions to both find nothing. */

CREATE UNIQUE INDEX leave_request_releases_once
    ON leave_ledger_entry (leave_request_id)
    WHERE entry_type = 'RELEASE';

/* And a request that ended holding its days. The mirror of
   `refuse_a_request_that_holds_no_days()`, checked at COMMIT for the same reason.

   This is the acceptance criterion the story is named for — "released on rejection,
   cancellation or withdrawal" — held where no service can forget it. `BalanceService`
   is the only writer of movements and it writes the status and the RELEASE in one
   transaction, so nothing that goes through the front door meets this. What it catches
   is the second writer: a story that adds a `cancelAll` and updates statuses in a loop,
   a data fix in psql marking a batch REFUSED, a migration correcting somebody's leave.
   Each of those looks entirely reasonable and each would leave days held forever. */

CREATE FUNCTION refuse_a_request_that_kept_its_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted`
       refuses it, but a constraint trigger fires on a row that no longer has to be
       there and reading a missing one would raise the wrong error entirely. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM leave_ledger_entry
         WHERE leave_request_id = NEW.id AND entry_type = 'RELEASE'
    ) THEN
        RAISE EXCEPTION 'Leave request % ended without giving its days back.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'Withdrawing, cancelling or refusing a request releases what '
                         'it was holding, in the same transaction. Days held by a '
                         'request that has ended are days nothing will ever give back, '
                         'and the balance is short with nothing to explain it. FR 26.';
    END IF;

    RETURN NULL;
END
$$;

/* WHEN, so the trigger costs nothing on the UPDATE that every reworded reason performs.
   A constraint trigger with its condition inside the function is a query per UPDATE;
   here the condition is on columns, so Postgres evaluates it without calling anything.

   `OLD.status IS DISTINCT FROM NEW.status` as well as the ending, because a settled row
   updated again — a reason improved after a refusal — must not be asked twice whether
   it released. It did, when it ended. */

CREATE CONSTRAINT TRIGGER leave_request_gives_its_days_back
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
          AND NEW.status IN ('WITHDRAWN', 'CANCELLED', 'REFUSED'))
    EXECUTE FUNCTION refuse_a_request_that_kept_its_days();

-- ---------------------------------------------------------------- privileges

/* Nothing to grant. UPDATE on `leave_request` was granted by
   create-and-submit-a-leave-request "for two columns' sake — `status`, which the
   approval story moves, and `reason`" — and this is the story that took it up on the
   first of those. The INSERT on `leave_ledger_entry` that the RELEASE needs has been
   there since immutable-leave-ledger. */

-- Down Migration

DROP TRIGGER IF EXISTS leave_request_gives_its_days_back ON leave_request;
DROP FUNCTION IF EXISTS refuse_a_request_that_kept_its_days();

DROP INDEX IF EXISTS leave_request_releases_once;

DROP TRIGGER IF EXISTS leave_request_ends_once ON leave_request;
DROP FUNCTION IF EXISTS refuse_an_impossible_transition();

/* The requests that have ended go back to being requests that never did, because the
   CHECK below admits one value and cannot hold them.

   **Their RELEASE entries stay.** `leave_ledger_entry_is_never_deleted` refuses to
   remove one on any connection, deliberately and since LMS 210 — the ledger is the
   record of what happened and a rollback of a schema is not a claim that it did not. So
   a rolled-back database has requests reading SUBMITTED whose days are already back in
   the balance. That is the honest outcome rather than a tidy one: the figures are right,
   and the statuses are the thing this migration is being asked to forget.

   **And where the released days were rebooked, it stops.** That is the whole feature —
   somebody withdrew leave and asked for those days again — and restoring the first
   request to SUBMITTED puts two live requests on one set of days, which
   `leave_request_never_overlaps` refuses. It is right to refuse: the database genuinely
   cannot go back, because going back means choosing which of the two bookings stands and
   that is a person's decision rather than a migration's. The handler is here so that
   whoever meets it is told that in a sentence rather than through an exclusion
   violation. */

DO $$
BEGIN
    UPDATE leave_request
       SET status = 'SUBMITTED'
     WHERE status IN ('WITHDRAWN', 'CANCELLED', 'REFUSED');
EXCEPTION
    WHEN exclusion_violation THEN
        RAISE EXCEPTION
            'Cannot roll back: leave released by this story has since been rebooked.'
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Restoring a withdrawn, cancelled or refused request to '
                         'SUBMITTED would put two live requests on the same days. '
                         'Decide which booking stands and settle the other by hand '
                         'first — a migration cannot make that choice.';
END
$$;

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (status IN ('SUBMITTED'));
