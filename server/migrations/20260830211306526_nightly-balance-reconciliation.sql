-- Up Migration

-- Checking the cache against the record it is a cache of. §7.4. LMS 213.
--
-- Design principle 1 has been an assertion for three stories: "the ledger is the
-- truth; balances are a cache. If they ever disagree, the ledger wins and the balance
-- is rebuilt." LMS 211 made the cache a function of the ledger so that it should never
-- disagree. This is the story that stops "should never" being the whole of the answer.
--
-- The failure it exists to catch is not one anybody can name in advance — a trigger
-- disabled during a maintenance window, a restore from a backup taken between two
-- statements, a future migration that moves rows with `session_replication_role` set.
-- Every one of those leaves a balance that is quietly wrong and a ledger that is
-- quietly right, and the system carries on. The story's own sentence is the point: a
-- discrepancy caught by the system rather than discovered by an employee.
--
-- ## Two views, and no new arithmetic
--
-- `what_the_ledger_says` is the projection of §5.7 — which of the five columns each
-- kind of movement moves — lifted out of `rebuild_one_balance_from_the_ledger()` and
-- given a name. `balances_that_disagree_with_the_ledger` is that beside the cache,
-- with the rows that agree left out.
--
-- The lifting is the reason this is a migration rather than a service. LMS 210
-- declined to write the projection twice — "a total computed in two places is the
-- drift the cached balance exists to be checked against" — and a reconciliation that
-- computed its own expected figures would be exactly that second copy, with the
-- special property that it could only ever agree with itself. The rebuild function is
-- rewritten below to read the view, so there is still one definition and both the
-- writer and the checker use it.
--
-- ## Nothing here corrects anything
--
-- The third acceptance criterion, and it is why these are views rather than a
-- procedure. A view cannot write, so the job that reads it cannot silently put a
-- figure right and leave nobody any the wiser about how it got wrong.
--
-- That is a real temptation rather than a straw man. `rebuild_one_balance_from_the_ledger()`
-- is sitting right there, it is correct, and calling it for every disagreeing balance
-- would make the report empty. It would also destroy the evidence: the discrepancy is
-- the only sign that something in this system does not work, and a job that erases
-- that sign every night at two in the morning is a job that guarantees nobody ever
-- finds the cause.
--
-- So: report, alert, and leave it exactly as it is. Putting a balance right afterwards
-- is a person's decision, made having read the ledger, and it is a call to the rebuild
-- function or an ADJUSTMENT with a reason on it.

-- --------------------------------------------- the projection, lifted out and named

/* What the ledger says every balance is. §5.7's second table, and the only
   implementation of it anywhere.

   This is `rebuild_one_balance_from_the_ledger()`'s own aggregate with a name on it.
   Nothing about the arithmetic has changed — the same eight kinds, the same five
   columns, the same two wrinkles — and the whole change is that two callers can now
   read it instead of one having it inside itself.

   Worth restating here because a view is where somebody will read it: `taken` and
   `pending` are positive counts of movements the ledger records as negative, and
   DEDUCTION appears in both because approval moves days from one to the other rather
   than consuming them a second time.

   Balances with no movements do not appear, because a balance is a group of ledger
   rows and there are none. That is the honest shape and the join below is what makes
   it safe: a cached row with nothing behind it is a disagreement rather than a row
   with nothing to compare it to. */

CREATE VIEW what_the_ledger_says AS
SELECT
    employee_id,
    leave_type_id,
    leave_year_id,
    coalesce(sum(days) FILTER (WHERE entry_type = 'GRANT'), 0) AS entitled,
    coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
        AS carried_over,
    coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
    coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0) AS taken,
    coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
        FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0) AS pending
FROM leave_ledger_entry
GROUP BY employee_id, leave_type_id, leave_year_id;

-- ------------------------------------------ the writer, now reading the same view

/* `rebuild_one_balance_from_the_ledger()`, with its arithmetic replaced by a read of
   the view above and nothing else changed.

   Replaced rather than left alone, because leaving it alone is what would create the
   second copy this file exists to avoid. The cached-balance-table migration is not
   edited — it never is once merged — so the function it declared is redefined here,
   and the down section puts its original body back.

   The lock still comes first and the sums still come second, for the concurrency
   reason that migration sets out at length: written as one statement with the
   aggregate inside the upsert, two transactions posting against one balance would
   each read the ledger before either took the lock.

   The join is a LEFT JOIN onto a single row of the three ids, so that a balance with
   no ledger entries at all still produces one row of noughts rather than no row and
   no update. That is not a case the trigger can reach — it fires after an insert, so
   there is always at least one entry — but a rebuild called by hand for a balance
   whose entries have gone is exactly the situation somebody would be calling it in,
   and leaving stale figures behind would be the worst possible moment to do nothing. */

