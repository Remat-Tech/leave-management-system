-- Up Migration

-- Sickness during annual leave, moved to sick leave. FR 32c, §8.6c. LMS 507.
--
-- Two ledger entries under one reason and one correlation id: the annual days credited
-- back, the same days charged to sick leave. The annual request keeps its dates and its
-- price — what moved is recorded beside it, not written over it.

-- ------------------------------------------------------- the tenth kind of movement

/* RECLASSIFICATION: days moving between two leave types, one entry per side.
   Either sign, like ADJUSTMENT, because the credit and the charge are the same act.
   It touches `taken` alone — a DEDUCTION would draw down a `pending` nothing reserved. */

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_type_known;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_type_known CHECK (
    entry_type IN (
        'GRANT', 'CARRY_FORWARD', 'ADJUSTMENT', 'EXPIRY', 'LAPSE',
        'RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION', 'RECLASSIFICATION'));

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_sign_matches_the_type;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_sign_matches_the_type CHECK (
    CASE entry_type
        WHEN 'GRANT'            THEN days > 0
        WHEN 'CARRY_FORWARD'    THEN days > 0
        WHEN 'RELEASE'          THEN days > 0
        WHEN 'RECALCULATION'    THEN days > 0
        WHEN 'RESERVATION'      THEN days < 0
        WHEN 'DEDUCTION'        THEN days < 0
        WHEN 'EXPIRY'           THEN days < 0
        WHEN 'LAPSE'            THEN days < 0
        WHEN 'ADJUSTMENT'       THEN days <> 0
        WHEN 'RECLASSIFICATION' THEN days <> 0
    END
);

/* It is a request movement: whole days, naming the leave it came out of, and free to
   certify days past an allowance. FR 24, FR 32a. */

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_requests_move_whole_days;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_requests_move_whole_days CHECK (
    entry_type NOT IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION', 'RECLASSIFICATION')
    OR days = trunc(days)
);

ALTER TABLE leave_ledger_entry
    DROP CONSTRAINT leave_ledger_entry_request_movements_name_a_request;

ALTER TABLE leave_ledger_entry
    ADD CONSTRAINT leave_ledger_entry_request_movements_name_a_request CHECK (
        (entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION',
                        'RECLASSIFICATION'))
        = (leave_request_id IS NOT NULL)
    );

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_only_a_request_certifies;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_only_a_request_certifies CHECK (
    certified_days = 0
    OR entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION',
                      'RECLASSIFICATION'));

-- ------------------------------------------------------ the projection, in its one place

/* `RECLASSIFICATION` joins `taken`, and that line is the whole change: the credit takes
   days out of one balance's taken, the charge puts the same days into the other's. */

CREATE OR REPLACE VIEW what_the_ledger_says AS
SELECT
    employee_id,
    leave_type_id,
    leave_year_id,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('GRANT', 'LAPSE')), 0) AS entitled,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
        AS carried_over,
    coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
    coalesce(sum(-days) FILTER (
        WHERE entry_type IN ('DEDUCTION', 'RECALCULATION', 'RECLASSIFICATION')), 0) AS taken,
    coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
        FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0) AS pending
FROM leave_ledger_entry
GROUP BY employee_id, leave_type_id, leave_year_id;

-- --------------------------------------------------------------- the correlation id

/* What `corrects_id` could not say. That one names an entry this one puts right inside
   one balance; this names the other side of a move between two. §8.6c.

   An equivalence: every reclassification carries one and nothing else may. */

ALTER TABLE leave_ledger_entry ADD COLUMN correlation_id UUID;

ALTER TABLE leave_ledger_entry
    ADD CONSTRAINT leave_ledger_entry_only_a_reclassification_correlates CHECK (
        (entry_type = 'RECLASSIFICATION') = (correlation_id IS NOT NULL));

CREATE INDEX leave_ledger_entry_correlated ON leave_ledger_entry (correlation_id)
    WHERE correlation_id IS NOT NULL;

/* The story's third criterion, held rather than described: two entries, one person, one
   year, one request, two leave types, one reason, and nought days between them.

   Deferred, because the two rows are written one after the other and the pair is only
   ever whole at COMMIT. */

CREATE FUNCTION refuse_a_correlation_that_is_not_a_pair() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    sides INTEGER;
    moved leave_ledger_entry.days%TYPE;
    people INTEGER;
    years INTEGER;
    requests INTEGER;
    types INTEGER;
    reasons INTEGER;
