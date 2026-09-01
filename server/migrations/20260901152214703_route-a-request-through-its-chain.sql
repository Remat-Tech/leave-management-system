-- Up Migration

-- A request goes to the approvers its leave type names, in order. FR 38, FR 38a, FR 40,
-- §6, §8. LMS 314.
--
-- The chain has been configuration since LMS 204 and nothing has read it. The
-- leave-type-approval-chain migration said so in as many words under "what is not here
-- yet": "The routing itself. Which *person* a request goes to, and what happens when it
-- gets there, is FR 48 and Phase 3. This table says the chain for unpaid leave is HR then
-- the Chief Executive; finding the HR officer on duty, and the one employee with no line
-- manager, is the request workflow's job and needs the request table to exist." This is
-- that migration, and it does the half that is about the request.
--
-- ## Where a request has got to becomes two facts
--
-- `status` has carried the whole of it since LMS 301, and it cannot carry this. A request
-- sitting with a manager and a request sitting with HR are in the same *state* — being
-- decided, holding their days, blocking the calendar — and differ only in who is being
-- waited on.
--
-- The tempting alternative is a status per stage: AWAITING_MANAGER, AWAITING_HR,
-- AWAITING_CEO. It is wrong for a reason design principle 5 already settled. **The number
-- of stages is configuration.** FR 31 gives the chain to an HR Administrator, `leave_type_
-- approval_step` holds it as rows, and a fourth desk added there would need a new status,
-- a new CHECK and new transitions — a code change and a deployment for a thing the SRS
-- insists is a form. So the status says whether the request is still being decided and
-- `awaiting_approval_from` says who is deciding it, and the chain can be any length.
--
-- ## APPROVED, and why it is not an ending
--
-- `leave_request_status_known` gains its fifth value, and the discipline LMS 209 set is
-- kept: the status arrives in the story that reaches it. `LeaveRequestService.approve()`
-- reaches it the day this lands, at the moment a chain runs out of desks.
--
-- It is the first status that is neither pending nor an ending, and every list in the
-- schema had to be asked about it separately:
--
--   | | Does APPROVED join it | Why |
--   |---|---|---|
--   | `leave_request_status_known` | yes | it is a state a request can be in |
--   | `leave_request_never_overlaps` | yes | agreed leave is the most live leave there is |
--   | the endings in `refuse_an_impossible_transition()` | no | it holds its days, it does not give them back |
--
-- The middle one is the one that would have been missed. LMS 304 wrote that constraint's
-- predicate as `status IN ('SUBMITTED')` when that was a tautology, and said why: "the list
-- is here from the start and the rule it states is the one that matters — a request blocks
-- the days only while it is still live. The approval story edits this list." This is the
-- story, and the edit is one word. Without it somebody could book a fortnight on top of
-- leave that had been agreed, and both requests would reconcile.
--
-- ## And the days become taken
--
-- Approval is the movement `BalanceService.commit` has been built and unused for since LMS
-- 212. It does not consume days a second time — the RESERVATION did that — it moves the
-- same days out of `pending` and into `taken`, leaving available exactly where it was. The
-- cached-balance migration described this before there was anything to describe: "DEDUCTION
-- appears twice, and is the only kind that does. Approval does not consume days a second
-- time... it takes five days out of `pending` and puts five into `taken`, leaving available
-- unmoved."
--
-- What this migration adds is the pair that makes the status and the movement one act, and
-- it is the third of a family whose shape is now settled:
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_commits_once` | a second DEDUCTION against one request, immediately, on every connection | a request approved holding its days |
--   | `leave_request_takes_its_days` | a request that reached APPROVED and committed nothing, at COMMIT | TRUNCATE, which no row trigger sees |
--
-- **Only the last approval writes one.** A request moving from its first approver to its
-- second changes no figure in any balance, so there is no entry to write and the deferred
-- trigger is keyed on the status changing to APPROVED rather than on the row being updated.

-- ------------------------------------------------- the desk a request is sitting at

/* Which approver this request is waiting on. MANAGER, HR or CEO.

   The same three spellings as `leave_type_approval_step.approver_role` and deliberately
   not a foreign key to it: a step is a stage of a *type's* chain and this is a stage a
   *request* has reached, and pointing at the step row would tie a request in flight to a
   configuration row an HR Administrator may delete. FR 31 says they may, `ON DELETE
   CASCADE` says what happens when they do, and a request whose desk vanished with the row
   would be a request with no desk at all — which `leave_request_waits_at_a_desk` below
   refuses, so the delete would fail and FR 31 would stop being true.

   So it is the desk by name, and what happens when the chain changes underneath a waiting
   request is answered in the application, by `ApprovalChainChanged`, with a sentence naming
   both chains. See /domain/leave-request.ts.

   Nullable, because it is null for every request that is not waiting on anybody: approved,
   withdrawn, cancelled, refused. What makes it more than a hint is the equivalence below. */

ALTER TABLE leave_request
    ADD COLUMN awaiting_approval_from VARCHAR(20);

/* Every request that is still being decided gets the first desk of its type's chain, which
   is where it would have started had this column existed when it was submitted.

   Read off `leave_type_approval_step` rather than written out, for the reason nothing above
   the database reads a type code: which desk annual leave starts at is data, and a
   migration that decided it here would be the one place in the system that disagreed with
   the table.

   A type with no chain has no first step, and `ensure_statutory_approval_chains()` is the
   repair for that — the leave-type-approval-chain migration explains why a chainless type
   is allowed to exist. A *submitted request* against one is a different matter: it is
   already in a queue nobody is looking at, and this migration cannot invent the desk. It
   says so and stops, rather than leaving the column null and failing on the constraint two
   statements later with a message about equivalences. */

UPDATE leave_request request
   SET awaiting_approval_from = (
        SELECT step.approver_role
          FROM leave_type_approval_step step
         WHERE step.leave_type_id = request.leave_type_id
         ORDER BY step.step_order
         LIMIT 1)
 WHERE request.status = 'SUBMITTED';

DO $$
DECLARE
    stranded INTEGER;
BEGIN
    SELECT count(*) INTO stranded
      FROM leave_request
     WHERE status = 'SUBMITTED' AND awaiting_approval_from IS NULL;

    IF stranded > 0 THEN
        RAISE EXCEPTION
            '% submitted request(s) are for a leave type with no approval chain.', stranded
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Run ensure_statutory_approval_chains() to give every type its '
                         'chain, then run this migration again. Those requests are '
                         'already sitting in a queue nobody can see, and this migration '
                         'cannot decide who should have been asked. FR 38a.';
    END IF;
END
$$;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_awaiting_role_known CHECK (
        awaiting_approval_from IS NULL
        OR awaiting_approval_from IN ('MANAGER', 'HR', 'CEO'));

/* And a request is waiting on exactly one desk while it is being decided, and on none
   otherwise.

   An equivalence rather than a NOT NULL, and both halves are load bearing — the same shape
   `leave_ledger_entry_request_movements_name_a_request` has, and for the same reason. The
   half nobody would write is the second: a request that has been approved, withdrawn or
   refused and still reads "awaiting HR" sits in that desk's queue for ever, and the person
   working through the queue has no way to tell it from work.

   `status = 'SUBMITTED'` rather than "not one of the endings", because APPROVED is neither.
   It is the reason this is written as one named state rather than as a negation: a negation
   would have quietly made APPROVED a state that waits on somebody, which is exactly what
   approval stops. A list is a decision somebody has to make; a negation is a decision that
   gets made for them. */

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_waits_at_a_desk CHECK (
        (status = 'SUBMITTED') = (awaiting_approval_from IS NOT NULL));

/* Every request one desk is waiting on, which is what an approver's queue reads and what
   FR 40 asks for. Partial, because the rows it excludes are every request that has ever
   been decided and the index would otherwise grow for ever while answering nothing. */

CREATE INDEX leave_request_by_desk
    ON leave_request (awaiting_approval_from, start_date)
    WHERE awaiting_approval_from IS NOT NULL;

-- ------------------------------------------------------------ the fifth status

/* Four values become five. The list is the domain's `REQUEST_STATUSES`, and the
   integration suite reads this constraint back out of `pg_constraint` and asserts the two
   agree — so neither can be extended alone. */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (
        status IN ('SUBMITTED', 'APPROVED', 'WITHDRAWN', 'CANCELLED', 'REFUSED'));

-- --------------------------------------- agreed leave blocks the calendar too

/* The one word LMS 304 wrote its predicate in advance for.

   `leave_request_never_overlaps` has carried `WHERE status IN ('SUBMITTED')` since that
   migration, which explained that the list "is here from the start and the rule it states
   is the one that matters: a request blocks the days only while it is still live", and
   named this story as the one that edits it.

   Leave that has been agreed is live in every sense that matters to the rule: the person
   will be away, the days have gone from the balance as `taken`, and a second request for
   the same days would take them a second time. Leaving APPROVED out would have let somebody
   book a fortnight on top of a fortnight their manager and HR had already signed off, with
   both rows reconciling perfectly.

   The constraint is dropped and rebuilt rather than altered, because a predicate is not
   something ALTER CONSTRAINT can change. That rebuilds the GiST index, which on a table of
   this size costs nothing and on a large one is the honest price of widening the rule. */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_never_overlaps;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_never_overlaps
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('SUBMITTED', 'APPROVED'));

-- ------------------------------------------ a request moves only where §6 says

/* `refuse_an_impossible_transition()` widened, and its trigger renamed with it.

   LMS 306 called the trigger `leave_request_ends_once`, which was the whole of the rule
   then: SUBMITTED could become any of the three endings, and an ending could become
   nothing. The rule now has a second half — SUBMITTED may also become APPROVED, and
   APPROVED may become nothing yet — and `leave_request_ends_once` is a puzzling thing to
   read in an error about leave that has just been agreed. A constraint name is what the
   application reports and what somebody greps for, so it says what it refuses.

   ## What is permitted, and what each refusal is about

     **A status that has not moved passes.** `leaveRequestPolicy.reword` lets the author
     improve why they needed the leave, and there is no reason that has to stop when the
     request is decided — the record of what somebody asked for is exactly what an appeal is
     worked from. Approval moving a request from one desk to the next is the other case: the
     status stays where it is and only `awaiting_approval_from` changes, so it passes here
     and is judged by `leave_request_waits_at_a_desk` instead.

     **Nothing moves out of an ending.** A request ends once. Moving a WITHDRAWN request to
     REFUSED writes no entry at all and quietly rewrites what happened to somebody's leave.

     **Nothing moves out of APPROVED yet**, and that is a boundary rather than a permanent
     rule. Taking agreed leave off the books is FR 26 and is a real thing HR does; it is not
     any of the three endings, because by then the days are `taken` rather than `pending` and
     giving them back is a movement against the DEDUCTION. The story that offers it adds a
     destination here and a row to TRANSITIONS. Until then this refuses, with a message that
     says which desk to ask rather than only that the answer is no.

     **And from a state that is still running, only these four destinations.** Written out
     rather than as "anything but SUBMITTED", because the next status to arrive would
     otherwise be permitted by a rule nobody wrote.

   The four names in this function are exactly the `to` column of TRANSITIONS in
   /domain/leave-request.ts, and the integration suite reads it back out of
   `pg_get_functiondef` and asserts as much. That is why SUBMITTED is not spelled anywhere
   in it: the check for a request that is still running is written as "not one of the four
   destinations" rather than as a comparison against the state it is in. */

DROP TRIGGER leave_request_ends_once ON leave_request;

CREATE OR REPLACE FUNCTION refuse_an_impossible_transition() RETURNS trigger
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
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'The days this request held have already been given back. '
                         'Moving it again would either release them twice or '
                         'rewrite what happened to somebody’s leave. If the days are '
                         'wanted, ask for them again. FR 26, FR 27.';
    END IF;

    IF OLD.status = 'APPROVED' THEN
        RAISE EXCEPTION
            'Leave request % has been approved and cannot be moved from there.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'The days are taken rather than held, so there is no hold left '
                         'to release and none of withdrawing, refusing or cancelling '
                         'means anything here. Taking agreed leave off the books is HR '
                         'putting the days back as a correction. FR 26, FR 27.';
    END IF;

    IF NEW.status NOT IN ('APPROVED', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled '
                         'or refused, and nothing may move it back. §6.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_moves_as_the_table_says
    BEFORE UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_impossible_transition();

-- ---------------------------------- a request takes its days, exactly once

/* The mirror of `leave_request_releases_once`, one movement along.

   A partial unique index rather than a count checked somewhere, for the reason that one is:
   an index is evaluated by the database on every connection at the moment of the write, and
   there is no window in it for two transactions to both find nothing. `daysToCommit` refuses
   the second approval anyway — the first emptied the hold it would have to come out of — and
   this is what holds where nothing went through that door. */

CREATE UNIQUE INDEX leave_request_commits_once
    ON leave_ledger_entry (leave_request_id)
    WHERE entry_type = 'DEDUCTION';

/* And a request that was approved and took nothing. The third of the family, checked at
   COMMIT for the reason the other two are: the status has to move before an entry can name
   the row it moved, so a request that is approved and has committed nothing is a legitimate
   intermediate state that only a check at the end can judge.

   What it catches is the second writer — a data fix marking a batch APPROVED, an import
   that sets a status while correcting something else. Each looks entirely reasonable, and
   each would leave somebody's leave agreed, absent from their calendar, and still counted
   as pending in their balance for ever.

   **The WHEN is what makes an intermediate approval free.** A request moving from its first
   desk to its second does not change status, so this never fires for it — which is correct
   rather than a loophole: no days moved, so there is no movement to insist on. */

CREATE FUNCTION refuse_a_request_that_took_no_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted` refuses
       it, but a constraint trigger fires on a row that no longer has to be there and
       reading a missing one would raise the wrong error entirely. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM leave_ledger_entry
         WHERE leave_request_id = NEW.id AND entry_type = 'DEDUCTION'
    ) THEN
        RAISE EXCEPTION 'Leave request % was approved without taking its days.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_takes_its_days',
                  HINT = 'The last approval in a chain turns the days a request was '
                         'holding into days taken, in the same transaction. Leave that '
                         'is agreed and still counted as pending is a balance that says '
                         'somebody is waiting to hear about leave they have been given. '
                         'FR 26, FR 38a.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_takes_its_days
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'APPROVED')
    EXECUTE FUNCTION refuse_a_request_that_took_no_days();

