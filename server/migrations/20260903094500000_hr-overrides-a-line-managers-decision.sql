-- Up Migration

-- HR overturns a line manager's decision, with the reason in writing. FR 44, §7.2, §6, §8.
-- LMS 318.
--
-- Both stages decide before leave is finally confirmed or rejected, and the last stage to
-- decide is the one whose word it lands on. Until now a refusal at any desk ended the request
-- and released its days, so a line manager's no was final and HR never saw it.
--
-- The state machine already had room for that: nothing here moves a request out of an ending,
-- no ledger entry type is added, and `leave_request_reserves_once` and
-- `leave_request_releases_once` are untouched. What changes is the two rules that assumed the
-- only decision worth carrying forward was an approval.
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | `leave_request_decision_action_known` | a verb nothing can perform | which verb was legitimate on this request |
--   | `leave_request_override_says_why` | an override with no justification | one whose justification is beside the point |
--   | `leave_request_decision_override_names_what_it_reverses` | an override reversing nothing, and a plain decision claiming to reverse something | whether the two belong to one request |
--   | `leave_request_decision_reverses_the_same_request` | an override naming another request's decision, itself, or the same verb | nothing; it is the backstop |
--   | `leave_request_decision_overturned_once` | two overrides of one decision | two decisions at one desk, which its own index holds |

-- --------------------------------------------- the two verbs, and what they must say

/* Four values where there were two. The list is the domain's `DECIDING_ACTIONS`, and the
   integration suite reads this constraint back out of `pg_constraint` and asserts the two
   agree — so neither can be extended alone.

   FR 44's fourth criterion is that this is a decision value rather than a flag. Held as
   `action = 'APPROVE'` with a boolean beside it, an override would sort, filter and read
   identically to an approval in every query that forgot the second column. */

ALTER TABLE leave_request_decision
    DROP CONSTRAINT leave_request_decision_action_known;

ALTER TABLE leave_request_decision
    ADD CONSTRAINT leave_request_decision_action_known CHECK (
        action IN ('APPROVE', 'REFUSE', 'OVERTURN_REJECTION', 'OVERTURN_APPROVAL'));

/* Its own constraint rather than a widening of `leave_request_refusal_says_why`, because
   `LeaveDecisionRepository` maps each name to its own refusal: one rule would tell an HR
   Officer who forgot the box about refusing leave. */

ALTER TABLE leave_request_decision
    ADD CONSTRAINT leave_request_override_says_why CHECK (
        action NOT IN ('OVERTURN_REJECTION', 'OVERTURN_APPROVAL') OR comment IS NOT NULL);

-- ------------------------------------------------- what an override reverses

/* The decision this one overturns, NULL on every decision that is not an override.

   A real foreign key: the reason staying visible is a claim about two rows, the override's
   justification and what the manager originally said. */

ALTER TABLE leave_request_decision
    ADD COLUMN overrides_decision_id BIGINT REFERENCES leave_request_decision(id);

/* An equivalence, the shape `leave_request_waits_at_a_desk` has. An override naming nothing
   reverses nothing; a plain approval naming something claims a disagreement it did not have. */

ALTER TABLE leave_request_decision
    ADD CONSTRAINT leave_request_decision_override_names_what_it_reverses CHECK (
        (action IN ('OVERTURN_REJECTION', 'OVERTURN_APPROVAL'))
        = (overrides_decision_id IS NOT NULL));

/* And a decision is overturned once. */

CREATE UNIQUE INDEX leave_request_decision_overturned_once
    ON leave_request_decision (overrides_decision_id)
    WHERE overrides_decision_id IS NOT NULL;

/* And what it reverses is on the same request, is not itself, and said the opposite.

   A foreign key says the row exists and cannot say whose it is. A trigger rather than a
   CHECK, because a CHECK may not read another row. */

