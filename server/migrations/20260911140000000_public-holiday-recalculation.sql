-- Up Migration

-- A public holiday declared inside leave somebody already had agreed. FR 25, §8.8. LMS 508.
--
-- The entry type has been in the ledger since immutable-leave-ledger and had one writer,
-- FR 47's withdrawal. This is the second and the one it was named for: a `RECALCULATION`
-- crediting the difference between what the leave cost and what it costs now.
--
-- The request keeps its dates and its price, as it does under a reclassification. What the
-- gazette changed is recorded beside it.

-- --------------------------------------------------------- what a holiday credited back

/* One row per request per holiday. Its own table for the reason `leave_request_withdrawal`
   and `leave_request_reclassification` are: it is a thing somebody did, on a day, and
   there is nowhere on `leave_request` for it to go. */

CREATE TABLE leave_request_recalculation (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The agreed leave the day fell inside. Untouched by this. */
    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* The day the gazette declared late. */
    holiday_id BIGINT NOT NULL REFERENCES holiday(id),

    /* Which day that was when the credit was given. Frozen here rather than read back
       through the holiday, so moving the row later cannot rewrite what was credited.
       NFR DAT 03. */
    holiday_date DATE NOT NULL,

    /* The difference: what the leave cost, less what it costs now. FR 24, FR 25. */
    days INTEGER NOT NULL,

    /* FR 27. The sentence the ledger entry carries. */
    reason TEXT NOT NULL,

    /* The credit itself. One entry, one recalculation, either findable from the other. */
    ledger_entry_id BIGINT NOT NULL UNIQUE REFERENCES leave_ledger_entry(id),

    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_recalculation_credits_whole_days CHECK (days > 0),
    CONSTRAINT leave_request_recalculation_says_why CHECK (btrim(reason) <> ''),
    CONSTRAINT leave_request_recalculation_recorded_by_not_blank
        CHECK (btrim(recorded_by) <> ''),

    /* The story's idempotence, and the reason HR may press the button twice. A second
       credit for one holiday would give a day back that was only ever charged once. */
    CONSTRAINT leave_request_recalculation_credits_a_holiday_once
        UNIQUE (leave_request_id, holiday_id)
);

CREATE INDEX leave_request_recalculation_by_holiday
    ON leave_request_recalculation (holiday_id, id);

CREATE FUNCTION stamp_the_writer_on_a_recalculation() RETURNS trigger
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

CREATE TRIGGER leave_request_recalculation_records_its_writer
    BEFORE INSERT ON leave_request_recalculation
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_writer_on_a_recalculation();

/* Append only, as every record of a movement here is. */

CREATE TRIGGER leave_request_recalculation_is_never_changed
    BEFORE UPDATE ON leave_request_recalculation
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A recalculation is the record of a day a balance got back. Changing one would move '
        'a figure with nothing to show for it. Where it was wrong, put the balance right '
        'with an adjustment and a reason. FR 25, FR 27.'
    );

CREATE TRIGGER leave_request_recalculation_is_never_deleted
    BEFORE DELETE ON leave_request_recalculation
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'Removing this would leave a ledger entry explaining itself by a row that is not '
        'there. FR 25, FR 27.'
    );

-- ------------------------------------------------- the facts a CHECK cannot reach

/* Five rules about other rows. The second and third are the story's own criteria: the day
   has to be inside leave that was agreed, and the leave has to be of a kind that skips a
   holiday at all. A `CALENDAR_DAYS` type counts the day whatever the gazette says, so
   there is no difference to credit and there is nothing to record. §7.3, FR 21. */

CREATE FUNCTION refuse_a_recalculation_that_does_not_fit() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    leave leave_request%ROWTYPE;
    declared holiday%ROWTYPE;
    basis leave_type.counting_basis%TYPE;
    works BOOLEAN;