BEGIN
    SELECT count(*), coalesce(sum(days), 0), count(DISTINCT employee_id),
           count(DISTINCT leave_year_id), count(DISTINCT leave_request_id),
           count(DISTINCT leave_type_id), count(DISTINCT reason)
      INTO sides, moved, people, years, requests, types, reasons
      FROM leave_ledger_entry
     WHERE correlation_id = NEW.correlation_id;

    IF sides <> 2 OR types <> 2 THEN
        RAISE EXCEPTION
            'Correlation % has % entries in % leave types, and a reclassification is two '
            'entries in two.', NEW.correlation_id, sides, types
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_correlates_a_pair',
                  HINT = 'Days moved out of one leave type and into another. One side on '
                         'its own is a balance credited or charged with nothing opposite '
                         'it. FR 32c, §8.6c.';
    END IF;

    IF moved <> 0 THEN
        RAISE EXCEPTION
            'Correlation % moves % days rather than nought.', NEW.correlation_id, moved
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_correlates_a_pair',
                  HINT = 'The days credited back are the days charged. A pair that does '
                         'not sum to nought has invented or lost entitlement between two '
                         'balances. FR 32c.';
    END IF;

    IF people <> 1 OR years <> 1 OR requests <> 1 OR reasons <> 1 THEN
        RAISE EXCEPTION
            'Correlation % spans % people, % leave years, % requests and % reasons.',
            NEW.correlation_id, people, years, requests, reasons
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_ledger_entry_correlates_a_pair',
                  HINT = 'One person’s days, in one leave year, out of one request, under '
                         'one reason — which is the sentence both sides are read by. '
                         'FR 27, FR 32c.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_ledger_entry_correlates_a_pair
    AFTER INSERT ON leave_ledger_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.correlation_id IS NOT NULL)
    EXECUTE FUNCTION refuse_a_correlation_that_is_not_a_pair();

-- ---------------------------------------------------- days credited back, per balance

/* `refuse_giving_back_more_than_was_taken()` scoped to one leave type and reading every
   movement rather than two named kinds.

   Unchanged for every row written before today — a request's entries were all of its own
   type — and correct for the two that are not: a reclassification credits the request's
   type and charges another, and neither may give back more than that balance ever spent
   on this leave. */

CREATE OR REPLACE FUNCTION refuse_giving_back_more_than_was_taken() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    given leave_ledger_entry.days%TYPE;
    taken leave_ledger_entry.days%TYPE;
BEGIN
    SELECT coalesce(sum(days) FILTER (WHERE days > 0), 0),
           coalesce(-sum(days) FILTER (WHERE days < 0), 0)
      INTO given, taken
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.leave_request_id
       AND leave_type_id = NEW.leave_type_id
       AND entry_type IN ('DEDUCTION', 'RECALCULATION', 'RECLASSIFICATION');

    IF given > taken THEN
        RAISE EXCEPTION
            'Leave request % has given back % days of that leave type and only ever took %.',
            NEW.leave_request_id, given, taken
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_back_no_more_than_it_took',
                  HINT = 'Days come back out of days that were spent. Crediting more than '
                         'that invents entitlement out of a leave request, against a '
                         'balance that will still reconcile. FR 27, FR 47.';
    END IF;

    RETURN NULL;
END
$$;

-- ------------------------------------------------------------ what moved, and on what

/* The record of the move itself: which days of which leave became sick leave, on whose
   certificate, and under which correlation. Its own table for the reason
   `leave_request_withdrawal` is one — it is a thing somebody did, and there is nowhere on
   `leave_request` for it to go. */

