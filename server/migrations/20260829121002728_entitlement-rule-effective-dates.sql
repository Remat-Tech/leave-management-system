-- Up Migration

-- What a leave type is worth, and from when. FR 31, §5.5. LMS 203.
--
-- The leave-type table says what *kind* of arithmetic a type is subject to. This
-- one says what numbers go into it — twenty days of annual leave, three of sick,
-- a hundred and twenty of maternity — and the whole of the difference between the
-- two tables is the two dates at the bottom of this one.
--
-- FR 31 in full: "No leave rule shall require a code change or a deployment", and
-- a change to one "shall not retroactively alter closed leave years". The first
-- half is LMS 201 and is a table. The second half is these columns, and it is the
-- harder half, because the failure it prevents is silent. HR raises annual leave
-- from twenty days to twenty two next January; without a date on the figure,
-- every balance ever calculated is now calculated against twenty two, last year's
-- included, and nobody finds out until somebody with a payslip disagrees.
--
-- ## The shape of the answer
--
-- A rule is never edited once it has taken effect and never deleted. Changing a
-- figure is *adding a row* with a later `effective_from`, and the question
-- "what is this worth" is only ever asked as "what is this worth on this day".
-- Those two together are what makes a closed year safe: the day is in the past,
-- the rows that covered it are still exactly as they were, and a rule written
-- this morning has an `effective_from` that does not reach it.
--
-- ## Scope, and what "most specific" means
--
-- A rule names a leave type, and optionally one of two narrower things: an
-- employee, or a department. Nothing narrower than an employee exists and nothing
-- between a department and everybody does, so the ladder has exactly three rungs
-- and resolution walks down it: the rule naming this person beats the rule naming
-- their department, which beats the rule naming nobody. Within one rung, the
-- latest `effective_from` that has arrived wins.
--
-- Naming both an employee and a department is refused rather than resolved. An
-- employee is already in exactly one department, so a rule naming both is either
-- redundant or a contradiction, and there is no reading of it worth storing.
--
-- ## Where the rest of it is
--
-- **The resolution itself is not in this file, and there is no view.** An
-- `ORDER BY ... LIMIT 1` here would be a second implementation of the rule the
-- story says to implement once, and the second implementation is the one that
-- goes wrong quietly when a third rung is added. The query fetches the candidate
-- rows for a person and a type; ../src/domain/entitlement-rule.ts picks between
-- them, and ../tests/unit/entitlement-rule.test.ts is where that is proved.
--
-- **The closed leave year is LMS 205.** `leave_year` and its closed flag do not
-- exist yet. What exists here is the half of "closed years are never recomputed"
-- that needs nothing else: a rule that has taken effect cannot be rewritten by
-- anybody, on any connection. The other half — refusing a *new* rule that reaches
-- back into a year already closed — is a rule about a boundary the database
-- cannot see today, so it is held one level up, where the boundary will arrive:
-- see `EarliestOpenDay` in ../src/domain/entitlement-rule.ts.

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_entitlement_rule (
    id                     BIGSERIAL PRIMARY KEY,

    /* Which type this is the figure for. No cascade: a leave type is retired and
       never deleted, and once a rule points at one the key refuses the deletion
       on its own — which is the guarantee the leave-type table has been carrying
       as a withheld privilege since LMS 201. */
    leave_type_id          BIGINT NOT NULL REFERENCES leave_type(id),

    /* The scope, as the two things that can narrow it. Both NULL is the rule for
       everybody, which is what the seven figures below are.

       An employee-scoped rule is somebody's terms — a negotiated allowance in a
       contract — and is the reason ../src/auth/entitlement-rule-policy.ts is not
       simply "anybody may read". A department-scoped rule is a whole team's, and
       is the rung that exists because "the field staff get twenty five" is a
       policy rather than a hundred exceptions. */
    employee_id            BIGINT REFERENCES employee(id),
    department_id          BIGINT REFERENCES department(id),

    /* The figure. Whole days, FR 24, and never a fraction: half days are settled
       informally with a manager and are deliberately not in this schema.

       Per leave year where the type's entitlement_basis is QUOTA, and per
       qualifying occurrence where it is EVENT. The Technical Design Document
       calls this column `days_per_year`, which is true of the two types that
       reset on 1 January and false of the five that do not — a hundred and twenty
       days of maternity is per confinement, and a woman with two confinements in
       one year is entitled to it twice. The name follows the meaning rather than
       the document; which of the two readings applies is `entitlement_basis` on
       the type, and is not a fact about this row.

       Zero is allowed and is not the same as no rule at all: it is HR saying this
       type is worth nothing to this person, which is a decision, where a missing
       rule is the absence of one. Unpaid leave has no rule below for exactly that
       reason — it is agreed occasion by occasion rather than accrued. */
    entitlement_days       INTEGER NOT NULL,

    /* FR 29. Whether somebody who joins part way through the leave year gets a
       proportion of this rather than the whole of it.

       Read only for QUOTA types: an event based entitlement is granted when the
       event happens, so there is no part year to take a proportion of. The
       formula itself is LMS 013 and is applied by LMS 215; this column is only
       whether it is applied at all.

       Defaulted FALSE rather than TRUE, because pro rating takes days off
       somebody. A rule that says nothing should grant the figure it names. */
    prorate_on_join        BOOLEAN NOT NULL DEFAULT FALSE,

    /* FR 36. Whether days left at the end of the leave year survive it.

       Annual leave and nothing else today, and this is the column that keeps the
       rollover job of LMS 217 from being a branch on a type code: "sick leave
       does not carry" is this boolean being false, not an `if` in the job. */
    carries_over           BOOLEAN NOT NULL DEFAULT FALSE,

    /* FR 36a. How many carried days survive, or NULL for uncapped, and the month
       in which whatever carried lapses, or NULL for never.

       Both unset on every rule shipped below, because current policy caps neither
       — "carry over is uncapped and does not expire" — and both exist because the
       first thing a new HR Administrator will want is one of them. They are
       meaningless where nothing carries at all, which
       leave_entitlement_rule_carryover_agrees holds from both sides rather than
       leaving a figure nothing reads sitting on a row somebody believed. */
    carryover_max_days     INTEGER,
    carryover_expiry_month SMALLINT,

    /* The two dates the whole table is for. Inclusive both ends.

       `effective_from` is the first day this figure applies to. `effective_to` is
       the last, or NULL for a rule with no end in sight — which is what an
       ordinary standing policy looks like, and is why it is nullable rather than
       being given a far future date that would read as a decision somebody made.

       They are DATE and not TIMESTAMPTZ. An entitlement changes on a day, not at
       an instant, and NFR DAT 03 is the rest of that argument: a moment carries a
       zone and would make "from 1 January" mean the second of January in Accra
       for anybody who wrote it from London. */
    effective_from         DATE NOT NULL,
    effective_to           DATE,

    /* Why this rule exists, in HR's words. A negotiated contract, a board
       decision, a correction. Free text and not required, but it is what the
       person reading a rule three years from now actually needs, and it is the
       one field of a rule in effect that may still be edited — see the trigger
       below. Explaining a figure better does not change it. */
    note                   TEXT,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* An employee is already in exactly one department. A rule naming both is
       either saying the same thing twice or contradicting itself, and neither is
       worth a resolution rule. */
    CONSTRAINT leave_entitlement_rule_scope_is_one_thing
        CHECK (employee_id IS NULL OR department_id IS NULL),

    /* FR 24. Whole days, and a negative allowance is not a smaller one. */
    CONSTRAINT leave_entitlement_rule_days_not_negative
        CHECK (entitlement_days >= 0),

    /* A period that ends before it starts covers no day at all, so every reading
       of it is "this rule does nothing" — which is never what somebody typing it
       meant. */
    CONSTRAINT leave_entitlement_rule_period_runs_forwards
        CHECK (effective_to IS NULL OR effective_to >= effective_from),

    /* The same shape as leave_type_documentation_agrees, and for the same reason:
       two columns describing one rule, either of which can be set without the
       other, and a half configured row that looks fine in a list. */
    CONSTRAINT leave_entitlement_rule_carryover_agrees
        CHECK (carries_over OR (carryover_max_days IS NULL AND carryover_expiry_month IS NULL)),

    /* Carrying a maximum of nothing is not carrying. Say carries_over = FALSE. */
    CONSTRAINT leave_entitlement_rule_carryover_cap_positive
        CHECK (carryover_max_days IS NULL OR carryover_max_days > 0),

    CONSTRAINT leave_entitlement_rule_carryover_month_real
        CHECK (carryover_expiry_month IS NULL
               OR carryover_expiry_month BETWEEN 1 AND 12)
);