CREATE FUNCTION refuse_an_override_of_another_request() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    reversed leave_request_decision%ROWTYPE;
BEGIN
    IF NEW.overrides_decision_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF NEW.overrides_decision_id = NEW.id THEN
        RAISE EXCEPTION 'Decision % cannot reverse itself.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_decision_reverses_the_same_request',
                  HINT = 'An override reverses a decision somebody else already made. FR 44.';
    END IF;

    SELECT * INTO reversed
      FROM leave_request_decision
     WHERE id = NEW.overrides_decision_id;

    /* Unreachable: the foreign key has already found the row and nothing deletes one.
       Answered rather than assumed, because a missing row makes every comparison below NULL
       and NULL is not true — a check that silently stops checking. */
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF reversed.leave_request_id <> NEW.leave_request_id THEN
        RAISE EXCEPTION
            'Decision % is about leave request %, not %.',
            reversed.id, reversed.leave_request_id, NEW.leave_request_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_decision_reverses_the_same_request',
                  HINT = 'The justification on an override is shown to the person whose '
                         'decision was reversed, so a pointer to another request would read '
                         'somebody else’s sentence out to the wrong person. FR 44.';
    END IF;

    IF (NEW.action = 'OVERTURN_REJECTION' AND reversed.action <> 'REFUSE')
       OR (NEW.action = 'OVERTURN_APPROVAL' AND reversed.action <> 'APPROVE') THEN
        RAISE EXCEPTION
            'A % reverses the opposite decision, and decision % is a %.',
            NEW.action, reversed.id, reversed.action
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_decision_reverses_the_same_request',
                  HINT = 'An override that agrees with what it names is a record of a '
                         'disagreement nobody had. FR 44.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_decision_reverses_the_same_request
    AFTER INSERT ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_override_of_another_request();

-- ------------------------------- every stage decided, and the last one said yes

/* `leave_request_is_approved_by_every_stage`, asking whether each stage has *decided* rather
   than whether each has approved. FR 41, FR 44.

   The manager's stage on an overturned request is answered by their rejection: FR 44's rule
   is that every stage decides, not that every stage agrees, and what makes the leave approved
   is the last stage saying yes.

   That is weaker than LMS 316's rule and is the correct weakening — a stage that has not been
   asked has neither an approval nor a rejection on record, so the failure that story was
   written against is caught exactly as before. */

