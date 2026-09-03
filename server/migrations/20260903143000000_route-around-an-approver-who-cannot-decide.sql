-- Up Migration

-- A request whose usual approver cannot decide it goes to somebody who can. FR 48, FR 48b,
-- FR 04, §8.6a, §6, §8. LMS 320.
--
-- LMS 319 refused the requester at four altitudes and left the reciprocal open: such a
-- request waited at a desk nobody could fill. This is the routing.
--
--   | Stage | Cannot be filled when | Goes to |
--   |---|---|---|
--   | `MANAGER` | the requester has no line manager — FR 04's root | `HR` |
--   | `HR` | every HR role is the requester's, or nobody's | `CEO` |
--   | `CEO` | the root is the requester, or there is no root | `HR` |
--
-- Neither of a pair available leaves the request `UNROUTABLE` with an alert. Nothing here
-- approves anything: a skipped stage is a stage nobody answered, and it is recorded as such.

-- ------------------------------------------------- the stages a request skipped

/* One row per stage another desk answered. FR 48b.

   A table rather than a column, for the reason `leave_request_decision` is one: the number
   of stages is configuration, so anything shaped by how many desks a chain has is rows.

   A stage that went *nowhere* is deliberately not recorded here — that is the `UNROUTABLE`
   status and the alert. Keeping it out is what lets a re-route reconsider the stage once
   somebody is at the desk, while a recorded skip stays settled. */

CREATE TABLE leave_request_routing (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* The desk the type's chain names, and the desk that answered it instead. The same
       three spellings as `leave_request.awaiting_approval_from`, and not a foreign key to
       `leave_type_approval_step` for the reason that column is not one. */
    stage VARCHAR(20) NOT NULL,
    routed_to VARCHAR(20) NOT NULL,

    /* Why, in the routing's own words. NFR USA 03. Free text, because it is what the person
       whose leave stopped and the officer who has to fix it both read. */
    because TEXT NOT NULL,

    /* Who and when, stamped by the trigger below rather than supplied. A writer who could
       name the recorder could record a skip under somebody else's name. */
    recorded_by TEXT NOT NULL,
    recorded_by_employee_id BIGINT REFERENCES employee(id),
    recorded_at TIMESTAMPTZ NOT NULL,

    /* Both closed lists, held in the domain as `APPROVER_ROLES`. */
    CONSTRAINT leave_request_routing_stage_known CHECK (
        stage IN ('MANAGER', 'HR', 'CEO')),

    CONSTRAINT leave_request_routing_desk_known CHECK (
        routed_to IN ('MANAGER', 'HR', 'CEO')),

    /* A stage that answered itself is not a skip. */
    CONSTRAINT leave_request_routing_goes_somewhere_else CHECK (stage <> routed_to),

    CONSTRAINT leave_request_routing_says_why CHECK (btrim(because) <> ''),

    CONSTRAINT leave_request_routing_recorded_by_not_blank CHECK (btrim(recorded_by) <> '')
);

/* And a stage is skipped once. Two writers reaching the same conclusion is one fact. */

CREATE UNIQUE INDEX leave_request_routing_once_per_stage
    ON leave_request_routing (leave_request_id, stage);

CREATE INDEX leave_request_routing_by_request
    ON leave_request_routing (leave_request_id, id);

/* The same three lines `stamp_the_decider_on_a_decision()` writes, against three differently
   named columns. */

CREATE FUNCTION stamp_the_recorder_on_a_routing() RETURNS trigger
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

CREATE TRIGGER leave_request_routing_records_its_recorder
    BEFORE INSERT ON leave_request_routing
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_recorder_on_a_routing();

/* Append only, on every connection. A skip that can be edited afterwards is an account of
   where a request went that says whatever the last person to look at it wanted. */

CREATE TRIGGER leave_request_routing_is_never_changed
    BEFORE UPDATE ON leave_request_routing
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A skipped stage is a record of where a request went and why. Editing it would '
        'rewrite the account the person whose leave it is has been given. FR 48b.'
    );

CREATE TRIGGER leave_request_routing_is_never_deleted
    BEFORE DELETE ON leave_request_routing
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A skipped stage is never removed. A request approved by fewer desks than its '
        'chain names, with nothing to say which was skipped or why, is a request nobody '
        'can explain. FR 48b.'
    );

