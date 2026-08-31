-- Up Migration

-- Asking for leave. FR 10, FR 11, §8. LMS 301.
--
-- The first table of Phase 3, and the one every table built so far was pointing at.
-- The leave-type-rules migration said `leave_request.leave_type_id will point here
-- from Phase 3`; the immutable-leave-ledger migration refused a `leave_request_id`
-- on the ledger and said it `arrives with the request table, as a column, a foreign
-- key, and the rule that the four request-shaped entry types must carry one`. This is
-- that migration, and it does both.
--
-- The story is an employee who wants to know what a fortnight will cost before it
-- costs it. Two things follow from that sentence and they are the whole design:
--
--   **The figure is quoted before it is charged, and it is the same figure.**
--   `LeaveRequestService.quote()` counts the days and hands them back without writing
--   anything; `submit()` counts again inside the transaction and stores what it
--   counted. Nothing in between can move it, because the count is stored rather than
--   derived on every read — see `counting_basis` and `days` below.
--
--   **Submitting holds the days.** The README has said since Phase 1 that "pending
--   days are reserved: submitting a request writes a RESERVATION entry immediately.
--   This is what stops somebody with five days left having three separate five day
--   requests in flight." `BalanceService.reserve` has been built and unused since
--   LMS 212 waiting for exactly this, and the request row and its RESERVATION are one
--   act — both land or neither does, the same shape LMS 218 gave a birth and the
--   grant it caused.
--
-- ## What this migration deliberately does not bring
--
-- **No state machine.** `status` is held to one value, and that is not an oversight
-- being papered over — it is LMS 209's rule applied honestly. A CHECK listing six
-- states of which one is reachable is a promise the schema cannot keep, and the
-- approval story extends the list in its own migration exactly as
-- event-based-entitlement-grants extended `leave_ledger_entry_type_known` to admit
-- `LAPSE`. The README's "only the state machine moves a request" is the rule that
-- story inherits; what this one guarantees is that nothing else has moved one first.
--
-- **No overlap constraint.** The baseline enabled `btree_gist` for "a GiST exclusion
-- constraint mixing equality on a scalar column with overlap on a range", which is
-- how two requests for the same fortnight are refused. It is not here because it is a
-- rule about two requests and this story is about one, and because the constraint has
-- to know which statuses count as live — which is the state machine's list and does
-- not exist yet. A request overlapping another is a real defect and it is the next
-- story's, named here so it is inherited rather than rediscovered.
--
-- **No splitting.** `leave_type.may_be_split` and `assertMayBeSplit()` have been in
-- the domain since LMS 201 and nothing calls them. A period crossing a leave year
-- boundary is refused outright below rather than split in two, because a split is two
-- requests with one approval between them and that is a decision rather than an
-- arithmetic.

-- --------------------------------------------------------------------- the request

/* One period of one kind of leave, asked for by one person.

   Four groups of columns, and the second is the story:

     **What was asked for.** Who, what kind, from when to when, and why. FR 10's four
     fields, and `reason` is mandatory here where a leave *event*'s note is optional —
     an event is a fact HR recorded and a request is somebody asking for something,
     and the person deciding it needs to know what they are deciding.

     **What it was priced at, copied.** `counting_basis`, `days` and `calendar_days`,
     written once at submission and never derived again. This is the story's third
     criterion and it is worth being plain about what it protects: an HR Administrator
     may edit a leave type — `leaveTypePolicy.update` — and changing `counting_basis`
     from WORKING_DAYS to CALENDAR_DAYS is one dropdown. Without the copy, every
     request ever approved under the old basis silently restates itself the next time
     a screen renders it, and last March's fortnight becomes fourteen days instead of
     ten. The ledger would still say ten. FR 11.

     **Where it is filed.** `leave_year_id`, so that a request and the movements it
     causes are keyed the same way a balance is, and the trigger below that holds the
     whole period inside that year.

     **Where it has got to.** `status`, and the reservation it caused.

   No `approved_by`, no `decided_at`, no `approval_step`. Those are the approval
   story's and a nullable column with nothing able to write it is the switch with
   nothing behind it that LMS 209 argued against — the same argument the ledger made
   when it refused `leave_request_id` until this table existed. */

