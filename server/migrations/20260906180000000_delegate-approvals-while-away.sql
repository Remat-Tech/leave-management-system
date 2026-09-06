-- Up Migration

-- An approver hands their approvals to a colleague for a date range. FR 49, §8.6a. LMS 327.
--
-- LMS 320 routed round a desk that is empty; this covers one whose occupant is away. A
-- delegation is of a person, never of a desk: the desks follow from whatever the approver
-- staffs on the day.

-- ------------------------------------------------ approvals, handed to a colleague

CREATE TABLE approval_delegation (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* Whose approvals these are, and who answers them while they are away. */
    approver_employee_id BIGINT NOT NULL REFERENCES employee(id),
    delegate_employee_id BIGINT NOT NULL REFERENCES employee(id),

    /* Inclusive at both ends, as every period here. NFR DAT 03. */
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,

    /** NFR USA 03. Optional: "I am away" is the whole of most of them. */
    because TEXT,

    /* Ended before its last day. NULL while it stands. */
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    revoked_by_employee_id BIGINT REFERENCES employee(id),

    /* Stamped rather than supplied, as every table here that records an act. */
    nominated_by TEXT NOT NULL,
    nominated_by_employee_id BIGINT REFERENCES employee(id),
    nominated_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT approval_delegation_ends_after_it_starts CHECK (ends_on >= starts_on),

    /* A delegation to yourself hands nothing to anybody. */
    CONSTRAINT approval_delegation_is_somebody_else CHECK (
        approver_employee_id <> delegate_employee_id),

    CONSTRAINT approval_delegation_reason_not_blank CHECK (
        because IS NULL OR btrim(because) <> ''),

    CONSTRAINT approval_delegation_ends_all_at_once CHECK (
        (revoked_at IS NULL) = (revoked_by IS NULL)),

    CONSTRAINT approval_delegation_nominated_by_not_blank CHECK (btrim(nominated_by) <> '')
);

/* One delegate at a time: two people holding one person's approvals is a decision recorded
   under whichever pressed first. The baseline's btree_gist, as `leave_request_never_overlaps`.
   An ended delegation drops out, so a fortnight handed to the wrong person is re-handed. */

ALTER TABLE approval_delegation
    ADD CONSTRAINT approval_delegation_one_delegate_at_a_time
    EXCLUDE USING gist (
        approver_employee_id WITH =,
        daterange(starts_on, ends_on, '[]') WITH &&)
    WHERE (revoked_at IS NULL);

CREATE INDEX approval_delegation_by_delegate
    ON approval_delegation (delegate_employee_id, starts_on, ends_on);

CREATE INDEX approval_delegation_by_approver
    ON approval_delegation (approver_employee_id, starts_on, ends_on);

/* The three lines `stamp_the_decider_on_a_decision()` writes. */

CREATE FUNCTION stamp_who_nominated_a_delegate() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.nominated_at := now();

    NEW.nominated_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.nominated_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    /* A nomination is never born ended. */
    NEW.revoked_at := NULL;
    NEW.revoked_by := NULL;
    NEW.revoked_by_employee_id := NULL;

    RETURN NEW;
END
$$;

CREATE TRIGGER approval_delegation_records_who_nominated_it
    BEFORE INSERT ON approval_delegation
    FOR EACH ROW
    EXECUTE FUNCTION stamp_who_nominated_a_delegate();

/* The one UPDATE there is: ending it. A delegation edited into a different one would rewrite
   what every decision recorded under it was explained by. */