-- ---------------------------------------------------------- the sixth status

/* Five values become six. The list is the domain's `REQUEST_STATUSES`, and the integration
   suite reads this constraint back out of `pg_constraint` and asserts the two agree.

   `UNROUTABLE` is neither pending nor an ending, and every list in the schema is asked about
   it separately:

     | | Does UNROUTABLE join it | Why |
     |---|---|---|
     | `leave_request_status_known` | yes | it is a state a request can be in |
     | `leave_request_never_overlaps` | yes | its RESERVATION still holds the days |
     | the endings in `refuse_an_impossible_transition()` | no | it gives nothing back |
     | `leave_request_waits_at_a_desk` | no | it waits on nobody, which is the whole of it | */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (
        status IN ('SUBMITTED', 'APPROVED', 'UNROUTABLE', 'WITHDRAWN', 'CANCELLED', 'REFUSED'));

/* And it blocks the calendar, for the reason APPROVED does: the days are out of the balance,
   so a second request for them would take them twice. */

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_never_overlaps;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_never_overlaps
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('SUBMITTED', 'APPROVED', 'UNROUTABLE'));

-- --------------------------------------- a request moves only where §6 says

/* `refuse_an_impossible_transition()` widened by two moves, and the pair is the story.

   **SUBMITTED may become UNROUTABLE**, which is where a decision leaves a request whose next
   stage has nobody to answer it. **UNROUTABLE may become SUBMITTED**, which is HR putting it
   back once somebody can — the one move in this schema that goes back into a live state, and
   it is legitimate precisely because nothing was decided.

   UNROUTABLE may also end: withdrawn by the person, cancelled by HR. It may not become
   APPROVED or REFUSED, because reaching either from there would be a decision nobody made. */

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

    /* FR 48b. Nothing was decided, so the only ways out are the two endings and going back
       to an approver. Reaching APPROVED or REFUSED from here would be a decision nobody
       made at a desk nobody could fill.

       It returns rather than falling through, because `SUBMITTED` is a destination no other
       state may reach — the check below is written as a list of destinations and would
       refuse the one move this branch exists to permit. */
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

-- --------------------------- and a stage that was skipped counts as answered

/* `refuse_an_approval_a_stage_never_gave()`, which asks that every stage of the type's chain
   has decided. FR 41, FR 44, FR 48b.

   A skipped stage has no decision and never will — that is what skipping it means — so
   without this the one request FR 48b exists to move would be the one that can never be
   approved. What is *not* weakened is the rule itself: a stage is answered by a decision or
   by a recorded skip, and a stage with neither still refuses the approval. */

CREATE OR REPLACE FUNCTION refuse_an_approval_a_stage_never_gave() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    unasked TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT string_agg(step.approver_role, ', ' ORDER BY step.step_order)
      INTO unasked
      FROM leave_type_approval_step step
     WHERE step.leave_type_id = NEW.leave_type_id
       AND NOT EXISTS (
            SELECT 1
              FROM leave_request_decision decision
             WHERE decision.leave_request_id = NEW.id
               AND decision.on_behalf_of = step.approver_role)
       /* FR 48b. Or skipped to a desk that did decide it. */
       AND NOT EXISTS (
            SELECT 1
              FROM leave_request_routing skip
             WHERE skip.leave_request_id = NEW.id
               AND skip.stage = step.approver_role);

    IF unasked IS NOT NULL THEN
        RAISE EXCEPTION
            'Leave request % was approved without %.', NEW.id, unasked
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_is_approved_by_every_stage',
                  HINT = 'Leave is agreed only once every stage of its type''s approval '
                         'chain has decided it, or has been recorded as skipped to a desk '
                         'that did. A request marked approved with a stage unasked tells '
                         'somebody their leave is agreed when it is not. FR 41, FR 44, '
                         'FR 48b.';
    END IF;

    RETURN NULL;
END
$$;

-- ------------------------ and a move at a desk still says who made it

/* `refuse_a_move_no_decision_explains()`, which now has a third kind of destination.

   A request that lands on UNROUTABLE was moved there by a desk that *did* decide — the
   decision is recorded, and there was simply nowhere to send it next — so it is judged
   exactly as APPROVED and REFUSED are, against any of the four verbs.

   Going back the other way is not a move at a desk at all: `OLD.awaiting_approval_from` is
   NULL on an unroutable request, so the WHEN clause does not fire and a re-route needs no
   decision. That is correct rather than a hole — nobody decided anything. */

