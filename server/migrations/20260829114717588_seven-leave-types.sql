-- Up Migration

-- The seven leave types of FR 32, and a guarantee rather than a moment.
-- LMS 202. §5.5 seed data.
--
-- The rows already exist. The leave-type-rules migration created the table and
-- filled it in the same file, which was the right thing to do there — a leave
-- system with no leave types is one where nobody can request anything at all,
-- and the story before this one could not ship a table that started empty.
--
-- What that insert is not is a guarantee. It ran once, against a table created
-- four statements earlier, and it can never run again: the file is applied
-- history on every database there is. So the statutory set is currently a fact
-- about one afternoon rather than something the schema keeps being true. The
-- difference shows up in the three places reference data actually goes missing —
-- a database restored from a backup taken before the type existed, one where
-- somebody holding the owner's password deleted a row that `lms_app` is not
-- allowed to touch, and the branch somebody brings up from a partial dump — and
-- in each of them the repair today is an INSERT typed at a psql prompt, which is
-- exactly the "not by hand" this story is about.
--
-- This file gives the set a name that can be run again.
--
-- ## What it does not do
--
-- It inserts what is missing and it changes nothing that is there. Editing a
-- type is the whole of LMS 201 — FR 31, "no leave rule shall require a code
-- change or a deployment" — so a function that reconciled the rows back to these
-- values would take away the thing the previous story exists to give. HR's
-- notice window, HR's wording, HR's retired type: all of them survive this
-- running, and the only row it writes is one that is not there at all.
--
-- ## The figures are still not here
--
-- Twenty working days of annual leave, three of sick, five of compassionate, a
-- hundred and twenty calendar days of maternity, fourteen of paternity, a
-- further month unpaid after maternity, and nothing fixed at all for unpaid
-- leave. Every one of those is a figure with an effective date on it — FR 31
-- again, which forbids a change "retroactively altering closed leave years" —
-- and they arrive as `leave_entitlement_rule` with LMS 203. What this table
-- holds is the arithmetic each type is subject to; the numbers that go into it
-- are dated, and a column has no date on it.

-- ----------------------------------------------------------- the reference set

/* Guarded on the code as well as the name, which is the one thing this does
   that the original insert did not, and it is not a refinement.

   Both identifiers are unique without regard to case. A name guard alone is
   sound against a table nothing has touched and wrong against every other kind:
   on a database where HR has reworded 'Annual Leave' to 'Vacation' — the exact
   rewording `code` exists to survive — the name is free, the row is offered, and
   `leave_type_code_unique` refuses it. That failure lands on the database that
   has been used the most, which is the worst possible order to discover it in.

   Either identifier being taken means somebody already has this type under a
   spelling of their own, and their version is the one that stays. */

CREATE FUNCTION ensure_statutory_leave_types() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    /* Whoever the caller said they were, kept and put back. A repair run from a
       migration or a psql prompt has named nobody, and 'not named by the writer'
       is a true but thin answer to "where did this row come from" when the row
       is a leave type that reappeared. Naming the function is the better entry.
       A caller who did say who they were keeps their name, and the setting is
       left exactly as it was found either way. */
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
        /* Twenty working days a year, and the only type anybody can be expected
           to plan: fourteen days of notice, warned about rather than refused. */
        ('ANNUAL', 'Annual Leave',
         'Your yearly allowance. Two weeks'' notice is expected; less is allowed but the approvers will see that it was short.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL::SMALLINT, TRUE, 14, 7, NULL::VARCHAR, 1),

        /* Three working days a year, and FR 32a makes that a documentation
           threshold rather than a cap — which is exceedable_with_document, not
           the documentation rule, and is why the balance may go negative. */
        ('SICK', 'Sick Leave',
         'Self certified up to your yearly allowance. Beyond that a medical certificate is needed, and the leave is still granted.',
         'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
         'NOT_REQUIRED', TRUE, NULL, TRUE, 0, 7, NULL, 2),

        /* FR 32f. Five working days per occasion, and no list of qualifying
           relationships anywhere in the system: that is the approvers' judgement
           on the reason given. */
        ('COMPASSIONATE', 'Compassionate Leave',
         'Granted per occasion. Say what it is for; whether it qualifies is for your manager and HR to decide.',
         'WORKING_DAYS', 'EVENT', TRUE, 'DAYS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 3),

        /* FR 32d. A hundred and twenty calendar days per confinement, said in
           months and counted in days. */
        ('MATERNITY', 'Maternity Leave',
         'Granted per confinement, counted in calendar days. Weekends and public holidays fall inside the period.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'MONTHS',
         'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', 4),

        /* FR 32e. Fourteen calendar days per birth, usable within six months of
           it, and the only type with an expiry on the grant. */
        ('PATERNITY', 'Paternity Leave',
         'Granted per birth and usable within six months of it. It need not be taken all at once.',
         'CALENDAR_DAYS', 'EVENT', TRUE, 'WEEKS',
         'NOT_REQUIRED', FALSE, 6, TRUE, 0, 7, 'MALE', 5),

        /* FR 32h. No figure at all — it is agreed rather than accrued — and
           approved by HR and the Chief Executive, which is FR 38a's chain and
           LMS 204 rather than anything in this table. */
        ('UNPAID', 'Unpaid Leave',
         'Agreed rather than accrued, and unpaid. Decided by HR and the Chief Executive.',
         'WORKING_DAYS', 'EVENT', FALSE, 'WEEKS',
         'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 6),

        /* A further month after maternity leave, unpaid, and the second type
           whose chain is HR then the CEO. */
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

-- ---------------------------------------------------------------- privileges

/* Nobody but the owner may run it.

   `lms_app` holds INSERT on leave_type and could write these rows one at a time
   through the service, so this is not withholding a power it has elsewhere. It
   is about which powers are reachable by guessing: restoring reference data is
   an operator's job, done knowingly, and a function that inserts seven rows is
   not something the application should be able to call because it happens to be
   connected. The default EXECUTE on a new function is PUBLIC, so it has to be
   taken away rather than not given. */

REVOKE EXECUTE ON FUNCTION ensure_statutory_leave_types() FROM PUBLIC;

-- ---------------------------------------------------------------- and run it

/* Zero on every database that has already been migrated in order, which is what
   it should be: this is a guarantee being written down, not a change being made.
   It says so out loud when it is not zero, because a migration that quietly
   inserted seven leave types into a live system is a thing somebody should read
   in the deployment log rather than find later. */

DO $$
DECLARE
    restored INTEGER;
BEGIN
    restored := ensure_statutory_leave_types();

    IF restored > 0 THEN
        RAISE NOTICE 'Inserted % of the seven leave types of FR 32.', restored;
    END IF;
END
$$;

-- Down Migration

/* The types themselves stay, exactly as the standard Monday to Friday week
   stayed when the working-pattern rules were rolled back. They are data rather
   than schema, they were here before this file, and requests and ledger entries
   will be filed under them — a down section that deleted them would be the
   rewriting of history the table has no DELETE grant to prevent. Re-applying the
   up section finds all seven and inserts nothing. */

DROP FUNCTION IF EXISTS ensure_statutory_leave_types();
