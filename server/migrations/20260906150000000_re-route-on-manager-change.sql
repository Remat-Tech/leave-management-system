-- Up Migration

-- Pending leave follows the reporting line. FR 07, §8.4, FR 48b. LMS 325.
--
-- The MANAGER desk resolves through the line, so a request waiting there is the new
-- manager's at once. What was missing: the record of the handover, and the two cases where
-- the desk itself moves — a request stranded UNROUTABLE, and one whose desk this empties.

-- ------------------------------------------ the requests a moved line carried with it

/* One row per request a reporting-line change moved. Usually `moved_from` = `moved_to` =
   MANAGER: the desk stayed and the person behind it changed. */

CREATE TABLE leave_request_reassignment (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* Either may be nobody: FR 04's root has no line manager. */
    from_manager_employee_id BIGINT REFERENCES employee(id),
    to_manager_employee_id BIGINT REFERENCES employee(id),

    /* The desk before and after. NULL is nobody, as `awaiting_approval_from` is. */
    moved_from VARCHAR(20),
    moved_to VARCHAR(20),

    /** NFR USA 03. What the requester and the new manager read. */
    because TEXT NOT NULL,

    /* Stamped rather than supplied, as every append-only table here. */
    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_reassignment_from_desk_known CHECK (
        moved_from IS NULL OR moved_from IN ('MANAGER', 'HR', 'CEO')),

    CONSTRAINT leave_request_reassignment_to_desk_known CHECK (
        moved_to IS NULL OR moved_to IN ('MANAGER', 'HR', 'CEO')),

    /* A line that did not move carried nothing. */
    CONSTRAINT leave_request_reassignment_line_moved CHECK (
        from_manager_employee_id IS DISTINCT FROM to_manager_employee_id),

    CONSTRAINT leave_request_reassignment_says_why CHECK (btrim(because) <> ''),

    CONSTRAINT leave_request_reassignment_recorded_by_not_blank CHECK (btrim(recorded_by) <> '')
);

CREATE INDEX leave_request_reassignment_by_request
    ON leave_request_reassignment (leave_request_id, id);

/* The three lines `stamp_the_recorder_on_a_routing()` writes, against this table. */

CREATE FUNCTION stamp_the_recorder_on_a_reassignment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.recorded_at := now();

    NEW.recorded_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.recorded_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_reassignment_records_its_recorder
    BEFORE INSERT ON leave_request_reassignment
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_recorder_on_a_reassignment();

/* Append only, on every connection. */

CREATE TRIGGER leave_request_reassignment_is_never_changed
    BEFORE UPDATE ON leave_request_reassignment
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A reassignment records that a request changed hands. Editing it would rewrite '
        'who was waiting on whose answer. FR 07.'
    );

CREATE TRIGGER leave_request_reassignment_is_never_deleted
    BEFORE DELETE ON leave_request_reassignment
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A reassignment is never removed. A request that moved desks with nothing to say '
        'what moved it is a request nobody can explain. FR 07.'
    );

-- ---------------------------- and a move a reporting line made is a move explained

/* `refuse_a_move_no_decision_explains()` takes a second kind of explanation. A reassignment
   decides nothing, so it cannot explain APPROVED or REFUSED. FR 07. */

CREATE OR REPLACE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT[] := CASE NEW.status
        WHEN 'REFUSED' THEN ARRAY['REFUSE', 'OVERTURN_APPROVAL']
        WHEN 'APPROVED' THEN ARRAY['APPROVE', 'OVERTURN_REJECTION']
        ELSE ARRAY['APPROVE', 'REFUSE', 'OVERTURN_REJECTION', 'OVERTURN_APPROVAL']
    END;
    latest leave_request_decision%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    IF NEW.status IN ('SUBMITTED', 'UNROUTABLE') AND EXISTS (
        SELECT 1
          FROM leave_request_reassignment moved
         WHERE moved.leave_request_id = NEW.id
           AND moved.moved_from IS NOT DISTINCT FROM OLD.awaiting_approval_from
           AND moved.moved_to IS NOT DISTINCT FROM NEW.awaiting_approval_from
    ) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO latest
      FROM leave_request_decision
     WHERE leave_request_id = NEW.id
     ORDER BY id DESC
     LIMIT 1;

    IF NOT FOUND
       OR NOT (latest.action = ANY (expected))
       OR latest.on_behalf_of IS DISTINCT FROM OLD.awaiting_approval_from THEN
        RAISE EXCEPTION
            'Leave request % moved to % at the % desk without recording who decided it.',
            NEW.id, NEW.status, OLD.awaiting_approval_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_records_its_decision',
                  HINT = 'Deciding leave writes a decision naming the desk it was decided '
                         'at, in the same transaction as the status. A request that moved '
                         'with nothing to say who moved it or why is the corridor '
                         'conversation the record exists to replace. FR 39, FR 52, FR 44.';
    END IF;

    RETURN NULL;
END
$$;

-- ------------------------------------------------------ one thing somebody was told

/* FR 59's list gains the handover, written to the manager who inherited the decision. */

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED'));

-- ---------------------------------------------------------------- privileges

GRANT SELECT, INSERT ON leave_request_reassignment TO lms_app;


-- Down Migration

-- The rule that reads the table comes off before the table does. Requests stay where the
-- reassignments left them; no days moved. What is lost is the account of what moved them.

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

DELETE FROM notification WHERE event = 'REASSIGNED';

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED'));

/* Back to the body LMS 320 wrote, which knows only about decisions. */

CREATE OR REPLACE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT[] := CASE NEW.status
        WHEN 'REFUSED' THEN ARRAY['REFUSE', 'OVERTURN_APPROVAL']
        WHEN 'APPROVED' THEN ARRAY['APPROVE', 'OVERTURN_REJECTION']
        ELSE ARRAY['APPROVE', 'REFUSE', 'OVERTURN_REJECTION', 'OVERTURN_APPROVAL']
    END;
    latest leave_request_decision%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO latest
      FROM leave_request_decision
     WHERE leave_request_id = NEW.id
     ORDER BY id DESC
     LIMIT 1;

    IF NOT FOUND
       OR NOT (latest.action = ANY (expected))
       OR latest.on_behalf_of IS DISTINCT FROM OLD.awaiting_approval_from THEN
        RAISE EXCEPTION
            'Leave request % moved to % at the % desk without recording who decided it.',
            NEW.id, NEW.status, OLD.awaiting_approval_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_records_its_decision',
                  HINT = 'Deciding leave writes a decision naming the desk it was decided '
                         'at, in the same transaction as the status. A request that moved '
                         'with nothing to say who moved it or why is the corridor '
                         'conversation the record exists to replace. FR 39, FR 52, FR 44.';
    END IF;

    RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS leave_request_reassignment_is_never_deleted ON leave_request_reassignment;
DROP TRIGGER IF EXISTS leave_request_reassignment_is_never_changed ON leave_request_reassignment;
DROP TRIGGER IF EXISTS leave_request_reassignment_records_its_recorder
    ON leave_request_reassignment;

DROP FUNCTION IF EXISTS stamp_the_recorder_on_a_reassignment();

DROP TABLE IF EXISTS leave_request_reassignment;