-- ---------------------------------------------------------------- privileges

/* Nothing to grant. UPDATE on `leave_request` was granted by
   create-and-submit-a-leave-request "for two columns' sake — `status`, which the approval
   story moves, and `reason`"; the grant is on the table rather than on a column list,
   which that migration argued for at the time — "a column list in a GRANT is a rule nobody
   reads, and a trigger is a rule with its argument attached" — so the column added above
   is covered by it. The INSERT on `leave_ledger_entry` that the DEDUCTION needs has been
   there since immutable-leave-ledger. */


-- Down Migration

-- The order below is the whole of this section and none of it is arbitrary: **every rule
-- that would refuse the restoring comes down before the restoring happens, and goes back
-- afterwards.** Rolling back means moving approved requests into a state neither the new
-- rules nor the old ones permit — that is what a rollback of a state machine is — and a
-- down section that leaves its own guards standing is one that fails halfway through with
-- a message about the very rule it is removing.

DROP TRIGGER IF EXISTS leave_request_takes_its_days ON leave_request;
DROP FUNCTION IF EXISTS refuse_a_request_that_took_no_days();

DROP INDEX IF EXISTS leave_request_commits_once;

/* The transition trigger comes down first and goes back last. Between the two there is no
   check on where a request may move, which is the only window in which an APPROVED one can
   be put back to SUBMITTED. */

