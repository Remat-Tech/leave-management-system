-- Up Migration

-- Leave is approved when every stage has approved it, and refusing at any stage ends it.
-- FR 41, FR 42, §6, §8. LMS 316.
--
-- The story is an employee who never takes leave believing it was agreed when it was not,
-- and the routing of LMS 314 gives them that only while nothing moves. It walks the chain
-- with a cursor — `awaiting_approval_from`, and the desk after the one that just signed —
-- and FR 31 gives the chain to an HR Administrator, who may edit it while a request is in
-- the queue.
--
-- **The case it gets wrong is a stage added in front of a request in flight.** Annual leave
-- goes manager then HR. A request is with HR because the manager has signed. The
-- administrator changes the chain to CEO, manager, HR. The desk after HR is nothing, so HR's
-- yes approves the leave, the Chief Executive never sees a request the policy now routes to
-- them, and the person is told their leave is agreed. Nothing about that arrives as a bug
-- report; it arrives as somebody on an aeroplane.
--
-- The application half of the answer is `nextUnapproved()` — the first stage with no approval
-- recorded rather than the one after the last signature — and it is a question about the
-- whole chain rather than about a position in it. That is only askable because LMS 315 made
-- decisions rows: until `leave_request_decision` existed, "has every stage approved" had no
-- answer in this system at all.
--
-- This migration is the half that holds when the application is not the writer.
--
-- ## Two criteria, two triggers
--
-- `leave_request_is_approved_by_every_stage` is FR 41: an APPROVED status exists only where
-- every stage of the chain has an approval on the record.
--
-- `leave_ledger_entry_takes_no_days_for_ended_leave` is FR 42, and it is what "the workflow
-- ends" means to a balance. A request refused at any stage — the last one included — has
-- ended and its days have gone back, and nothing may take them afterwards.
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_is_approved_by_every_stage` | a request approved with a stage unasked | a chain that grows after approval |
--   | `leave_ledger_entry_takes_no_days_for_ended_leave` | days taken for leave that was refused, withdrawn or cancelled | days taken for a request still being decided — see below |
--   | `leave_request_decision_once_per_desk` | one desk deciding twice on one request | two requests decided by one desk |
--
-- ## Why the second is about endings rather than about approval
--
-- The tempting rule is the exact converse of `leave_request_takes_its_days` — that one says
-- an approved request committed its days, so this would say days committed belong to leave
-- that was approved, and the two would make a DEDUCTION and an APPROVED status exist only
-- together. That is a stronger and a truer statement of how this system works.
--
-- **It is not this story's to make, because it retires `BalanceService.commit`.** That method
-- is the primitive behind the approval door and it is deliberately still there; LMS 314 said
-- why when it built the door beside it: "this posts the entry and leaves the request saying
-- it is still waiting to be decided, which is a balance and a request that disagree. This is
-- the primitive rather than the door, and it stays for the same reason `release` does — the
-- movement is a real one and a story that commits days for a reason other than a chain
-- running out will want it." A converse rule refuses every use of it, which is to say all of
-- them: an already-approved request has no hold left to draw down.
--
-- Taking a movement away from the ledger is somebody's decision to make rather than a side
-- effect of tightening the approval workflow — the same judgement LMS 314 made about not
-- narrowing `leaveRequestPolicy.refuse` to the chain. The story that removes the primitive
-- adds the converse here in one line.
--
-- What this migration takes is the half that is unambiguously FR 42 and costs nothing:
-- **days are never taken for leave that has ended.** A request refused by HR after its
-- manager approved is over, its days are back in the balance, and a second writer posting a
-- DEDUCTION against it — a retry, an import, a reconciliation that decided a request "looked
-- approved" — would charge somebody for leave they were turned down for, against a balance
-- that reconciles perfectly afterwards.
--
-- ## What the first one is judged against, and when
--
-- The chain **as it stands at the moment of approval**, which is the same reading the
-- application makes and is the only one that can be right. A request approved last March
-- under a two-stage chain is not retrospectively unapproved by a third stage added in
-- November: the trigger fires on the transition and never again, so what it judges is what
-- was true when somebody said yes. Design principle 1 — what was recorded is what happened,
-- and configuration describes what happens next.
--
-- **Order is deliberately not checked.** The rule is that every stage approved, not that they
-- approved in the order the chain lists them, and those are different claims. The order is
-- the routing's — `nextUnapproved()` hands the request on in chain order, and the policy
-- admits only the desk it is with — so a check here would be a third statement of a rule two
-- places already hold, and one that would refuse a legitimate approval the afternoon somebody
-- reorders a chain mid-flight. What the schema is for is the claim nothing else can make:
-- that the set is complete.
--
-- A type with no chain has no stages, so this passes vacuously. That is
-- `assertSomebodyApprovesIt`'s to refuse at submission with the type named, and
-- `leave_request_records_its_decision` means an approved request has at least one approval on
-- it regardless.

-- ------------------------------------------- one desk decides one request once

/* Each stage decides once, which is now a rule the walk keeps and the schema can hold.

   LMS 315 declined this index, and said why: "a chain reordered underneath a live request can
   ask the same desk twice… a unique index here would be a rule FR 31 can break, refusing a
   legitimate approval with a message about a constraint." That was true of the walk it was
   written against. `nextUnapproved()` never returns a desk that has signed, so the second ask
   cannot happen — and the index is what stops that being a promise the application makes to
   itself.

   Approvals and refusals share it, which is correct rather than incidental: a refusal ends
   the request, so a desk that has refused is never asked again either, and a desk that has
   approved cannot come back and refuse. One decision per stage per request, whichever it was. */

CREATE UNIQUE INDEX leave_request_decision_once_per_desk
    ON leave_request_decision (leave_request_id, on_behalf_of);

-- ------------------------------------------ every stage approved, FR 41

/* The story's first criterion, where no service can forget it.

   Deferred, for the reason the rest of the family is: the decision names the request, so the
   status has to move before the row explaining it can be written, and "a request that has
   just been approved and whose last decision is not in yet" is a legitimate intermediate
   state that only a check at COMMIT judges correctly.

   The message names the stages that did not approve rather than only refusing, because the
   reader is whoever is holding the second writer — a data fix, an import, a migration
   correcting something else — and "the Chief Executive never saw this" is the whole of what
   they need to know. */

CREATE FUNCTION refuse_an_approval_a_stage_never_gave() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    unasked TEXT;
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted` refuses
       it, but a constraint trigger fires on a row that no longer has to be there and
       reading a missing one would raise the wrong error entirely. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT string_agg(step.approver_role, ', ' ORDER BY step.step_order)
      INTO unasked
      FROM leave_type_approval_step step
     WHERE step.leave_type_id = NEW.leave_type_id
       AND NOT EXISTS (
            SELECT 1
              FROM leave_request_decision decision
             WHERE decision.leave_request_id = NEW.id
               AND decision.action = 'APPROVE'
               AND decision.on_behalf_of = step.approver_role);

    IF unasked IS NOT NULL THEN
        RAISE EXCEPTION
            'Leave request % was approved without %.', NEW.id, unasked
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_is_approved_by_every_stage',
                  HINT = 'Leave is agreed only once every stage of its type''s approval '
                         'chain has approved it. A request marked approved with a stage '
                         'unasked tells somebody their leave is agreed when it is not, and '
                         'they book a flight on it. FR 41, FR 42.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_is_approved_by_every_stage
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'APPROVED')
    EXECUTE FUNCTION refuse_an_approval_a_stage_never_gave();