-- ------------------------------------------------- what makes resolution total

/* One rule per scope per starting day.

   This is the constraint that makes "most specific, then the latest
   effective_from" an answer rather than a preference. Once the scope is fixed and
   the day is fixed there is at most one row, so the two sort keys the domain uses
   cannot tie — and a resolution that could tie would be one that returned
   whichever row the planner happened to hand back first, which is a figure that
   changes when the table grows.

   NULLS NOT DISTINCT is doing real work and is why this is an index rather than a
   table constraint written the ordinary way. Both scope columns are NULL on every
   company-wide rule, and under the default rule two NULLs are not equal — so
   without it the one scope that matters most would be the one scope with no
   uniqueness at all, and "annual leave from 1 January" could be in the table
   twice with different figures. Postgres 15 and later; production is 17. */

CREATE UNIQUE INDEX leave_entitlement_rule_one_per_scope_and_day
    ON leave_entitlement_rule (leave_type_id, employee_id, department_id, effective_from)
    NULLS NOT DISTINCT;

/* The read the resolution makes: every rule for one type, narrowed by scope. The
   date is deliberately not in the index's leading columns — the query hands the
   candidates to the domain rather than asking the database to choose. */
CREATE INDEX leave_entitlement_rule_by_type
    ON leave_entitlement_rule (leave_type_id, effective_from DESC);

