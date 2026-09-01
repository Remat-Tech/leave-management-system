-- Up Migration

-- Approving or turning down leave, with a reason and a name on it. FR 39, FR 52, §6, §8.
-- LMS 315.
--
-- The create-and-submit-a-leave-request migration listed what it was deliberately leaving
-- out: "No `approved_by`, no `decided_at`, no `approval_step`. Those are the approval
-- story's and a nullable column with nothing able to write it is the switch with nothing
-- behind it that LMS 209 argued against." LMS 314 built the routing and still wrote none of
-- them. This is the migration that brings all three, and it brings them as a table.
--
-- ## Why a table and not three columns on the request
--
-- Because a chain has stages, and each stage is a decision. Annual leave goes to the line
-- manager and then to HR; both say yes, and the manager's "cover is arranged, take it" is
-- not the same sentence as HR's "your balance covers it". Three columns on `leave_request`
-- hold one of those and lose the other — and which one they lose is whichever was written
-- second, silently.
--
-- That is the same argument LMS 314 made about the *status*: the number of stages is
-- configuration, FR 31 gives it to an HR Administrator, and anything whose shape depends on
-- how many desks there are has to be rows rather than columns. A fourth desk added to
-- `leave_type_approval_step` needs nothing here.
--
-- ## What a decision records, and why each part of it
--
--   **What was decided.** APPROVE or REFUSE — the verb, matching the domain's
--   `REQUEST_ACTIONS`, for the reason that table is keyed by verbs rather than by
--   destinations: an approval at the first of two desks moves the request on without moving
--   its status at all, so "what happened" cannot be read off where the request ended up.
--
--   **Why, where a reason is owed.** `comment`, required of a refusal by
--   `leave_request_refusal_says_why` and optional on an approval. The story's first two
--   criteria are that asymmetry, and it is a real one rather than a tidy pair: somebody
--   whose leave is turned down has to be able to act on it, and "no" with nothing after it
--   is the corridor conversation this story exists to replace. Somebody whose leave is
--   granted needs no explanation of the yes.
--
--   **Who, and when.** `decided_by`, `decided_by_employee_id` and `decided_at`, stamped by
--   the trigger below from the setting the repositories put on the transaction — never
--   supplied by the writer, exactly as `leave_ledger_entry` stamps its own three. A person
--   who could name the decider could record a refusal under somebody else's name, and a
--   person who could date one could put a decision before the request it decides.
--
--   **On whose behalf.** `on_behalf_of` is the desk the request was standing at when this
--   was decided — the stage this decision answers for. FR 52.
--
-- ## `on_behalf_of` is the desk, and it is not the same fact as `decided_by`
--
-- The one column here worth arguing about, because for most rows the two say the same thing
-- twice. An approval can only be given by the person the desk resolves to —
-- `leaveRequestPolicy.approve` admits `THE_DESK_IT_IS_WITH` and nobody else — so an approval
-- row names a person and the office they answered for, and they match.
--
-- A refusal need not. `TRANSITIONS` admits `THEIR_LINE_MANAGER` and `LEAVE_ADMINISTRATION`
-- to the REFUSE row, which LMS 314 deliberately did not narrow to the chain: an HR Officer
-- may turn down leave that is sitting with a line manager, and a line manager may turn down
-- unpaid leave whose chain has no manager stage at all. Both are legitimate and both are
-- somebody deciding at a stage that is not their own.
--
-- So the two are recorded separately and neither is inferred from the other. "Refused by
-- Ama Mensah of HR, at the line manager's stage" is a sentence a manager can read and
-- recognise as a decision they did not make, which is the whole point of writing down on
-- whose behalf as well as who. Folding them into one column would make that unanswerable in
-- exactly the case somebody asks.
--
-- ## Append only, and not audited
--
-- A decision is a thing that happened. `refuse_update()` and `refuse_delete()` hold that on
-- every connection, including the owner's, and `lms_app` is never granted more than SELECT
-- and INSERT.
--
-- There is deliberately **no audit trigger**, and it is the same declining the
-- immutable-leave-ledger migration made: an entry that can never change is already its own
-- history, and it carries its writer and its timestamp in its own columns. An audit entry
-- would be a second copy of a row that cannot move. `AUDITED_ENTITIES` in
-- /domain/audit.ts is the list that must not gain this table, and the integration suite
-- reads the triggers back out of the catalogue and asserts the two agree.
--
-- The change to `leave_request.status` that a decision accompanies **is** audited, as it has
-- been since LMS 301, and the two land in one transaction — so the log answers "who moved
-- this out of SUBMITTED" and this table answers "and what did they say about it".

-- --------------------------------------------------- one decision at one stage

