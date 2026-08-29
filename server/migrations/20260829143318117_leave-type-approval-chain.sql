-- Up Migration

-- Who approves each kind of leave, and in what order. FR 38a, §5.5. LMS 204.
--
-- The second of the two things design principle 5 of the Technical Design
-- Document says vary by leave type: "Two things vary by leave type, and both used
-- to be global... If either is written as an `if` on a type code, every future
-- leave type becomes a code change." The first was the counting basis and is
-- LMS 201. This is the other one, and it is the one the README states in the
-- plainest terms: "Most types go manager then HR; unpaid leave goes HR then CEO.
-- Both are configuration. If either appears as an `if` on a type code, that is a
-- bug."
--
-- The leave-type-rules migration left it out on purpose and said why: "a nullable
-- `approver_role` added now would be the wrong shape stored in the right place,
-- which is harder to remove than nothing". This is the right shape.
--
-- ## Why it is a child table and not two columns
--
-- A chain is an ordered list whose length is a policy decision. Held as
-- `approver_1_role` and `approver_2_role` it would be a table that has to be
-- migrated the day somebody wants three stages, and a pair of nullable columns
-- can hold a hole — a second approver with no first is a chain nothing can walk.
-- Held as rows with a `step_order`, a three stage chain is a third row and the
-- hole is a constraint.
--
-- ## The three approver roles are not the four role codes
--
-- MANAGER, HR and CEO. None of them is a row in `role`, and that is not an
-- oversight to be tidied up later — the two sets describe different things and
-- the fact that both could be called "roles" is the trap.
--
--   **MANAGER is a relationship.** You are one if some employee has your id as
--   their manager_id. The organisation migration has refused to make it a granted
--   role since the table was created: "Holding it as a role too would create two
--   sources of truth that drift the moment somebody changes team."
--
--   **HR is a granted role**, or rather two of them — HR_OFFICER and HR_ADMIN
--   both staff that desk. The chain names the desk rather than the grant, because
--   "unpaid leave is approved by HR" is what the policy says and which of the two
--   codes the person on duty holds is not a thing HR should have to encode.
--
--   **CEO is a position.** FR 04: exactly one employee has no line manager, and
--   the employee_one_root index is what makes that "exactly one". Nobody grants
--   it and nobody holds it as a role.
--
-- So what this column records is *which desk*, and how the desk is found is three
-- different questions answered in three different places. Turning them into one
-- lookup — a `role_id` here — would have made the chain joinable to `role` and
-- then silently wrong, because two of the three have no row there to join to.
-- The spellings are deliberately not the spellings in `role.code`: nothing can
-- accidentally match 'HR' against 'HR_ADMIN', and `readRoleCode('MANAGER')`
-- already refuses with an explanation.
--
-- Held as a CHECK rather than as a lookup table, the same way counting_basis is:
-- a fourth approver role is a change to the routing code as well as to this
-- constraint, so it is a migration with an argument attached rather than a row.
--
-- ## The default is rows, not a fallback
--
-- Manager then HR, for every type that does not say otherwise. It could have been
-- a constant read when a chain came back empty, and that would have been the
-- version of "default" that HR cannot see: the configuration screen would show
-- nothing for annual leave, and changing what "otherwise" means would be a
-- release. So every type carries its chain explicitly, this migration writes the
-- ones that exist today, and ../src/domain/approval-chain.ts holds the same two
-- roles for the type nobody has written a chain for yet.

-- ------------------------------------------------------------------ the table