CREATE INDEX leave_entitlement_rule_for_employee
    ON leave_entitlement_rule (employee_id) WHERE employee_id IS NOT NULL;

CREATE INDEX leave_entitlement_rule_for_department
    ON leave_entitlement_rule (department_id) WHERE department_id IS NOT NULL;

-- ------------------------------------------------- a rule in effect is history

/* The half of "closed leave years are never recomputed" that the database can
   hold on its own, and the reason it is held here rather than only in the service
   is that the service is not the only writer. A correction applied from a psql
   prompt at half past six is exactly the way last year gets rewritten.

   A rule that has not yet taken effect is somebody's draft: HR set next January's
   figure to twenty two, meant twenty five, and should fix the row rather than
   litter the table with a superseding rule that supersedes a mistake. Everything
   about it may be changed, and it may be deleted outright.

   A rule that *has* taken effect is a statement about days people have already
   planned around. Two things may still happen to it and nothing else may:

     Its `note` may be improved. Explaining a figure better does not change it.

     Its `effective_to` may be set or moved, but never to a day before today.
     Ending a rule is how a standing policy stops, and it looks symmetrical with
     ending it *retroactively* — which is the same silent rewrite by another
     route, because every day between the new end and today has already been
     counted against this figure.

   Changing anything else is refused, and the answer is always the same: add a
   rule with a later effective_from. That is not a workaround for the constraint,
   it is what changing an entitlement *is*. */

