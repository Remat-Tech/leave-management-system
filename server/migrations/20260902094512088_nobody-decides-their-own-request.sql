-- Up Migration

-- Nobody decides their own request. FR 48, §8.6a, §10. LMS 319.
--
-- The story is one sentence and it is about what an approval is worth: leave that was agreed
-- by the person taking it was not agreed by anybody, and an approval anybody can give
-- themselves is a field on a form rather than a decision. So the rule is not "an employee may
-- not approve" — it is that the *requester* may not, whoever they turn out to be, which
-- includes an HR Administrator, the Head of HR and the Chief Executive.
--
-- ## What was already true, and the half that was not
--
-- LMS 314 built the routing and excluded the requester from `THE_DESK_IT_IS_WITH`, so nobody
-- has been able to *approve* their own leave since. That was written for an ordinary case
-- rather than an adversarial one: unpaid leave routes to the HR desk first — §4.3.1 — and an
-- HR Officer asking for unpaid leave holds a code that staffs the desk their own request
-- starts at.
--
-- Refusing was open. `TRANSITIONS` admits `LEAVE_ADMINISTRATION` to the REFUSE row, which is
-- right — HR turning down somebody else's leave is what the standing is for — and the same
-- officer asking for their own leave held it. They could turn their own request down: a row
-- in this table, with a desk on it and their own name against it, recording a decision nobody
-- else made. `leaveRequestPolicy.notTheirOwn` is what closes that in the application, asked
-- at the top of both decision methods and again inside the balance lock at both doors.
--
-- ## Why the same rule is also here
--
-- Because the story's criterion is that it fires *regardless of role, screen or endpoint*,
-- and an application check answers for the endpoints that exist today. This answers for the
-- ones that do not: the admin view of Phase 4, a bulk action approving a queue in one click,
-- a repair script at a psql prompt, next year's import. Every one of them writes this table
-- or writes nothing at all, because `leave_request_records_its_decision` refuses a request
-- that moved at a desk with no decision behind it — so a self-approval that never wrote a row
-- here cannot move a request either.
--
-- That pairing is what makes this a complete answer rather than a second opinion. The two
-- triggers are one rule read from both ends: a move needs a decision, and a decision may not
-- be the requester's.
--
-- ## What it compares, and what it lets through
--
-- `decided_by_employee_id` against the `employee_id` of the request being decided. Both are
-- ids of the same table, and neither is supplied by the writer — `stamp_the_decider_on_a_
-- decision()` puts the first there from the transaction-local setting the repositories set,
-- which is the property this whole check rests on. A writer who could name the decider could
-- name somebody else and approve their own leave under a colleague's name, which is why the
-- stamping trigger and this one are two halves of one guarantee rather than two checks.
--
-- **A null decider passes**, and that is deliberate rather than a gap. It is the annual run,
-- the rollover and the seed — `theSystem`, which /auth/actor.ts makes nobody on purpose so
-- that it matches no record's owner and can never be somebody's colleague by accident. It is
-- also an unattributed write, which `decided_by` records as such and which is a finding in
-- its own right; refusing it here would refuse it with the wrong sentence.
--
-- **Withdrawals and cancellations are not reached at all.** Neither writes a decision —
-- `leave_request_decision_action_known` admits APPROVE and REFUSE and nothing else — because
-- neither is a judgement at a desk. Taking back your own leave is the one act on this table's
-- subject that is *only* ever your own, and a rule here that caught it would be the schema
-- refusing a person the right to change their mind.
--
-- ## AFTER INSERT rather than BEFORE, and why that is not a detail
--
-- The column this reads is written by a BEFORE INSERT trigger, and BEFORE triggers fire in
-- name order — so a BEFORE trigger named for this rule would run before `leave_request_
-- decision_records_its_decider` and read a null every time, passing everything silently. An
-- AFTER trigger runs once every BEFORE trigger has had its say, which is the only point at
-- which the decider is a fact.
--
-- It is a CONSTRAINT TRIGGER so that the refusal carries a constraint name a caller can
-- recognise, and it is NOT deferred: there is nothing to wait for, the row is complete when
-- it is written, and a refusal at the statement is a refusal beside the statement that caused
-- it rather than at a COMMIT that names four of them.

CREATE FUNCTION refuse_a_decision_by_the_requester() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    requester BIGINT;
BEGIN
    /* Nobody decided it, which is the system or an unattributed write. See the note above:
       `theSystem` is nobody by construction, and nobody is not somebody. */
    IF NEW.decided_by_employee_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT employee_id INTO requester
      FROM leave_request
     WHERE id = NEW.leave_request_id;

    /* Unreachable: `leave_request_id` is NOT NULL with a foreign key behind it and
       `leave_request_is_never_deleted` refuses to remove a request on any connection.
       Answered rather than assumed, because a missing row would make the comparison NULL and
       NULL is not true — which is a check that silently stops checking. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF requester = NEW.decided_by_employee_id THEN
        RAISE EXCEPTION
            'Employee % asked for leave request % and cannot % it.',
            requester, NEW.leave_request_id, lower(NEW.action)
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_never_decided_by_the_requester',
                  HINT = 'Leave is decided by somebody other than the person taking it, '
                         'whatever roles they hold and wherever the request is sitting. An '
                         'approval somebody can give themselves is not an approval. If the '
                         'leave is no longer wanted the person withdraws it, and if the '
                         'request should not be on the books HR cancels it — neither of '
                         'which is a decision at a desk. FR 48, §8.6a.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_never_decided_by_the_requester
    AFTER INSERT ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_decision_by_the_requester();


-- Down Migration

/* Dropping this puts the database back where it was this morning: an application that asks
   the same question three times, and nothing underneath it if something ever writes this
   table without asking. The rows already written are unaffected — none of them could have
   been self-made, which is the point of having applied it. */

DROP TRIGGER IF EXISTS leave_request_never_decided_by_the_requester ON leave_request_decision;
DROP FUNCTION IF EXISTS refuse_a_decision_by_the_requester();
