-- Up Migration

-- Leave types, and the rules each one carries. FR 21, FR 31, FR 32, §5.5.
-- LMS 201.
--
-- The story is an HR Administrator adding or changing a leave type without
-- waiting on a developer, and FR 31 says it in the strongest terms the SRS
-- uses: "No leave rule shall require a code change or a deployment." So every
-- rule that differs between annual leave and maternity leave is a column here
-- rather than a branch somewhere.
--
-- Design principle 5 of the Technical Design Document is the one this table
-- exists to serve: "Two things vary by leave type, and both used to be global.
-- If either is written as an `if` on a type code, every future leave type
-- becomes a code change." This is the first of the two. The second, the approval
-- chain, is FR 38a and its own table; see the note at the foot of this file.
--
-- ## Where the figures are not
--
-- Twenty days of annual leave, a hundred and twenty of maternity, three of sick
-- leave: none of them are here. They are `leave_entitlement_rule`, effective
-- dated, because FR 31 also says a change "shall not retroactively alter closed
-- leave years" and a figure in a column has no date on it. This table says what
-- *kind* of arithmetic a type is subject to; that one says what numbers go into
-- it, and from when.
--
-- Sick leave is the case that makes the split obvious. Its three days is not a
-- cap at all: FR 32a calls it "a documentation threshold, not a hard cap", and
-- `exceedable_with_document` below is the column that makes it behave as one.
-- The figure lives with the dates; the behaviour lives here.
--
-- ## Why a starting set is inserted here rather than seeded
--
-- The same argument the working-pattern-rules migration made about the standard
-- Monday to Friday week. A production database is migrated and never seeded, and
-- FR 32 names seven types the system "shall support" — so they are reference
-- data, guarded so that a database which already holds a type of that name keeps
-- its own version. That is not the opposite of "never waits on a developer"; it
-- is what makes it safe, because every column of every row is editable from the
-- first minute.

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_type (
    id                       BIGSERIAL PRIMARY KEY,

    /* The stable handle. A name is HR's to reword — "Annual Leave" becomes
       "Vacation" and every screen follows — but a report from last year, a
       ledger entry and a staff import column all need something that survives
       the rewording.

       It is emphatically **not** a branch point. Nothing above the database may
       read this column and decide anything; every rule this type carries is one
       of the columns below, and a `WHEN code = 'MATERNITY'` anywhere is the bug
       design principle 5 names. It is here to be joined on and reported by. */
    code                     VARCHAR(40) NOT NULL,

    name                     VARCHAR(80) NOT NULL,

    /* What HR wants staff to read on the request form beside the name. Free
       text, because the handbook wording is theirs and not ours. */
    description              TEXT,

    /* FR 21. WORKING_DAYS | CALENDAR_DAYS.

       Whether a day inside the request that the person does not work still costs
       them one. FR 22: annual, sick and compassionate count working days, so a
       weekend inside a fortnight off is free and so is the Wednesday a part
       timer does not work. Maternity and paternity count calendar days, because
       a hundred and twenty days is a continuous period of absence rather than an
       allowance of workdays.

       The single most consequential column in the table, and the one a system
       that hard codes it gets wrong for exactly one type at a time. */
    counting_basis           VARCHAR(20) NOT NULL,

    /* QUOTA | EVENT. The TDD's `is_quota_based`, as a named pair rather than a
       boolean, so that the two words appear in the code instead of `true`.

       FR 32g settles which is which: annual and sick are annual allowances that
       reset each leave year; maternity, paternity, compassionate, unpaid and the
       unpaid maternity extension are granted per qualifying occurrence, do not
       reset on 1 January, and do not accumulate year on year.

       What turns on it: a quota type gets a `leave_balance` row per person per
       leave year and a place in the rollover job. An event type gets a GRANT
       when the event is recorded, and "you have three days left" is not a
       sentence that means anything about one. */
    entitlement_basis        VARCHAR(20) NOT NULL,

    /* Whether the leave is paid. FALSE for unpaid leave and the unpaid maternity
       extension, TRUE for everything else. Nothing in the ledger turns on it
       yet — it is payroll's question and payroll is out of scope — but it is
       what the report of FR 63 has to group by, and a type whose paid status
       nobody recorded is a type that ends up in the wrong column of it. */
    is_paid                  BOOLEAN NOT NULL DEFAULT TRUE,

    /* DAYS | WEEKS | MONTHS. How the allowance is *expressed* to a person, never
       how it is counted.

       Maternity is "4 months, 120 days" and paternity is "2 weeks, 14 days".
       Both are stored and counted in days — FR 24, whole days only — and this is
       what lets a screen say "4 months" beside the figure without any part of
       the system doing arithmetic in months. Keeping it apart from
       counting_basis is the point: one is presentation and the other decides
       what a day costs. */
    unit                     VARCHAR(10) NOT NULL DEFAULT 'DAYS',

    /* FR 13 and FR 31. NOT_REQUIRED | ALWAYS | AFTER_DAYS.

       Three states rather than the TDD's boolean-plus-threshold, because the
       pair could disagree: `requires_attachment` false beside a threshold of two
       is a rule nothing evaluates, and a threshold of null beside a rule that
       needs one is a rule nothing can evaluate.
       leave_type_documentation_agrees holds the two halves together, which a
       boolean and a nullable number cannot do between them. */
    documentation            VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED',

    /* The TDD's `attachment_required_after_days`. How long the request has to be
       before the document is wanted, counted under this type's own basis. NULL
       unless the rule is AFTER_DAYS, and NOT NULL when it is.

       Unset on every type shipped below, which is worth being explicit about,
       because the obvious candidate is not one. Sick leave's certificate rule is
       *not* "beyond three days of this request"; FR 32a makes it "beyond the
       three days of the yearly allowance", which is a balance question and is
       exceedable_with_document immediately below. This column is for a type
       whose threshold really is the length of the request. */
    documentation_after_days SMALLINT,

    /* FR 32a. Whether exceeding the available balance is a refusal or a request
       for evidence.

       TRUE for sick leave and nothing else. It inverts the balance check of
       FR 14: instead of "reject when the balance is exceeded", it becomes
       "require an attachment when the balance is exceeded, then allow it". Sick
       leave is therefore effectively unlimited with certification, its balance
       will routinely go negative, and that is correct rather than a fault to be
       guarded against.

       It is a column rather than a rule about sick leave for exactly the reason
       everything else here is: the day HR decides compassionate leave works the
       same way, that is a checkbox. */
    exceedable_with_document BOOLEAN NOT NULL DEFAULT FALSE,

    /* How many months after the qualifying event an unused grant lapses, or NULL
       for one that does not.

       Paternity, and at present only paternity: FR 32e gives 14 calendar days
       per birth "usable within 6 months of the birth date, after which any
       unused balance lapses". §8.6aa is how it is spent — a GRANT carrying an
       expiry date, drawn down by several requests, with an EXPIRY entry for
       whatever is left.

       **Not carry over.** Unused *annual* leave rolling into the next year, and
       when it lapses, is FR 36 and lives on leave_entitlement_rule with the
       effective dates: `carryover_max_days` and `carryover_expiry_month`, both
       unset today because current policy caps neither. Two different clocks with
       similar names, and conflating them would expire the wrong days. */
    entitlement_expiry_months SMALLINT,

    /* The TDD's `allows_split_across_requests`. Whether one grant may be drawn
       down by more than one request.

       TRUE everywhere today, including maternity, and that is deliberate rather
       than an oversight: §8.6aa says the column exists "so that a future type
       which genuinely must be continuous, maternity being the obvious candidate,
       can say so". The rule is configuration; today nobody has switched it on. */
    may_be_split             BOOLEAN NOT NULL DEFAULT TRUE,

    /* FR 17. Calendar days of notice, and 14 for annual leave alone. "No other
       type carries a notice requirement: the event based types cannot be
       foreseen, and sick leave by its nature cannot be given notice at all."

       Calendar days rather than working days, and named so, because notice is
       counted off a wall calendar by the person giving it. It is measured
       against the day the leave starts, not against the day count.

       **Short notice warns; it does not refuse.** FR 17 is explicit: the system
       "shall warn and require the employee to acknowledge, then allow it
       through, since whether short notice is workable is a judgement for the
       approvers". The number here is the threshold of that warning. */
    min_notice_calendar_days INT NOT NULL DEFAULT 0,

    /* FR 18. Calendar days after the fact that leave may still be recorded, so
       that emergency absence can be entered on return. Seven for every type,
       which is the TDD's default and the SRS's one week.

       This one does refuse, which is the asymmetry worth knowing: notice is
       advice and backdating is a limit. Beyond it, "only HR may enter the
       record, with a reason" — an escape hatch that belongs to the request
       workflow rather than to this table, since it is about who is asking. */
    max_backdate_calendar_days INT NOT NULL DEFAULT 7,

    /* FR 05. MALE | FEMALE, or NULL where the type is open to everybody.

       Almost every type is NULL and this exists for the three that are not.
       employee.gender is nullable and is documented on that table as being for
       eligibility checks only — this is the check it was made nullable for, and
       the only place in the schema that reads it. */
    gender_restriction       VARCHAR(20),

    /* FR 33. Sick leave, maternity leave and public holidays shall never reduce
       annual leave entitlement.

       A column whose only permitted value is FALSE, which reads as a joke until
       you notice what it is doing. The TDD carries it as a comment — "must stay
       FALSE" — and a comment is not a constraint. Held as a column with a CHECK,
       the requirement is enforced against the configuration screen this story is
       about: an HR Administrator cannot tick it, because there is nothing to
       tick. If a type is ever genuinely meant to draw down annual leave, that is
       a migration with an argument attached, which is the right price. */
    deducts_from_annual      BOOLEAN NOT NULL DEFAULT FALSE,

    /* The order a request form and a balance screen list types in. §7.4 of the
       TDD orders the balance read by it, so it is here rather than being an
       alphabetical accident: HR decides that annual leave comes first, not the
       letter A. */
    display_order            INT NOT NULL DEFAULT 0,

    /* Retired, never deleted. A type is the heading every request, ledger entry
       and report of either is filed under, so removing the row rewrites history
       in the way FR 06 refuses for an employee. */
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT leave_type_code_not_blank CHECK (btrim(code) <> ''),
    CONSTRAINT leave_type_name_not_blank CHECK (btrim(name) <> ''),

    CONSTRAINT leave_type_counting_basis_known
        CHECK (counting_basis IN ('WORKING_DAYS', 'CALENDAR_DAYS')),

    CONSTRAINT leave_type_entitlement_basis_known
        CHECK (entitlement_basis IN ('QUOTA', 'EVENT')),

    CONSTRAINT leave_type_unit_known
        CHECK (unit IN ('DAYS', 'WEEKS', 'MONTHS')),

    CONSTRAINT leave_type_documentation_known
        CHECK (documentation IN ('NOT_REQUIRED', 'ALWAYS', 'AFTER_DAYS')),

    /* The threshold and the rule stand or fall together. A type saying
       AFTER_DAYS with no number is a rule nothing can evaluate; a number beside
       any other rule is a figure somebody set, believed, and that nothing reads.
       Both are the sort of half configured row that looks fine in a list and
       produces the wrong answer once, months later. */
    CONSTRAINT leave_type_documentation_agrees
        CHECK ((documentation = 'AFTER_DAYS') = (documentation_after_days IS NOT NULL)),

    /* Zero would be ALWAYS said in a way no screen renders correctly. */
    CONSTRAINT leave_type_documentation_threshold_positive
        CHECK (documentation_after_days IS NULL OR documentation_after_days > 0),

    CONSTRAINT leave_type_expiry_months_positive
        CHECK (entitlement_expiry_months IS NULL OR entitlement_expiry_months > 0),

    CONSTRAINT leave_type_notice_not_negative
        CHECK (min_notice_calendar_days >= 0),
    CONSTRAINT leave_type_backdating_not_negative
        CHECK (max_backdate_calendar_days >= 0),

    /* FR 33, and the whole point of the column. */
    CONSTRAINT leave_type_never_deducts_from_annual
        CHECK (deducts_from_annual = FALSE),

    /* The same two values employee_gender_known holds, and it has to be the same
       two: a restriction naming something no employee record can hold is a type
       nobody is eligible for. */
    CONSTRAINT leave_type_gender_known
        CHECK (gender_restriction IS NULL OR gender_restriction IN ('MALE', 'FEMALE'))
);