CREATE FUNCTION refuse_rewriting_an_applied_entitlement_rule() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.effective_from <= current_date THEN
            RAISE EXCEPTION
                'Entitlement rule % has applied since %, so it cannot be deleted.',
                OLD.id, OLD.effective_from
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_entitlement_rule_in_effect_is_history',
                      HINT = 'Add a rule with a later effective_from, or set '
                             'effective_to on this one. A rule people have '
                             'already been paid against is history. FR 31.';
        END IF;

        RETURN OLD;
    END IF;

    IF OLD.effective_from > current_date THEN
        -- Not yet anybody's entitlement. Correct it freely.
        RETURN NEW;
    END IF;

    IF NEW.leave_type_id           IS DISTINCT FROM OLD.leave_type_id
       OR NEW.employee_id          IS DISTINCT FROM OLD.employee_id
       OR NEW.department_id        IS DISTINCT FROM OLD.department_id
       OR NEW.entitlement_days     IS DISTINCT FROM OLD.entitlement_days
       OR NEW.prorate_on_join      IS DISTINCT FROM OLD.prorate_on_join
       OR NEW.carries_over         IS DISTINCT FROM OLD.carries_over
       OR NEW.carryover_max_days   IS DISTINCT FROM OLD.carryover_max_days
       OR NEW.carryover_expiry_month IS DISTINCT FROM OLD.carryover_expiry_month
       OR NEW.effective_from       IS DISTINCT FROM OLD.effective_from
    THEN
        RAISE EXCEPTION
            'Entitlement rule % has applied since %, so its figures and dates cannot be changed.',
            OLD.id, OLD.effective_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_rule_in_effect_is_history',
                  HINT = 'Add a rule with a later effective_from. Changing this '
                         'one would alter what people were owed for days that '
                         'have already passed. FR 31.';
    END IF;

    IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
       AND NEW.effective_to IS NOT NULL
       AND NEW.effective_to < current_date
    THEN
        RAISE EXCEPTION
            'Entitlement rule % cannot be ended on %, which is in the past.',
            OLD.id, NEW.effective_to
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_entitlement_rule_in_effect_is_history',
                  HINT = 'End it today or later. Every day between then and now '
                         'has already been counted against this figure. FR 31.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_entitlement_rule_in_effect_is_history
    BEFORE UPDATE OR DELETE ON leave_entitlement_rule
    FOR EACH ROW
    EXECUTE FUNCTION refuse_rewriting_an_applied_entitlement_rule();

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the
   department rules has reused them.

   The audit trigger matters more here than on most tables. NFR AUD 01 names
   configuration changes, and this is the configuration that decides what somebody
   is owed: "who changed the annual leave figure, when, and from what" is the
   first question asked when a balance is disputed, and the row itself cannot
   answer it because the row is only ever the current state.

   The two triggers below fire after the one above has already refused whatever
   should not be happening, so nothing unauditable reaches the log. */

CREATE TRIGGER leave_entitlement_rule_set_updated_at
    BEFORE UPDATE ON leave_entitlement_rule
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_entitlement_rule_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_entitlement_rule
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration.

   UPDATE and DELETE are both granted, which is the opposite of what leave_type
   and employee were given, and the difference is the trigger above rather than a
   change of mind. A leave type has no state in which deleting it is harmless — it
   heads last year's report whatever its age. A rule that has not yet taken effect
   has harmed nobody and heads nothing: it is next January's plan, and the honest
   correction for one typed wrong is to remove it. Once it has taken effect the
   trigger refuses both, for every writer including this one, so what is granted
   here is only ever exercised on rules that are still drafts. */

GRANT UPDATE, DELETE ON leave_entitlement_rule TO lms_app;

-- ------------------------------------------------- the figures of the FR 32 table

/* Reference data, by the same argument as the seven types themselves and the
   standard Monday to Friday week: a production database is migrated and never
   seeded, and a leave system whose annual leave is worth nothing is one where
   every balance is zero.

   Owned by a function for the reason LMS 202 gave — so that the repair for a lost
   figure is a call rather than five rows retyped — and here that is not
   hypothetical. The fixture seed truncates `employee`, this table has a foreign
   key to it, and TRUNCATE CASCADE empties every referencing table wholesale. So
   server/seeds/seed.mjs clears this table deliberately and calls the function
   below to put the statutory figures back, rather than carrying a copy of the
   figures that could drift from these.

   Effective from the first of January 2026, which is the leave year the system
   goes live in and the first of the two LMS 205 seeds. Everything before that
   date resolves to no rule at all, which is the honest answer: this system holds
   no entitlement history from before it existed, and inventing one would be worse
   than saying so.

   Two of the seven types get no rule, deliberately:

     **Unpaid leave** has no figure to hold. FR 32h is an arrangement agreed
     occasion by occasion and approved by HR and the Chief Executive; a standing
     allowance would be a fiction, and zero would say the wrong thing — zero is a
     decision that it is worth nothing, and this is the absence of one.

     **The unpaid maternity extension** is "a further month", which the
     entitlement table does not give in days. Everything else here is a figure
     somebody can point at in the SRS. Rather than turn a month into thirty days
     by arithmetic nobody signed off, it is left for HR to set on the screen this
     table exists to feed — which takes one row and no deployment, which is the
     whole of FR 31. */

