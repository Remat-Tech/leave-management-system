-- Up Migration

-- Holding one balance still while it is checked. FR 26, §8.2. LMS 212.
--
-- The story is two screens open at once. Somebody asks for five days on one and five
-- on the other, and both are checked against the same twelve days before either is
-- written down. Both look affordable. Ten days are held against a balance that
-- covered five of them twice.
--
-- Nothing in the schema so far prevents that, and nothing should have: LMS 210 made
-- every movement a row nobody can change, and LMS 211 made the cache of those rows
-- follow them in the same transaction. Neither is a rule about *whether a movement
-- should happen*, and the overdraft above is two entries that are each individually
-- correct. The rule that stops it is "check and write with nobody else in between",
-- which is a rule about a window rather than about a row.
--
-- ## One function, and it is the window
--
-- `SELECT ... FOR UPDATE` on the balance, taken before it is read and held until the
-- transaction ends. The second request blocks at that line, and when it resumes it
-- re-reads a balance that already has the first five days held against it — so it
-- is refused rather than granted twice.
--
-- ## Why it is a function and not a line of SQL in the repository
--
-- Because the application cannot write that line. `lms_app` holds SELECT on
-- `leave_balance` and no UPDATE — LMS 211 revoked the INSERT the default privileges
-- give and never granted the rest — and **every row locking clause Postgres offers
-- requires UPDATE**, `FOR KEY SHARE` included. The application asking for a row lock
-- directly is refused with a bare permission error.
--
-- That is the right position to be in rather than an obstacle to route around. The
-- alternative is granting `lms_app` UPDATE on the cache so that it can take a lock
-- it is never allowed to use, which would put a privilege in the grant table that
-- exists to be unused, and would make "the application cannot write a balance" a
-- sentence somebody has to read a trigger to confirm. So the privilege stays off,
-- and the one thing the application legitimately needs — *hold this still while I
-- look at it* — is a function that says so by name.
--
-- SECURITY DEFINER for that reason and no other. It reads one row and returns it. It
-- cannot write anything, and there is nothing to get wrong in a caller.
--
-- ## What it deliberately does not do
--
-- **It does not create the row.** A balance nothing has moved yet has no row, so
-- there is nothing to lock, and this returns nothing rather than opening one.
--
-- That is safe, and the reason is worth having in front of you rather than being
-- discovered later: where there is no row the balance is nought, so either the
-- reserve is refused — and two refusals do not race — or the leave type is one that
-- may be exceeded, FR 32a's sick leave, where there is no cap to race for in the
-- first place. The lock exists to protect a limit, and a balance with no rows has no
-- limit to protect. Opening a row here instead would put a line of zeros in the
-- cache every time somebody was refused, and `updated_at` on it would say something
-- had moved a balance that nothing had.
--
-- **It does not decide anything.** Whether the days are there is FR 26, and that is
-- ../src/domain/balance.ts; whether this person may move this balance at all is
-- ../src/auth/ledger-policy.ts. This function's whole contribution is that nobody
-- else may answer either question about this balance until the caller has finished.
--
-- **It does not enforce that the caller is in a transaction**, because it cannot: a
-- row lock outside one is taken and released by the same statement, and there is no
-- honest way for a function to ask whether its caller opened a transaction it did
-- not open itself. What makes that safe is that there is one caller —
-- `BalanceRepository.holdStill()` — and it is only reachable from inside
-- `Transactions.allOrNothing`, which is the seam that owns the transaction. See the
-- note there.

CREATE FUNCTION hold_one_balance_while_it_is_checked(
    for_employee BIGINT,
    of_leave_type BIGINT,
    in_leave_year BIGINT
) RETURNS SETOF leave_balance
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT *
      FROM leave_balance
     WHERE employee_id = for_employee
       AND leave_type_id = of_leave_type
       AND leave_year_id = in_leave_year
       FOR UPDATE;
$$;

/* Left executable by everybody, which is unusual for a SECURITY DEFINER function
   and is a property of what this one does rather than of who calls it. It returns a
   row the caller may already read and takes a lock they already have every right to
   wait behind. The worst an unexpected caller can do with it is make themselves
   wait. */

-- ------------------------------------------------------ what is deliberately not here

/* **No rule about how many days may be held.** The obvious next thought is a trigger
   refusing a RESERVATION that takes a balance negative, and it would be wrong for the
   reason LMS 211 declined to put a CHECK on any of the five figures: the write it
   refused would be the trigger's, and a rolled back trigger takes the ledger entry
   down with it. A movement that genuinely happened has to be recordable.

   It would also be wrong in a way that matters more here. FR 32a's sick leave is
   *meant* to go negative, §8.6b says so plainly, and a database rule would have to
   read `leave_type.exceedable_with_document` and branch on it — putting a leave
   policy in a trigger, where the one place responsible for it is supposed to be a
   service this story is named after.

   So the limit is checked above, inside the window this function holds open, and the
   database's contribution is the window. */

-- Down Migration

DROP FUNCTION IF EXISTS hold_one_balance_while_it_is_checked(BIGINT, BIGINT, BIGINT);
