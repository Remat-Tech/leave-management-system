-- Up Migration

-- Each employee has exactly one line manager. FR 02 and FR 04.
--
-- The column arrived with the organisation migration carrying the comment "NULL
-- only for the root". Nothing enforced it. A comment is a note to the next
-- reader, and the reader it needed to reach was whoever wrote the second
-- manager-less record.
--
-- Two people with no manager is not a second chief executive. It is a record
-- whose leave requests have nowhere to go, and it is found by the employee whose
-- request vanishes rather than by the HR officer who created it. That is the
-- whole of why FR 04 says exactly one: so that every request has somewhere to go
-- without anyone deciding case by case.
--
-- No column is added and none changes type. manager_id already references
-- employee(id) and employee_not_own_manager already forbids somebody managing
-- themselves; what was missing was the count.

-- ---------------------------------------------------------- exactly one root

/* At most one employee may have no manager. FR 04.

   The index key is the constant true, so every manager-less row indexes under
   the same key and the second one collides with the first. The partial predicate
   is what keeps that from applying to anybody else: an employee who has a
   manager is not in this index at all, so the constant costs nothing and
   constrains nothing outside the one case it is about.

   A CHECK cannot express this. "At most one row in the table" is a statement
   about the table, and a CHECK sees one row.

   Succession is the one operation this makes order dependent, and it is worth
   knowing before it is needed at four in the afternoon. When a new head of the
   organisation arrives, give the outgoing one their manager first — which takes
   the table to zero manager-less rows, and zero is permitted — and only then
   clear the new one's. Doing it the other way round means two for the length of
   a statement, and the index is immediate rather than deferrable, so it fails.

   Giving the outgoing head a manager rather than leaving them rootless is also
   the point of doing it in that order: the table stays a single tree, so a walk
   upward from anybody at all, leavers included, terminates at the one root. A
   second rootless record would make that walk stop somewhere that is not the
   top, which is the same defect wearing a different hat. */

CREATE UNIQUE INDEX employee_one_root ON employee ((true)) WHERE manager_id IS NULL;

-- ----------------------------------------------------- what is not held here

/* Three rules belong to this story's subject and are deliberately not
   constraints. Each is left to a layer that can hold it honestly rather than
   written here in a form that would be wrong.

   AT LEAST ONE ROOT. The index makes "no more than one" a fact; it cannot make
   "no fewer than one" one. An empty table has no root and is not broken, and the
   seed empties this one every time it reloads the fixture organisation, so a
   rule checked statement by statement would refuse the seed its truncate and
   every insert up to the chief executive's. It is reported to HR instead, by
   EmployeeService.reportingLineWarnings().

   Worth knowing what a rootless table actually means, because it is not
   "somebody forgot": with manager_id a foreign key to this same table and no
   NULL anywhere in it, every upward walk is infinite over a finite set, so it
   must revisit somebody. Zero roots on a non-empty table is a cycle. That is
   FR 03 and LMS 104.

   A MANAGER WHO IS STILL HERE. Routing a request to somebody who left in July is
   the same black hole as routing it nowhere, so the service refuses to assign a
   terminated employee as anybody's manager. It is not a constraint because it
   cannot be one truthfully: it is a rule about the current state of a different
   row, and that row changes without this one being touched. The manager who is
   here today leaves in March, and a constraint that was satisfied when it was
   checked is quietly false thereafter. A constraint that can be falsified
   without touching the row it guards is a constraint that lies. The write-time
   refusal catches it being created; reportingLineWarnings() catches it having
   drifted.

   CYCLES. A -> B -> A with somebody else as the root satisfies everything here.
   employee_not_own_manager catches only the loop of length one. FR 03 and
   LMS 104, walked in the service layer, as the organisation migration says. */

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. lms_app already holds the UPDATE on employee
   that recording a manager needs, granted by the organisation migration, and an
   index needs no privilege of its own. */

-- Down Migration

DROP INDEX IF EXISTS employee_one_root;