CREATE FUNCTION ensure_statutory_entitlement_rules() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_entitlement_rules()'),
        true);

    INSERT INTO leave_entitlement_rule (
        leave_type_id, entitlement_days, prorate_on_join, carries_over,
        effective_from, note
    )
    SELECT type.id, statutory.days, statutory.prorate, statutory.carries,
           DATE '2026-01-01', statutory.note
      FROM (VALUES
        /* FR 28. Twenty working days a year. The only type that is pro rated for
           a joiner and the only one whose unused days survive the year — FR 36,
           uncapped and with no expiry, which is both carryover columns left
           unset rather than a policy nobody wrote down. */
        ('ANNUAL', 20, TRUE, TRUE,
         'FR 32 entitlement table, at go live. Twenty working days a year.'),

        /* FR 32a. Three working days a year, and a threshold rather than a cap:
           past it the leave is still granted and asks for a certificate, which is
           leave_type.exceedable_with_document and not a figure. Not pro rated —
           three days shared over part of a year is a day and a half, and FR 24
           has no such thing. */
        ('SICK', 3, FALSE, FALSE,
         'FR 32 entitlement table, at go live. Three working days a year, past which a certificate is asked for.'),

        /* FR 32f. Five working days per occasion, and per occasion is why it does
           not reset, carry, or pro rate. */
        ('COMPASSIONATE', 5, FALSE, FALSE,
         'FR 32 entitlement table, at go live. Five working days per occasion.'),

        /* FR 32d. A hundred and twenty calendar days per confinement — per
           confinement, so a second one in the same year is entitled to it again,
           which is what entitlement_basis EVENT means and why this figure is not
           per year. */
        ('MATERNITY', 120, FALSE, FALSE,
         'FR 32 entitlement table, at go live. A hundred and twenty calendar days per confinement.'),

        /* FR 32e. Fourteen calendar days per birth. The six month expiry on the
           unused part is leave_type.entitlement_expiry_months, because it is
           counted from the birth rather than from the leave year. */
        ('PATERNITY', 14, FALSE, FALSE,
         'FR 32 entitlement table, at go live. Fourteen calendar days per birth.')
      ) AS statutory (code, days, prorate, carries, note)
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

/* The join is to leave_type by code, which is the one thing `code` is for, and it
   is the reason a database where HR has already retyped a figure keeps theirs:
   the guard asks whether *any* company-wide rule exists for that type, not
   whether this exact row does. A type whose figure somebody has already set is a
   type whose policy has an owner. */

REVOKE EXECUTE ON FUNCTION ensure_statutory_entitlement_rules() FROM PUBLIC;

DO $$
DECLARE
    inserted INTEGER;
BEGIN
    inserted := ensure_statutory_entitlement_rules();

    RAISE NOTICE 'Wrote % entitlement rules, effective from 2026-01-01.', inserted;
END
$$;

-- ------------------------------------------------------ what is not here yet

/* **The leave year.** LMS 205, `leave_year`, with a start, an end and a closed
   flag, and 2026 and 2027 seeded. It is what turns "this figure applies on this
   day" into "this figure applies to this year", and it is what a closed year is.
   Nothing here needs it: a date is a date whether or not somebody has drawn a
   year around it, and the rules above are already safe against a rewrite.

   **The grant.** A resolved figure becomes days somebody actually has only when
   the ledger records it — LMS 210 and LMS 214 — and that is the other half of why
   a closed year cannot move. A grant is an entry with an amount on it, written
   once; recalculating it is a compensating entry that says so, never a quiet
   subtraction. This table is what the grant is calculated *from*, on the day it
   is calculated.

   **The pro rating formula.** LMS 013 obtained it and LMS 215 applies it.
   `prorate_on_join` is only whether it applies at all; where the fraction comes
   from is not a column here, because it is one calculation for the whole company
   rather than a figure per rule. */

-- Down Migration

DROP FUNCTION IF EXISTS ensure_statutory_entitlement_rules();

DROP TRIGGER IF EXISTS leave_entitlement_rule_is_audited ON leave_entitlement_rule;
DROP TRIGGER IF EXISTS leave_entitlement_rule_set_updated_at ON leave_entitlement_rule;
DROP TRIGGER IF EXISTS leave_entitlement_rule_in_effect_is_history ON leave_entitlement_rule;
DROP FUNCTION IF EXISTS refuse_rewriting_an_applied_entitlement_rule();

DROP TABLE IF EXISTS leave_entitlement_rule;