CREATE TABLE leave_request (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The same three a balance is keyed by, and the same three the RESERVATION
       carries, so a request and the movement it caused are filed identically. */
    employee_id BIGINT NOT NULL REFERENCES employee(id),
    leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),
    leave_year_id BIGINT NOT NULL REFERENCES leave_year(id),

    /* DATE and not a timestamp, as every calendar date in this schema is. NFR DAT 03:
       leave dates carry no time and no zone, because the day somebody comes back is
       the same day in Accra and on a laptop set to Tokyo. Inclusive at both ends —
       away from the twenty first to the thirty first means both of those days, which
       is how a person writes it and how `countLeaveDays` reads it. */
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    /* FR 10. Mandatory and not blank, unlike an entitlement event's note.

       The argument for making it mandatory is the person who has to decide it: a
       manager looking at five days in March with no reason on them is being asked to
       approve something they know nothing about, and the honest options are to
       approve everything or to telephone everybody. Both are worse than a sentence. */
    reason TEXT NOT NULL,

    /* The story's third criterion. FR 11.

       A copy of `leave_type.counting_basis` as it stood the moment this was submitted,
       so that a later edit to the type cannot rewrite what this request cost. Held to
       the same two values the type is held to; the domain's COUNTING_BASES is the same
       list and the integration suite asserts the two agree.

       Not a foreign key to the type's column, because that is precisely what would
       let it change. The point is that it is a copy. */
    counting_basis TEXT NOT NULL,

    /* What the copy above priced it at, and what the RESERVATION took.

       `days` is an INTEGER and not the ledger's NUMERIC(6,2), which is FR 24 drawn in
       the type system: leave is requested in whole days. The ledger's column is
       fractional because §8.6d pro rates a joiner to 10.08 days — "FR 24 governs how
       leave is requested, not how entitlement is held" — and this is the requesting
       side of that line.

       `calendar_days` is the span, counted or not, and it is stored beside the cost
       rather than computed from the two dates because it is the other half of the
       sentence a person reads: "nine days off, seven of them counted". Deriving it
       would be safe today and is stored for the same reason `days` is — a request
       says what it said. */
    days INTEGER NOT NULL,
    calendar_days INTEGER NOT NULL,

    /* Where it has got to. One value today; see the module note.

       DEFAULT deliberately absent. A request's state is the most consequential thing
       on this row and a default is what a writer gets when it says nothing — which is
       the writer with the most to say. */
    status TEXT NOT NULL,

    /* When it was asked for, which is not when the leave starts and is not
       `created_at` restated: FR 17's notice period is counted from this, and FR 18's
       backdating window is judged against it. A TIMESTAMPTZ because it is an instant
       — the moment somebody pressed the button — and stored rather than defaulted for
       the reason the ledger stamps its own: a default applies only when a writer says
       nothing, and notice measured from a figure a writer could supply is notice a
       writer could give itself. Stamped by the trigger below. */
    submitted_at TIMESTAMPTZ NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* A period that is not a period. Both ends inclusive, so one day is a legitimate
       request and `end_date < start_date` is two dates entered the wrong way round. */
    CONSTRAINT leave_request_ends_after_it_starts CHECK (end_date >= start_date),

    CONSTRAINT leave_request_reason_not_blank CHECK (btrim(reason) <> ''),

    CONSTRAINT leave_request_counting_basis_known CHECK (
        counting_basis IN ('WORKING_DAYS', 'CALENDAR_DAYS')),

    /* One value, and the approval story adds to this list in a migration of its own.
       See the module note for why it is not six values with five unreachable. */
    CONSTRAINT leave_request_status_known CHECK (status IN ('SUBMITTED')),

    /* Leave that costs nothing is leave nobody needs to ask for, and the domain
       refuses it with a sentence naming the free days — `LeaveCountsNoDays`. This is
       the same rule where no sentence can reach: a zero here is a request that sits in
       a queue, deducts nothing, and appears on a team calendar as an absence nobody
       paid for. */
    CONSTRAINT leave_request_costs_at_least_a_day CHECK (days >= 1),

    /* And it cannot cost more days than it spans. A working-day count is at most the
       calendar span and a calendar-day count is exactly it, so this holds both bases
       with one inequality and catches the arithmetic that would otherwise reserve
       fourteen days for a long weekend. */
    CONSTRAINT leave_request_costs_no_more_than_it_spans CHECK (
        days <= calendar_days),

    /* The span really is the span. Written by the caller, so it is checked here
       rather than trusted — the two dates are the authority and this column is a
       reading of them. */
    CONSTRAINT leave_request_spans_its_own_dates CHECK (
        calendar_days = (end_date - start_date) + 1)
);

