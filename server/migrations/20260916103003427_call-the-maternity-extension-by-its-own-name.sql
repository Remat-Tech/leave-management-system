-- Up Migration

-- The unpaid maternity extension, called Maternity Extension.
--
-- The balance card already says Unpaid on a pill beside the name, so the word said it twice and
-- took the width a small screen does not have. The code, MAT_EXT_UNPAID, is unchanged: nothing
-- that matches on a type matches on its name.
--
-- The function is replaced as well as the row renamed, because it is what recreates the seven
-- types on a database that lost one, and it would otherwise put the old name back.
--
-- Guarded on the old name, so an HR Administrator who has already called it something else
-- keeps what they chose.

SELECT set_config('lms.audit.actor', 'migration: call the maternity extension by its own name', false);

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

        ('MAT_EXT_UNPAID', 'Maternity Extension',
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

UPDATE leave_type
   SET name = 'Maternity Extension'
 WHERE upper(code) = 'MAT_EXT_UNPAID'
   AND name = 'Unpaid Maternity Extension';

-- Down Migration

SELECT set_config('lms.audit.actor', 'migration: call the maternity extension by its own name', false);

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

UPDATE leave_type
   SET name = 'Unpaid Maternity Extension'
 WHERE upper(code) = 'MAT_EXT_UNPAID'
   AND name = 'Maternity Extension';
