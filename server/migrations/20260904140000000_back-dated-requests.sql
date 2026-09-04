-- Up Migration

-- Why leave was put on the record after the fact. FR 18, §5.6.
--
-- The window itself is `leave_type.max_backdate_calendar_days` and has been a column since
-- leave-type-rules. What was missing is the exception FR 18 names: past the window "only HR
-- may enter the record, with a reason". This is that reason.
--
-- Its own column rather than `reason`, which is the requester's account of the leave and is
-- theirs to reword. This is the entering desk's account of the lateness, and the two are
-- different sentences by different people.

ALTER TABLE leave_request
    ADD COLUMN late_entry_reason TEXT;

/* Never the empty string: nothing to say is NULL, so "was this an exception" has two
   answers rather than three. */
ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_late_entry_reason_not_blank
    CHECK (late_entry_reason IS NULL OR btrim(late_entry_reason) <> '');

/* Written once, like a decision's comment and a withdrawal's reason.

   `reason` stays editable because it explains the leave. This justifies an exception that
   was made, and an exception whose justification can be rewritten afterwards is not one.
   Body otherwise unchanged from create-and-submit-a-leave-request. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id       IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id     IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id     IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date        IS DISTINCT FROM OLD.start_date
    OR NEW.end_date          IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis    IS DISTINCT FROM OLD.counting_basis
    OR NEW.days              IS DISTINCT FROM OLD.days
    OR NEW.calendar_days     IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at      IS DISTINCT FROM OLD.submitted_at
    OR NEW.late_entry_reason IS DISTINCT FROM OLD.late_entry_reason
    THEN
        RAISE EXCEPTION
            'Leave request % was priced when it was submitted and cannot be repriced.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_says_what_it_said',
                  HINT = 'The days are already held in the ledger against these '
                         'figures. Changing the dates is a new request; changing what '
                         'the old one cost is a compensating ADJUSTMENT with a reason '
                         'on it. FR 11, FR 27.';
    END IF;

    RETURN NEW;
END
$$;

-- Down Migration

/* Back to the body create-and-submit-a-leave-request left. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id       IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id     IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id     IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date        IS DISTINCT FROM OLD.start_date
    OR NEW.end_date          IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis    IS DISTINCT FROM OLD.counting_basis
    OR NEW.days              IS DISTINCT FROM OLD.days
    OR NEW.calendar_days     IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at      IS DISTINCT FROM OLD.submitted_at
    THEN
        RAISE EXCEPTION
            'Leave request % was priced when it was submitted and cannot be repriced.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_says_what_it_said',
                  HINT = 'The days are already held in the ledger against these '
                         'figures. Changing the dates is a new request; changing what '
                         'the old one cost is a compensating ADJUSTMENT with a reason '
                         'on it. FR 11, FR 27.';
    END IF;

    RETURN NEW;
END
$$;

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_late_entry_reason_not_blank;

ALTER TABLE leave_request
    DROP COLUMN late_entry_reason;