-- ------------------------- and leave that has ended never takes days, FR 42

/* The story's second criterion: a rejection at the final stage ends the workflow, and what
   "ends" means to a balance is that no days are ever taken for it afterwards.

   The three endings are written out rather than said as "not approved", which is the
   narrowing the note above argues for and is also the discipline `RELEASING_STATUSES` keeps
   in /domain/leave-request.ts: a list is a decision somebody has to make, and a negation is a
   decision that gets made for them. The same three names are in the transition trigger of
   LMS 306, and the integration suite reads all of them back out of the catalogue and asserts
   they agree with the domain's list — so none of them can be extended alone.

   Deferred, because the status and the entry are written in one transaction and the order
   within it is the application's business rather than this rule's. `WHEN` keeps it to the one
   entry type that takes days: a RESERVATION belongs to a request being decided, a RELEASE is
   what an ending writes and must go on working, and a RECALCULATION is FR 25 adjusting leave
   that is already agreed. */

CREATE FUNCTION refuse_days_taken_for_leave_that_ended() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    said TEXT;
BEGIN
    SELECT status INTO said FROM leave_request WHERE id = NEW.leave_request_id;

    /* Unreachable: `leave_ledger_entry_request_movements_name_a_request` requires the id and
       a foreign key has already found the row, which nothing deletes. Answered rather than
       assumed, because a NULL comparison below would quietly permit what this refuses. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF said IN ('WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % was % and cannot take days.', NEW.leave_request_id, said
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_takes_no_days_for_ended_leave',
                  HINT = 'A request that was refused — at its last stage or at any other — '
                         'has ended, and the days it was holding have gone back to the '
                         'person. Taking them afterwards charges somebody for leave they '
                         'were turned down for, against a balance that reconciles perfectly. '
                         'FR 26, FR 42.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_ledger_entry_takes_no_days_for_ended_leave
    AFTER INSERT ON leave_ledger_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.entry_type = 'DEDUCTION')
    EXECUTE FUNCTION refuse_days_taken_for_leave_that_ended();

-- ---------------------------------------------------------------- privileges

/* Nothing to grant. Both triggers refuse writes rather than making new ones possible, and
   the index is on a table `lms_app` already holds SELECT and INSERT on. */


-- Down Migration

/* The two checks come off, and nothing else has to be unpicked: neither wrote a row, and a
   database that has forgotten how to insist on every stage still holds every decision that
   was recorded while it did. That is the difference between rolling this back and rolling
   back LMS 314, whose down section had to remove ledger entries because the figures would
   otherwise have stopped explaining themselves. */

DROP TRIGGER IF EXISTS leave_ledger_entry_takes_no_days_for_ended_leave ON leave_ledger_entry;
DROP FUNCTION IF EXISTS refuse_days_taken_for_leave_that_ended();

DROP TRIGGER IF EXISTS leave_request_is_approved_by_every_stage ON leave_request;
DROP FUNCTION IF EXISTS refuse_an_approval_a_stage_never_gave();

/* And the index, which the walk of LMS 314 would otherwise be refused by: `approverAfter()`
   can ask a desk twice where a chain was reordered under a live request, and a rollback of
   this migration is a rollback to that walk. */

DROP INDEX IF EXISTS leave_request_decision_once_per_desk;
