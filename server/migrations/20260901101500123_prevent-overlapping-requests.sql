-- Up Migration

-- One person is in one place on one day. FR 15, §5.6. LMS 304.
--
-- The constraint the baseline enabled an extension for and named two migrations
-- before it existed. The baseline: "btree_gist lets a GiST exclusion constraint mix
-- equality on a scalar column with overlap on a range, which is how overlapping leave
-- is prevented at the database level rather than in application code." The
-- leave-year-rules migration, declining to use it: "the extension is what you need to
-- put a scalar equality beside a range overlap in the same constraint, which is the
-- shape the overlapping *leave request* rule of §8 will want — one employee, and their
-- dates. That story brings it." This is that story, and this is that constraint.
--
-- The defect it exists to stop is a balance consumed twice for the same days.
-- Somebody books the first to the tenth of March, forgets, and books the fifth to the
-- twelfth. Both reserve. Twelve days come off a balance for eight days away, and
-- nothing in the ledger is wrong — every entry reconciles, every figure is
-- explainable, and the number is still incorrect. That is the failure mode design
-- principle 1 cannot catch on its own: the record is faithful and the request was
-- never one a person should have been allowed to make.
--
-- ## Why the constraint is on the employee and not on the employee and the type
--
-- Because a person is away or they are not. Annual leave from the first to the tenth
-- and sick leave on the fifth are not two absences that happen to share a day, they
-- are one day with two claims on it, and each of them takes a day off a different
-- balance. Keying the constraint by leave type as well would permit exactly that and
-- would read as though somebody had thought about it.
--
-- FR 32b's "sick leave during annual leave is converted" is the real version of that
-- case, and it is a conversion: the annual leave is amended and the days come back.
-- That is a decision with an approver on it, not two rows quietly coexisting, and the
-- story that offers it will move the first request rather than write a second one
-- beside it.
--
-- ## Why there is a WHERE clause when there is only one status
--
-- `status IN ('SUBMITTED')` is a tautology today. `leave_request_status_known` admits
-- one value, so the predicate excludes nothing and the constraint would behave
-- identically without it.
--
-- It is here anyway, and deliberately, because of what happens the day it stops being
-- a tautology. The approval story brings WITHDRAWN, CANCELLED and REFUSED alongside
-- APPROVED, and every one of the first three is a request that no longer holds a day
-- in anybody's calendar. A constraint written without a predicate would block a
-- fortnight in March against leave that was refused in January, and the person hitting
-- it would be told to withdraw a request they had already withdrawn. Adding the
-- predicate at that point is a migration nobody would think to write until somebody
-- reported the bug.
--
-- So the list is here from the start and the rule it states is the one that matters:
-- **a request blocks the days only while it is still live.** The approval story edits
-- this list, exactly as event-based-entitlement-grants edited
-- `leave_ledger_entry_type_known` to admit LAPSE, and `LIVE_STATUSES` in
-- /domain/leave-request.ts holds the same list in the application. The integration
-- suite asserts the two agree, so neither can be extended alone.
--
-- ## What the application does about it
--
-- `LeaveRequestService` asks the same question first, from `resolve()`, so that the
-- person at the form gets `LeaveOverlapsAnother` naming the leave already in the way —
-- its dates, what it cost, and what kind it is. That is the refusal anybody using this
-- system meets.
--
-- **This is the one that is true under concurrency.** Two tabs, or two clicks, submit
-- the same fortnight at the same moment: both service checks read a table with no
-- conflict in it, both pass, and the constraint refuses the second INSERT. There is no
-- arrangement of application code that closes that window — the check and the write
-- are two statements — and the only thing that can is a constraint the database
-- evaluates as it writes the row. The repository turns the violation back into
-- `LeaveOverlapsAnother` so both callers meet the same refusal.

/* Inclusive at both ends, `[]`, because that is what the two dates mean everywhere
   else in this schema: away from the twenty-first to the thirty-first means both of
   those days. A half-open range would let a request starting on the tenth sit beside
   one ending on the tenth, which is one day booked twice and is exactly the shape of
   the bug.

   Not deferrable. The leave-year constraint is, because moving the boundary between
   two years is two statements with a legitimate overlap between them; nothing here has
   an equivalent. `refuse_rewriting_what_a_request_cost()` freezes both dates and the
   employee on every connection, so no UPDATE can ever move a row into or out of this
   constraint's way — only an INSERT, or a status change the approval story will make,
   and both are single statements that should be refused where they happen. */

ALTER TABLE leave_request
    ADD CONSTRAINT leave_request_never_overlaps
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&)
    WHERE (status IN ('SUBMITTED'));

/* The constraint builds its own GiST index, so there is nothing to add beside it.
   `leave_request_by_employee` and `leave_request_by_balance` stay: a b-tree on
   (employee_id, start_date DESC) is what a leave page reads and is a better plan for
   it than a GiST index on a range. */

-- Down Migration

ALTER TABLE leave_request
    DROP CONSTRAINT leave_request_never_overlaps;