CREATE OR REPLACE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT[] := CASE NEW.status
        WHEN 'REFUSED' THEN ARRAY['REFUSE', 'OVERTURN_APPROVAL']
        WHEN 'APPROVED' THEN ARRAY['APPROVE', 'OVERTURN_REJECTION']
        ELSE ARRAY['APPROVE', 'REFUSE', 'OVERTURN_REJECTION', 'OVERTURN_APPROVAL']
    END;
    latest leave_request_decision%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO latest
      FROM leave_request_decision
     WHERE leave_request_id = NEW.id
     ORDER BY id DESC
     LIMIT 1;

    IF NOT FOUND
       OR NOT (latest.action = ANY (expected))
       OR latest.on_behalf_of IS DISTINCT FROM OLD.awaiting_approval_from THEN
        RAISE EXCEPTION
            'Leave request % moved to % at the % desk without recording who decided it.',
            NEW.id, NEW.status, OLD.awaiting_approval_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_records_its_decision',
                  HINT = 'Deciding leave writes a decision naming the desk it was decided '
                         'at, in the same transaction as the status. A request that moved '
                         'with nothing to say who moved it or why is the corridor '
                         'conversation the record exists to replace. FR 39, FR 52, FR 44.';
    END IF;

    RETURN NULL;
END
$$;

DROP TRIGGER leave_request_records_its_decision ON leave_request;

CREATE CONSTRAINT TRIGGER leave_request_records_its_decision
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (
        OLD.awaiting_approval_from IS NOT NULL
        AND (
            (NEW.status IN ('APPROVED', 'REFUSED', 'UNROUTABLE')
                AND NEW.status IS DISTINCT FROM OLD.status)
            OR (NEW.status = 'SUBMITTED'
                AND NEW.awaiting_approval_from IS DISTINCT FROM OLD.awaiting_approval_from)
        )
    )
    EXECUTE FUNCTION refuse_a_move_no_decision_explains();

-- ------------------------------------------------------ one thing somebody was told

/* FR 59's list gains the alert. It goes to the person whose leave stopped and to everybody
   who could unstick it, which is what `notification.employee_id` was built to allow. */

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE'));

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT on the new table arrive from the default privileges of the
   restricted-application-role migration, which is the whole of what it needs. Nothing grants
   UPDATE or DELETE, so the two triggers above stop the honest mistake at a psql prompt and
   the privileges stop everything else. Restated here for legibility. */

GRANT SELECT, INSERT ON leave_request_routing TO lms_app;


-- Down Migration

-- The order is the reverse of the up section: every rule that would refuse the unpicking
-- comes off before the rows are unpicked, and goes back afterwards.
--
-- **Requests that stopped go back to the first desk of their type's chain**, which is where
-- a database that has forgotten how to route around an empty desk would have put them — and
-- is the "stuck and visible" LMS 319 settled for. No days move: the RESERVATION has held
-- them throughout. What is lost is the record of which stages were skipped and why.

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

DELETE FROM notification WHERE event = 'UNROUTABLE';

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED'));

DROP TRIGGER IF EXISTS leave_request_records_its_decision ON leave_request;

/* The transition rule comes off before the unroutable requests are moved, because putting
   them anywhere is exactly what it is about to stop permitting. */

DROP TRIGGER IF EXISTS leave_request_moves_as_the_table_says ON leave_request;

/* Back to being decided, at the first desk their type's chain names — read off
   `leave_type_approval_step` rather than written out, for the reason the LMS 314 migration
   read it: which desk a type starts at is data. No ledger entry, because no days moved. */

UPDATE leave_request request
   SET status = 'SUBMITTED',
       awaiting_approval_from = (
        SELECT step.approver_role
          FROM leave_type_approval_step step
         WHERE step.leave_type_id = request.leave_type_id
         ORDER BY step.step_order
         LIMIT 1)
 WHERE request.status = 'UNROUTABLE';

DO $$
DECLARE
    stranded INTEGER;