CREATE TABLE leave_type_approval_step (
    /* The type this is a stage of. ON DELETE CASCADE, which is the opposite of
       what leave_entitlement_rule chose, and the difference is what the row is: a
       rule is a record *about* a type and outlives it as history, a step is part
       of the type and means nothing without it. work_pattern_day cascades from a
       pattern for the same reason.

       It withdraws no protection. lms_app holds no DELETE on leave_type, so the
       only writer who can reach this cascade is the owner, deleting a type on
       purpose — and the entitlement rules still refuse that deletion on their own
       for any type that has ever been worth anything. */
    leave_type_id BIGINT      NOT NULL REFERENCES leave_type(id) ON DELETE CASCADE,

    /* Where in the chain this stage sits. 1 is the first approver.

       Numbered from one and contiguous, which leave_type_approval_chain_is_whole
       holds: a chain of steps 1 and 3 is a chain that stops after the first
       approval, because the walk from 1 asks for 2 and is handed nothing. That is
       the failure mode of an ordered list held as rows, and it is silent — the
       request simply sits in a queue nobody is looking at. */
    step_order    SMALLINT    NOT NULL,

    /* MANAGER | HR | CEO. Which desk this stage belongs to; see the note above
       for why that is not the same question as which role somebody holds. */
    approver_role VARCHAR(20) NOT NULL,

    /* No timestamps, for the reason work_pattern_day has none. A step is not
       edited in its own right — it is part of a chain, replaced wholesale when
       the chain changes — and its history is the type's. The audit entries below
       are filed under the type for exactly that reason. */

    /* One step per position, which is what makes "the first approver" a question
       with one answer. */
    PRIMARY KEY (leave_type_id, step_order),

    CONSTRAINT leave_type_approval_step_order_positive
        CHECK (step_order >= 1),

    CONSTRAINT leave_type_approval_step_role_known
        CHECK (approver_role IN ('MANAGER', 'HR', 'CEO'))
);

/* And one position per desk. A chain that asks the same approver twice is either
   a mistake or a request that waits for somebody to approve what they have
   already approved; §8 has no state for the second and no story asks for it.

   It also puts a ceiling on a chain without anybody writing one: three roles,
   each usable once, so the longest chain there can be is three stages. That is
   the right ceiling for the wrong-looking reason — it is not a policy about how
   many approvals are sensible, it follows from there being three desks. */

CREATE UNIQUE INDEX leave_type_approval_step_role_once
    ON leave_type_approval_step (leave_type_id, approver_role);

-- --------------------------------------------------------- a chain with no hole

/* A chain that exists is numbered 1 to n with nothing missing.

   Deferred, because the operation this would otherwise refuse is the ordinary
   one. Changing a chain is a delete of every step and an insert of the new ones,
   and between those two statements the type has no chain at all — the same shape
   as replacing a working pattern's week, and deferred for the same reason. At
   COMMIT the only state there is is the one that will be stored.

   What it deliberately does not say is that every type has a chain. That reads
   like the obvious companion rule and it would break the thing LMS 202 built:
   `ensure_statutory_leave_types()` puts back a type that has gone missing, in one
   statement, and it cannot know about a table that did not exist when it was
   written. A rule refusing a chainless type would turn the documented repair for
   one kind of lost reference data into a failure.

   So the chainless type is allowed to exist and is closed off at the two places
   it matters. `ensure_statutory_approval_chains()` below is the repair, and it is
   the other half of that call. And a request against a type nobody approves is
   refused at the point of asking, by assertSomebodyApprovesIt() in
   ../src/domain/leave-type.ts, with a message that says whose job it is to fix —
   which is a better outcome than a constraint that fires on the operator putting
   the type back rather than on the person who left it half configured. */

CREATE FUNCTION refuse_an_approval_chain_with_a_hole_in_it() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    type_id   BIGINT := CASE WHEN TG_OP = 'DELETE'
                             THEN OLD.leave_type_id ELSE NEW.leave_type_id END;
    type_name TEXT;
    steps     INTEGER;
    last_step INTEGER;
