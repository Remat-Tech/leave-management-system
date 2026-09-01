-- Up Migration

-- Days come back on rejection, all of them, at the moment of the rejection. FR 43, §8.2.
-- LMS 317.
--
-- The story is somebody whose leave was turned down being able to ask for the same fortnight
-- again straight away, rather than waiting for anybody to give the days back to them.
--
-- **Most of it has been true since LMS 306**, and this migration says so rather than
-- pretending otherwise. That story built the three endings as one movement: refusing writes a
-- RELEASE and a status in one transaction through `BalanceService.releaseForRequest`, so the
-- days are back before the approver's screen has finished reloading, and `REFUSED` is not in
-- `leave_request_never_overlaps`, so the dates stop blocking the calendar in the same
-- instant. Nothing waits on anybody.
--
-- What LMS 306 did not say is **how many** days come back.
--
-- ## The hole this closes: a release that gave back some of them
--
-- `leave_request_gives_its_days_back` has asked one question since LMS 306 — is there a
-- RELEASE — and it is the right question asked short. A request that ends having released one
-- day of the six it was holding satisfies it perfectly, and leaves five days in `pending` that
-- nothing will ever give back: a balance permanently short, against a request that says it
-- ended, with a ledger that reconciles.
--
-- That is worse than releasing nothing, which somebody notices. Five days missing from an
-- employee's balance for a request they can see was refused is the exact shape of FR 43's
-- failure — the days did not come back, and the person is waiting on somebody to work out
-- why.
--
-- **Nothing that goes through the door can do it.** `daysToRelease()` refuses to give back
-- more than is held and the amount it is asked for is the request's own frozen `days`, so a
-- release is for the whole hold or it raises `NotEnoughHeld` and nothing is written at all.
-- What this catches is the second writer LMS 306 named and only half-covered: "a story that
-- adds a `cancelAll` and updates statuses in a loop, a data fix in psql marking a batch
-- REFUSED, a migration correcting somebody's leave." Each of those can as easily release the
-- wrong figure as none.
--
-- ## So the existing rule is widened rather than joined
--
-- `CREATE OR REPLACE` on the function, with the trigger, its `WHEN` and — the part that
-- matters to every caller — its **constraint name** left exactly as they were. The rule was
-- "a request that ended gave its days back"; it is now "gave *its days* back", which is the
-- same sentence read properly rather than a second one beside it.
--
-- A separate trigger was the alternative and it is the worse shape: two rules about one act,
-- firing on the same `WHEN`, of which the older one is implied by the newer. Whoever met the
-- pair would have to work out which was the real rule, and `LeaveRequestRepository` would
-- have to learn a second constraint name to say the same thing about.
--
-- The same widening LMS 314 made to `refuse_an_impossible_transition()`, and for the same
-- reason: replacing the body is what "the same rule, saying more" looks like in SQL.
--
-- ## What it is and is not judged against
--
-- **The request's own `days`**, which `refuse_rewriting_what_a_request_cost()` has frozen
-- since submission — so the figure that has to come back is the figure that was taken, and
-- neither can move.
--
-- **Not the balance.** "Is `pending` back where it was" is the question somebody reaches for
-- first and it cannot be asked here: `pending` is per employee, leave type and leave year, so
-- a person with two requests in flight has one figure covering both, and nothing about it can
-- say which request's days are which. That is the same reason `LeaveAlreadySettled` guards on
-- the status rather than on the balance — `ledgerPolicy.release` put it plainly, that a wrong
-- release "is the request state machine's integrity to keep rather than the balance's".
--
-- **All three endings, not only rejection.** The `WHEN` is untouched. A withdrawal that gave
-- back one day of six is the same defect wearing another name, and a rule that covered only
-- refusals would be a rule about which button was pressed rather than about what a request
-- was holding.

-- ------------------------------------- a request gives back what it was holding

/* The body LMS 306 wrote, asked about the amount as well as the existence.

   The two branches are one condition and two sentences, because the reader is a person
   holding a second writer and the two mistakes need different fixes: releasing nothing is a
   statement that was never written, and releasing part is a figure that was worked out
   wrongly. Naming both numbers is what makes the second one actionable — `daysToRelease()`
   is handed the request's own frozen day count, and a writer that reached its own figure got
   it from somewhere. */

CREATE OR REPLACE FUNCTION refuse_a_request_that_kept_its_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    /* Typed as the column it sums rather than as a type written out here, which is the
       honest declaration and not a way past LMS 209's rule that nothing in this schema
       holds a fraction. `leave_ledger_entry.days` is the one exception that rule names —
       §8.6d pro rates a joiner to 10.08 days — so a variable that adds those up holds
       whatever it holds, and saying `INTEGER` would be a rounding waiting for the day the
       column's own `leave_ledger_entry_requests_move_whole_days` is relaxed.

       What the comparison below is against is `leave_request.days`, which is an INTEGER and
       is FR 24: leave is requested in whole days. A release that came back fractional is
       therefore refused by this function rather than quietly truncated into agreeing. */
    given leave_ledger_entry.days%TYPE;
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted`
       refuses it, but a constraint trigger fires on a row that no longer has to be
       there and reading a missing one would raise the wrong error entirely. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    /* A sum rather than the one row `leave_request_releases_once` permits, because the
       question is how many days came back rather than how many entries said so, and a
       rule written against the index would have to be rewritten if a story ever released
       in parts. Today it is one row and the sum is that row. */
    SELECT coalesce(sum(days), 0) INTO given
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.id AND entry_type = 'RELEASE';

    IF given = 0 THEN
        RAISE EXCEPTION 'Leave request % ended without giving its days back.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'Withdrawing, cancelling or refusing a request releases what '
                         'it was holding, in the same transaction. Days held by a '
                         'request that has ended are days nothing will ever give back, '
                         'and the balance is short with nothing to explain it. FR 26.';
    END IF;

    IF given <> NEW.days THEN
        RAISE EXCEPTION
            'Leave request % was holding % day(s) and gave back %.', NEW.id, NEW.days, given
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'A request that ends gives back everything it was holding, not '
                         'part of it. The days left behind are in nobody''s hands: the '
                         'request says it ended, the balance says they are still spoken '
                         'for, and both reconcile. Release the figure the request was '
                         'priced at — it has not moved since it was submitted. FR 26, '
                         'FR 43.';
    END IF;

    RETURN NULL;
END
$$;


-- Down Migration

/* The body goes back to the one LMS 306 wrote, asking only whether anything came back.

   `CREATE OR REPLACE` in both directions, and nothing else moves: the trigger, its `WHEN`
   and its constraint name were never touched, so there is no trigger to drop and no name for
   a caller to stop recognising. A rollback here is a rule refusing less, which is the one
   direction a down section can always take safely — every row that satisfies the widened
   rule satisfies the narrow one. */

CREATE OR REPLACE FUNCTION refuse_a_request_that_kept_its_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