CREATE TABLE leave_request_reclassification (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The approved leave the days came out of. Its dates and its price are untouched. */
    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* What they became. Held to a type whose allowance may be exceeded — §8.6b's sick
       balance, which is the one that may go negative — by the trigger below. */
    to_leave_type_id BIGINT NOT NULL REFERENCES leave_type(id),

    /* Which days. Inside the request's own dates, by the trigger below, and each day
       moved at most once by the exclusion constraint. NFR DAT 03. */
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,

    /* What that period cost, counted on the request's own basis. FR 11, FR 24. */
    days INTEGER NOT NULL,

    /* One sentence, carried onto both ledger entries. FR 27, FR 32c. */
    reason TEXT NOT NULL,

    /* The two entries, findable from either end. */
    correlation_id UUID NOT NULL UNIQUE,

    /* The clean certificate this stands on. FR 13, NFR SEC 07, FR 32c. A real foreign
       key, so the file cannot be removed while the days it moved stand. */
    certificate_id BIGINT NOT NULL REFERENCES leave_request_attachment(id),

    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_reclassification_ends_after_it_starts CHECK (end_date >= start_date),
    CONSTRAINT leave_request_reclassification_moves_whole_days CHECK (days > 0),
    CONSTRAINT leave_request_reclassification_says_why CHECK (btrim(reason) <> ''),
    CONSTRAINT leave_request_reclassification_recorded_by_not_blank CHECK (btrim(recorded_by) <> ''),

    /* A day already moved is not moved again: the second would credit annual leave twice
       for one day and charge sick leave twice for it. Inclusive at both ends, as every
       other period in this schema is. FR 32c. */
    CONSTRAINT leave_request_reclassification_covers_each_day_once
        EXCLUDE USING GIST (
            leave_request_id WITH =,
            daterange(start_date, end_date, '[]') WITH &&)
);

CREATE INDEX leave_request_reclassification_by_request
    ON leave_request_reclassification (leave_request_id, id);

CREATE FUNCTION stamp_the_writer_on_a_reclassification() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.recorded_at := now();

    NEW.recorded_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.recorded_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_reclassification_records_its_writer
    BEFORE INSERT ON leave_request_reclassification
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_writer_on_a_reclassification();

/* Append only, against the owner as well as the application, as a withdrawal is. */

CREATE TRIGGER leave_request_reclassification_is_never_changed
    BEFORE UPDATE ON leave_request_reclassification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A reclassification is the record of days that moved between two balances. '
        'Changing one would move a figure in both with nothing to show for it. Where it '
        'was wrong, put each balance right with an adjustment and a reason. FR 27, FR 32c.'
    );

CREATE TRIGGER leave_request_reclassification_is_never_deleted
    BEFORE DELETE ON leave_request_reclassification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'Removing this would leave two ledger entries explaining themselves by a row that '
        'is not there. FR 27, FR 32c.'
    );

-- ------------------------------------------------- the facts a CHECK cannot reach

/* Four rules about other rows: the days are inside the leave, the type is one a balance
   may be exceeded in, it is not the type the leave already is, and the certificate is a
   clean file of the same person's. FR 13, FR 32c, §8.6b, NFR SEC 07. */

CREATE FUNCTION refuse_a_reclassification_that_does_not_fit() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    leave leave_request%ROWTYPE;
    moved_into leave_type%ROWTYPE;
    certificate leave_request_attachment%ROWTYPE;
BEGIN
    SELECT * INTO leave FROM leave_request WHERE id = NEW.leave_request_id;

    /* Unreachable: the foreign key has already found it. */
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.start_date < leave.start_date OR NEW.end_date > leave.end_date THEN
        RAISE EXCEPTION
            'Leave request % runs from % to %, and % to % is not inside it.',
            leave.id, leave.start_date, leave.end_date, NEW.start_date, NEW.end_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_stays_inside_the_leave',
                  HINT = 'Sickness outside agreed leave is a sick leave request of its '
                         'own. What this moves is days somebody was already booked off '
                         'for. FR 32c.';
    END IF;

    SELECT * INTO moved_into FROM leave_type WHERE id = NEW.to_leave_type_id;

    IF moved_into.id = leave.leave_type_id THEN
        RAISE EXCEPTION 'Leave request % is already % leave.', leave.id, moved_into.name
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_moves_between_two_types',
                  HINT = 'A move from a balance to itself is two entries that cancel out '
                         'and a day nobody can account for. FR 32c.';
    END IF;

    IF NOT moved_into.exceedable_with_document THEN
        RAISE EXCEPTION
            'Leave of type % is refused at its allowance rather than exceeded with a '
            'document, so days cannot be moved into it.', moved_into.name
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_moves_into_an_exceedable_type',
                  HINT = 'The days arrive whether or not the balance can afford them, so '
                         'the type has to be one that may go past its allowance on a '
                         'certificate. §8.6b, FR 32a.';
    END IF;

    SELECT * INTO certificate
      FROM leave_request_attachment WHERE id = NEW.certificate_id;

    IF certificate.held_for_employee_id <> leave.employee_id THEN
        RAISE EXCEPTION 'Attachment % is not %’s.', certificate.id, leave.employee_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_stands_on_their_certificate',
                  HINT = 'The certificate is the account of this person being unwell. '
                         'FR 13, FR 32c.';
    END IF;

    IF certificate.scan_status <> 'CLEAN' THEN
        RAISE EXCEPTION 'Attachment % is %, not CLEAN.', certificate.id, certificate.scan_status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_stands_on_a_clean_certificate',
                  HINT = 'A file nothing has cleared cannot let leave through. Wait for '
                         'the scan. NFR SEC 07, FR 13.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_reclassification_fits_the_leave
    BEFORE INSERT ON leave_request_reclassification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_reclassification_that_does_not_fit();