CREATE TABLE leave_request_decision (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* The request this decides. A real foreign key, because a decision about nothing is
       not a decision — unlike `audit_log.actor_employee_id`, where an id is a handle for a
       join somebody may choose to make.

       ON DELETE is absent, which is the default and is right: `leave_request_is_never_
       deleted` refuses to remove a request on any connection, so there is no delete for
       this to cascade from. */
    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* APPROVE or REFUSE. The verb rather than the state it left the request in.

       The two deciding members of the domain's `REQUEST_ACTIONS`, and the list is short for
       the reason `leave_request_status_known` started with one value: a CHECK naming acts
       nothing can perform is a promise the schema cannot keep. WITHDRAW and CANCEL are
       absent because neither is a decision at a desk — withdrawing is the person taking
       their own request back and cancelling is HR unwinding something that should not be on
       the books, and a row here saying either would put a decision in front of the
       requester that nobody made. */
    action VARCHAR(20) NOT NULL,

    /* FR 52. The desk this decision answers for: the stage the request was standing at when
       it was made. MANAGER, HR or CEO.

       The same three spellings as `leave_request.awaiting_approval_from`, and not a foreign
       key to `leave_type_approval_step` for the reason that column is not one: a step is a
       stage of a *type's* chain, which FR 31 lets an HR Administrator delete, and a decision
       that had already been made cannot stop having been made because the configuration
       moved afterwards. See the route-a-request-through-its-chain migration, which makes the
       same argument at length about a request in flight. */
    on_behalf_of VARCHAR(20) NOT NULL,

    /* Why. Required of a refusal, optional on an approval — see the checks below.

       Free text, and never a list of codes. "The team cannot cover both of you that week"
       is the sentence the person needs, and a dropdown of reasons is how an approver comes
       to pick the nearest wrong one. The same latitude `leave_ledger_entry.reason` is given,
       and for the same reason: a reason nobody can write freely is a reason everybody writes
       'no' in. */
    comment TEXT,

    /* Who, in the two forms audit_log keeps them: the id to join on, and the description to
       read when the id belongs to nobody. Both stamped by the trigger below and never by the
       writer, exactly as `leave_ledger_entry` stamps its own — a fact the writer has an
       interest in is not a fact the writer supplies. */
    decided_by TEXT NOT NULL,
    decided_by_employee_id BIGINT REFERENCES employee(id),

    /* When. Stamped by the same trigger rather than defaulted.

       A DEFAULT would be enough against an honest writer and not against the one this
       protects from: a default applies only where the writer says nothing, and a refusal
       dated before the request was submitted is a record of a decision that could not have
       been made. The ledger makes the same argument about an entry dated into last
       December. */
    decided_at TIMESTAMPTZ NOT NULL,

    /* The two closed lists. Both are held in the domain as well — `DECIDING_ACTIONS` in
       /domain/leave-decision.ts and `APPROVER_ROLES` in /domain/approval-chain.ts — and the
       integration suite reads these constraints back out of `pg_constraint` and asserts they
       agree, so neither side can be widened alone. */
    CONSTRAINT leave_request_decision_action_known CHECK (
        action IN ('APPROVE', 'REFUSE')),

    CONSTRAINT leave_request_decision_desk_known CHECK (
        on_behalf_of IN ('MANAGER', 'HR', 'CEO')),

    /* The story's first criterion, where no service can forget it. FR 39.

       An implication rather than an equivalence, and that asymmetry is the story: a refusal
       must say why, and an approval may. Written as a disjunction because that is what an
       implication is in SQL, and named so the refusal a caller sees says what it wanted. */
    CONSTRAINT leave_request_refusal_says_why CHECK (
        action <> 'REFUSE' OR comment IS NOT NULL),

    /* And a comment that is there is something. A refusal whose reason is a space satisfies
       the rule above and defeats it, which is the shape every "required field" bug has —
       the same pairing `leave_request_reason_not_blank` makes with its NOT NULL. */
    CONSTRAINT leave_request_decision_comment_not_blank CHECK (
        comment IS NULL OR btrim(comment) <> ''),

    CONSTRAINT leave_request_decision_decided_by_not_blank CHECK (
        btrim(decided_by) <> '')
);

/* Every decision one request has collected, oldest first, which is what is shown beside it
   and what the deferred check below reads. */
CREATE INDEX leave_request_decision_by_request
    ON leave_request_decision (leave_request_id, id);

-- ------------------------------------------------------- who decided, and when

/* The same three lines `stamp_the_writer_on_a_ledger_entry()` writes, against three
   differently named columns.

   Written out rather than shared, and the duplication is the smaller cost. A single
   function parameterised by column name through TG_ARGV would be a trigger that writes
   wherever it is told, which is a thing to have to check the arguments of at every call
   site; these are seven lines that say plainly what they set. `refuse_delete()` is
   parameterised and is the counter-example that shows where the line is — it takes a
   *message*, not a target.

   `decided_by` falls back to the same sentence the audit log uses for an unattributed write,
   which /domain/audit.ts holds as `UNATTRIBUTED` and the integration suite asserts is still
   the same words. A decision nobody is recorded as having made is itself a finding, and a
   null is a thing every reader has to guard and half of them forget to. */