BEGIN
    SELECT * INTO leave FROM leave_request WHERE id = NEW.leave_request_id;

    /* Unreachable: the foreign key has already found it. */
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT * INTO declared FROM holiday WHERE id = NEW.holiday_id;

    IF declared.holiday_date <> NEW.holiday_date THEN
        RAISE EXCEPTION
            'Holiday % falls on %, and this credits %.',
            declared.name, declared.holiday_date, NEW.holiday_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_credits_the_gazetted_day',
                  HINT = 'The day credited back is the day the office was closed. FR 25.';
    END IF;

    IF NEW.holiday_date < leave.start_date OR NEW.holiday_date > leave.end_date THEN
        RAISE EXCEPTION
            'Leave request % runs from % to %, and % is not inside it.',
            leave.id, leave.start_date, leave.end_date, NEW.holiday_date
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_falls_inside_the_leave',
                  HINT = 'A holiday outside somebody’s leave costs them nothing and gives '
                         'them nothing back. FR 25.';
    END IF;

    IF leave.status <> 'APPROVED' THEN
        RAISE EXCEPTION 'Leave request % is %, not APPROVED.', leave.id, leave.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_credits_agreed_leave',
                  HINT = 'A request still being decided is holding its days rather than '
                         'having spent them, and it is priced again if it is ever '
                         'approved. There is nothing to credit back. FR 25.';
    END IF;

    SELECT counting_basis INTO basis FROM leave_type WHERE id = leave.leave_type_id;

    IF basis <> 'WORKING_DAYS' THEN
        RAISE EXCEPTION 'Leave request % is counted in %.', leave.id, basis
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_credits_a_working_day_type',
                  HINT = 'Leave counted in calendar days does not skip a public holiday, '
                         'so a new one changes nothing about what it cost. Maternity '
                         'leave is not shortened by Christmas. FR 21, FR 25, §7.3.';
    END IF;

    SELECT day.is_working_day INTO works
      FROM employee person
      JOIN work_pattern_day day ON day.work_pattern_id = person.work_pattern_id
     WHERE person.id = leave.employee_id
       AND day.day_of_week = EXTRACT(ISODOW FROM NEW.holiday_date);

    IF NOT coalesce(works, FALSE) THEN
        RAISE EXCEPTION '% is not a day % works.', NEW.holiday_date, leave.employee_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_credits_a_day_they_work',
                  HINT = 'A holiday landing on somebody’s rest day cost them nothing in '
                         'the first place — the pattern is asked before the calendar — so '
                         'there is nothing to give back. FR 23, FR 25, §7.3.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_recalculation_fits_the_leave
    BEFORE INSERT ON leave_request_recalculation
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_recalculation_that_does_not_fit();

/* And the entry it names is the credit it says it is: the right kind, against the same
   leave and the same balance, for the same number of days. The ledger is the truth, so a
   record of a credit the ledger does not show is a sentence about a day that never moved. */

CREATE FUNCTION refuse_a_recalculation_the_ledger_does_not_show() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    leave leave_request%ROWTYPE;
    credit leave_ledger_entry%ROWTYPE;
BEGIN
    SELECT * INTO leave FROM leave_request WHERE id = NEW.leave_request_id;
    SELECT * INTO credit FROM leave_ledger_entry WHERE id = NEW.ledger_entry_id;

    IF credit.entry_type <> 'RECALCULATION'
    OR credit.leave_request_id IS DISTINCT FROM NEW.leave_request_id
    OR credit.employee_id <> leave.employee_id
    OR credit.leave_type_id <> leave.leave_type_id
    OR credit.leave_year_id <> leave.leave_year_id
    OR credit.days <> NEW.days
    THEN
        RAISE EXCEPTION
            'Recalculation of leave request % says % days came back; entry % is a % of %.',
            NEW.leave_request_id, NEW.days, credit.id, credit.entry_type, credit.days
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_recalculation_credits_its_days',
                  HINT = 'The day is given back by a RECALCULATION against the balance the '
                         'leave was charged to, and this row is what explains it. FR 25, '
                         'FR 27.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_recalculation_credits_its_days
    BEFORE INSERT ON leave_request_recalculation
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_recalculation_the_ledger_does_not_show();