CREATE FUNCTION end_a_delegation_and_nothing_else() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Delegation % has already ended.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'approval_delegation_ends_once',
                  HINT = 'A delegation ends once. Ending it again would move the moment the '
                         'delegate stopped answering. FR 49.';
    END IF;

    IF NEW.revoked_at IS NULL
       OR NEW.approver_employee_id IS DISTINCT FROM OLD.approver_employee_id
       OR NEW.delegate_employee_id IS DISTINCT FROM OLD.delegate_employee_id
       OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
       OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
       OR NEW.because IS DISTINCT FROM OLD.because
       OR NEW.nominated_by IS DISTINCT FROM OLD.nominated_by
       OR NEW.nominated_by_employee_id IS DISTINCT FROM OLD.nominated_by_employee_id
       OR NEW.nominated_at IS DISTINCT FROM OLD.nominated_at THEN
        RAISE EXCEPTION 'Delegation % may only be ended, not edited.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'approval_delegation_is_never_rewritten',
                  HINT = 'A delegation is nominated once and ended once. To hand the same '
                         'approvals to somebody else, end this one and nominate another. '
                         'FR 49.';
    END IF;

    /* Who ended it and when are the database's, as who nominated it is. */
    NEW.revoked_at := now();

    NEW.revoked_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.revoked_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER approval_delegation_is_only_ever_ended
    BEFORE UPDATE ON approval_delegation
    FOR EACH ROW
    EXECUTE FUNCTION end_a_delegation_and_nothing_else();

CREATE TRIGGER approval_delegation_is_never_deleted
    BEFORE DELETE ON approval_delegation
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A delegation is never removed. Decisions made under it name it. End it instead. FR 49.'
    );

/* Handing approvals over is a grant of authority, so it is audited as `user_role` is. NFR AUD 02. */

CREATE TRIGGER approval_delegation_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON approval_delegation
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- --------------------------------------------- and the decision says whose it answered

/* FR 49's third criterion, FR 52. Null on an ordinary decision, where it would repeat
   `decided_by_employee_id`. */

ALTER TABLE leave_request_decision
    ADD COLUMN delegated_for_employee_id BIGINT REFERENCES employee(id);

/* You do not stand in for yourself. */

ALTER TABLE leave_request_decision
    ADD CONSTRAINT leave_request_decision_delegate_is_somebody_else CHECK (
        delegated_for_employee_id IS NULL
        OR delegated_for_employee_id IS DISTINCT FROM decided_by_employee_id);

/* FR 48 reaching the one path that could go round it: nobody answers their own request, and
   neither does somebody answering *as* them. AFTER INSERT, as
   `refuse_a_decision_by_the_requester()` — BEFORE triggers fire in name order. */

CREATE FUNCTION refuse_a_decision_delegated_by_the_requester() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    requester BIGINT;
BEGIN
    IF NEW.delegated_for_employee_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT employee_id INTO requester
      FROM leave_request
     WHERE id = NEW.leave_request_id;

    /* Unreachable; answered because a comparison against NULL is a check that stopped. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF requester = NEW.delegated_for_employee_id THEN
        RAISE EXCEPTION
            'Leave request % is employee %''s own, so nobody answers it on their behalf.',
            NEW.leave_request_id, requester
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_never_decided_for_the_requester',
                  HINT = 'A delegation hands over the approvals somebody owes other people, '
                         'never a say over their own leave. Their own request goes to the '
                         'desk that stands in for theirs. FR 48, FR 48b, FR 49.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_never_decided_for_the_requester
    AFTER INSERT ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_decision_delegated_by_the_requester();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges. UPDATE because ending one is an edit
   of the row; DELETE is not granted. */

GRANT UPDATE ON approval_delegation TO lms_app;


-- Down Migration

-- The column comes off with the rules that read it. Decisions keep their desks and deciders;
-- what is lost is whose absence each covered.

DROP TRIGGER IF EXISTS leave_request_never_decided_for_the_requester ON leave_request_decision;

DROP FUNCTION IF EXISTS refuse_a_decision_delegated_by_the_requester();

ALTER TABLE leave_request_decision
    DROP CONSTRAINT IF EXISTS leave_request_decision_delegate_is_somebody_else;

ALTER TABLE leave_request_decision
    DROP COLUMN IF EXISTS delegated_for_employee_id;

DROP TRIGGER IF EXISTS approval_delegation_is_audited ON approval_delegation;
DROP TRIGGER IF EXISTS approval_delegation_is_never_deleted ON approval_delegation;
DROP TRIGGER IF EXISTS approval_delegation_is_only_ever_ended ON approval_delegation;
DROP TRIGGER IF EXISTS approval_delegation_records_who_nominated_it ON approval_delegation;

DROP FUNCTION IF EXISTS end_a_delegation_and_nothing_else();
DROP FUNCTION IF EXISTS stamp_who_nominated_a_delegate();

DROP TABLE IF EXISTS approval_delegation;