CREATE OR REPLACE FUNCTION rebuild_one_balance_from_the_ledger(
    for_employee BIGINT,
    of_leave_type BIGINT,
    in_leave_year BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM set_config('lms.balance.from_the_ledger', 'on', true);

    INSERT INTO leave_balance (employee_id, leave_type_id, leave_year_id)
    VALUES (for_employee, of_leave_type, in_leave_year)
    ON CONFLICT ON CONSTRAINT leave_balance_one_per_year
        DO UPDATE SET employee_id = leave_balance.employee_id;

    UPDATE leave_balance SET
        entitled = coalesce(totals.entitled, 0),
        carried_over = coalesce(totals.carried_over, 0),
        adjustment = coalesce(totals.adjustment, 0),
        taken = coalesce(totals.taken, 0),
        pending = coalesce(totals.pending, 0)
    FROM (SELECT for_employee AS employee_id, of_leave_type AS leave_type_id,
                 in_leave_year AS leave_year_id) AS asked
         LEFT JOIN what_the_ledger_says AS totals
              USING (employee_id, leave_type_id, leave_year_id)
    WHERE leave_balance.employee_id = for_employee
      AND leave_balance.leave_type_id = of_leave_type
      AND leave_balance.leave_year_id = in_leave_year;

    PERFORM set_config('lms.balance.from_the_ledger', '', true);
END
$$;

-- ------------------------------------------------------------- what disagrees, and how

/* Every balance where the cache and the ledger do not say the same thing.

   A FULL OUTER JOIN rather than a join from either side, because there are three
   shapes of disagreement and only one of them is the obvious one:

     **The figures differ.** A cached column that has drifted from the movements
     behind it. What anybody imagines when they hear "reconciliation".

     **The ledger has movements and there is no cached row.** Worse, and invisible
     from the balance table: somebody's balance simply does not exist, so every screen
     shows them nought days and the ledger says otherwise. A join starting from
     `leave_balance` would never find it.

     **A cached row has no movements behind it.** Figures with nothing to explain
     them, which is the one state design principle 1 exists to make impossible.

   `has_cached_row` is what tells the second apart from a genuine row of noughts. Both
   read as "the cache says nought", and they are different faults with different
   causes.

   The employee number, the leave type name and the leave year label are joined in
   because the report is read by a person. Three bigints are a row somebody has to go
   and look up before they can act; "RH-0042, Annual leave, 2026" is one they can act
   on. The employee's name is deliberately not among them — the number is the handle
   every report and import in this system already uses, and an alert that may sit in a
   mailbox or be forwarded is not a place to accumulate staff details it does not
   need. */

CREATE VIEW balances_that_disagree_with_the_ledger AS
SELECT
    coalesce(cached.employee_id, ledger.employee_id) AS employee_id,
    employee.employee_number,
    coalesce(cached.leave_type_id, ledger.leave_type_id) AS leave_type_id,
    leave_type.name AS leave_type_name,
    coalesce(cached.leave_year_id, ledger.leave_year_id) AS leave_year_id,
    leave_year.label AS leave_year_label,

    (cached.id IS NOT NULL) AS has_cached_row,

    coalesce(cached.entitled, 0) AS cached_entitled,
    coalesce(ledger.entitled, 0) AS ledger_entitled,
    coalesce(cached.carried_over, 0) AS cached_carried_over,
    coalesce(ledger.carried_over, 0) AS ledger_carried_over,
    coalesce(cached.adjustment, 0) AS cached_adjustment,
    coalesce(ledger.adjustment, 0) AS ledger_adjustment,
    coalesce(cached.taken, 0) AS cached_taken,
    coalesce(ledger.taken, 0) AS ledger_taken,
    coalesce(cached.pending, 0) AS cached_pending,
    coalesce(ledger.pending, 0) AS ledger_pending
FROM leave_balance AS cached
FULL OUTER JOIN what_the_ledger_says AS ledger
    ON ledger.employee_id = cached.employee_id
   AND ledger.leave_type_id = cached.leave_type_id
   AND ledger.leave_year_id = cached.leave_year_id
JOIN employee ON employee.id = coalesce(cached.employee_id, ledger.employee_id)
JOIN leave_type ON leave_type.id = coalesce(cached.leave_type_id, ledger.leave_type_id)
JOIN leave_year ON leave_year.id = coalesce(cached.leave_year_id, ledger.leave_year_id)
WHERE coalesce(cached.entitled, 0) <> coalesce(ledger.entitled, 0)
   OR coalesce(cached.carried_over, 0) <> coalesce(ledger.carried_over, 0)
   OR coalesce(cached.adjustment, 0) <> coalesce(ledger.adjustment, 0)
   OR coalesce(cached.taken, 0) <> coalesce(ledger.taken, 0)
   OR coalesce(cached.pending, 0) <> coalesce(ledger.pending, 0)
   OR cached.id IS NULL;

/* The last clause is not redundant with the five above it, and the case it catches is
   the one worth catching: a balance whose ledger entries all net to nought — a
   reservation and the release that gave it back — with no cached row. Every figure
   agrees at nought and the row still should exist, because the trigger should have
   opened it. It is the mildest possible symptom of the most serious possible fault,
   which is the trigger not having fired. */

-- ---------------------------------------------------------------------- privileges

/* Read, and only read, exactly as `leave_balance` is.

   The default privileges grant SELECT and INSERT on every new table and a view counts
   as one. An INSERT on either of these would fail anyway — neither is an updatable
   view — but a privilege that is only prevented by the shape of a query is one that
   starts working the day somebody simplifies the query. The reconciliation reads and
   does nothing else, and this is that sentence in the grant table. */

REVOKE INSERT ON what_the_ledger_says FROM lms_app;
REVOKE INSERT ON balances_that_disagree_with_the_ledger FROM lms_app;

GRANT SELECT ON what_the_ledger_says TO lms_app;
GRANT SELECT ON balances_that_disagree_with_the_ledger TO lms_app;

-- ------------------------------------------------------- what is deliberately not here

/* **No schedule.** "Nightly" is a cron line, and this build has no process to hang one
   on: there is no server entry point, no route layer and no scheduler, and inventing
   one to hold a single job would be inventing more infrastructure than the job. What
   this story ships is the check and the alert, in ../src/jobs/, ready for the first
   thing that runs on a timer. The README says which line.

   **No record of the runs.** A `reconciliation_run` table holding "checked at 02:00,
   found nothing" is a real thing to want — it is the difference between "no news" and
   "the job has not run since Tuesday" — and it is a different story with a screen in
   it. What this ships alerts when something is wrong; noticing that the alert itself
   has gone quiet is monitoring, and monitoring is Phase 6.

   **No correction.** Said again here because this is where somebody will come looking
   for it. The rebuild function above will put any balance right, one call, and the job
   deliberately does not call it. See the note at the top. */

-- Down Migration

DROP VIEW IF EXISTS balances_that_disagree_with_the_ledger;

/* The rebuild function goes back to the body the cached-balance-table migration gave
   it, aggregate and all, because that is the state this migration found it in. A down
   section restores the previous state rather than the state somebody would prefer —
   and the view it currently reads is dropped below, so leaving it as it is would leave
   a function that cannot run. */

CREATE OR REPLACE FUNCTION rebuild_one_balance_from_the_ledger(
    for_employee BIGINT,
    of_leave_type BIGINT,
    in_leave_year BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM set_config('lms.balance.from_the_ledger', 'on', true);

    INSERT INTO leave_balance (employee_id, leave_type_id, leave_year_id)
    VALUES (for_employee, of_leave_type, in_leave_year)
    ON CONFLICT ON CONSTRAINT leave_balance_one_per_year
        DO UPDATE SET employee_id = leave_balance.employee_id;

    UPDATE leave_balance SET
        entitled = totals.entitled,
        carried_over = totals.carried_over,
        adjustment = totals.adjustment,
        taken = totals.taken,
        pending = totals.pending
    FROM (
        SELECT
            coalesce(sum(days) FILTER (WHERE entry_type = 'GRANT'), 0) AS entitled,
            coalesce(sum(days) FILTER (WHERE entry_type IN ('CARRY_FORWARD', 'EXPIRY')), 0)
                AS carried_over,
            coalesce(sum(days) FILTER (WHERE entry_type = 'ADJUSTMENT'), 0) AS adjustment,
            coalesce(sum(-days) FILTER (WHERE entry_type IN ('DEDUCTION', 'RECALCULATION')), 0)
                AS taken,
            coalesce(sum(CASE WHEN entry_type = 'DEDUCTION' THEN days ELSE -days END)
                FILTER (WHERE entry_type IN ('RESERVATION', 'DEDUCTION', 'RELEASE')), 0)
                AS pending
        FROM leave_ledger_entry
        WHERE employee_id = for_employee
          AND leave_type_id = of_leave_type
          AND leave_year_id = in_leave_year
    ) AS totals
    WHERE leave_balance.employee_id = for_employee
      AND leave_balance.leave_type_id = of_leave_type
      AND leave_balance.leave_year_id = in_leave_year;

    PERFORM set_config('lms.balance.from_the_ledger', '', true);
END
$$;

DROP VIEW IF EXISTS what_the_ledger_says;