/* One person's requests, newest first, which is what a leave page asks. */
CREATE INDEX leave_request_by_employee
    ON leave_request (employee_id, start_date DESC);

/* One balance's requests, which is what a screen asks to put "5 days in March" beside
   a figure, and what the overlap check of the next story will need. */
CREATE INDEX leave_request_by_balance
    ON leave_request (employee_id, leave_type_id, leave_year_id, start_date);

-- ------------------------------------------- a request belongs to one leave year

/* `leave_year_id` is not free to disagree with the dates, and neither end may fall
   outside it.

   A fact about another row, so a trigger rather than a CHECK — the same class of rule
   as `refuse_an_event_outside_its_leave_year()`, and stricter in one way that matters:
   an event happens on a day and a request spans a period, so both ends are held.

   **A period crossing a year end is refused here rather than split.** Twenty eighth of
   December to the fifth of January is two balances, and a request is one row against
   one of them: reserving ten days against next year's entitlement for days taken this
   year would be a figure that reconciles and is wrong. `leave_type.may_be_split` and
   `assertMayBeSplit()` are what a story that wants to offer the split would use, and
   it is a decision — two requests with one approval between them — rather than an
   arithmetic this trigger could perform. The refusal names both years so the person
   at the form knows what to do. */

CREATE FUNCTION refuse_a_request_outside_its_leave_year() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    year leave_year%ROWTYPE;
BEGIN
    SELECT * INTO year FROM leave_year WHERE id = NEW.leave_year_id;

    /* Unreachable: the foreign key has already found it. Answered rather than
       assumed, because the alternative is a NULL comparison below quietly permitting
       what this function exists to refuse. */
    IF NOT FOUND THEN
        RAISE EXCEPTION 'There is no leave year %.', NEW.leave_year_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_falls_in_its_leave_year';
    END IF;

    IF NEW.start_date < year.start_date OR NEW.end_date > year.end_date THEN
        RAISE EXCEPTION
            'Leave from % to % does not fall inside leave year % (% to %).',
            NEW.start_date, NEW.end_date, year.label, year.start_date, year.end_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_falls_in_its_leave_year',
                  HINT = 'A request is one period against one balance, and a balance '
                         'belongs to one leave year. Leave that crosses a year end is '
                         'asked for as two requests, one in each year.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_falls_in_its_leave_year
    BEFORE INSERT OR UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_request_outside_its_leave_year();

-- --------------------------------------------------- when it was asked for

/* `submitted_at` is the database's to stamp, exactly as `created_at` on a ledger
   entry is.

   FR 17 counts notice from this and FR 18 judges backdating against it, so it is a
   figure with consequences for the person supplying it: a request that could date its
   own submission could give itself a fortnight's notice on the morning of the leave.
   The same argument `stamp_the_writer_on_a_ledger_entry()` makes about who — a fact
   the writer has an interest in is not a fact the writer supplies.

   Left alone on UPDATE, because a request is asked for once. */

CREATE FUNCTION stamp_when_a_request_was_submitted() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.submitted_at := now();
    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_says_when_it_was_submitted
    BEFORE INSERT ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION stamp_when_a_request_was_submitted();

-- ---------------------------------------- what a request said, it goes on saying

