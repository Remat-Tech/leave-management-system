-- Up Migration

-- The Chief Executive reverses a request that is fully approved or fully refused.
--
--   | | Approved → refused | Refused → approved |
--   |---|---|---|
--   | when | before the leave starts | any time |
--   | the ledger | a `RECALCULATION` of what it took | a second `RESERVATION` and a `DEDUCTION` |
--   | a reason | required | required |
--
-- Once per request, recorded in its own append-only table, like a withdrawal.

-- ------------------------------------------------------------------ the reversal

CREATE TABLE leave_request_reversal (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    action VARCHAR(20) NOT NULL,

    reason TEXT NOT NULL,

    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_reversal_action_known CHECK (
        action IN ('REVERSE_APPROVAL', 'REVERSE_REFUSAL')),

    CONSTRAINT leave_request_reversal_says_why CHECK (btrim(reason) <> ''),

    CONSTRAINT leave_request_reversal_recorded_by_not_blank CHECK (btrim(recorded_by) <> '')
);

/* A request is reversed once. */
CREATE UNIQUE INDEX leave_request_reversed_once ON leave_request_reversal (leave_request_id);

/* The same three columns a withdrawal stamps, so the same function. */
CREATE TRIGGER leave_request_reversal_records_its_writer
    BEFORE INSERT ON leave_request_reversal
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_writer_on_a_withdrawal();

CREATE TRIGGER leave_request_reversal_is_never_changed
    BEFORE UPDATE ON leave_request_reversal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A reversal is a record of a decision the Chief Executive made. It is not edited '
        'afterwards.'
    );

CREATE TRIGGER leave_request_reversal_is_never_deleted
    BEFORE DELETE ON leave_request_reversal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'Removing a reversal leaves a request whose status nothing explains.'
    );

-- --------------------------------------- a settled request may now be reversed

/* `refuse_an_impossible_transition()` as withdraw-an-approved-request left it, plus
   APPROVED → REFUSED and REFUSED → APPROVED. The trigger below says who may make them. */

CREATE OR REPLACE FUNCTION refuse_an_impossible_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'REFUSED' AND NEW.status = 'APPROVED' THEN
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
        IF NEW.status NOT IN ('WITHDRAWN', 'REFUSED') THEN
            RAISE EXCEPTION
                'Leave request % has been approved and cannot become %.', OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'Agreed leave comes off the books by the person asking and HR '
                             'agreeing, or by the Chief Executive reversing the decision. '
                             'FR 26, FR 27, FR 47.';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.status = 'UNROUTABLE' THEN
        IF NEW.status NOT IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED') THEN
            RAISE EXCEPTION
                'Leave request % has nobody who can decide it and cannot become %.',
                OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'A request nobody could be found to decide has not been judged. '
                             'It may go back to an approver once there is one, be withdrawn '
                             'by the person who asked, or be cancelled by HR — and it may '
                             'not be approved or turned down by a desk that was never '
                             'filled. FR 48b.';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('APPROVED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled, '
                         'refused, or left with nobody who can decide it. §6.';
    END IF;

    RETURN NEW;
END
$$;

-- ------------------------- and only the Chief Executive, with a reversal behind it

CREATE FUNCTION refuse_a_reversal_nobody_recorded() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    wanted TEXT := CASE WHEN NEW.status = 'REFUSED' THEN 'REVERSE_APPROVAL'
                        ELSE 'REVERSE_REFUSAL' END;
    reversal leave_request_reversal%ROWTYPE;
    chief BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO reversal
      FROM leave_request_reversal
     WHERE leave_request_id = NEW.id AND action = wanted;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Leave request % went from % to % with no reversal recorded.',
            NEW.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reversed_by_the_chief_executive',
                  HINT = 'A settled request changes its outcome only by the Chief '
                         'Executive reversing it, with the reason, in the same transaction.';
    END IF;

    SELECT ceo_employee_id INTO chief FROM organisation_setting LIMIT 1;

    IF reversal.recorded_by_employee_id IS NULL
       OR chief IS NULL
       OR reversal.recorded_by_employee_id <> chief
       OR reversal.recorded_by_employee_id = NEW.employee_id THEN
        RAISE EXCEPTION
            'Leave request % was reversed by somebody who may not reverse it.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reversed_by_the_chief_executive',
                  HINT = 'Only the Chief Executive reverses a settled request, and never '
                         'their own. FR 48.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_reversed_by_the_chief_executive
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN ((OLD.status = 'APPROVED' AND NEW.status = 'REFUSED')
          OR (OLD.status = 'REFUSED' AND NEW.status = 'APPROVED'))
    EXECUTE FUNCTION refuse_a_reversal_nobody_recorded();

-- ---------------------- a request holds its days once at a time, not once ever

/* A reversed refusal holds its days a second time, after the first hold was released. The
   unique index becomes "no more holds than releases, plus one". */

DROP INDEX leave_request_reserves_once;

CREATE FUNCTION refuse_a_second_hold_on_the_same_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    holds INTEGER;
    releases INTEGER;
BEGIN
    SELECT count(*) FILTER (WHERE entry_type = 'RESERVATION'),
           count(*) FILTER (WHERE entry_type = 'RELEASE')
      INTO holds, releases
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.leave_request_id;

    IF holds > releases + 1 THEN
        RAISE EXCEPTION
            'Leave request % is already holding its days.', NEW.leave_request_id
            USING ERRCODE = 'unique_violation',
                  CONSTRAINT = 'leave_request_reserves_once',
                  HINT = 'A request holds what it costs once. Holding it again before the '
                         'first hold was given back charges the same leave twice. FR 26.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_reserves_once
    AFTER INSERT ON leave_ledger_entry
    FOR EACH ROW
    WHEN (NEW.entry_type = 'RESERVATION')
    EXECUTE FUNCTION refuse_a_second_hold_on_the_same_days();

-- ------------------------------------------------------------ what somebody is told

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING',
                  'LEAVE_RECLASSIFIED', 'LEAVE_RECALCULATED', 'DECISION_REVERSED'));

