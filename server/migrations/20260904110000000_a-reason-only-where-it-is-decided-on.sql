-- Up Migration

-- A reason only on the unpaid types. FR 10, FR 31, §5.5.
--
-- Drawing down an allowance you are owed is not asking for a favour, and a required box
-- on the ordinary case is one everybody fills with the word "leave".
--
-- A column rather than a read of `is_paid`: FR 63 owns that one, and design principle 5
-- wants every rule that differs between types editable without a deployment. The two
-- happen to agree today, which is the seeding below rather than a rule anything reads.

/* FR 10. Whether a request for this type has to say why. Defaults TRUE: a type that
   quietly stopped asking is an approver deciding blind. */
ALTER TABLE leave_type
    ADD COLUMN reason_required BOOLEAN NOT NULL DEFAULT TRUE;

/* The two unpaid types ask; every paid one does not. There is no entitlement behind
   unpaid leave, so the sentence is the whole of what HR and the CEO are deciding. */
UPDATE leave_type
   SET reason_required = NOT is_paid;

/* Replaced for the reason unpaid-leave-is-a-yearly-allowance replaced it: a restore
   without a column added since brings the type back wrong. Body otherwise unchanged. */
CREATE OR REPLACE FUNCTION ensure_statutory_leave_types() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_leave_types()'),
        true);

    INSERT INTO leave_type (
        code, name, description, counting_basis, entitlement_basis, is_paid, unit,
        documentation, exceedable_with_document, entitlement_expiry_months,
        may_be_split, min_notice_calendar_days, max_backdate_calendar_days,
        gender_restriction, reason_required, display_order
    )
    SELECT * FROM (VALUES
        ('ANNUAL', 'Annual Leave',
         'Your yearly allowance. Two weeks'' notice is expected; less is allowed but the approvers will see that it was short.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL::SMALLINT, TRUE, 14, 7, NULL::VARCHAR, FALSE, 1),

        ('SICK', 'Sick Leave',
         'Self certified up to your yearly allowance. Beyond that a medical certificate is needed, and the leave is still granted.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', TRUE, NULL, TRUE, 0, 7, NULL, FALSE, 2),

        ('UNPAID', 'Unpaid Leave',
         'Agreed rather than accrued, and unpaid. Decided by HR and the Chief Executive.',
         'WORKING_DAYS', 'QUOTA', FALSE, 'WEEKS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, TRUE, 3),

        ('COMPASSIONATE', 'Compassionate Leave',
         'Granted per occasion. Say what it is for; whether it qualifies is for your manager and HR to decide.',
         'WORKING_DAYS', 'EVENT', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, FALSE, 4),

        ('MATERNITY', 'Maternity Leave',
         'Granted per confinement, counted in calendar days. Weekends and public holidays fall inside the period.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'MONTHS',
         'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', FALSE, 5),

        ('PATERNITY', 'Paternity Leave',
         'Granted per birth and usable within six months of it. It need not be taken all at once.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'WEEKS',
         'NOT_REQUIRED', FALSE, 6, TRUE, 0, 7, 'MALE', FALSE, 6),

        ('MAT_EXT_UNPAID', 'Unpaid Maternity Extension',
         'A further unpaid month after maternity leave. Decided by HR and the Chief Executive.',
         'CALENDAR_DAYS', 'EVENT', FALSE, 'MONTHS',
         'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', TRUE, 7)
    ) AS statutory (
        code, name, description, counting_basis, entitlement_basis, is_paid, unit,
        documentation, exceedable_with_document, entitlement_expiry_months,
        may_be_split, min_notice_calendar_days, max_backdate_calendar_days,
        gender_restriction, reason_required, display_order
    )
    WHERE NOT EXISTS (
        SELECT 1 FROM leave_type existing
         WHERE lower(existing.name) = lower(statutory.name)
            OR upper(existing.code) = upper(statutory.code)
    );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

/* Nullable, and never the empty string: nothing to say is stored as NULL, so
   "did they explain themselves" has two answers rather than three. */
ALTER TABLE leave_request
    ALTER COLUMN reason DROP NOT NULL;

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_reason_not_blank;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_reason_not_blank
    CHECK (reason IS NULL OR btrim(reason) <> '');

-- Down Migration

-- A request made without a reason has none to restore, so it is given one saying so.

UPDATE leave_request
   SET reason = 'No reason was given, and this kind of leave did not ask for one.'
 WHERE reason IS NULL;

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_reason_not_blank;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_reason_not_blank
    CHECK (btrim(reason) <> '');

ALTER TABLE leave_request
    ALTER COLUMN reason SET NOT NULL;

/* Back to the body unpaid-leave-is-a-yearly-allowance left. */
CREATE OR REPLACE FUNCTION ensure_statutory_leave_types() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_leave_types()'),
        true);

    INSERT INTO leave_type (
        code, name, description, counting_basis, entitlement_basis, is_paid, unit,
        documentation, exceedable_with_document, entitlement_expiry_months,
        may_be_split, min_notice_calendar_days, max_backdate_calendar_days,
        gender_restriction, display_order
    )
    SELECT * FROM (VALUES
        ('ANNUAL', 'Annual Leave',
         'Your yearly allowance. Two weeks'' notice is expected; less is allowed but the approvers will see that it was short.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL::SMALLINT, TRUE, 14, 7, NULL::VARCHAR, 1),

        ('SICK', 'Sick Leave',
         'Self certified up to your yearly allowance. Beyond that a medical certificate is needed, and the leave is still granted.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', TRUE, NULL, TRUE, 0, 7, NULL, 2),

        ('UNPAID', 'Unpaid Leave',
         'Agreed rather than accrued, and unpaid. Decided by HR and the Chief Executive.',
         'WORKING_DAYS', 'QUOTA', FALSE, 'WEEKS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 3),

        ('COMPASSIONATE', 'Compassionate Leave',
         'Granted per occasion. Say what it is for; whether it qualifies is for your manager and HR to decide.',
         'WORKING_DAYS', 'EVENT', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 4),

        ('MATERNITY', 'Maternity Leave',
         'Granted per confinement, counted in calendar days. Weekends and public holidays fall inside the period.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'MONTHS',
         'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', 5),

        ('PATERNITY', 'Paternity Leave',
         'Granted per birth and usable within six months of it. It need not be taken all at once.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'WEEKS',
         'NOT_REQUIRED', FALSE, 6, TRUE, 0, 7, 'MALE', 6),

        ('MAT_EXT_UNPAID', 'Unpaid Maternity Extension',
         'A further unpaid month after maternity leave. Decided by HR and the Chief Executive.',
         'CALENDAR_DAYS', 'EVENT', FALSE, 'MONTHS',
         'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', 7)
    ) AS statutory (
        code, name, description, counting_basis, entitlement_basis, is_paid, unit,
        documentation, exceedable_with_document, entitlement_expiry_months,
        may_be_split, min_notice_calendar_days, max_backdate_calendar_days,
        gender_restriction, display_order
    )
    WHERE NOT EXISTS (
        SELECT 1 FROM leave_type existing
         WHERE lower(existing.name) = lower(statutory.name)
            OR upper(existing.code) = upper(statutory.code)
    );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

ALTER TABLE leave_type
    DROP COLUMN reason_required;