BEGIN
    SELECT count(*) INTO stranded
      FROM leave_request
     WHERE status = 'SUBMITTED' AND awaiting_approval_from IS NULL;

    IF stranded > 0 THEN
        RAISE EXCEPTION
            '% request(s) are for a leave type with no approval chain.', stranded
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Run ensure_statutory_approval_chains() to give every type its '
                         'chain, then run this rollback again. FR 38a.';
    END IF;
END
$$;

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_never_overlaps;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_never_overlaps
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('SUBMITTED', 'APPROVED'));

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_status_known;

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_status_known CHECK (
        status IN ('SUBMITTED', 'APPROVED', 'WITHDRAWN', 'CANCELLED', 'REFUSED'));

/* And the three functions go back to the bodies LMS 314 and LMS 318 wrote. They go back
   last, after every row they would have refused has moved. */

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

    IF NEW.status NOT IN ('APPROVED', 'WITHDRAWN', 'CANCELLED', 'REFUSED') THEN
        RAISE EXCEPTION
            'Leave request % cannot move from % to %.', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_moves_as_the_table_says',
                  HINT = 'A request being decided may be approved, withdrawn, cancelled '
                         'or refused, and nothing may move it back. §6.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_moves_as_the_table_says
    BEFORE UPDATE ON leave_request
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_impossible_transition();

CREATE OR REPLACE FUNCTION refuse_an_approval_a_stage_never_gave() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    unasked TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT string_agg(step.approver_role, ', ' ORDER BY step.step_order)
      INTO unasked
      FROM leave_type_approval_step step
     WHERE step.leave_type_id = NEW.leave_type_id
       AND NOT EXISTS (
            SELECT 1
              FROM leave_request_decision decision
             WHERE decision.leave_request_id = NEW.id
               AND decision.on_behalf_of = step.approver_role);

    IF unasked IS NOT NULL THEN
        RAISE EXCEPTION
            'Leave request % was approved without %.', NEW.id, unasked
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_is_approved_by_every_stage',
                  HINT = 'Leave is agreed only once every stage of its type''s approval '
                         'chain has decided it. A request marked approved with a stage '
                         'unasked tells somebody their leave is agreed when it is not, and '
                         'they book a flight on it. FR 41, FR 42, FR 44.';
    END IF;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT[] := CASE NEW.status
        WHEN 'REFUSED' THEN ARRAY['REFUSE', 'OVERTURN_APPROVAL']
        WHEN 'APPROVED' THEN ARRAY['APPROVE', 'OVERTURN_REJECTION']
        ELSE ARRAY['APPROVE', 'REFUSE', 'OVERTURN_REJECTION', 'OVERTURN_APPROVAL']
    END;
    latest leave_request_decision%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM leave_request WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;

    SELECT * INTO latest
      FROM leave_request_decision
     WHERE leave_request_id = NEW.id
     ORDER BY id DESC
     LIMIT 1;

    IF NOT FOUND
       OR NOT (latest.action = ANY (expected))
       OR latest.on_behalf_of IS DISTINCT FROM OLD.awaiting_approval_from THEN
        RAISE EXCEPTION
            'Leave request % moved to % at the % desk without recording who decided it.',
            NEW.id, NEW.status, OLD.awaiting_approval_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_records_its_decision',
                  HINT = 'Deciding leave writes a decision naming the desk it was decided '
                         'at, in the same transaction as the status. A request that moved '
                         'with nothing to say who moved it or why is the corridor '
                         'conversation the record exists to replace. FR 39, FR 52, FR 44.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_records_its_decision
    AFTER UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (
        OLD.awaiting_approval_from IS NOT NULL
        AND (
            (NEW.status IN ('APPROVED', 'REFUSED') AND NEW.status IS DISTINCT FROM OLD.status)
            OR (NEW.status = 'SUBMITTED'
                AND NEW.awaiting_approval_from IS DISTINCT FROM OLD.awaiting_approval_from)
        )
    )
    EXECUTE FUNCTION refuse_a_move_no_decision_explains();

DROP TRIGGER IF EXISTS leave_request_routing_is_never_deleted ON leave_request_routing;
DROP TRIGGER IF EXISTS leave_request_routing_is_never_changed ON leave_request_routing;
DROP TRIGGER IF EXISTS leave_request_routing_records_its_recorder ON leave_request_routing;

DROP TABLE IF EXISTS leave_request_routing;

DROP FUNCTION IF EXISTS stamp_the_recorder_on_a_routing();