-- ---------------------------------------------------------- one row per type

/* Both identifiers are unique without regard to case, the same way a department
   name and a working pattern name are: 'ANNUAL' and 'annual' are one type to
   everybody except a byte comparison, and a second row under the other spelling
   is two allowances for one kind of leave.

   Folded rather than stored folded, so 'Compassionate Leave' keeps its shape on
   the screen where somebody picks it. */

CREATE UNIQUE INDEX leave_type_code_unique ON leave_type (upper(code));
CREATE UNIQUE INDEX leave_type_name_unique ON leave_type (lower(name));

/* What a request form offers, in the order §7.4 reads them. */
CREATE INDEX leave_type_offered ON leave_type (display_order, name) WHERE is_active;

-- --------------------------------------------------------------- maintenance

/* set_updated_at() reused rather than copied, as every table since the
   department rules has reused it. "When did this last change" is the first
   question asked of a leave type that produced a day count somebody disputes,
   and the second is who changed it — which is the audit trigger below. */

CREATE TRIGGER leave_type_set_updated_at
    BEFORE UPDATE ON leave_type
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

/* NFR AUD 01 names configuration changes explicitly: "Every create, update,
   decision, override, and configuration change shall be written to an append
   only audit log." This is the configuration. No column is noise and none is a
   secret, so the trigger takes its defaults. */