BEGIN
    /* The type itself was deleted and its chain cascaded with it. There is no
       chain with a hole in it here, only an absent one. */
    SELECT name INTO type_name FROM leave_type WHERE id = type_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT count(*), coalesce(max(step_order), 0)
      INTO steps, last_step
      FROM leave_type_approval_step
     WHERE leave_type_id = type_id;

    /* Every step_order is distinct, is at least one, and there are `steps` of
       them. So the highest being the count is the whole of "1 to n with nothing
       missing"; anything else has a gap in it. */
    IF steps > 0 AND last_step <> steps THEN
        RAISE EXCEPTION
            'The approval chain for "%" has % step(s) numbered up to %.',
            type_name, steps, last_step
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'leave_type_approval_chain_is_whole',
                  HINT = 'Number the steps from 1 with no gaps. A chain that '
                         'skips a number stops at the gap, and the request waits '
                         'in a queue nobody is looking at. FR 38a.';
    END IF;

    -- AFTER trigger. The return value is discarded; this either lets the
    -- transaction stand or has raised above.
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_type_approval_chain_is_whole
    AFTER INSERT OR UPDATE OR DELETE ON leave_type_approval_step
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_an_approval_chain_with_a_hole_in_it();

-- --------------------------------------------------------------- maintenance

/* record_in_audit_log() reused, told to file under the type rather than under the
   row, exactly as work_pattern_day is told to file under the pattern. Nobody
   searches for the second stage of a chain; they search for the leave type whose
   requests went to the wrong desk, and want every change to it in one list.

   NFR AUD 01 names configuration changes, and this is a configuration change with
   somebody's authority in it: "the administrator took the CEO out of the unpaid
   leave chain" is the sentence a dispute about an approval turns on. There is no
   updated_at on this table to carry it, so the log is the whole of the history. */

CREATE TRIGGER leave_type_approval_step_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON leave_type_approval_step
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log('leave_type_id');

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration. DELETE is granted because changing a
   chain is deleting one and writing another; the repository does both inside one
   transaction, which is what the deferred constraint above is for.

   UPDATE is not granted, and the omission is the point rather than an economy. A
   chain is replaced as a whole. Moving 'manager then HR' to 'HR then CEO' by
   updating rows in place passes through 'HR then HR' or 'manager then CEO'
   depending on which row is written first, and both of those are real chains that
   a concurrent reader would find. Delete and insert has no such intermediate
   state to read: the rows are simply not there. */

GRANT DELETE ON leave_type_approval_step TO lms_app;

-- ------------------------------------------- the chains of FR 38a and §5.5

/* Reference data, and it has an owner from the first minute rather than acquiring
   one a story later. That is the whole lesson of LMS 202: the insert that runs
   inside the migration which creates the table proves a database *started out*
   right and can never run again, and the three places reference data actually
   goes missing — a restore from an older backup, a row deleted by somebody
   holding the owner's password, a branch brought up from a partial dump — all
   want a call rather than rows retyped at a psql prompt.

   Here it wants one more than usual, because a type restored by
   `ensure_statutory_leave_types()` comes back with no chain at all. That function
   cannot know about this table — it was written before it existed — so the repair
   for a lost leave type is now two calls, and this is the second of them.

   ## What it does and does not do

   It gives a chain to a type that has none. It never touches a type that has one,
   which is the same refusal `ensure_statutory_leave_types()` makes and for the
   same reason: FR 31 gives the chain to HR, and a function that reconciled the
   rows back to the values shipped here would take that away the first time
   somebody added the CEO to the compassionate leave chain.

   ## The two chains, and why a CASE on the code is not the bug design principle 5 names

   Everything goes manager then HR except unpaid leave and the unpaid maternity
   extension, which go HR then CEO — FR 32h, and §4.3.1 says it of both: "Decided
   by HR and the Chief Executive." There is no manager stage on either, which is
   the part worth noticing: unpaid leave is not a request a line manager signs off
   and HR confirms, it is an arrangement with the company.

   The CASE reads a type code, which everything above the database is forbidden to
   do. The distinction is the one `ensure_statutory_entitlement_rules()` already
   relies on when it joins by code: this is reference data being *placed*, once,
   for types the SRS names. Nothing reads the code to decide where a request goes.
   The moment these rows exist, the chain is what routing reads and the code is a
   handle for reports again. */