/* And the days it says it moved are days the ledger moved. Deferred: the entries and this
   row are written in one transaction, in either order. */

CREATE FUNCTION refuse_a_reclassification_the_ledger_does_not_show() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    leave leave_request%ROWTYPE;
    credited leave_ledger_entry.days%TYPE;
    charged leave_ledger_entry.days%TYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request_reclassification WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO leave FROM leave_request WHERE id = NEW.leave_request_id;

    SELECT coalesce(sum(days) FILTER (WHERE leave_type_id = leave.leave_type_id), 0),
           coalesce(-sum(days) FILTER (WHERE leave_type_id = NEW.to_leave_type_id), 0)
      INTO credited, charged
      FROM leave_ledger_entry
     WHERE correlation_id = NEW.correlation_id;

    IF credited <> NEW.days OR charged <> NEW.days THEN
        RAISE EXCEPTION
            'Reclassification % says % days moved; the ledger credits % and charges %.',
            NEW.id, NEW.days, credited, charged
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_reclassification_moves_its_days',
                  HINT = 'The ledger is the truth, so a record of a move that the ledger '
                         'does not show is a sentence about days that never went '
                         'anywhere. FR 27, FR 32c.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_reclassification_moves_its_days
    AFTER INSERT ON leave_request_reclassification
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_reclassification_the_ledger_does_not_show();

-- ----------------------------------------------------------- one more piece of news

/* FR 59's list gains the move. Not `LEAVE_AMENDED`: nothing came off the books, and what
   the person needs told is that a fortnight they spent unwell is back. */

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING',
                  'LEAVE_RECLASSIFIED'));

-- ---------------------------------------------------------------------- privileges

/* SELECT and INSERT, as the ledger holds them and for the same reason: the record of a
   move is written once and never put right. No UPDATE and no DELETE. */

GRANT SELECT, INSERT ON leave_request_reclassification TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS leave_request_reclassification_moves_its_days
    ON leave_request_reclassification;
DROP TRIGGER IF EXISTS leave_request_reclassification_fits_the_leave
    ON leave_request_reclassification;
DROP TRIGGER IF EXISTS leave_request_reclassification_is_never_deleted
    ON leave_request_reclassification;
DROP TRIGGER IF EXISTS leave_request_reclassification_is_never_changed
    ON leave_request_reclassification;
DROP TRIGGER IF EXISTS leave_request_reclassification_records_its_writer
    ON leave_request_reclassification;

DROP FUNCTION IF EXISTS refuse_a_reclassification_the_ledger_does_not_show();
DROP FUNCTION IF EXISTS refuse_a_reclassification_that_does_not_fit();
DROP FUNCTION IF EXISTS stamp_the_writer_on_a_reclassification();

DROP TABLE IF EXISTS leave_request_reclassification;

DROP TRIGGER IF EXISTS leave_ledger_entry_correlates_a_pair ON leave_ledger_entry;
DROP FUNCTION IF EXISTS refuse_a_correlation_that_is_not_a_pair();

/* The movements go with the column that explained them: a reclassification left standing
   without its correlation is a credit and a charge that no longer name each other. Both
   sides go, so no balance is left half corrected.

   The rule against removing an entry comes off for this and goes straight back, which is
   the deliberate act with a written reason FR 27 asks for. The cache is rebuilt by hand
   after, because `leave_ledger_entry_keeps_the_balance_in_step` fires on INSERT alone and a
   balance nothing recomputed would keep days the ledger no longer shows. */

DROP TRIGGER IF EXISTS leave_ledger_entry_is_never_deleted ON leave_ledger_entry;

WITH removed AS (
    DELETE FROM leave_ledger_entry
     WHERE entry_type = 'RECLASSIFICATION'
    RETURNING employee_id, leave_type_id, leave_year_id
)
SELECT rebuild_one_balance_from_the_ledger(employee_id, leave_type_id, leave_year_id)
  FROM (SELECT DISTINCT employee_id, leave_type_id, leave_year_id FROM removed) AS touched;