CREATE TRIGGER leave_type_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_type
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration. UPDATE is granted because editing a
   type is the story.

   DELETE is not, and that is the load bearing omission. A leave type is the
   heading every request, ledger entry and report of either is filed under, so a
   deleted row takes the meaning of last year's figures with it — the same
   argument that withholds DELETE on `employee` for FR 06. is_active is the
   ending this table has.

   leave_request.leave_type_id will point here from Phase 3 and the key will
   refuse most of these deletions on its own. The row nobody has used yet would
   still be deletable, and this closes that today, before there is anything to
   lose. */

GRANT UPDATE ON leave_type TO lms_app;

-- --------------------------------------------------- the seven types of FR 32

/* Annual, sick, maternity, paternity, compassionate, unpaid, and the unpaid
   maternity extension. The rules are from SRS §4.3.1 and TDD §5.5; the figures
   deliberately are not here.

   Every row is inserted only where no type of that name exists, so this file is
   safe to apply to a database with history — which, after today, is the only
   kind there is.

   Read down the notice and backdating columns and the shape of the policy is
   visible: annual leave is the only type anybody can be expected to plan, so it
   is the only one with a notice threshold, and every type may be recorded a week
   late because every type can be overtaken by events. */

INSERT INTO leave_type (
    code, name, description, counting_basis, entitlement_basis, is_paid, unit,
    documentation, exceedable_with_document, entitlement_expiry_months,
    may_be_split, min_notice_calendar_days, max_backdate_calendar_days,
    gender_restriction, display_order
)
SELECT * FROM (VALUES
    /* FR 28 and FR 17. The only type with a notice threshold, and the only one
       whose unused days carry into the next year — which is FR 36 and lives on
       the entitlement rule, not here. */
    ('ANNUAL', 'Annual Leave',
     'Your yearly allowance. Two weeks'' notice is expected; less is allowed but the approvers will see that it was short.',
     'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
     'NOT_REQUIRED', FALSE, NULL::SMALLINT, TRUE, 14, 7, NULL::VARCHAR, 1),

    /* FR 32a, and the reason exceedable_with_document exists. The three day
       allowance is a documentation threshold rather than a cap: up to it you
       self certify, beyond it a medical certificate is required and the leave is
       still granted. `documentation` is therefore NOT_REQUIRED — the certificate
       is demanded by the balance rule, not by the length of the request. */
    ('SICK', 'Sick Leave',
     'Self certified up to your yearly allowance. Beyond that a medical certificate is needed, and the leave is still granted.',
     'WORKING_DAYS', 'QUOTA', TRUE, 'DAYS',
     'NOT_REQUIRED', TRUE, NULL, TRUE, 0, 7, NULL, 2),

    /* FR 32f. Five working days per event, and the system holds no list of
       qualifying relationships: eligibility is the approvers' judgement on the
       reason given. */
    ('COMPASSIONATE', 'Compassionate Leave',
     'Granted per occasion. Say what it is for; whether it qualifies is for your manager and HR to decide.',
     'WORKING_DAYS', 'EVENT', TRUE, 'DAYS',
     'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 3),

    /* FR 32d. 120 calendar days per confinement. Expressed in months and counted
       in days, which is what `unit` is for. may_be_split stays TRUE: §8.6aa
       names maternity as the obvious candidate for a future type that must be
       continuous, and leaves the switch unthrown. */
    ('MATERNITY', 'Maternity Leave',
     'Granted per confinement, counted in calendar days. Weekends and public holidays fall inside the period.',
     'CALENDAR_DAYS', 'EVENT', TRUE, 'MONTHS',
     'ALWAYS', FALSE, NULL, TRUE, 0, 7, 'FEMALE', 4),

    /* FR 32e. 14 calendar days per birth, usable within six months, and may be
       taken in more than one spell — the one type today that actually needs both
       entitlement_expiry_months and may_be_split. */
    ('PATERNITY', 'Paternity Leave',
     'Granted per birth and usable within six months of it. It need not be taken all at once.',
     'CALENDAR_DAYS', 'EVENT', TRUE, 'WEEKS',
     'NOT_REQUIRED', FALSE, 6, TRUE, 0, 7, 'MALE', 5),

    /* FR 32h. Unpaid, and approved by HR and the CEO with no manager stage —
       which is the approval chain of FR 38a and not a column of this table. */
    ('UNPAID', 'Unpaid Leave',
     'Agreed rather than accrued, and unpaid. Decided by HR and the Chief Executive.',
     'WORKING_DAYS', 'EVENT', FALSE, 'WEEKS',
     'NOT_REQUIRED', FALSE, NULL, TRUE, 0, 7, NULL, 6),

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
    SELECT 1 FROM leave_type existing WHERE lower(existing.name) = lower(statutory.name)
);

-- ------------------------------------------------------ what is not here yet

/* **The entitlement figures.** Twenty days of annual leave, a hundred and twenty
   of maternity, three of sick. FR 31 requires them to be versioned with an
   effective date and to leave closed leave years alone, and a column here has no
   date on it. They are `leave_entitlement_rule`, with `days_per_year`,
   `prorate_on_join`, `carryover_max_days` and `carryover_expiry_month`, and they
   arrive with the leave year and the ledger.

   **The approval chain.** FR 38a: an ordered list of approver roles per type,
   manager then HR for most and HR then the CEO for the two unpaid types. It is
   `leave_type_approval_step` in TDD §5.5 — a child table with a step order, not
   a column — and it is left out rather than stubbed because a nullable
   `approver_role` added now would be the wrong shape stored in the right place,
   which is harder to remove than nothing.

   **Holiday interaction.** Whether a public holiday inside a request is free
   follows from counting_basis and the `holiday` table, and the calendar does not
   exist yet. FR 25's recalculation applies "only to working day leave types",
   which is a read of this table and needs nothing added to it — the point of
   having settled the basis first. */

-- Down Migration

DROP TRIGGER IF EXISTS leave_type_is_audited ON leave_type;
DROP TRIGGER IF EXISTS leave_type_set_updated_at ON leave_type;

DROP TABLE IF EXISTS leave_type;
