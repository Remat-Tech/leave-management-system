-- Up Migration

-- A reporting line never loops back on itself. FR 03, Technical Design Document
-- section 5.2.
--
-- The organisation migration promised this one and left it: "A full cycle
-- (A -> B -> C -> A) is caught in the service layer by walking up from the
-- proposed manager to the root." The walk is now written, in the service where
-- it can name the people involved, and here as well.
--
-- Here as well, because the service covers the application and the story asks
-- for every manager change including a bulk import, and a bulk import is exactly
-- the thing that does not go through a service. A loop is also the one bad state
-- in this table that nothing downstream can survive: FR 04 gives the tree one
-- root so that a walk upward terminates, and a loop makes it not terminate. A
-- request going round it is never approved, never rejected, and never seen
-- again.
--
-- The existing rules stop short of it, and it is worth being exact about how far
-- each gets:
--
--   employee_not_own_manager, a CHECK from the organisation migration, catches
--   the loop of length one and nothing longer. It is a row level rule and a
--   cycle is not a fact about a row.
--
--   employee_one_root, from the line-manager-rules migration, makes a loop
--   *visible* after the event — with manager_id a foreign key to this table and
--   at most one NULL in it, a table with no root at all has to contain a cycle —
--   but it refuses nothing, because a loop below the root leaves the root alone.

-- ------------------------------------------------------------------ the walk

/* Named for the job and not reusable, unlike set_updated_at() and
   refuse_delete(). Those two read TG_TABLE_NAME and work anywhere; this one has
   to know that the parent of a row is manager_id and that the table is employee,
   so writing it as though it were general would be a lie about what it does.

   The walk goes up from the proposed manager rather than down from the employee.
   Both find the same loop, but upward is bounded by the depth of the tree and
   downward by the size of the subtree, and the depth of an organisation is a far
   smaller number than the count of people in it.

   The CYCLE clause is what makes this safe against a table that already contains
   a loop — one restored from a dump taken before this migration, or written
   while the trigger was dropped. Without it the walk would follow the loop for
   ever, and a check for cycles that hangs on a cycle is worse than no check at
   all. With it, Postgres stops the recursion the moment a row repeats. */

CREATE FUNCTION refuse_manager_cycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    loops boolean;
BEGIN
    WITH RECURSIVE chain AS (
            SELECT e.id, e.manager_id
              FROM employee e
             WHERE e.id = NEW.manager_id
        UNION ALL
            SELECT m.id, m.manager_id
              FROM employee m
              JOIN chain c ON m.id = c.manager_id
    ) CYCLE id SET is_cycle USING walked
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = NEW.id) INTO loops;

    IF loops THEN
        RAISE EXCEPTION 'Employee % cannot report to employee %: the line loops back.',
                        NEW.id, NEW.manager_id
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'employee_no_manager_cycle',
                  HINT = 'That manager already reports to this employee, directly or '
                         'through somebody else. A request walking up the line would '
                         'go round for ever and reach nobody. FR 03.';
    END IF;

    -- AFTER trigger. The return value is discarded; the row is already written
    -- and this either lets the transaction stand or has raised above.
    RETURN NULL;
END
$$;

-- --------------------------------------------------------------- the trigger

/* A CONSTRAINT TRIGGER, deferred to the end of the transaction, rather than an
   ordinary BEFORE ROW trigger. That is the whole reason a bulk import can be
   held to this rule without being broken by it.

   A row trigger sees the table half changed. Swapping two people over — the
   manager becomes the report and the report the manager — is a legitimate
   restructure whose final state is a perfectly good tree, but whichever of the
   two rows is written first leaves a loop standing until the other one is
   written. Checked per row, that legitimate change is refused. Checked at
   commit, the intermediate state is nobody's business and only the state that
   will actually be stored is judged.

   Deferring costs the accuracy of the error's position: the failure arrives at
   COMMIT rather than at the statement that caused it, so a bulk import is told
   that it contains a loop rather than which line of the file holds it. That is
   the right way round. The application knows which line before it writes
   anything, because the service walks first; this is the net underneath, and a
   net that refuses legitimate work to give a better message is not worth having.

   INSERT is covered as well as UPDATE, and that is not belt and braces. It looks
   at first as though an insert cannot close a loop, since a brand new id is
   above nobody and the foreign key refuses a manager who does not exist yet. But
   a foreign key is itself an AFTER ROW trigger that fires at the end of the
   statement, so a single multi row INSERT can put two rows in that name each
   other and satisfy the key. Verified against Postgres 17 rather than reasoned
   about: it inserts two people into a loop, and this trigger is what stops it.

   Self reference is deliberately not this trigger's job even though the walk
   would find it. employee_not_own_manager is a CHECK, so it is evaluated as part
   of writing the row, long before any AFTER trigger and whether or not anything
   is deferred, and it names itself in the error. Two rules refusing the same
   statement is fine; the one that fires first and says more should be the one
   that gets there.

   The cost is one upward walk per row whose manager was set or changed, taken at
   commit, each of it a handful of primary key lookups. A bulk import of the
   whole company pays it once per person. */

CREATE CONSTRAINT TRIGGER employee_no_manager_cycle
    AFTER INSERT OR UPDATE OF manager_id ON employee
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    -- Clearing a manager can close nothing. The head of the organisation is
    -- reached by walking up, not by walking into it.
    WHEN (NEW.manager_id IS NOT NULL)
    EXECUTE FUNCTION refuse_manager_cycle();

-- ------------------------------------------------- what this changes upstream

/* Succession, and this is a correction to something the line-manager-rules
   migration says. That file is merged and is not edited, so the correction lives
   here, where the rule that caused it does.

   It says that replacing the head of the organisation is an ordered pair of
   ordinary updates: give the outgoing head their manager first, taking the table
   to zero rootless rows, then clear the incoming one's. The first of those two
   statements is now a loop — the outgoing head reports to the incoming one and
   the incoming one still reports to the outgoing — so it is refused.

   The other order is refused as well, by employee_one_root: clearing the
   incoming head's line first makes two rootless records. And there is no third
   order, because any manager the outgoing head could be given is somebody below
   them, and below them is where the loop comes from.

   So succession is now one transaction rather than two statements, and it works
   for the same reason a bulk import does. Inside a transaction the loop stands
   for exactly one statement, which is nobody's business because this trigger is
   deferred, while the number of rootless rows goes 1 -> 0 -> 1 and never reaches
   the two that the index would refuse:

       BEGIN;
       UPDATE employee SET manager_id = :incoming WHERE id = :outgoing;
       UPDATE employee SET manager_id = NULL      WHERE id = :incoming;
       COMMIT;

   EmployeeService has no way to express that: every method there is a single
   autocommitted statement, and the checks it runs first would refuse the halves
   individually in any case. A succeedHead() that opens a transaction and leaves
   the deferred trigger to judge the result is what this wants. It needs doing,
   and it is not done. The integration suite pins the transaction above so that
   the shape is written down rather than rediscovered. */

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. A trigger function runs as part of the caller's
   own statement and needs no privilege of its own, and lms_app already holds the
   UPDATE on employee that moving a reporting line needs. */

-- Down Migration

DROP TRIGGER IF EXISTS employee_no_manager_cycle ON employee;
DROP FUNCTION IF EXISTS refuse_manager_cycle();