/* The story's third criterion, held where no service can forget it.

   Everything the reservation was calculated from is frozen: who, what kind, which
   year, the two dates, the basis it was priced under, and the two counts. Changing
   any of them after the fact would move what the request says without moving the
   days in the ledger, and the ledger is the one that is right — design principle 1.

   `counting_basis` is the column this story is named for and it is the least obvious
   of them. The others are things somebody might edit on purpose; this one is a copy
   nobody would think to protect, which is exactly why a future story reading it fresh
   off `leave_type` — "it is the same value, and this way it cannot drift" — has to be
   stopped by something other than a comment.

   `reason` is left editable, and it is the only one. It explains rather than decides,
   which is the same line `leave_entitlement_event` draws around its `note` and
   `leave_entitlement_rule` around its. Somebody clarifying why they need the Friday
   is improving the record; nothing recalculates from it.

   `status` is left editable because the approval story moves it, and that story's own
   migration is where the rules about *which* transitions are permitted belong. What
   this one guarantees is that the figures underneath cannot move while it does. */

CREATE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
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

CREATE TRIGGER leave_request_says_what_it_said
    BEFORE UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_rewriting_what_a_request_cost();

/* And nothing is removed. A request heads a RESERVATION that is in the ledger
   forever, so deleting the row would leave days held in somebody's balance with
   nothing to say who is holding them or why — which is design principle 1 read
   backwards, and the same argument `leave_entitlement_event` makes.

   Withdrawing a request is not deleting it: it is a RELEASE and a status, and it
   belongs to the story that owns the transitions. */

CREATE TRIGGER leave_request_is_never_deleted
    BEFORE DELETE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'The days this request holds are in the ledger and cannot be removed, so '
        'removing the request would leave a balance short with nothing to explain '
        'it. Withdrawing leave releases the days and keeps the record. FR 27.'
    );

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the
   department rules has reused them.

   The audit trigger matters here for a reason the other tables do not have: this is
   the first table in the schema whose rows are written by the *subject* of the record
   rather than about them. Every leave request is somebody asking for something they
   want, and "when was this submitted, and has anything about it moved since" is the
   first question asked when a manager and an employee remember a fortnight
   differently. `submitted_at` answers the first half; the audit log answers the
   second, including for the columns the trigger above already refuses to move. */

CREATE TRIGGER leave_request_set_updated_at
    BEFORE UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER leave_request_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_request
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ------------------------------------------- the ledger learns which request

/* The column the immutable-leave-ledger migration refused to add until there was
   something to put behind it.

   Its own words: "a nullable id with no foreign key behind it would be a column
   nothing could populate and nothing could check — the switch with nothing behind it
   that LMS 209 argued against. It arrives with the request table, as a column, a
   foreign key, and the rule that the four request-shaped entry types must carry one."
   All three are here.

   Nullable, because the column is null for every entry that is *not* about a request —
   a grant, a carry forward, an adjustment, an expiry, a lapse — and those are most of
   the rows written so far. What makes it more than a hint is the CHECK below, which is
   an equivalence rather than a requirement: a request movement must have one and
   anything else must not. Half of that is the half nobody writes, and it is the half
   that catches a GRANT being posted against a request id because a method was copied.

   RECALCULATION is in the list and has no writer yet — FR 25 gives a day back on an
   approved request when a holiday is declared inside it, which is a movement about a
   request by definition. Including it now costs nothing and means the story that
   writes it inherits the rule rather than having to add it. */

ALTER TABLE leave_ledger_entry
    ADD COLUMN leave_request_id BIGINT REFERENCES leave_request(id);

