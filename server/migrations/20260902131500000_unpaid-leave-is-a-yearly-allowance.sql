-- Up Migration

-- Unpaid leave is ten working days a year, and the two unpaid figures HR was left to set.
-- FR 31, FR 32g, FR 32h. LMS 401.
--
-- Three corrections to shipped configuration, none of them a schema change. They are here
-- rather than typed into a database because a change that is not a migration does not
-- exist on anybody else's machine — and because the seven-leave-types and
-- entitlement-rule-effective-dates migrations are merged and are never edited. This is
-- what "fix a mistake with a new migration" looks like when the mistake is a policy
-- reading rather than a column.
--
-- ## Unpaid leave is a QUOTA type, and that is the load bearing one
--
-- It shipped as `EVENT` on FR 32g's list — "granted per qualifying occurrence, does not
-- reset on 1 January and does not accumulate: maternity, paternity, compassionate, unpaid,
-- and the unpaid maternity extension" — and on the entitlement migration's reading that it
-- is "agreed occasion by occasion rather than accrued, so a standing allowance would be a
-- fiction".
--
-- The business has since settled it: **ten working days for the year**. That is an annual
-- allowance that resets, which is precisely what `QUOTA` means, so the classification was
-- wrong rather than the figure merely missing.
--
-- The correction has to come first, and the figure below is inert without it.
-- `AnnualGrant` only ever loops over types where `hasRunningBalance()` is true — FR 32g,
-- `entitlement_basis = 'QUOTA'` — so an entitlement rule against an EVENT type is a figure
-- nothing would ever grant. The two changes are one change.
--
-- What does *not* move is the approval chain. Unpaid leave goes HR then the Chief
-- Executive, §4.3.1 and FR 32h, and it goes on doing so: how much leave somebody is owed
-- and who signs it off are different questions, and this migration answers only the first.
--
-- ## The unpaid maternity extension keeps its basis and gets a figure
--
-- "A further month", which the entitlement migration declined to write down: "turning a
-- month into thirty by arithmetic nobody signed off would be worse than leaving HR one row
-- to write." Thirty calendar days is now signed off, and it is not arbitrary — paid
-- maternity is a hundred and twenty calendar days expressed as "4 months", so a month is
-- thirty by this system's own existing convention.
--
-- It stays `EVENT`, because it genuinely is per confinement: a second birth is entitled to
-- it again, which is what an event type is for.
--
-- ## And unpaid leave moves up the screen
--
-- `display_order` is §7.4's own ordering and the reason the column exists — "the order a
-- balance screen lists annual, sick and compassionate leave in is a decision somebody made
-- rather than an alphabetical accident". Somebody has now made a different one: unpaid
-- leave is third, ahead of compassionate.
--
-- It moves the card on the balance screen *and* the row in every report, because
-- `BalanceRepository.forEmployee` and `byDisplayOrder` read the same column. That is the
-- point rather than a side effect.

-- ------------------------------------------------- who this is recorded against
--
-- Every table touched below is audited, and the audit trigger reads this setting for the
-- name on the row. Without it these changes are attributed to nobody, which is the one
-- thing the audit log is not allowed to say. The same arrangement
-- `ensure_statutory_leave_types()` makes.

SELECT set_config('lms.audit.actor', 'migration: unpaid leave is a yearly allowance', false);

-- ------------------------------------------------------------ the classification

UPDATE leave_type
   SET entitlement_basis = 'QUOTA'
 WHERE upper(code) = 'UNPAID'
   AND entitlement_basis <> 'QUOTA';

-- --------------------------------------------------------------------- the order

/* Written as one statement against a list rather than four UPDATEs, so that the order is
   readable as an order. Guarded on the code, which is what a code is for. */

UPDATE leave_type
   SET display_order = wanted.position
  FROM (VALUES
    ('ANNUAL', 1),
    ('SICK', 2),
    ('UNPAID', 3),
    ('COMPASSIONATE', 4),
    ('MATERNITY', 5),
    ('PATERNITY', 6),
    ('MAT_EXT_UNPAID', 7)
  ) AS wanted (code, position)
 WHERE upper(leave_type.code) = wanted.code
   AND leave_type.display_order <> wanted.position;

-- ------------------------------------------------------------------- the figures