-- ---------------------------------------------------------------------- privileges

GRANT SELECT, INSERT ON leave_request_reversal TO lms_app;


-- Down Migration

-- Run before anything has been reversed: a reversed request would break the rules put back.

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

DELETE FROM notification WHERE event = 'DECISION_REVERSED';

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING',
                  'LEAVE_RECLASSIFIED', 'LEAVE_RECALCULATED'));

DROP TRIGGER IF EXISTS leave_request_reserves_once ON leave_ledger_entry;
DROP FUNCTION IF EXISTS refuse_a_second_hold_on_the_same_days();

CREATE UNIQUE INDEX leave_request_reserves_once
    ON leave_ledger_entry (leave_request_id)
    WHERE entry_type = 'RESERVATION';

DROP TRIGGER IF EXISTS leave_request_reversed_by_the_chief_executive ON leave_request;
DROP FUNCTION IF EXISTS refuse_a_reversal_nobody_recorded();

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
        IF NEW.status <> 'WITHDRAWN' THEN
            RAISE EXCEPTION
                'Leave request % has been approved and cannot become %.', OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'Leave that every desk has agreed to is not turned down and is '
                             'not unwound: the person asks for it to be withdrawn and HR '
                             'agrees, which puts the days back as a correction. A mistake '
                             'on an approved request is an adjustment with a reason on it. '
                             'FR 26, FR 27, FR 47.';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.status = 'UNROUTABLE' THEN
        IF NEW.status NOT IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED') THEN
            RAISE EXCEPTION
                'Leave request % has nobody who can decide it and cannot become %.',
                OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'A request nobody could be found to decide has not been judged. '
                             'It may go back to an approver once there is one, be withdrawn '
                             'by the person who asked, or be cancelled by HR — and it may '
                             'not be approved or turned down by a desk that was never '
                             'filled. FR 48b.';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('APPROVED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled, '
                         'refused, or left with nobody who can decide it. §6.';
    END IF;

    RETURN NEW;
END
$$;

DROP TABLE IF EXISTS leave_request_reversal;