ALTER TABLE leave_ledger_entry
    ADD CONSTRAINT leave_ledger_entry_request_movements_name_a_request CHECK (
        (entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'))
        = (leave_request_id IS NOT NULL)
    );

/* Every movement one request caused, which is what a screen shows beside it and what
   the approval story reads to find the reservation it has to draw down. */
CREATE INDEX leave_ledger_entry_by_request
    ON leave_ledger_entry (leave_request_id)
    WHERE leave_request_id IS NOT NULL;

-- ------------------------------------------ a request holds its days, exactly once

/* The link runs one way — entries name the request — and there is deliberately no
   `reserved_entry_id` on `leave_request` pointing back.

   Two foreign keys between two tables, each NOT NULL, is a pair neither row can be
   written first: the request needs the entry's id and the entry needs the request's.
   `leave_entitlement_event.granted_entry_id` does not have that problem because the
   ledger has no column pointing the other way; here it does, and one direction is the
   filing while two would be two sources of truth about the same fact.

   What the missing NOT NULL would have guaranteed is guaranteed by the pair below,
   which is the division of labour the working-pattern-rules migration made for
   "exactly one default" and the line-manager rules for "exactly one root":

     | | Covers | Does not cover |
     |---|---|---|
     | the unique partial index | a second RESERVATION against one request, immediately, on every connection | a request with none |
     | the deferred constraint trigger | a request that reserved nothing, at COMMIT | TRUNCATE, which no row trigger sees |

   **Deferred is the whole point of the second one**, exactly as it is for those two.
   The request row has to exist before an entry can name it, so between the two
   statements there is a request holding nothing — a legitimate intermediate state that
   a per-row check would refuse and that a check at commit judges correctly, because
   the only state it ever sees is the one that will actually be stored. */

CREATE UNIQUE INDEX leave_request_reserves_once
    ON leave_ledger_entry (leave_request_id)
    WHERE entry_type = 'RESERVATION';

CREATE FUNCTION refuse_a_request_that_holds_no_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    /* The row may have been deleted by the same transaction — it cannot, the delete
       trigger refuses it, but a constraint trigger fires on a row that no longer has
       to be there and reading a missing one would raise the wrong error entirely. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM leave_ledger_entry
         WHERE leave_request_id = NEW.id AND entry_type = 'RESERVATION'
    ) THEN
        RAISE EXCEPTION 'Leave request % holds no days.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_holds_its_days',
                  HINT = 'Submitting a request reserves what it costs, in the same '
                         'transaction. A request holding nothing could be submitted '
                         'three times against a balance with five days in it. FR 26.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_holds_its_days
    AFTER INSERT ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_request_that_holds_no_days();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration.

   UPDATE is granted for two columns' sake — `status`, which the approval story moves,
   and `reason`, which the person who wrote it may improve — and the trigger above is
   what makes that safe rather than the grant being narrow. Postgres can grant UPDATE
   per column and this deliberately does not, for the reason
   event-based-entitlement-grants gives: a column list in a GRANT is a rule nobody
   reads, and a trigger is a rule with its argument attached.

   DELETE is not granted, and the trigger refuses it for the owner as well. */

GRANT UPDATE ON leave_request TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS leave_request_holds_its_days ON leave_request;
DROP FUNCTION IF EXISTS refuse_a_request_that_holds_no_days();

DROP INDEX IF EXISTS leave_request_reserves_once;
DROP INDEX IF EXISTS leave_ledger_entry_by_request;

ALTER TABLE leave_ledger_entry
    DROP CONSTRAINT IF EXISTS leave_ledger_entry_request_movements_name_a_request;

/* The request-shaped entries go with the requests that caused them. Rolling this back
   with reservations in the ledger is rolling back days that are being held, and
   leaving them would leave every one of them pointing at a table that is about to not
   exist. The balances rebuild themselves from the remaining rows, because
   `rebuild_one_balance_from_the_ledger()` fires on the delete. */

DELETE FROM leave_ledger_entry
    WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION');

ALTER TABLE leave_ledger_entry DROP COLUMN IF EXISTS leave_request_id;

DROP TRIGGER IF EXISTS leave_request_is_audited ON leave_request;
DROP TRIGGER IF EXISTS leave_request_set_updated_at ON leave_request;
DROP TRIGGER IF EXISTS leave_request_is_never_deleted ON leave_request;
DROP TRIGGER IF EXISTS leave_request_says_what_it_said ON leave_request;
DROP TRIGGER IF EXISTS leave_request_says_when_it_was_submitted ON leave_request;
DROP TRIGGER IF EXISTS leave_request_falls_in_its_leave_year ON leave_request;

DROP TABLE IF EXISTS leave_request;

DROP FUNCTION IF EXISTS refuse_rewriting_what_a_request_cost();
DROP FUNCTION IF EXISTS stamp_when_a_request_was_submitted();
DROP FUNCTION IF EXISTS refuse_a_request_outside_its_leave_year();
