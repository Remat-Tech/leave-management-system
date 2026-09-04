-- Up Migration

-- Saving a request and finishing it later. FR 19, §6. LMS 302.
--
-- A draft is a table rather than a `DRAFT` status because every rule on `leave_request`
-- is a rule about a request that has been made, and a draft is exempt from all of them:
-- it holds no days, has no price, may have no dates, is freely edited, blocks no
-- calendar, sits at no desk, and is thrown away. `TRANSITIONS` is untouched — the move
-- this story brings is into `SUBMITTED` from outside the table.
--
-- Not priced, not counted, not checked against a balance or a leave year or leave
-- already booked. Those belong to submission, which is the first criterion.

-- --------------------------------------------------------------- the unfinished form

/* A leave request somebody has started and not finished. FR 19.

   FR 10's four fields, every one nullable except whose it is. The other eight columns of
   `leave_request` are derived at submission or are facts about a workflow this row is
   not in. */

CREATE TABLE leave_request_draft (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    employee_id BIGINT NOT NULL REFERENCES employee(id),

    /* A real foreign key though the column is nullable: a draft naming a kind of leave
       names one that exists. A type retired since is refused at submission. FR 21. */
    leave_type_id BIGINT REFERENCES leave_type(id),

    /* DATE, as every calendar date here is, and absent independently. NFR DAT 03. */
    start_date DATE,
    end_date DATE,

    /* Optional, where `leave_request.reason` is mandatory: a draft has no approver to
       decide on it. FR 10. */
    reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* What "finish it later" is ordered by. */
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Unfinished is an absent date; the tenth to the third is a mistake worth naming now
       rather than at submission. */
    CONSTRAINT leave_request_draft_ends_after_it_starts CHECK (
        start_date IS NULL OR end_date IS NULL OR end_date >= start_date),

    /* Absent and blank are one state, and only one of them can be answered. */
    CONSTRAINT leave_request_draft_reason_not_blank CHECK (
        reason IS NULL OR btrim(reason) <> '')
);

/* One person's drafts, the one they were last working on first. */
CREATE INDEX leave_request_draft_by_employee
    ON leave_request_draft (employee_id, updated_at DESC);

-- ------------------------------------------------- and it stays the person's own

/* A draft never changes hands. FR 19.

   `leave_request_says_what_it_said` freezes `employee_id` on a request along with
   everything else; this table freezes nothing else on purpose, so the one column that
   must not move says so itself. It is the whole of who may read a draft: `draftPolicy`
   admits the owner and nobody else. */

CREATE FUNCTION refuse_moving_a_draft_to_somebody_else() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
        RAISE EXCEPTION
            'Leave request draft % belongs to employee %, not %.',
            OLD.id, OLD.employee_id, NEW.employee_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_draft_stays_with_whose_it_is',
                  HINT = 'A draft is leave nobody has asked for, and only the person '
                         'planning it may read one. Start a draft of your own. FR 19.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_draft_stays_with_whose_it_is
    BEFORE UPDATE ON leave_request_draft
    FOR EACH ROW
    EXECUTE FUNCTION refuse_moving_a_draft_to_somebody_else();

-- --------------------------------------------------------------- maintenance

/* set_updated_at() reused. It is the column the draft list is ordered by. */

CREATE TRIGGER leave_request_draft_set_updated_at
    BEFORE UPDATE ON leave_request_draft
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

/* Deliberately no audit trigger, and `AUDITED_ENTITIES` must not gain this table: an
   audited draft is a log of the contents of everything anybody discarded, which is the
   one thing a draft exists not to be. NFR AUD 01. */

-- ---------------------------------------------------------------- privileges

/* A draft is edited and thrown away, which is the second criterion. Both grants are
   explicit; the column that must not move is held by the trigger above rather than by a
   column list, as event-based-entitlement-grants argued. */

GRANT UPDATE, DELETE ON leave_request_draft TO lms_app;

-- Down Migration

-- Drafts are lost and nothing else is. Nothing references this table, and a request that
-- came out of a draft is a `leave_request` like any other.

DROP TRIGGER IF EXISTS leave_request_draft_set_updated_at ON leave_request_draft;
DROP TRIGGER IF EXISTS leave_request_draft_stays_with_whose_it_is ON leave_request_draft;

DROP INDEX IF EXISTS leave_request_draft_by_employee;

DROP TABLE IF EXISTS leave_request_draft;

DROP FUNCTION IF EXISTS refuse_moving_a_draft_to_somebody_else();