DROP TRIGGER IF EXISTS leave_request_moves_as_the_table_says ON leave_request;

/* And the equivalence, because a request restored to SUBMITTED with no desk on it is
   precisely what it refuses. The column goes at the end of this section regardless, so
   nothing is lost by taking the rule off it now. */

ALTER TABLE leave_request
    DROP CONSTRAINT IF EXISTS leave_request_waits_at_a_desk;

/* Requests that were approved go back to being requests that are still being decided, and
   their DEDUCTION entries go with them.

   **This is the only rollback in the schema that removes a ledger row, and it is a
   deliberate act rather than an oversight of `leave_ledger_entry_is_never_deleted`.** That
   trigger refuses a DELETE on every connection, and the release story declined to work
   around it — its down section leaves RELEASE entries in place and says so: "the ledger is
   the record of what happened and a rollback of a schema is not a claim that it did not".
   The figures there stayed right and only the statuses were being forgotten.

   Here the figures do not stay right. A DEDUCTION left behind by a request restored to
   SUBMITTED is days sitting in `taken` for leave the schema now says nobody has approved,
   and `rebuild_one_balance_from_the_ledger()` would go on reporting it that way for ever —
   a balance that reconciles against a request that contradicts it, which is worse than
   either being wrong on its own.

   So the trigger comes off for the length of one statement and goes straight back. The
   employees-never-deleted migration describes exactly this escape hatch and its price:
   "drop this trigger in a migration, delete the row, and put the trigger back in the same
   migration. That is a deliberate act" — with an author and a review on it, which is the
   most a database can offer.

   The entries go before the statuses, so that no moment exists in which a request reads
   APPROVED with nothing to show for it. */

