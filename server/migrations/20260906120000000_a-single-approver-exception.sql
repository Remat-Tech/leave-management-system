-- Up Migration

-- A request one person decided says so. FR 48d, FR 44, FR 48, §8.6a. LMS 322.
--
-- LMS 320 deduplicated by desk. Two desks can resolve to one person, and asking them twice
-- writes two approvals where there was one. Two stages get two people; where the company has
-- nobody else, the request goes through stamped rather than signed twice.

-- ------------------------------------------------- one person decides one stage

/* Sibling of `leave_request_decision_once_per_desk`. NULL is nobody — `theSystem` — and
   Postgres holds as many of those as arrive, which is the wanted answer. */

CREATE UNIQUE INDEX leave_request_decision_once_per_person
    ON leave_request_decision (leave_request_id, decided_by_employee_id);

-- --------------------------------------------------------------- and says when it was one

/* Written by the move that settles it, false everywhere else. FR 48d. */

ALTER TABLE leave_request
    ADD COLUMN decided_by_a_single_approver BOOLEAN NOT NULL DEFAULT false;

/* And it agrees with the decisions, both ways: the exception cannot be left off, and it
   cannot be claimed where a second person decided. A chain of one stage is not an exception.

   Deferred, as `leave_request_records_its_decision` is: the decision lands after the
   status it explains. */

CREATE FUNCTION refuse_a_miscounted_approver() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    stages INTEGER;
    decisions INTEGER;
    people INTEGER;
    unnamed INTEGER;
    one_hand BOOLEAN;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO stages
      FROM leave_type_approval_step
     WHERE leave_type_id = NEW.leave_type_id;

    SELECT count(*),
           count(DISTINCT decided_by_employee_id),
           count(*) FILTER (WHERE decided_by_employee_id IS NULL)
      INTO decisions, people, unnamed
      FROM leave_request_decision
     WHERE leave_request_id = NEW.id;

    one_hand := NEW.status IN ('APPROVED', 'REFUSED')
                AND stages > 1
                AND decisions > 0
                AND unnamed = 0
                AND people = 1;

    IF NEW.decided_by_a_single_approver IS DISTINCT FROM one_hand THEN
        RAISE EXCEPTION
            'Leave request % says it was decided by a single approver: %, and it was: %.',
            NEW.id, NEW.decided_by_a_single_approver, one_hand
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_says_when_one_person_decided_it',
                  HINT = 'A request every stage of which was answered by one person is on '
                         'the record as exactly that, and one that two people decided is '
                         'not. Otherwise somebody reads two approvals where there was '
                         'really one. FR 48d.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_says_when_one_person_decided_it
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (
        (NEW.status IN ('APPROVED', 'REFUSED') AND NEW.status IS DISTINCT FROM OLD.status)
        OR NEW.decided_by_a_single_approver IS DISTINCT FROM OLD.decided_by_a_single_approver
    )
    EXECUTE FUNCTION refuse_a_miscounted_approver();

-- ---------------------------------------------------------- the requests already settled

/* Stamped by the same reading the trigger makes. Nothing is decided and no days move. */

UPDATE leave_request request
   SET decided_by_a_single_approver = true
 WHERE request.status IN ('APPROVED', 'REFUSED')
   AND (SELECT count(*)
          FROM leave_type_approval_step step
         WHERE step.leave_type_id = request.leave_type_id) > 1
   AND EXISTS (SELECT 1
                 FROM leave_request_decision decision
                WHERE decision.leave_request_id = request.id)
   AND NOT EXISTS (SELECT 1
                     FROM leave_request_decision decision
                    WHERE decision.leave_request_id = request.id
                      AND decision.decided_by_employee_id IS NULL)
   AND (SELECT count(DISTINCT decision.decided_by_employee_id)
          FROM leave_request_decision decision
         WHERE decision.leave_request_id = request.id) = 1;


-- Down Migration

-- The stamp goes; the decisions it was read from stay, so the fact is still derivable.
-- No days move.

DROP TRIGGER IF EXISTS leave_request_says_when_one_person_decided_it ON leave_request;

DROP FUNCTION IF EXISTS refuse_a_miscounted_approver();

ALTER TABLE leave_request
    DROP COLUMN IF EXISTS decided_by_a_single_approver;

DROP INDEX IF EXISTS leave_request_decision_once_per_person;