/* The same shape `ensure_statutory_entitlement_rules()` has, and a separate function
   rather than a change to it, because that one is merged and is never edited.
   ../seeds/seed.mjs calls both: the fixture reload truncates this table, so a figure that
   only this migration wrote would vanish on the next `npm run seed` and never come back.

   Guarded on "any company-wide rule for this type" rather than on this exact row, which is
   the guard the original uses and for the reason it gives: "a type whose figure somebody
   has already set is a type whose policy has an owner". A database where HR has already
   typed ten days keeps theirs. */

CREATE FUNCTION ensure_unpaid_entitlement_rules() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_unpaid_entitlement_rules()'),
        true);

    INSERT INTO leave_entitlement_rule (
        leave_type_id, entitlement_days, prorate_on_join, carries_over,
        effective_from, note
    )
    SELECT type.id, statutory.days, FALSE, FALSE, DATE '2026-01-01', statutory.note
      FROM (VALUES
        /* FR 32h. Ten working days a year, unpaid, and still decided by HR and the Chief
           Executive — the chain is the type's and is untouched. Not pro rated for a
           joiner, on the reading sick leave takes: an allowance agreed as a whole is not
           something anybody accrues by the day. Does not carry over; an unpaid allowance
           banked across a year end is a liability nobody asked for. */
        ('UNPAID', 10,
         'FR 32 entitlement table. Ten working days a year, unpaid.'),

        /* A further unpaid month after maternity leave, per confinement. Thirty calendar
           days, which is paid maternity's own convention — a hundred and twenty days
           expressed as four months. It stays an event type, so this figure is per
           confinement rather than per year. */
        ('MAT_EXT_UNPAID', 30,
         'FR 32 entitlement table. A further unpaid month after maternity leave, per confinement.')
      ) AS statutory (code, days, note)
      JOIN leave_type type ON upper(type.code) = statutory.code
     WHERE NOT EXISTS (
        SELECT 1 FROM leave_entitlement_rule existing
         WHERE existing.leave_type_id = type.id
           AND existing.employee_id IS NULL
           AND existing.department_id IS NULL
     );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

/* Nobody but the owner, exactly as its sibling: restoring reference data is an operator's
   job and not a power the application should have by being connected. */
REVOKE EXECUTE ON FUNCTION ensure_unpaid_entitlement_rules() FROM PUBLIC;

DO $$
DECLARE
    inserted INTEGER;
BEGIN
    inserted := ensure_unpaid_entitlement_rules();

    RAISE NOTICE 'Wrote % unpaid entitlement rules, effective from 2026-01-01.', inserted;
END
$$;

-- Down Migration

-- The classification and the order go back exactly. The figures largely do not, and that
-- is the table refusing rather than this section being lazy.
--
-- `refuse_rewriting_an_applied_entitlement_rule()` will not delete a rule whose
-- `effective_from` has passed: "a rule people have already been paid against is history.
-- FR 31." These are effective from 2026-01-01, so on any database where that day has
-- arrived the DELETE below matches nothing and the rows stay — correctly, because balances
-- have been granted against them and removing the figure would leave a `GRANT` in the
-- ledger that nothing explains.
--
-- So this section is honest rather than complete, and it runs cleanly either way. Undoing
-- an entitlement figure that has applied is what `effective_to` is for, and it is a
-- decision with a date on it rather than a rollback.

SELECT set_config('lms.audit.actor', 'migration: reversing the unpaid leave allowance', false);

DELETE FROM leave_entitlement_rule
 WHERE effective_from > current_date
   AND employee_id IS NULL
   AND department_id IS NULL
   AND leave_type_id IN (
        SELECT id FROM leave_type WHERE upper(code) IN ('UNPAID', 'MAT_EXT_UNPAID')
   );

DROP FUNCTION IF EXISTS ensure_unpaid_entitlement_rules();

UPDATE leave_type
   SET display_order = wanted.position
  FROM (VALUES
    ('ANNUAL', 1),
    ('SICK', 2),
    ('COMPASSIONATE', 3),
    ('MATERNITY', 4),
    ('PATERNITY', 5),
    ('UNPAID', 6),
    ('MAT_EXT_UNPAID', 7)
  ) AS wanted (code, position)
 WHERE upper(leave_type.code) = wanted.code
   AND leave_type.display_order <> wanted.position;

UPDATE leave_type
   SET entitlement_basis = 'EVENT'
 WHERE upper(code) = 'UNPAID'
   AND entitlement_basis <> 'EVENT';