DROP TRIGGER IF EXISTS leave_ledger_entry_is_never_deleted ON leave_ledger_entry;

DELETE FROM leave_ledger_entry
    WHERE entry_type = 'DEDUCTION'
      AND leave_request_id IN (SELECT id FROM leave_request WHERE status = 'APPROVED');

CREATE TRIGGER leave_ledger_entry_is_never_deleted
    BEFORE DELETE ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A ledger entry is never removed. Days that moved, moved; a balance that '
        'no longer explains itself is worse than one that is wrong. Post a '
        'compensating ADJUSTMENT naming this row instead. FR 27.'
    );

/* And the cache in front of them, which does not rebuild itself here.

   `leave_ledger_entry_rebuilds_the_balance` is an `AFTER INSERT` trigger and nothing else,
   because the ledger is append only and a story that removes a row from it was not a story
   anybody expected to write. This one does, so the recompute is asked for by name — the
   same call the trigger makes, over every balance, which is exactly what the
   cached-balance migration did to build the cache in the first place.

   Without it the deductions are gone and `taken` still says five: a cached figure with
   nothing behind it, which the nightly reconciliation of LMS 215 would report as a
   disagreement every night until somebody noticed. */

SELECT rebuild_one_balance_from_the_ledger(employee_id, leave_type_id, leave_year_id)
FROM (
    SELECT DISTINCT employee_id, leave_type_id, leave_year_id FROM leave_balance
) AS balances;

