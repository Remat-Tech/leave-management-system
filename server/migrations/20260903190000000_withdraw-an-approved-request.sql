-- Up Migration

-- Asking for approved leave to be taken off the books, and HR answering. FR 47, §6, §8.2.
-- LMS 324.
--
-- `APPROVED` has had no row out of it since LMS 306, which said why: the days are taken
-- rather than held, so "taking agreed leave off the books is HR putting the days back as a
-- correction". The correction is a `RECALCULATION` — the entry type immutable-leave-ledger
-- listed with no writer — so nothing new arrives in `leave_ledger_entry_type_known`.
--
-- **Two acts, not one.** The person asks and HR answers, which is a fact about two people
-- and two moments and has nowhere to live on `leave_request`. So it is a table, for the
-- reason `leave_request_decision` is one.
--
-- **What HR's answer does depends on the calendar, not on which button they press.**
--
--   | | Leave has not started | Leave has started |
--   |---|---|---|
--   | the act | `WITHDRAW_APPROVED` | `AMEND` |
--   | the request | ends, `WITHDRAWN` | stands, `APPROVED` |
--   | the ledger | a `RECALCULATION` of everything it took | a `RECALCULATION` of what is left |
--   | a reason | optional | **required** |
--
-- `leave_request_says_what_it_said` is untouched: leave that has begun happened, in part, so
-- the dates and the day count stand and the difference comes back as a compensating
-- movement with HR's sentence on it.
--
-- ## What each rule covers
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_withdrawal_action_known` | an act nothing can perform | which act was legitimate on this request |
--   | `leave_request_withdrawal_says_why` | an amendment or a refusal with nothing said | one whose sentence is beside the point |
--   | `leave_request_withdrawal_answer_names_its_ask` | an answer to nothing, and an ask that claims to answer something | whether the two belong to one request |
--   | `leave_request_withdrawal_answers_the_same_request` | an answer naming another request's ask, or naming an answer | nothing; it is the backstop |
--   | `leave_request_withdrawal_answered_once` | two answers to one ask | two asks, which the rule below holds |
--   | `leave_request_is_asked_to_withdraw_once_at_a_time` | a second ask while one is unanswered | asking again after an answer, which is legitimate |
--   | `leave_request_gives_its_days_back` | an ending that gave nothing back, whichever state it ended from | TRUNCATE |
--   | `leave_request_withdrawn_from_approved_was_asked_for` | agreed leave taken off the books with nobody's ask and nobody's answer behind it | whether the ask was a good one |
--   | `leave_request_gives_back_no_more_than_it_took` | a request credited more days than it ever spent | a request that gave back less, which is what an amendment is |

-- ------------------------------------------------- the ask, and what HR answered

CREATE TABLE leave_request_withdrawal (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The request this is about. A real foreign key, for the reason
       `leave_request_decision.leave_request_id` is one: an ask about nothing is not an ask.
       ON DELETE is absent because `leave_request_is_never_deleted` refuses the delete this
       would cascade from. */
    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* Which of the four acts this row is. The domain's `WITHDRAWAL_ACTIONS`, read back out
       of `pg_constraint` by the integration suite so neither can be extended alone. Four
       values rather than a flag, for the reason `leave_request_decision_action_known` gives. */
    action VARCHAR(20) NOT NULL,

    /* Why. The employee's account on an ask, HR's on an amendment or a refusal, and optional
       on the one act that needs none. Free text, the latitude
       `leave_request_decision.comment` is given. */
    reason TEXT,

    /* The ask this answers, NULL on an ask itself. The shape
       `leave_request_decision.overrides_decision_id` has, and a real foreign key for the same
       reason: HR's sentence is read beside the employee's. */
    answers_id BIGINT REFERENCES leave_request_withdrawal(id),

    /* Who and when, stamped by the trigger below and never supplied by the writer. */
    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_withdrawal_action_known CHECK (
        action IN ('ASK_TO_WITHDRAW', 'WITHDRAW_APPROVED', 'AMEND', 'REFUSE_WITHDRAWAL')),

    /* An implication rather than an equivalence: FR 47's third criterion plus FR 39's
       asymmetry. Three of the four say why; agreeing to take leave that has not started off
       the books needs no explanation of the yes. */
    CONSTRAINT leave_request_withdrawal_says_why CHECK (
        action = 'WITHDRAW_APPROVED' OR reason IS NOT NULL),

    /* And a reason that is there is something. */
    CONSTRAINT leave_request_withdrawal_reason_not_blank CHECK (
        reason IS NULL OR btrim(reason) <> ''),

    /* An equivalence, the shape `leave_request_decision_override_names_what_it_reverses`
       has. */
    CONSTRAINT leave_request_withdrawal_answer_names_its_ask CHECK (
        (action <> 'ASK_TO_WITHDRAW') = (answers_id IS NOT NULL)),

    CONSTRAINT leave_request_withdrawal_recorded_by_not_blank CHECK (
        btrim(recorded_by) <> '')
);

/* Everything one request has collected, oldest first. */
CREATE INDEX leave_request_withdrawal_by_request
    ON leave_request_withdrawal (leave_request_id, id);

/* An ask is answered once. */
CREATE UNIQUE INDEX leave_request_withdrawal_answered_once
    ON leave_request_withdrawal (answers_id)
    WHERE answers_id IS NOT NULL;

-- ------------------------------------------- who asked, or answered, and when

/* The same three lines `stamp_the_decider_on_a_decision()` writes, against three differently
   named columns. */

CREATE FUNCTION stamp_the_writer_on_a_withdrawal() RETURNS trigger
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

CREATE TRIGGER leave_request_withdrawal_records_its_writer
    BEFORE INSERT ON leave_request_withdrawal
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_writer_on_a_withdrawal();

-- ------------------------------------------- and neither is ever rewritten

/* Append only, against the owner as well as the application, exactly as a decision is. Not
   audited for the same reason: a row that can never change is already its own history, so
   `AUDITED_ENTITIES` must not gain this table. */

CREATE TRIGGER leave_request_withdrawal_is_never_changed
    BEFORE UPDATE ON leave_request_withdrawal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'An ask to withdraw leave, and the answer to it, are records of things people did. '
        'Editing one afterwards would rewrite what somebody asked for or what they were '
        'told. If it was put badly, ask again once it has been answered. FR 47.'
    );

CREATE TRIGGER leave_request_withdrawal_is_never_deleted
    BEFORE DELETE ON leave_request_withdrawal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'Agreed leave that came off the books did so because somebody asked and somebody '
        'answered, and removing either leaves days back in a balance with nothing to say '
        'who put them there. FR 27, FR 47.'
    );

-- ---------------------------------- an answer answers an ask, on this request

/* A foreign key says the row exists and cannot say whose it is. A trigger rather than a
   CHECK, because a CHECK may not read another row. */

CREATE FUNCTION refuse_an_answer_to_the_wrong_ask() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    asked leave_request_withdrawal%ROWTYPE;
BEGIN
    IF NEW.answers_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO asked
      FROM leave_request_withdrawal
     WHERE id = NEW.answers_id;

    /* Unreachable: the foreign key found the row and nothing deletes one. Answered anyway,
       because a missing row makes every comparison below NULL. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF asked.action <> 'ASK_TO_WITHDRAW' THEN
        RAISE EXCEPTION
            'Withdrawal % is a %, and an answer answers an ask.', asked.id, asked.action
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_withdrawal_answers_the_same_request',
                  HINT = 'HR answers the person who asked for their leave to be taken off '
                         'the books. An answer to an answer is a conversation with itself. '
                         'FR 47.';
    END IF;

    IF asked.leave_request_id <> NEW.leave_request_id THEN
        RAISE EXCEPTION
            'Withdrawal % is about leave request %, not %.',
            asked.id, asked.leave_request_id, NEW.leave_request_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_withdrawal_answers_the_same_request',
                  HINT = 'The answer to an ask is shown beside the ask, so a pointer to '
                         'another request would read somebody else’s sentence out against '
                         'the wrong leave. FR 47.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_withdrawal_answers_the_same_request
    AFTER INSERT ON leave_request_withdrawal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_answer_to_the_wrong_ask();

-- ------------------------------------- and one ask is open at a time, not one ever

/* Asking twice while HR has not answered leaves two rows for one answer to choose between.
   Asking again *after* an answer is legitimate, so this is not a unique index: "at most one
   row with no answer" is a statement about the absence of another row. */

CREATE FUNCTION refuse_a_second_open_ask() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    open_ask BIGINT;
BEGIN
    IF NEW.action <> 'ASK_TO_WITHDRAW' THEN
        RETURN NULL;
    END IF;

    SELECT ask.id INTO open_ask
      FROM leave_request_withdrawal ask
     WHERE ask.leave_request_id = NEW.leave_request_id
       AND ask.action = 'ASK_TO_WITHDRAW'
       AND ask.id <> NEW.id
       AND NOT EXISTS (
            SELECT 1
              FROM leave_request_withdrawal answer
             WHERE answer.answers_id = ask.id)
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'Leave request % has already been asked to be withdrawn, in ask %.',
            NEW.leave_request_id, open_ask
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_is_asked_to_withdraw_once_at_a_time',
                  HINT = 'HR has not answered the first one yet. Two asks for one piece of '
                         'leave give HR two sentences and one decision, and whichever they '
                         'answer the other is left open for ever. FR 47.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_is_asked_to_withdraw_once_at_a_time
    AFTER INSERT ON leave_request_withdrawal
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_second_open_ask();

-- ------------------------------------------- a request may now leave APPROVED

/* `refuse_an_impossible_transition()`, widened by exactly one move: APPROVED may become
   WITHDRAWN and nothing else. Not CANCELLED, which is HR's adjustment, and not REFUSED,
   which is FR 44's `OVERTURN_APPROVAL` and happens before a request reaches here. */

CREATE OR REPLACE FUNCTION refuse_an_impossible_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status IN ('WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % was already %, and a request ends once.', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'The days this request held have already been given back. '
                         'Moving it again would either release them twice or '
                         'rewrite what happened to somebody’s leave. If the days are '
                         'wanted, ask for them again. FR 26, FR 27.';
    END IF;

    /* FR 47. It returns rather than falling through, because the list below is a list of
       destinations for a request still being decided. */
    IF OLD.status = 'APPROVED' THEN
        IF NEW.status <> 'WITHDRAWN' THEN
            RAISE EXCEPTION
                'Leave request % has been approved and cannot become %.', OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'Leave that every desk has agreed to is not turned down and is '
                             'not unwound: the person asks for it to be withdrawn and HR '
                             'agrees, which puts the days back as a correction. A mistake '
                             'on an approved request is an adjustment with a reason on it. '
                             'FR 26, FR 27, FR 47.';
        END IF;

        RETURN NEW;
    END IF;

    /* FR 48b. Nothing was decided, so the only ways out are the two endings and going back
       to an approver. Reaching APPROVED or REFUSED from here would be a decision nobody
       made at a desk nobody could fill. */
    IF OLD.status = 'UNROUTABLE' THEN
        IF NEW.status NOT IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED') THEN
            RAISE EXCEPTION
                'Leave request % has nobody who can decide it and cannot become %.',
                OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'A request nobody could be found to decide has not been judged. '
                             'It may go back to an approver once there is one, be withdrawn '
                             'by the person who asked, or be cancelled by HR — and it may '
                             'not be approved or turned down by a desk that was never '
                             'filled. FR 48b.';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('APPROVED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled, '
                         'refused, or left with nobody who can decide it. §6.';
    END IF;

    RETURN NEW;
END
$$;

-- ------------------------- and an ending gives its days back, whichever way

/* `refuse_a_request_that_kept_its_days()`, now asking the question the ending's starting
   point decides: a RELEASE from a state that held a hold, a RECALCULATION from APPROVED,
   where the DEDUCTION spent it. Asking for "either" would let an ending write neither. */

CREATE OR REPLACE FUNCTION refuse_a_request_that_kept_its_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    /* The entry type that gives the days back, which the ending's starting point decides. */
    wanted TEXT := CASE WHEN OLD.status = 'APPROVED' THEN 'RECALCULATION' ELSE 'RELEASE' END;
    /* Typed as the column it sums, for the reason LMS 317 gives at the same line. */
    given leave_ledger_entry.days%TYPE;
BEGIN
    /* The row may be gone by COMMIT — it cannot, but a constraint trigger fires anyway. */
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(sum(days), 0) INTO given
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.id AND entry_type = wanted;

    IF given = 0 THEN
        RAISE EXCEPTION 'Leave request % ended without giving its days back.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'A request that ends gives back what it was holding, in the same '
                         'transaction: a hold is released, and leave that had been agreed '
                         'is put back as a correction against the days it took. Days left '
                         'behind by a request that has ended are days nothing will ever '
                         'give back, and the balance is short with nothing to explain it. '
                         'FR 26, FR 47.';
    END IF;

    /* LMS 317's rule, and it holds for both entry types: a request that *ends* gives back
       everything. An amendment is legitimately partial and never reaches here, because it
       leaves the request APPROVED and this fires only on an ending. */
    IF given <> NEW.days THEN
        RAISE EXCEPTION
            'Leave request % was holding % day(s) and gave back %.', NEW.id, NEW.days, given
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'A request that ends gives back everything it was holding, not '
                         'part of it. The days left behind are in nobody''s hands: the '
                         'request says it ended, the balance says they are still spoken '
                         'for, and both reconcile. Release the figure the request was '
                         'priced at — it has not moved since it was submitted. FR 26, '
                         'FR 43, FR 47.';
    END IF;

    RETURN NULL;
END
$$;

-- ------------------- and agreed leave comes off the books because somebody asked

/* The story's first criterion, held where no service can forget it, and the fifth of the
   family whose shape LMS 314 settled. Deferred for the reason all of them are: the answer
   names the request, so the request has to have moved first.

   `WHEN` keeps it to the one move it is about. A withdrawal out of `SUBMITTED` or
   `UNROUTABLE` is the person taking back leave nobody has agreed to, and needs no ask. */

CREATE FUNCTION refuse_agreed_leave_nobody_asked_to_withdraw() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM leave_request_withdrawal answer
          JOIN leave_request_withdrawal ask ON ask.id = answer.answers_id
         WHERE answer.leave_request_id = NEW.id
           AND answer.action = 'WITHDRAW_APPROVED'
    ) THEN
        RAISE EXCEPTION
            'Leave request % was approved and came off the books with nothing to say who '
            'asked for that or who agreed to it.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_withdrawn_from_approved_was_asked_for',
                  HINT = 'Agreed leave is taken back by the person asking and HR agreeing, '
                         'in the same transaction as the days going back. Leave that '
                         'vanished from somebody’s calendar with nobody named is the '
                         'corridor conversation the record exists to replace. FR 47.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_withdrawn_from_approved_was_asked_for
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.status = 'APPROVED' AND NEW.status = 'WITHDRAWN')
    EXECUTE FUNCTION refuse_agreed_leave_nobody_asked_to_withdraw();

-- ------------------------------- and nothing gives back more than it took

/* Two things write a `RECALCULATION`: FR 47's withdrawal of agreed leave, and FR 25's
   holiday falling inside it. Neither may give back more than the request spent — a request
   credited fifteen days that only took ten reconciles perfectly and is wrong by five.

   Deferred, because the two entry types may be written in either order. Summed rather than
   compared row by row, because an amendment is legitimately partial. */

CREATE FUNCTION refuse_giving_back_more_than_was_taken() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    /* The column's own type rather than a written-out one, so a widened ledger cannot
       silently truncate this comparison. */
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
                         'balance that adds up. FR 25, FR 27, FR 47.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_gives_back_no_more_than_it_took
    AFTER INSERT ON leave_ledger_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.entry_type = 'RECALCULATION')
    EXECUTE FUNCTION refuse_giving_back_more_than_was_taken();

-- ------------------------------------------------ what somebody is told about

/* FR 59's list gains the four events LMS 324 makes reachable. `WITHDRAWAL_ASKED` goes to
   HR, who has to answer it. `WITHDRAWAL_GRANTED` is not `WITHDRAWN`, whose message says
   "nobody has to approve anything for that to take effect". */

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED'));

-- ---------------------------------------------------------------- privileges

/* Read and insert, never UPDATE or DELETE — the terms every append-only table here has. */

GRANT SELECT, INSERT ON leave_request_withdrawal TO lms_app;


-- Down Migration

-- The order is the reverse of the up section: every rule that would refuse the unpicking
-- comes off before the rows are unpicked, and goes back afterwards.
--
-- **This rollback loses information and leaves some behind.** The asks and answers go with
-- the table. The requests stay `WITHDRAWN` and their `RECALCULATION` entries stay in the
-- ledger, because `leave_ledger_entry_is_never_deleted` refuses to remove one and a rollback
-- of a schema is not a claim that the days did not go back. Run it before agreed leave has
-- been withdrawn rather than after.

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

DELETE FROM notification
    WHERE event IN ('WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                    'WITHDRAWAL_REFUSED');

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE'));

DROP TRIGGER IF EXISTS leave_request_gives_back_no_more_than_it_took ON leave_ledger_entry;
DROP FUNCTION IF EXISTS refuse_giving_back_more_than_was_taken();

DROP TRIGGER IF EXISTS leave_request_withdrawn_from_approved_was_asked_for ON leave_request;
DROP FUNCTION IF EXISTS refuse_agreed_leave_nobody_asked_to_withdraw();

/* The two rules that were widened go back to the bodies LMS 306 and LMS 320 wrote. */

CREATE OR REPLACE FUNCTION refuse_a_request_that_kept_its_days() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    given leave_ledger_entry.days%TYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(sum(days), 0) INTO given
      FROM leave_ledger_entry
     WHERE leave_request_id = NEW.id AND entry_type = 'RELEASE';

    IF given = 0 THEN
        RAISE EXCEPTION 'Leave request % ended without giving its days back.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'Withdrawing, cancelling or refusing a request releases what '
                         'it was holding, in the same transaction. Days held by a '
                         'request that has ended are days nothing will ever give back, '
                         'and the balance is short with nothing to explain it. FR 26.';
    END IF;

    IF given <> NEW.days THEN
        RAISE EXCEPTION
            'Leave request % was holding % day(s) and gave back %.', NEW.id, NEW.days, given
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_gives_its_days_back',
                  HINT = 'A request that ends gives back everything it was holding, not '
                         'part of it. The days left behind are in nobody''s hands: the '
                         'request says it ended, the balance says they are still spoken '
                         'for, and both reconcile. Release the figure the request was '
                         'priced at — it has not moved since it was submitted. FR 26, '
                         'FR 43.';
    END IF;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION refuse_an_impossible_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status IN ('WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % was already %, and a request ends once.', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'The days this request held have already been given back. '
                         'Moving it again would either release them twice or '
                         'rewrite what happened to somebody’s leave. If the days are '
                         'wanted, ask for them again. FR 26, FR 27.';
    END IF;

    IF OLD.status = 'APPROVED' THEN
        RAISE EXCEPTION
            'Leave request % has been approved and cannot be moved from there.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'The days are taken rather than held, so there is no hold left '
                         'to release and none of withdrawing, refusing or cancelling '
                         'means anything here. Taking agreed leave off the books is HR '
                         'putting the days back as a correction. FR 26, FR 27.';
    END IF;

    IF OLD.status = 'UNROUTABLE' THEN
        IF NEW.status NOT IN ('SUBMITTED', 'WITHDRAWN', 'CANCELLED') THEN
            RAISE EXCEPTION
                'Leave request % has nobody who can decide it and cannot become %.',
                OLD.id, NEW.status
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'leave_request_moves_as_the_table_says',
                      HINT = 'A request nobody could be found to decide has not been judged. '
                             'It may go back to an approver once there is one, be withdrawn '
                             'by the person who asked, or be cancelled by HR — and it may '
                             'not be approved or turned down by a desk that was never '
                             'filled. FR 48b.';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.status NOT IN ('APPROVED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled, '
                         'refused, or left with nobody who can decide it. §6.';
    END IF;

    RETURN NEW;
END
$$;

/* And the table. DROP TABLE fires no row trigger, so `..._is_never_deleted` goes with it. */

DROP TRIGGER IF EXISTS leave_request_is_asked_to_withdraw_once_at_a_time
    ON leave_request_withdrawal;
DROP FUNCTION IF EXISTS refuse_a_second_open_ask();

DROP TRIGGER IF EXISTS leave_request_withdrawal_answers_the_same_request
    ON leave_request_withdrawal;
DROP FUNCTION IF EXISTS refuse_an_answer_to_the_wrong_ask();

DROP TABLE IF EXISTS leave_request_withdrawal;

DROP FUNCTION IF EXISTS stamp_the_writer_on_a_withdrawal();