CREATE FUNCTION stamp_the_decider_on_a_decision() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.decided_at := now();

    NEW.decided_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.decided_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_decision_records_its_decider
    BEFORE INSERT ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_decider_on_a_decision();

-- ------------------------------------------------- a decision is never rewritten

/* Append only, and against the owner as well as the application.

   A refusal whose comment can be edited afterwards is a refusal that says whatever the last
   person to look at it wanted it to say, which is worth less than no record at all — the
   person it was written for would have no way of knowing. An approver who put it badly adds
   a decision rather than correcting one, exactly as a wrong ledger entry is compensated
   rather than amended. */

CREATE TRIGGER leave_request_decision_is_never_changed
    BEFORE UPDATE ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'A decision is a record of something somebody did, and this is what the person '
        'whose leave it was has been told. Editing it afterwards would rewrite the reason '
        'they were given. If it was put badly, decide again — the history is the answer. '
        'FR 39, FR 52.'
    );

CREATE TRIGGER leave_request_decision_is_never_deleted
    BEFORE DELETE ON leave_request_decision
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A decision is never removed. A request that reached APPROVED or REFUSED with '
        'nothing to say who decided it is a request nobody can explain, which is the '
        'condition §6 exists to prevent. FR 39, FR 52.'
    );

-- --------------------------------- a request that moved at a desk says who moved it

/* The story's third criterion, and the fourth of a family whose shape LMS 314 settled.

   `leave_request_gives_its_days_back` catches an ending that released nothing.
   `leave_request_takes_its_days` catches an approval that committed nothing. This catches a
   move made at a desk that recorded no decision — and the three together are the same rule
   said about three different things that have to land in one transaction with a status.

   Deferred, for the reason both of the others are: the decision names the request, so the
   request has to have moved before the row can be written, and "a request that has just
   been approved and has not recorded its decision yet" is a legitimate intermediate state
   that only a check at COMMIT can judge correctly.

   ## The three moves it fires for, and the two it does not

   **A request that reached APPROVED or REFUSED**, which is the last desk saying yes and any
   desk saying no.

   **A request that changed desks while staying SUBMITTED**, which is an intermediate
   approval — the one move in this schema that changes no status at all. Without this branch
   the whole middle of a chain would be unguarded: a manager's approval of stage one is
   precisely the decision whose comment nothing else in the schema would miss.

   **Not a withdrawal and not a cancellation.** Both leave a desk behind and neither is a
   decision at one; requiring a comment of somebody taking back their own leave would be the
   system asking a person to justify changing their mind.

   ## What it checks is the *latest* decision, not merely that one exists

   The obvious form is EXISTS, and it is too weak by one case. A chain reordered underneath a
   live request can ask the same desk twice — annual leave is manager-then-HR, the manager
   approves, an HR Administrator reorders it to HR-then-manager, and the manager is asked
   again — so a decision at that desk from an hour ago would satisfy an EXISTS while the
   second approval recorded nothing. Reading the last row written instead is exact, and it
   costs the same index probe.

   That case is also why there is no unique index on (request, desk) here. It would be a rule
   FR 31 can break, refusing a legitimate approval with a message about a constraint. */

CREATE FUNCTION refuse_a_move_no_decision_explains() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected TEXT := CASE WHEN NEW.status = 'REFUSED' THEN 'REFUSE' ELSE 'APPROVE' END;
    latest leave_request_decision%ROWTYPE;
BEGIN
    /* The row may be gone by COMMIT — it cannot, `leave_request_is_never_deleted` refuses
       it, but a constraint trigger fires on a row that no longer has to be there and
       reading a missing one would raise the wrong error entirely. */
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

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration, which is the whole of what this table needs.

   Nothing grants UPDATE or DELETE, and that is how the two triggers above come to be
   layers rather than duplicates: the privileges stop the writer an attacker actually
   reaches, and the triggers stop the honest mistake at a psql prompt. */


-- Down Migration

/* The deferred check comes off first. Between it and the table going, a request may move
   at a desk without recording anything — which is what a database that has forgotten how
   to record a decision looks like, and is the state every row written before this
   migration is already in. */

DROP TRIGGER IF EXISTS leave_request_records_its_decision ON leave_request;
DROP FUNCTION IF EXISTS refuse_a_move_no_decision_explains();

/* The decisions themselves go with the table, and unlike the rollback of LMS 314 nothing
   has to be unpicked first: a decision moves no figure, so a balance that reconciled before
   this is dropped reconciles after it. What is lost is the record of who said what, which
   is the honest price of removing the table that holds it — the requests keep the statuses
   those decisions produced. */

DROP TRIGGER IF EXISTS leave_request_decision_is_never_deleted ON leave_request_decision;
DROP TRIGGER IF EXISTS leave_request_decision_is_never_changed ON leave_request_decision;
DROP TRIGGER IF EXISTS leave_request_decision_records_its_decider ON leave_request_decision;

DROP TABLE IF EXISTS leave_request_decision;

DROP FUNCTION IF EXISTS stamp_the_decider_on_a_decision();