CREATE OR REPLACE FUNCTION refuse_an_approval_a_stage_never_gave() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    unasked TEXT;
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted` refuses it,
       but a constraint trigger fires on a row that no longer has to be there. */
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

-- ------------------------------------- and a move at a desk still says who made it

/* `refuse_a_move_no_decision_explains()`, which had one verb per destination and now has
   several.

   A request reaches APPROVED by an approval or an overturned rejection, and REFUSED by a
   refusal or an overturned approval. **And a request that changed desks without changing
   status accepts any of the four**, which is the branch LMS 318 made necessary: an
   intermediate decision used to be an approval by definition, and a manager's rejection is
   now one too.

   The desk comparison is untouched and is the part doing the work — the latest decision has
   to be recorded at the stage the request was standing on. */

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

-- ------------------------------------------------------- one thing somebody was told

/* FR 59's list gains the two events LMS 318 makes reachable, which the
   tell-people-what-happened-to-their-leave migration said this story would bring.

   `STAGE_REFUSED` is the counterpart of `STAGE_APPROVED`: a manager's no no longer ends the
   request, so "turned down, your days are back" would be wrong in both halves.

   `DECISION_OVERTURNED` is the story's fifth criterion, and the one notice written to
   somebody other than the person taking the leave — which `notification.employee_id` was
   built to allow. */

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED'));

-- ---------------------------------------------------------------- privileges

/* Nothing to grant. The column added above is covered by the table-wide privileges
   `leave_request_decision` already has, and nothing grants UPDATE or DELETE on it — an
   override is a new row rather than an edit to the one it disagrees with, which is why the
   reason stays visible. */


-- Down Migration

-- The order is the reverse of the up section: every rule that would refuse the unpicking comes
-- off before the rows are unpicked, and goes back afterwards.
--
-- **This rollback loses information.** The overrides themselves have to go — the restored
-- CHECK does not permit their `action` — and what is lost is the record that HR reversed a
-- manager, which is the thing FR 44 asks to keep. Run it before an override has been made
-- rather than after.

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

DELETE FROM notification
    WHERE event IN ('STAGE_REFUSED', 'DECISION_OVERTURNED');

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'APPROVED', 'REFUSED', 'WITHDRAWN',
                  'CANCELLED'));

/* The move check comes off first: a request that reached APPROVED on an overturned rejection
   would otherwise be left explaining itself with a row that is about to be deleted. */

DROP TRIGGER IF EXISTS leave_request_records_its_decision ON leave_request;

DROP TRIGGER IF EXISTS leave_request_decision_reverses_the_same_request
    ON leave_request_decision;
DROP FUNCTION IF EXISTS refuse_an_override_of_another_request();

DROP INDEX IF EXISTS leave_request_decision_overturned_once;

/* The escape hatch the employees-never-deleted migration describes: the trigger comes off for
   the length of one statement and goes straight back. */

DROP TRIGGER IF EXISTS leave_request_decision_is_never_deleted ON leave_request_decision;

DELETE FROM leave_request_decision
    WHERE action IN ('OVERTURN_REJECTION', 'OVERTURN_APPROVAL');

CREATE TRIGGER leave_request_decision_is_never_deleted
    BEFORE DELETE ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A decision is never removed. A request that reached APPROVED or REFUSED with '
        'nothing to say who decided it is a request nobody can explain, which is the '
        'condition §6 exists to prevent. FR 39, FR 52.'
    );

ALTER TABLE leave_request_decision
    DROP CONSTRAINT IF EXISTS leave_request_decision_override_names_what_it_reverses;

ALTER TABLE leave_request_decision
    DROP CONSTRAINT IF EXISTS leave_request_override_says_why;

ALTER TABLE leave_request_decision
    DROP COLUMN IF EXISTS overrides_decision_id;

ALTER TABLE leave_request_decision
    DROP CONSTRAINT leave_request_decision_action_known;

ALTER TABLE leave_request_decision
    ADD CONSTRAINT leave_request_decision_action_known CHECK (
        action IN ('APPROVE', 'REFUSE'));

/* And the two rules go back to the bodies LMS 315 and LMS 316 wrote, each refusing more than
   the one above it. They go back last, after every row they would have refused has gone. */

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
               AND decision.action = 'APPROVE'
               AND decision.on_behalf_of = step.approver_role);

    IF unasked IS NOT NULL THEN
        RAISE EXCEPTION
            'Leave request % was approved without %.', NEW.id, unasked
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_is_approved_by_every_stage',
                  HINT = 'Leave is agreed only once every stage of its type''s approval '
                         'chain has approved it. A request marked approved with a stage '
                         'unasked tells somebody their leave is agreed when it is not, and '
                         'they book a flight on it. FR 41, FR 42.';
    END IF;

    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT := CASE WHEN NEW.status = 'REFUSED' THEN 'REFUSE' ELSE 'APPROVE' END;
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
       OR latest.action <> expected
       OR latest.on_behalf_of IS DISTINCT FROM OLD.awaiting_approval_from THEN
        RAISE EXCEPTION
            'Leave request % was % at the % desk without recording who decided it.',
            NEW.id, lower(expected), OLD.awaiting_approval_from
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_records_its_decision',
                  HINT = 'Approving or refusing leave writes a decision naming the desk it '
                         'was decided at, in the same transaction as the status. A request '
                         'that moved with nothing to say who moved it or why is the '
                         'corridor conversation the record exists to replace. FR 39, FR 52.';
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