CREATE FUNCTION ensure_statutory_approval_chains() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    /* Whoever the caller said they were, kept and put back — the same courtesy
       the other two ensure functions do, and for the same reason. A chain that
       reappeared should say where it came from, and 'not named by the writer' is
       a thin answer when the question is who decided that unpaid leave goes to
       the Chief Executive. */
    named_by TEXT := current_setting('lms.audit.actor', true);
    given    INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_statutory_approval_chains()'),
        true);

    WITH unapprovable AS (
        SELECT type.id,
               CASE WHEN upper(type.code) IN ('UNPAID', 'MAT_EXT_UNPAID')
                    THEN ARRAY['HR', 'CEO']
                    ELSE ARRAY['MANAGER', 'HR']
               END AS chain
          FROM leave_type type
         WHERE NOT EXISTS (
             SELECT 1 FROM leave_type_approval_step step
              WHERE step.leave_type_id = type.id
         )
    ), written AS (
        INSERT INTO leave_type_approval_step (leave_type_id, step_order, approver_role)
        SELECT unapprovable.id, stage.step_order, stage.approver_role
          FROM unapprovable,
               unnest(unapprovable.chain) WITH ORDINALITY AS stage(approver_role, step_order)
        RETURNING leave_type_id
    )
    SELECT count(DISTINCT leave_type_id) INTO given FROM written;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN given;
END
$$;

/* Nobody but the owner may run it, as with its two siblings. lms_app holds INSERT
   on the table and writes chains through the service all day, so this withholds
   no power it has elsewhere; it keeps a bulk rewrite of every unapprovable type
   from being one call away from anything that happens to be connected. Restoring
   reference data is an operator's job, done knowingly. */

REVOKE EXECUTE ON FUNCTION ensure_statutory_approval_chains() FROM PUBLIC;

/* And run it, which on a database migrated in order gives a chain to all seven
   types of FR 32 and to anything HR has added since. It says how many out loud,
   because a migration that quietly decided who approves leave is a thing somebody
   should read in the deployment log rather than find later. */

DO $$
DECLARE
    given INTEGER;
BEGIN
    given := ensure_statutory_approval_chains();

    RAISE NOTICE 'Gave an approval chain to % leave type(s).', given;
END
$$;

-- ------------------------------------------------------ what is not here yet

/* **The routing itself.** Which *person* a request goes to, and what happens when
   it gets there, is FR 48 and Phase 3. This table says the chain for unpaid leave
   is HR then the Chief Executive; finding the HR officer on duty, and the one
   employee with no line manager, is the request workflow's job and needs the
   request table to exist. ../src/domain/approval-chain.ts holds the walk —
   "given this chain and the stage just approved, who is next" — as a pure
   function, so that when the workflow arrives there is nothing left to decide.

   **Self approval, and the manager who is also the requester.** FR 48b: a manager
   raising their own leave has nobody below them in the chain to send it to, so it
   routes upwards. That is a rule about a particular request and a particular
   reporting line rather than about a leave type, and putting it here would be the
   same category error as putting the entitlement figure on the leave type.

   **Delegation and cover.** Who approves while the approver is themselves on
   leave is FR 49, is about people rather than types, and is a table of its own.

   **Parallel approval.** Every chain here is a sequence: stage two is asked after
   stage one has said yes. Nothing in the SRS asks for two approvers at once, and
   `step_order` would carry it badly if anything did — two rows sharing a number
   is the one thing the primary key refuses. That is a deliberate ceiling, not an
   oversight. */

-- Down Migration

DROP FUNCTION IF EXISTS ensure_statutory_approval_chains();

DROP TRIGGER IF EXISTS leave_type_approval_step_is_audited ON leave_type_approval_step;
DROP TRIGGER IF EXISTS leave_type_approval_chain_is_whole ON leave_type_approval_step;
DROP FUNCTION IF EXISTS refuse_an_approval_chain_with_a_hole_in_it();

DROP TABLE IF EXISTS leave_type_approval_step;
