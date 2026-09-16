-- Up Migration

-- Carried annual leave expires at the end of June. FR 36a.
--
-- The rule in force from 2026-01-01 has applied and cannot be changed, so this adds one
-- with the same figures and `carryover_expiry_month = 6`. It starts 2026-10-01 so that it
-- is the rule on 2027-01-01, which is what the expiry job reads for days carried out of
-- 2026. A function, like `ensure_unpaid_entitlement_rules()`, so seed.mjs can restore it.

SELECT set_config('lms.audit.actor', 'migration: carried annual leave expires at the end of June', false);

CREATE FUNCTION ensure_carryover_expiry_rules() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_carryover_expiry_rules()'),
        true);

    INSERT INTO leave_entitlement_rule (
        leave_type_id, entitlement_days, prorate_on_join, carries_over,
        carryover_expiry_month, effective_from, note
    )
    SELECT type.id, 20, TRUE, TRUE, 6, DATE '2026-10-01',
           'Twenty working days a year. Carried days not used by the end of June expire.'
      FROM leave_type type
     WHERE upper(type.code) = 'ANNUAL'
       /* Leaves alone a database where HR has already set a later annual figure. */
       AND NOT EXISTS (
        SELECT 1 FROM leave_entitlement_rule existing
         WHERE existing.leave_type_id = type.id
           AND existing.employee_id IS NULL
           AND existing.department_id IS NULL
           AND existing.effective_from >= DATE '2026-10-01'
       );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

REVOKE EXECUTE ON FUNCTION ensure_carryover_expiry_rules() FROM PUBLIC;

DO $$
DECLARE
    inserted INTEGER;
BEGIN
    inserted := ensure_carryover_expiry_rules();

    RAISE NOTICE 'Wrote % carryover expiry rules, effective from 2026-10-01.', inserted;
END
$$;

-- Down Migration

-- Removes the rule only while it is still a draft; once applied, the table refuses.

SELECT set_config('lms.audit.actor', 'migration: reversing the carried annual leave expiry', false);

DELETE FROM leave_entitlement_rule
 WHERE effective_from = DATE '2026-10-01'
   AND effective_from > current_date
   AND carryover_expiry_month = 6
   AND employee_id IS NULL
   AND department_id IS NULL
   AND leave_type_id IN (SELECT id FROM leave_type WHERE upper(code) = 'ANNUAL');

DROP FUNCTION IF EXISTS ensure_carryover_expiry_rules();