/* And the requests themselves, back to waiting to be decided — which is what they will
   look like to a database that has forgotten how to approve anything. Their days are back
   in `pending`, where the reservation still holds them. */

UPDATE leave_request
   SET status = 'SUBMITTED'
 WHERE status = 'APPROVED';

/* Back to the predicate LMS 304 wrote. Nothing moves in or out of it: every row this
   rebuild sees was SUBMITTED or APPROVED a moment ago and is SUBMITTED now, and both were
   inside the wider rule. */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_never_overlaps;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_never_overlaps
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('SUBMITTED'));

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (
        status IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED', 'REFUSED'));

/* The transition rule goes back to the one LMS 306 wrote, name and body.

   `CREATE OR REPLACE` rather than a drop, in both directions: the function is shared with
   its trigger and replacing the body is what "the same rule, refusing less" looks like. It
   goes back last, after every row it would have refused has already moved. */

CREATE OR REPLACE FUNCTION refuse_an_impossible_transition() RETURNS trigger
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

DROP INDEX IF EXISTS leave_request_by_desk;

ALTER TABLE leave_request
    DROP CONSTRAINT IF EXISTS leave_request_awaiting_role_known;

ALTER TABLE leave_request
    DROP COLUMN IF EXISTS awaiting_approval_from;
