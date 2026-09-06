-- Up Migration

-- Certified sickness beyond the allowance. FR 32a, FR 32b, FR 33, §8.6b. LMS 312.
--
-- LMS 311 made the allowance answerable; this records which days stood on the certificate.
-- FR 33 needs nothing here: `leave_type_never_deducts_from_annual` already holds it.

-- ------------------------------------------- how many of a request's days were certified

/* Frozen with the rest of the price, as `evidence_required` is. FR 32a. */

ALTER TABLE leave_request
    ADD COLUMN certified_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_certified_days_are_part_of_it
        CHECK (certified_days BETWEEN 0 AND days),
    /* Certified days are days a certificate let through. FR 13, FR 32a. */
    ADD CONSTRAINT leave_request_certified_days_stand_on_evidence
        CHECK (certified_days = 0 OR evidence_required);

/* Body otherwise unchanged from required-documentation. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id        IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id      IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id      IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date         IS DISTINCT FROM OLD.start_date
    OR NEW.end_date           IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis     IS DISTINCT FROM OLD.counting_basis
    OR NEW.days               IS DISTINCT FROM OLD.days
    OR NEW.calendar_days      IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at       IS DISTINCT FROM OLD.submitted_at
    OR NEW.late_entry_reason  IS DISTINCT FROM OLD.late_entry_reason
    OR NEW.evidence_required  IS DISTINCT FROM OLD.evidence_required
    OR NEW.certified_days     IS DISTINCT FROM OLD.certified_days
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

-- ----------------------------------------------------- and the same count on the movement

/* The story's criterion: the ledger is the truth, so the tag goes where the days moved.
   §5.7. INTEGER because a request is whole days — FR 24, LMS 209. */

ALTER TABLE leave_ledger_entry
    ADD COLUMN certified_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE leave_ledger_entry
    ADD CONSTRAINT leave_ledger_entry_certified_days_are_part_of_it
        CHECK (certified_days >= 0 AND certified_days <= abs(days)),
    /* Only the four that follow a request. What somebody is owed certifies nothing. */
    ADD CONSTRAINT leave_ledger_entry_only_a_request_certifies
        CHECK (certified_days = 0
               OR entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'));

/* Certified sickness in a year, which is the read the column exists for. */

CREATE INDEX leave_ledger_entry_certified
    ON leave_ledger_entry (leave_year_id, leave_type_id, employee_id)
    WHERE certified_days > 0;

-- ------------------------------------ and only where the allowance is one to be exceeded

/* FR 32a. A type refused at its allowance has no days past it to certify. One function for
   both tables, because both name a leave type and count the same days. */

CREATE FUNCTION refuse_certified_days_a_type_does_not_allow() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.certified_days > 0
    AND NOT EXISTS (
        SELECT 1 FROM leave_type
        WHERE id = NEW.leave_type_id AND exceedable_with_document)
    THEN
        RAISE EXCEPTION
            'This kind of leave is refused at its allowance rather than exceeded with a '
            'document, so none of its days can be certified past it.'
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = TG_ARGV[0],
                  HINT = 'Certified days are FR 32a''s, and FR 32a is '
                         'leave_type.exceedable_with_document. §8.6b.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_certified_days_need_an_exceedable_allowance
    BEFORE INSERT OR UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_certified_days_a_type_does_not_allow(
        'leave_request_certified_days_need_an_exceedable_allowance');

CREATE TRIGGER leave_ledger_entry_certified_days_need_an_exceedable_allowance
    BEFORE INSERT ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_certified_days_a_type_does_not_allow(
        'leave_ledger_entry_certified_days_need_an_exceedable_allowance');

-- Down Migration

DROP TRIGGER IF EXISTS leave_ledger_entry_certified_days_need_an_exceedable_allowance
    ON leave_ledger_entry;
DROP TRIGGER IF EXISTS leave_request_certified_days_need_an_exceedable_allowance
    ON leave_request;

DROP FUNCTION IF EXISTS refuse_certified_days_a_type_does_not_allow();

DROP INDEX IF EXISTS leave_ledger_entry_certified;

ALTER TABLE leave_ledger_entry
    DROP CONSTRAINT IF EXISTS leave_ledger_entry_only_a_request_certifies,
    DROP CONSTRAINT IF EXISTS leave_ledger_entry_certified_days_are_part_of_it;

ALTER TABLE leave_ledger_entry
    DROP COLUMN certified_days;

/* Back to the body required-documentation left. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id        IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id      IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id      IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date         IS DISTINCT FROM OLD.start_date
    OR NEW.end_date           IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis     IS DISTINCT FROM OLD.counting_basis
    OR NEW.days               IS DISTINCT FROM OLD.days
    OR NEW.calendar_days      IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at       IS DISTINCT FROM OLD.submitted_at
    OR NEW.late_entry_reason  IS DISTINCT FROM OLD.late_entry_reason
    OR NEW.evidence_required  IS DISTINCT FROM OLD.evidence_required
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
    DROP CONSTRAINT IF EXISTS leave_request_certified_days_stand_on_evidence,
    DROP CONSTRAINT IF EXISTS leave_request_certified_days_are_part_of_it;

ALTER TABLE leave_request
    DROP COLUMN certified_days;