CREATE TRIGGER leave_ledger_entry_is_never_deleted
    BEFORE DELETE ON leave_ledger_entry
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A ledger entry is never removed. Days that moved, moved; a balance that '
        'no longer explains itself is worse than one that is wrong. Post a '
        'compensating ADJUSTMENT naming this row instead. FR 27.'
    );

DROP INDEX IF EXISTS leave_ledger_entry_correlated;

ALTER TABLE leave_ledger_entry
    DROP CONSTRAINT IF EXISTS leave_ledger_entry_only_a_reclassification_correlates;

ALTER TABLE leave_ledger_entry DROP COLUMN correlation_id;

/* Back to the body the withdrawal migration left, which named two kinds and no type. */
CREATE OR REPLACE FUNCTION refuse_giving_back_more_than_was_taken() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    given leave_ledger_entry.days%TYPE;
    taken leave_ledger_entry.days%TYPE;
BEGIN
    SELECT coalesce(sum(days), 0) INTO given
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.leave_request_id
       AND entry_type = 'RECALCULATION';

    SELECT coalesce(-sum(days), 0) INTO taken
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.leave_request_id
       AND entry_type = 'DEDUCTION';

    IF given > taken THEN
        RAISE EXCEPTION
            'Leave request % has given back % days and only ever took %.',
            NEW.leave_request_id, given, taken
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_back_no_more_than_it_took',
                  HINT = 'Days come back out of days that were spent. Crediting more than '
                         'that invents entitlement out of a leave request, against a '
                         'balance that will still reconcile. FR 27, FR 47.';
    END IF;

    RETURN NULL;
END
$$;

CREATE OR REPLACE VIEW what_the_ledger_says AS
SELECT
    employee_id,
    leave_type_id,
    leave_year_id,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('GRANT', 'LAPSE')), 0) AS entitled,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
        AS carried_over,
    coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
    coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0) AS taken,
    coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
        FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0) AS pending
FROM leave_ledger_entry
GROUP BY employee_id, leave_type_id, leave_year_id;

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_only_a_request_certifies;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_only_a_request_certifies CHECK (
    certified_days = 0
    OR entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'));

ALTER TABLE leave_ledger_entry
    DROP CONSTRAINT leave_ledger_entry_request_movements_name_a_request;

ALTER TABLE leave_ledger_entry
    ADD CONSTRAINT leave_ledger_entry_request_movements_name_a_request CHECK (
        (entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'))
        = (leave_request_id IS NOT NULL)
    );

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_requests_move_whole_days;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_requests_move_whole_days CHECK (
    entry_type NOT IN ('RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION')
    OR days = trunc(days)
);

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_sign_matches_the_type;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_sign_matches_the_type CHECK (
    CASE entry_type
        WHEN 'GRANT'         THEN days > 0
        WHEN 'CARRY_FORWARD' THEN days > 0
        WHEN 'RELEASE'       THEN days > 0
        WHEN 'RECALCULATION' THEN days > 0
        WHEN 'RESERVATION'   THEN days < 0
        WHEN 'DEDUCTION'     THEN days < 0
        WHEN 'EXPIRY'        THEN days < 0
        WHEN 'LAPSE'         THEN days < 0
        WHEN 'ADJUSTMENT'    THEN days <> 0
    END
);

ALTER TABLE leave_ledger_entry DROP CONSTRAINT leave_ledger_entry_type_known;

ALTER TABLE leave_ledger_entry ADD CONSTRAINT leave_ledger_entry_type_known CHECK (
    entry_type IN (
        'GRANT', 'CARRY_FORWARD', 'ADJUSTMENT', 'EXPIRY', 'LAPSE',
        'RESERVATION', 'DEDUCTION', 'RELEASE', 'RECALCULATION'));

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

DROP TRIGGER IF EXISTS notification_is_never_deleted ON notification;

DELETE FROM notification WHERE event = 'LEAVE_RECLASSIFIED';

CREATE TRIGGER notification_is_never_deleted
    BEFORE DELETE ON notification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A notice is never removed. What somebody was told about their leave, and when, is '
        'half of every dispute about whether they knew — and the other half is the request, '
        'which is never deleted either. Mark it read. FR 59.'
    );

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING'));