-- ------------------------------------------ and the day itself stops being editable

/* A holiday that has credited somebody is fixed where it is. The foreign key already
   refuses the DELETE; this refuses the move, which would otherwise leave the credit
   pointing at a row that now says a different day.

   Nothing here takes a credited day back off anybody, which is the reason this is a
   refusal rather than a cascade. Where the gazette really did withdraw the day, the
   correction is an adjustment per person with a reason on it. FR 27. */

CREATE FUNCTION refuse_moving_a_holiday_that_was_credited() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.holiday_date IS DISTINCT FROM OLD.holiday_date
    AND EXISTS (SELECT 1 FROM leave_request_recalculation WHERE holiday_id = OLD.id)
    THEN
        RAISE EXCEPTION
            'Holiday % has already been credited back into approved leave.', OLD.name
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'holiday_stays_where_it_was_credited',
                  HINT = 'The days are in people’s balances against this date. Moving it '
                         'would leave every credit explaining itself by a day that is no '
                         'longer there. Put each balance right with an adjustment instead. '
                         'FR 25, FR 27.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER holiday_stays_where_it_was_credited
    BEFORE UPDATE ON holiday
    FOR EACH ROW
    EXECUTE FUNCTION refuse_moving_a_holiday_that_was_credited();

-- ----------------------------------------------------------- one more piece of news

/* FR 59's list gains the credit. Not `LEAVE_AMENDED`: no leave came off the books and
   nobody agreed to anything. A day everybody had off stopped being charged for. */

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING',
                  'LEAVE_RECLASSIFIED', 'LEAVE_RECALCULATED'));

-- ---------------------------------------------------------------------- privileges

/* SELECT and INSERT, as the ledger and the reclassification hold them. */

GRANT SELECT, INSERT ON leave_request_recalculation TO lms_app;

-- Down Migration

DROP TRIGGER IF EXISTS holiday_stays_where_it_was_credited ON holiday;
DROP FUNCTION IF EXISTS refuse_moving_a_holiday_that_was_credited();

DROP TRIGGER IF EXISTS leave_request_recalculation_credits_its_days
    ON leave_request_recalculation;
DROP TRIGGER IF EXISTS leave_request_recalculation_fits_the_leave
    ON leave_request_recalculation;
DROP TRIGGER IF EXISTS leave_request_recalculation_is_never_deleted
    ON leave_request_recalculation;
DROP TRIGGER IF EXISTS leave_request_recalculation_is_never_changed
    ON leave_request_recalculation;
DROP TRIGGER IF EXISTS leave_request_recalculation_records_its_writer
    ON leave_request_recalculation;

DROP FUNCTION IF EXISTS refuse_a_recalculation_the_ledger_does_not_show();
DROP FUNCTION IF EXISTS refuse_a_recalculation_that_does_not_fit();
DROP FUNCTION IF EXISTS stamp_the_writer_on_a_recalculation();

/* The credits go with the table that explained them, and the cache is rebuilt by hand
   after: `leave_ledger_entry_keeps_the_balance_in_step` fires on INSERT alone, so a
   balance nothing recomputed would keep days the ledger no longer shows.

   Only the entries this table names. FR 47's withdrawals write the same entry type and
   are nothing to do with this migration. */

DROP TRIGGER IF EXISTS leave_ledger_entry_is_never_deleted ON leave_ledger_entry;

WITH removed AS (
    DELETE FROM leave_ledger_entry
     WHERE id IN (SELECT ledger_entry_id FROM leave_request_recalculation)
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

DROP TABLE IF EXISTS leave_request_recalculation;

ALTER TABLE notification DROP CONSTRAINT notification_event_known;

DROP TRIGGER IF EXISTS notification_is_never_deleted ON notification;

DELETE FROM notification WHERE event = 'LEAVE_RECALCULATED';

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
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING',
                  'LEAVE_RECLASSIFIED'));
