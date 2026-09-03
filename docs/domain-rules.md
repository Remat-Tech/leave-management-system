# Leave rules, and the ones that will bite you

Every rule the system enforces about leave: what a type is worth, how a day is
counted, how a balance moves, and what a request may do. Written when each was
decided, and kept because the reasoning is the part that is expensive to rebuild.

Grouped roughly by the feature folder that owns it — see **Where things live** in
the README.

---

## Things that will bite you if you do not know them

These are the load bearing decisions. The reasoning is in the Technical Design Document, section 1.

**The ledger is the truth, balances are a cache.** Every day added to or removed from a balance is an immutable row in `leave_ledger_entry`. The `leave_balance` table is a running total kept alongside it for fast reads. If they ever disagree, the ledger wins and the balance is rebuilt. **Never update a balance directly.**

Since LMS 211 that last sentence is not advice. `lms_app` holds SELECT on
`leave_balance` and no INSERT, every column is `never` for insert and update in
`db/schema.ts` so a write does not compile, and a trigger refuses one from the owner
connection as well. The figures are recomputed from the ledger, in the transaction
of the entry that moved them, by the one function that knows the projection. See
[The cached balance](#the-cached-balance).

**And there is one place that moves days.** `BalanceService`, since LMS 212 — reserve,
commit, release, adjust and correct, each of them locking the balance while it decides.
Nothing else in the tree posts a ledger entry, and a unit test reads the source to
keep that true. A story that needs a movement it does not offer adds a method there
rather than a second way in. See [One place a balance
changes](#one-place-a-balance-changes).

**And the two are compared every night.** Since LMS 213 a job recomputes every balance
from the ledger and alerts HR about anything that disagrees — deliberately without
correcting it, because the discrepancy is the only evidence of how it arose. See
[Checking the cache against the
record](#checking-the-cache-against-the-record).

**Days first arrive from a rule.** LMS 214 grants a year's entitlement as a `GRANT`
entry, once per balance per year, from the figure in force on the first day of that
year. See [The annual grant](#the-annual-grant).

Since LMS 210 the first half of that exists. `leave_ledger_entry` attaches to what
LMS 113 already built, exactly as that story predicted it would: `refuse_update()`
and `refuse_delete()` are named for the job rather than for the table, so an
append-only ledger was two triggers and no new machinery. See
[The audit log](#the-audit-log) and [The balance ledger](#the-balance-ledger).

What is still not built is `leave_balance`, the cache the first sentence is about.
Nothing yet computes what somebody may book — see the ledger section for why a run
of signed days is not that figure.

**Policy is data, not code.** Every entitlement figure, threshold and notice period lives in a table with an effective date. Nobody should ever ship a release because HR changed an allowance.

**Pending days are reserved.** Submitting a request writes a `RESERVATION` entry immediately. This is what stops somebody with five days left having three separate five day requests in flight.

**Only the state machine moves a request.** All transitions go through one service method with one authorisation check and one audit write. No route mutates `leave_request.status`.

**Counting basis and approval chain vary by leave type.** Annual, sick and compassionate count working days; maternity and paternity count calendar days. Most types go manager then HR; unpaid leave goes HR then CEO. Both are configuration. If either appears as an `if` on a type code, that is a bug.

Since LMS 201 the first half of that is a table, `leave_type`, and since LMS 204
the second is `leave_type_approval_step` beside it. Both are set out further down.

Since LMS 207 the first half is also *read* that way. `countLeaveDays()` is one
walk over the days of a period with one branch inside it, and the branch asks
`countsWorkingDays()` — never `type.code`, which the file does not import and which
`unit/leave-calculator.test.ts` checks it does not mention. A leave type HR adds
next year counts correctly the moment the row exists, which is the test of whether
FR 31 was achieved rather than merely described. See [The day
calculator](#the-day-calculator).

FR 48 — which person a chain's desk resolves to, and what happens when the request
reaches them — is [LMS 314](#routing-a-request-to-its-approvers) and
[LMS 319](#nobody-approves-their-own-request). FR 48b is the reciprocal and is
[LMS 320](#routing-round-an-approver-who-cannot-decide): a stage its own desk cannot
answer is skipped to the one desk that stands in for it, and where neither can be
filled the request is `UNROUTABLE` with an alert rather than approved by nobody.

**Everything is a whole number of days.** FR 24. Half days are settled between an
employee and their manager, come off no balance, and are not in this system at all.
There is no fraction anywhere: not in a column, not in a field, not in an argument.

Since LMS 209 that is a rule rather than a habit, and it is held up in three places
because it can be broken in three ways.

| | Holds | Checked by |
|---|---|---|
| `shared/whole-days.ts` | `isWholeDays()`, the one predicate every figure in days is asked | `unit/whole-days.test.ts`, over every entry point that takes one |
| the migrations | no column of any table can hold a fraction, and none is a half day flag | `unit/migrations.test.ts`, read out of the SQL |
| `server/src` | nothing in the API is named for a half day | `unit/whole-days.test.ts`, read out of the source |

**A fraction is refused where it arrives, never rounded.** There is deliberately no
`roundToWholeDays()`. Half a day rounded up is a day somebody did not take and is
charged for; rounded down it is a day the company gives away; and neither announces
itself — the number simply comes out slightly wrong, in a system whose whole claim
is that the number can be explained. So `0.5` is refused at the boundary, while the
person still has the form open and can say what they meant.

**The schema holds no fractional type at all.** §5.5 and §5.7 of the Technical
Design Document specify `NUMERIC(5,2)` for `day_count` and `NUMERIC(6,2)` for every
balance column, "kept only so that a future policy change does not need a
migration". This build declines that, and §7.3's own note is the reason: `day_count`
"is always an integer despite its numeric type". A column that must never hold a
fraction, in a type that permits one, is a rule with nothing enforcing it — and
widening `INTEGER` on the day the policy actually changes is a three line migration.
`leave_type.allows_half_day` from §5.5 is absent for the same reason: a switch with
nothing behind it is a switch somebody eventually wires up.

**The one figure FR 24 does not govern is a pro rated entitlement**, and it is worth
and it is the one exception. §8.6d gives a 1 July joiner 10.08 days and says plainly
that FR 24 "governs how leave is requested, not how entitlement is held".
`entitlement_days` still holds no fraction — that is the rule's figure, always 20 or
3 or 120 — but `leave_ledger_entry.days` does, because the fraction appears when the
grant is calculated and the ledger is where a grant is recorded.

Since LMS 215 that calculation exists: `features/entitlement/pro-rata.ts`, and it is the one place in
this system where rounding a number of days is right rather than refused. It rounds to
the hundredth, which is the ledger column's own precision and the precision §8.6d quotes
its example to. See [Pro rating a part year](#pro-rating-a-part-year).

LMS 209 wrote the rule down before there was anything to except from it, and said
what the answer would have to be: allow that column by name and leave every other
one integral. LMS 210 is that answer, and it comes with a condition the ledger
enforces inside the column — the four entry types that follow a leave request are
held to whole days by a constraint of their own. So the exception buys a fractional
*entitlement*, never fractional *leave*, and the day somebody makes a request's day
count a `NUMERIC` for symmetry it still fails.

**And LMS 211 pays the same price in a different currency.** `leave_balance` is
where those movements are added up, so three of its five columns inherit the
fraction — `entitled` is a pro rated grant, `carried_over` is a proportion of one
that survived a year end, `adjustment` is HR putting either right. The other two are
`INTEGER`, where §5.7 asks for `NUMERIC(6,2)` on all five: `taken` and `pending` are
sums of the four request-shaped entry types alone, which cannot be fractional. The
line LMS 210 drew inside one column is drawn again between two columns, where the
schema shows it rather than a constraint enforcing it out of sight.

**Dates are dates.** Leave dates are calendar dates with no time and no timezone. Everything else is UTC. Mixing these up is the most common source of off by one day bugs in leave systems.

The two rules, said plainly, because almost every such bug is the two being
confused:

| | Is | Stored as | Carried as | Shown as |
|---|---|---|---|---|
| An instant — signed in at, expires at, occurred at | a moment in time, the same moment everywhere | `timestamptz`, which is UTC | a `Date` | the reader's zone, `DISPLAY_TIMEZONE` |
| A date — started on, left on, away from | a day, with nothing in it for a zone to move | `date` | the ten characters `YYYY-MM-DD` | itself, unconverted |

**Never turn a calendar date into an instant, and never turn an instant into a
calendar date without saying where.** `new Date('2026-07-31')` is midnight UTC,
which is the thirtieth of July in Accra by an hour and in New York by five, and
it is how a leaver acquires an exit date one day either side of the one on their
letter. `server/src/shared/time.ts` holds both rules, and there is exactly one
function in it that crosses between the two — `calendarDateIn()`, which will not
do it without a zone.

Four things hold that up, and it is worth knowing which covers what:

| | Covers | Does not cover |
|---|---|---|
| the `date` type parser in `server/src/db` | a `date` arriving as `'2026-07-31'` instead of a `Date` at midnight UTC, on every read | what the *server* renders it as, which is `DateStyle` |
| `server/src/db` setting `TimeZone` and `DateStyle` on every pooled connection | the running application, whatever the host is set to and whether or not the migration has run | psql, the seed, a migration correcting data |
| the timestamps-in-utc migration, on the role and on the database | every connection to this database, owner included — which is what keeps an audit snapshot's timestamps comparable between two writers | a host that will not permit the `ALTER DATABASE`, where it warns and the first two still hold |
| `unit/migrations.test.ts` and `integration/time.test.ts` | a *future* table declaring a moment without a zone, or a leave date with a time on it — the ledger, the request, the balance | nothing; it is the backstop, and it is a test because the only thing in Postgres that sees DDL is an event trigger and those need a superuser |

Compare dates as strings; for `YYYY-MM-DD` that is the same comparison, and it is
most of why the form is fixed. `DateStyle` being pinned to `ISO, YMD` is what
makes that safe rather than usually safe: the parser hands back the characters
the server sent, and a host set to `German, DMY` would send `01.09.2026` and
every date comparison in `/domain` would quietly begin comparing the day of the
month first.

**The display timezone is a setting and moves nothing.** `DISPLAY_TIMEZONE`
defaults to `Africa/Accra` and is read by `displayTimezone()`. It is one zone for
the company rather than one per person, deliberately — somebody travelling wants
their leave to read the same as it does to the colleague approving it. A name
this Node does not know is refused rather than quietly falling back, because
`Africa/Akkra` silently becoming Accra is right this once and wrong the day
somebody sets `Europe/Lisbon` and means it.

Accra is UTC+0 all year and observes no daylight saving, which makes it a correct
default to ship and a useless one to test against: a suite that only ever ran
there would pass with every conversion deleted. `unit/time.test.ts` therefore does
its arithmetic in Kiritimati, Niue, Tokyo and London, on both sides of midnight
and across a clock change.

**`updated_at` is maintained by a trigger, not by the writer.** The
`set_updated_at()` function is deliberately named for the job rather than for the
table that first needed it. A new table with an `updated_at` column attaches a
`BEFORE UPDATE` trigger to that same function rather than declaring its own copy.
There is more than one writer — the application, the seed, and a migration
correcting data — and only one of them would have remembered to set the column.

**Employees are deactivated, never deleted.** Somebody who leaves is
`employment_status = 'TERMINATED'` with an `exit_date`, set through
`EmployeeService.terminate()`. The row stays, keeping the id that all of their
leave history points at, because a dispute about a balance settled two years ago
is answered by rows that reference them. FR 06.

Three things enforce that, and it is worth knowing which covers what:

| | Covers | Does not cover |
|---|---|---|
| `lms_app` holds no `DELETE` on `employee` | the running application | anything on the owner connection |
| the `employee_never_deleted` trigger | every connection, owner included | `TRUNCATE`, which the seed needs and which `lms_app` was never granted |
| `server/tests/unit/employee-never-deleted.test.ts` | the delete being *written* — a repository call, raw SQL, a `DELETE /employees/:id` route | anything that reaches the database by a route it does not recognise |

The trigger calls `refuse_delete()`, which like `set_updated_at()` is named for
the job rather than the table and reads `TG_TABLE_NAME` for its message. LMS 113
took it at its word: `audit_log` attaches to the same function rather than
declaring its own `RAISE`, and gained a sibling, `refuse_update()`. LMS 210's
ledger attaches to both. Both raise `restrict_violation` (SQLSTATE `23001`), so a
caller can tell a refused write from a genuine fault without reading the message
text.

**The hint is the caller's, since LMS 210.** `refuse_delete()` used to hard code the
employee sentence — "deactivate the record instead" — which was right while
`employee` was the only table refusing a delete and was quietly wrong on `audit_log`
from the day it attached. It now takes `TG_ARGV[0]` with that sentence as the
default, the shape `refuse_update()` has always had, so each table says what to do
instead of its own accord: post a compensating entry, on the ledger.

If a hard delete is ever genuinely needed, drop the trigger in a migration,
delete the row, and restore the trigger in the same migration. That makes it a
deliberate act with a written reason, which is the entire point.

**Every employee has exactly one line manager, and exactly one employee has
none.** `managerId` is required when a record is created, and required in the
type rather than only at runtime. `null` is the head of the organisation saying
so, which is a deliberate thing to state and not the same as having left the
field out — the second is refused. FR 02 and FR 04.

The reason is routing. A record with no manager is a record whose leave requests
have nowhere to go, and it is found by the employee whose request vanishes rather
than by the HR officer who created it.

**And a reporting line never loops.** `A -> B -> C -> A` is the one bad state in
this table that nothing downstream survives: FR 04 gives the tree a single root
so that a walk upward terminates, and a loop makes it not terminate. A request
going round one is never approved, never rejected and never seen again. FR 03.

| | Covers | Does not cover |
|---|---|---|
| the `employee_one_root` partial unique index | a second manager-less record, on every connection | a table with *no* root, which no per-statement rule can hold |
| `employee_manager_id_fkey`, `employee_not_own_manager` | a manager who is nobody, and the loop of length one | any longer loop |
| `EmployeeService.checkManager()` | all of the above said in words HR can act on, a manager who has already left, and any loop — by walking up from the proposed manager and looking for the employee | anything that does not go through the service |
| the `employee_no_manager_cycle` constraint trigger | every loop, on every connection, including a bulk import | nothing; it is the backstop |
| `EmployeeService.reportingLineWarnings()` | a manager who leaves *afterwards*, reported as a standing check | nothing; it refuses nothing, because everything it finds is already true |

Three of those deserve knowing before they are needed.

**The cycle trigger is deferred, and that is the whole point of it.** It is a
`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, so it fires at `COMMIT`
rather than per row. A row trigger sees the table half changed: swapping a
manager and their report over is a legitimate restructure whose final state is a
good tree, but whichever row is written first leaves a loop standing until the
other one is written. Checked per row, that legitimate change is refused;
checked at commit, only the state that will actually be stored is judged. The
cost is that a bulk import is told it contains a loop rather than which line of
the file holds it — the right way round, because the service walks first and
knows the answer before it writes anything.

It covers `INSERT` as well as `UPDATE`, which looks redundant and is not: a
foreign key is itself an `AFTER ROW` trigger that fires at the end of the
statement, so a single multi-row `INSERT` can put two rows in that name each
other and satisfy the key. Verified against Postgres 17 rather than reasoned
about.

**Succeeding the head of the organisation is one transaction, not two
statements.** FR 03 and FR 04 between them leave no order that works a statement
at a time: clearing the incoming head's line first makes two rootless records,
and giving the outgoing head theirs first makes the two point at each other. Nor
is there a third move — any manager the outgoing head could be given is somebody
below them, and below them is where the loop comes from. Inside one transaction
the loop stands for exactly one statement, which the deferred trigger permits,
while the rootless count goes 1 → 0 → 1 and never reaches the two the index would
refuse:

```sql
BEGIN;
UPDATE employee SET manager_id = :incoming WHERE id = :outgoing;
UPDATE employee SET manager_id = NULL      WHERE id = :incoming;
COMMIT;
```

`EmployeeService` cannot express that — every method there is a single
autocommitted statement — so a `succeedHead()` is wanted and is not written. The
integration suite pins the transaction so the shape is recorded rather than
rediscovered.

**"A manager who is still here" is not a constraint, and cannot be.** It is a
rule about the current state of a different row, and that row changes without
this one being touched. The manager who is here today leaves in March, and a
constraint satisfied when it was checked is quietly false thereafter. So it is
refused when the line is drawn and *reported* when it drifts, which is the whole
job of `reportingLineWarnings()` — a read, safe from a dashboard or a nightly
job, returning an empty list when every employee has somewhere for their requests
to go.

One thing is deliberately absent: **re-parenting when a manager leaves**.
`terminate()` does not move the leaver's reports onto anybody, because who they
should go to is a decision rather than a rule, and guessing it in the termination
path is how a whole team silently ends up reporting to the CEO.

**And the whole of it is drawn, because some faults are only visible as a
shape.** `EmployeeService.orgChart()` builds the tree from `manager_id` and
nothing else. It is the other half of `reportingLineWarnings()` and catches a
different mistake: a warning finds the manager who has left, and only a chart
finds the new starter put under the wrong team lead — nothing is *invalid* about
that record, it is simply in the wrong place, and being in the wrong place is a
thing you see rather than a thing you check. FR 09.

**Everybody appears exactly once**, which is the property the whole of
`server/src/features/employee/org-chart.ts` is built around. A chart that quietly drops the
people it could not place looks correct precisely when the organisation is not,
and the person it drops is the one whose manager is missing. So there is one list
of roots, everybody hangs off one of them, and a root that should not be a root
carries a `concern` saying why:

| Standing | What it means | Where it comes from |
|---|---|---|
| `HEAD_OF_THE_ORGANISATION` | no line manager, because there is nobody above them | FR 04, and the only root that is not a fault |
| `SECOND_HEAD` | a second record with no line manager | a database restored from before `employee_one_root` |
| `MANAGER_NOT_ON_THE_CHART` | their manager is not among the records charted | a chart of one department, or of only the currently employed |
| `REPORTING_LINE_LOOPS` | the line goes round in a circle, so no walk up it terminates | FR 03, refused by the deferred trigger and drawn anyway |

The last two are the useful ones, and the loop is rooted at somebody actually
*in* the loop rather than at the first unplaced record — those are often different
people, and rooting it at the person the loop has trapped would name the fault
against the wrong record.

**Leavers are on the chart.** A chart of only the currently employed would drop a
manager who has left and leave their team hanging off nobody, which is the exact
condition the story exists to catch and the one it would then hide. They are
marked rather than absent.

**There is no depth limit and no recursion.** The tree is built and drawn with
explicit stacks, so five levels is a fact about the fixtures rather than a
ceiling, and a loop — which is an infinitely deep line until something bounds it —
is charted with a warning on it instead of overflowing the stack. `unit/org-chart.test.ts`
builds fifty thousand levels to keep that honest.

Two renderings ship with it because there is no front end yet and a chart nobody
can look at is not a chart: `renderOrgChart()` for anywhere text goes — a support
request, a nightly job, an email to the officer asking why a request has not
arrived — and `renderOrgChartAsMermaid()` for anywhere a diagram can be drawn,
which is a pull request or a document. Both are pure functions of the tree, and so
is the screen that eventually joins them.

```bash
npm run chart   # the fixture organisation drawn, and then broken on purpose
```

That is `server/tests/walkthrough/org-chart.ts`, and it exists because a chart is
judged by looking at it. It builds a disposable database, draws the organisation
at five levels, has the team lead leave, and shows what the same chart looks like
with the leavers taken off it.

**Every employee is in exactly one department, and a department is closed rather
than deleted.** `employee.department_id` is `NOT NULL`, and `departmentId` is
required on `NewEmployee` in the type rather than only at runtime. There is no
`null` and no exception for anybody — unlike the line manager, where the head of
the organisation genuinely has nobody above them, everybody is in some team
including them. The reason is the story's own: leave is reported and planned by
team, and somebody in no team appears in no team's figures. They are not visibly
missing either, which is the worse half — a headcount by department that quietly
adds up to less than the company.

Which team somebody is in and who they report to are separate facts. Moving
between teams is an ordinary `EmployeeService.update({ departmentId })` and does
not touch the reporting line; the two are edited independently and neither
implies the other.

A department has one ending, `DepartmentService.deactivate()`, and two rules keep
an employed person out of a closed team from both directions:

| | Refuses |
|---|---|
| `assertCanTakeEmployees()`, on create and on transfer | moving somebody into a closed department |
| `assertCanDeactivate()`, with the headcount | closing a department somebody is still employed in, and says how many to move |

That pair is not belt and braces. `employee.department_id` is `NOT NULL`, so
closing a team cannot move the people out of it — they would go on being counted
under a heading no report offers as a choice. Between them the two leave one gap,
which the service closes explicitly: reinstating a leaver whose team was wound up
while they were gone re-checks the department, because nobody edited their record
when it closed and so no write-time check ever ran on it.

**A leaver is not counted, and may sit in a closed team.** They stay in the
department they left from — FR 06 keeps every other field of their record too —
and they are no bar to closing it, because they are not going to raise a request
that has to appear under a team heading. The same latitude is what makes history
importable: a leaver may be *created* into a closed department, which a stricter
rule would make impossible.

**`lms_app` lost its `DELETE` on `department`.** The organisation migration
granted it before anything used the table and never argued for it; the
department-rules migration takes it back, because leaving a live delete path
beside `deactivate()` would give the application two endings, one of them
undocumented. This is deliberately a shade weaker than `employee`, which refuses
the owner connection too — there the foreign key protects everything that
matters, since a department anybody is in cannot be deleted by anyone at all, and
what stays deletable is a department nobody has ever been in. That is the typo
created on a Tuesday afternoon, and being able to remove it is worth more than
the symmetry.

**Everybody works a week, and the week is seven rows.** `employee.work_pattern_id`
is `NOT NULL`, because a day count has to know which days somebody works. Abena
Sarpong works Monday, Tuesday, Thursday and Friday: a week off costs her four
days rather than five, and a public holiday on a Wednesday costs her nothing.
FR 23. Which Wednesdays those are is a table too, since LMS 206 — see [The public
holiday calendar](#the-public-holiday-calendar).

A pattern is stored as **seven `work_pattern_day` rows**, one per ISO weekday
(1 is Monday), each saying whether it is worked — never as only the days that
are. A missing row leaves "does this Saturday cost a day" to whichever join the
counting query happened to use, which is a decision nobody made on purpose. The
`work_pattern_week_complete` trigger refuses a pattern that names fewer than
seven, and one that works none of them.

**The standard Monday to Friday week is reference data, not fixture data.** It is
inserted by the working-pattern-rules migration, next to `role`, because a
production database is migrated and never seeded and no employee can be created
without a default to stand in. The seed owns only the *second* pattern, the part
timer's, which exists to make the counting tests honest rather than to make the
system work — and it no longer truncates `work_pattern`, because that would
delete reference data every time somebody reloaded the fixtures.

**Exactly one pattern is the default**, held by the same pair as the one root
employee and with the same division of labour:

| | Covers | Does not cover |
|---|---|---|
| the `work_pattern_one_default` partial unique index | a second default, immediately, on every connection | a table with *no* default |
| the `work_pattern_always_has_a_default` constraint trigger | the last default being deleted or cleared, at `COMMIT` | `TRUNCATE`, which no row trigger sees and `lms_app` was never granted |

Both deferred triggers exist to **permit a legitimate intermediate state**, which
is the only reason either can be deferred. Changing the default clears the old
one and sets the new one, passing through no default for one statement; changing
a week deletes seven day rows and writes seven more, naming no days in between.
Checked per statement, both ordinary operations are refused. Checked at commit,
only the state that will actually be stored is judged. Neither works as two
autocommitted statements, so `WorkPatternRepository` opens a transaction for
each.

**A pattern is deleted, not deactivated** — the opposite of a department, and
deliberately. A department heading outlives the team and appears on last year's
report, so it is closed; a pattern is a current fact about a week and nothing
points at an unused one. `lms_app` therefore keeps its `DELETE` here. What stays
reachable is only the pattern nobody works: `employee.work_pattern_id` has no
cascade, so a pattern anybody is on cannot be deleted by anyone at all, and the
trigger above holds the default.

**A leaver counts as somebody on a pattern**, unlike a department's headcount
where they do not. FR 37a settles a leaver's final figure by counting days
against the week they worked, so their pattern is still load bearing after they
have gone.

**Every rule that differs between annual leave and maternity leave is a column
of `leave_type`.** FR 21, FR 31, FR 32 and §5.5. FR 31 puts it in the strongest
terms the SRS uses — "No leave rule shall require a code change or a deployment"
— and design principle 5 of the Technical Design Document says what happens if
that is not honoured: "If either is written as an `if` on a type code, every
future leave type becomes a code change."

| Column | What it decides | Why it is not an assumption |
|---|---|---|
| `counting_basis` | WORKING_DAYS or CALENDAR_DAYS — whether the working pattern is consulted at all | a weekend inside a fortnight off is free for annual leave and is not for maternity. FR 21, FR 22 |
| `entitlement_basis` | QUOTA or EVENT — whether the year rollover opens a `leave_balance` row | "you have three days left" means nothing about a bereavement. FR 32g |
| `is_paid` | which column of the liability report it lands in | FR 63; the two unpaid types are the exception |
| `unit` | DAYS, WEEKS or MONTHS — how the allowance is *said* | "4 months, 120 days" reads as months and is counted in days. FR 24 |
| `documentation` + `documentation_after_days` | whether *this request* needs something attached, always or past a length | FR 13 |
| `exceedable_with_document` | whether exceeding the *yearly balance* asks for evidence instead of refusing | FR 32a: sick leave's three days is "a documentation threshold, not a hard cap" |
| `entitlement_expiry_months` | how long after the event an unused grant lapses | FR 32e; paternity's six months, and **not** carry over |
| `may_be_split` | whether one grant may be drawn down by several requests | §8.6aa; true everywhere today, maternity included |
| `min_notice_calendar_days` | how much notice is *expected* | FR 17; fourteen for annual leave, nothing elsewhere |
| `max_backdate_calendar_days` | how late it may still be entered | FR 18; seven everywhere |
| `gender_restriction` | who is eligible | FR 05, and the reason `employee.gender` is nullable rather than required |
| `deducts_from_annual` | nothing, ever | FR 33, as a CHECK rather than the TDD's "must stay FALSE" comment |

**`code` is a handle, never a branch.** It is what a report from last year and a
staff import column join on, so it survives HR rewording "Annual Leave" to
"Vacation". Nothing above the database may read it and decide anything.
`unit/leave-type.test.ts` ends by configuring two types with the same code and
opposite rules and asserting they behave oppositely, which is design principle 5
stated as something that can fail.

**Notice warns; backdating refuses.** The two windows look symmetrical and are
not, and this is the pair most likely to be got backwards. FR 17: a short notice
annual leave request is warned about, acknowledged, and *allowed through*,
"since whether short notice is workable is a judgement for the approvers". FR 18:
beyond the backdating window the employee may not enter the record at all and
"only HR may enter the record, with a reason". So `noticeShortfall()` returns a
number and `assertWithinBackdatingWindow()` throws. Annual leave carries both
windows at once — fourteen days of notice and seven of backdating — so any rule
holding them to be mutually exclusive would make the one type everybody uses
unconfigurable.

**A documentation threshold is not a balance threshold.** `AFTER_DAYS` asks for a
document when *this request* is longer than n days. `exceedable_with_document`
asks for one when the request would take the *yearly balance* past its allowance.
Sick leave is the second: FR 32a makes its three days the point at which evidence
is demanded rather than a cap, so a four day absence by somebody who has taken
none all year needs nothing, and the ninth day of the year needs a certificate.
§8.6b spells out the consequence — sick balances go negative, and that is correct.

**One pair of fields may not disagree, and it is held twice.** `documentation`
and `documentation_after_days` describe one rule between them, and either can be
set without the other. The domain names the field and says what to do; the
constraint makes the row impossible for every writer, including a migration and a
psql prompt. Neither is redundant: one is a message and the other is a guarantee.

**The seven types of FR 32 are reference data, inserted by the migration and not
by the seed.** The same argument the standard Monday to Friday week settled: a
production database is migrated and never seeded, and a leave system with no
leave types is one where nobody can request anything at all. It is not the
opposite of "never waits on a developer" — it is what makes it safe, because
every column of every row is editable from the first minute.

**Since LMS 202 the set has an owner as well as an origin.** The insert in the
leave-type-rules migration ran against a table created four statements earlier
and can never run again, so what it establishes is that a database migrated in
order *started out* right. `ensure_statutory_leave_types()`, from the
seven-leave-types migration, is the same seven rows as something with a name:
run again, it inserts whatever is missing and returns how many. That matters in
the three places reference data actually goes missing — a restore from a backup
taken before the type existed, a row deleted by somebody holding the owner's
password, a branch brought up from a partial dump — where the repair would
otherwise be seven rows retyped at a psql prompt.

Three things about it are load bearing. **It inserts and never updates**, because
reconciling the rows back to the shipped values would take away exactly what
FR 31 gives: HR's reworded name, HR's notice window and HR's retired type all
survive it running. **It is guarded on the code as well as the name**, which the
original insert was not and did not need to be — both identifiers are unique
without regard to case, so a name-only guard is refused by
`leave_type_code_unique` on the first database where somebody had reworded
"Annual Leave" to "Vacation", which is the database that has been used the most.
**It names itself in the audit log**, keeping a caller's name where one was given
and putting the setting back afterwards, so that a type which reappeared says
where it came from rather than "not named by the writer".

`EXECUTE` is revoked from `PUBLIC`. `lms_app` holds `INSERT` on the table and
could write these rows one at a time through the service, so this withholds no
power it has elsewhere; it keeps seven rows from being one call away from
anything that happens to be connected. Restoring reference data is an operator's
job, done knowingly.

**A type is retired, never deleted, and `lms_app` holds no DELETE on the table.**
A type is the heading every request, ledger entry and report of either is filed
under, so removing the row rewrites history in the way FR 06 refuses for an
employee. There is no foreign key pointing at `leave_type` yet, which is exactly
why the privilege matters now: once `leave_request` exists the key will refuse
most deletions on its own, and the row nobody has used yet would still be
deletable today.

**Reading a type is open to anybody signed in; writing one is an HR
Administrator's.** The temptation was to make the whole resource theirs, because
the story is theirs. That would have been wrong in the direction that matters:
the person who most needs to read a notice window is the one about to miss it.

**What deliberately is not there.** The entitlement *figures* — twenty days of
annual leave, a hundred and twenty of maternity, three of sick — are
`leave_entitlement_rule` and are set out below. FR 31 requires them versioned with
an effective date and forbids them altering closed leave years, and a column has
no date on it. The approval chain is FR 38a and is not a column either: it is an
ordered list, so it is `leave_type_approval_step`, which arrived with LMS 204 and
is set out two sections below.

### What a leave type is worth, and from when

**Every figure carries two dates, and that is the whole of the difference between
`leave_entitlement_rule` and `leave_type`.** FR 31, LMS 203. The type says what
*kind* of arithmetic applies; the rule says what number goes into it, and from
which day. The failure the dates prevent is silent: raise annual leave from twenty
to twenty two next January without them and every balance ever calculated is now
calculated against twenty two, last year's included, and nobody finds out until
somebody with a payslip disagrees.

**Changing a figure is adding a row.** HR writes "twenty two, effective from 1
January 2027" and the twenty day rule stays exactly where it is, still answering
every question about the days it covered. The old rule does not have to be closed
off first — both are open ended, both cover 2027, and the later start wins — which
matters because a second operation is one that can be forgotten, and a forgotten
one leaves a year with no figure at all.

**Resolution is most specific, then latest.** A rule naming this employee beats
one naming their department, which beats one naming nobody; within a rung, the
latest `effective_from` that has arrived wins. Three rungs, because nothing
narrower than a person exists and nothing sits between a department and everybody.
Naming both an employee and a department is refused rather than resolved — a
person is already in exactly one department, so a rule naming both is either
saying the same thing twice or contradicting itself.

`leave_entitlement_rule_one_per_scope_and_day` is what makes that an answer rather
than a preference: once the scope and the starting day are fixed there is at most
one row, so the two sort keys cannot tie. It is a `NULLS NOT DISTINCT` index,
which is doing real work — both scope columns are null on every company-wide rule,
and under the default rule two nulls are not equal, so the scope that matters most
would have been the one scope with no uniqueness at all.

**It is implemented once, and the once is a pure function.**
`resolve()` in `/features/entitlement/entitlement-rule.ts`. The repository fetches the
candidates for a person and a type and orders nothing; there is no view, and
`integration/entitlement-rule.test.ts` asserts there is none. The obvious query —
narrow by day, order by specificity and date, take the first — is an `ORDER BY
LIMIT 1` that looks like an optimisation and is a second copy of the rule, in the
one place that cannot be unit tested. The cost of not writing it is a handful of
rows crossing the wire.

**Three things keep a closed year closed, and it takes all three.**

*There is no undated question.* `resolve()` takes a day and there is no overload
that does not, so a caller cannot hold "the figure" as a single number.

*A rule that has taken effect is never rewritten.* Not by the service and not by
anybody: `leave_entitlement_rule_in_effect_is_history` is a trigger, so a
correction typed at a psql prompt at half past six is refused too. Two things may
still happen to such a rule and nothing else may — its `note` may be improved,
because explaining a figure does not change it, and its `effective_to` may be set
or moved, but never to a day before today. Those last two look symmetrical and are
not: ending a rule is how a standing policy stops, and ending it retroactively is
the same silent rewrite by another route, because every day between the new end
and today has already been counted against this figure.

*A new rule may not reach back into a closed year.* This is the one no constraint
on that table can decide, because a closed leave year is a row in another one. It
is held one level up as `assertDoesNotReachIntoAClosedYear`, which takes the
boundary as an argument the way `worksOn` takes a weekday — the domain knows the
rule, the caller brings the fact. Since LMS 205 the fact comes from `leave_year`,
through `earliestOpenDayFrom()`; see [The leave year, and closing
one](#the-leave-year-and-closing-one). On go live nothing is closed, the whole of
2026 is open, and entering the current policy from 1 January is exactly what HR has
to be able to do.

**A draft may be edited and deleted; this is the one configuration table with a
`DELETE` grant.** A rule dated to start next January has produced nothing, heads
nothing and has been calculated from by nobody, so fixing it in place is honest
and removing one entered by mistake is better than leaving it to fire on the first
of the month. The moment it starts applying the trigger refuses both, so the
privilege is only ever exercised on drafts. That is the opposite of the decision
`leave_type` and `employee` made, and the difference is that neither of those has
a state in which deleting it is harmless.

**Reading a company figure is open; reading a personal one is not.** This is the
first configuration table with a person-shaped field on it, so the policy reads the
row rather than the table. "Annual leave is twenty days" is what everybody plans
against. "Kwame gets twenty five" is a fact about Kwame's contract, and the refusal
says nothing at all — being told that rule 41 is not yours is being told rule 41 is
somebody's. A department rule is open, deliberately: "the field staff get twenty
five" is a policy about a job. The whole *list* is HR's, because a list of
exceptions is a list of who has one, and somebody's own figure reaches them through
their balance instead.

**The figures on a migrated database.** Twenty working days of annual leave, three
of sick, five of compassionate, a hundred and twenty calendar days of maternity,
fourteen of paternity — all effective from 1 January 2026, the leave year the
system goes live in. Everything before that date resolves to no rule at all, which
is the honest answer: this system holds no entitlement history from before it
existed. Annual leave is the only one that is pro rated for a joiner and the only
one that carries over, uncapped and without expiry, which is FR 36a said as two
unset columns rather than as a policy nobody wrote down.

Two of the seven types have **no rule, which is not the same as a rule of zero**.
Unpaid leave is agreed occasion by occasion rather than accrued, so a standing
allowance would be a fiction. The unpaid maternity extension is "a further month",
which the entitlement table does not give in days, and turning a month into thirty
by arithmetic nobody signed off would be worse than leaving HR one row to write.
Zero is a decision that something is worth nothing; no rule is the absence of one,
and `resolve()` returns `undefined` rather than throwing so that every caller has
to notice the difference.

**The fixture seed clears this table and calls the migration to refill it.** A
rule may name an employee, so the table has a foreign key to `employee`, and
`TRUNCATE ... CASCADE` empties every referencing table wholesale rather than the
rows that point at what was cleared — so the statutory figures would vanish on
every fixture reload whether or not `seed.mjs` mentioned them. It names the table
and calls `ensure_statutory_entitlement_rules()`, the same arrangement LMS 202
made for the types. Nothing in that file knows what annual leave is worth, and
nothing there should.

### Who approves each kind of leave

**The chain is an ordered list of rows, and it is the second half of design
principle 5.** FR 38a, LMS 204. Most types go manager then HR; unpaid leave and
the unpaid maternity extension go HR then CEO, with no manager stage at all —
§4.3.1 says of both that they are "Decided by HR and the Chief Executive", which
is an arrangement with the company rather than a request a line manager signs off.
Nothing anywhere reads a type code to work that out, and
`unit/migrations.test.ts` asserts that no file under `server/src` so much as names
one.

**`leave_type_approval_step` is a child table because a chain is a list.** Held as
`approver_1_role` and `approver_2_role` it would need a migration the day somebody
wants three stages, and a pair of nullable columns can hold a hole — a second
approver with no first is a chain nothing can walk. As rows with a `step_order`, a
third stage is a third row and the hole is a constraint.

**The three approver roles are not the four role codes, and the two sets are
disjoint on purpose.** A chain names a *desk*; how the person at that desk is
found is three different questions with three different answers.

| Desk | What it is | Where the answer comes from |
|---|---|---|
| `MANAGER` | a relationship | `employee.manager_id`. Never a grant — "Holding it as a role too would create two sources of truth that drift the moment somebody changes team" |
| `HR` | a granted role, and in fact two of them | `HR_OFFICER` or `HR_ADMIN`. The chain names the desk, because which of the two is on duty is not something HR should have to encode |
| `CEO` | a position | FR 04's single root: exactly one employee has no line manager, and `employee_one_root` is what makes that exactly one |

Turning them into a `role_id` would have made the chain joinable to `role` and
then silently wrong, because two of the three have no row there to join to. The
spellings deliberately do not collide with `role.code` either: nothing can match
`HR` against `HR_ADMIN` by accident, and `readRoleCode('MANAGER')` already refuses
with an explanation.

**The default is rows, not a fallback read.** Manager then HR, for any type that
does not say otherwise. Reading an empty chain as "the default" at query time
would have been the version of default HR cannot see — the configuration screen
showing nothing for annual leave while the system routed it somewhere — so every
type carries its chain explicitly. It is therefore stated twice, in
`/features/leave-type/approval-chain.ts` for a type nobody configured and in the migration for
a type an operator restores, and `integration/approval-chain.test.ts` asserts the
two are the same two desks. Same arrangement as `READS_EVERY_RECORD` and
`MANDATORY_ROLES`.

**A chain is replaced as a whole, and `lms_app` holds `DELETE` but no `UPDATE`.**
Moving "manager then HR" to "HR then CEO" by editing rows in place passes through
"HR then HR" or "manager then CEO" depending on which row is written first, and
both of those are real chains a concurrent reader would find. Delete and insert
has no such state to read. That means an intermediate moment with no chain at all,
which is why `leave_type_approval_chain_is_whole` is deferred — the same shape,
and the same reason, as replacing a working pattern's week.

**Changing it is its own operation with its own policy decision.**
`LeaveTypeService.setApprovalChain`, not a field of `update`, for the reason
retiring a type is not one either. "Changed the maternity type" and "changed who
approves maternity leave" are different sentences, and the second is the one whose
effect nobody sees directly: a request sent to the wrong desk does not fail, it
waits.

**A type with no chain at all is possible, and is refused at the point of
asking.** `ensure_statutory_leave_types()` puts back a lost leave type in one
statement and cannot know about a table written after it, so a type restored on
its own comes back unapprovable. A constraint forbidding that would have turned
LMS 202's documented repair into a failure, so instead there are two answers:
`ensure_statutory_approval_chains()` is the call beside it, and
`assertSomebodyApprovesIt()` refuses a request against such a type with a message
saying whose job it is to fix. That is told apart from `NotEligibleForLeaveType`
deliberately — one is somebody's mistake and the other is a fact about the person
asking, and telling somebody they are ineligible for a type nobody finished
configuring sends them away with the wrong problem.

**Which person a desk resolves to is [LMS 314](#routing-a-request-to-its-approvers)**,
which took `approverAfter()` up on its offer: the walk was already a pure function,
so the workflow had nothing left to decide about ordering and only had to say which
person each desk is.

**And a stage no person fills is [LMS 320](#routing-round-an-approver-who-cannot-decide)**,
which is FR 48b and is about a reporting line and a pair of granted roles rather
than about a leave type — so the chain table knows nothing of it, and the skip is
recorded against the *request* instead.

**What is still not built.** Cover while an approver is themselves away is FR 49,
and is a different question from an empty desk. Parallel approval is nothing the
SRS asks for and is the one thing `step_order` refuses outright: two rows cannot
share a number.

### The leave year, and closing one

**Every balance is per person, per leave type, per leave year, and `leave_year` is
the third of those.** §5.4, LMS 205. 2026 and 2027 are seeded by the migration,
running the calendar year, inclusive at both ends. 2026 is not an arbitrary
starting point: the statutory entitlement figures were already dated from the
first of January 2026, and `integration/leave-year.test.ts` asserts the two
migrations still agree about it.

**Two rules keep a day in exactly one leave year, and they are one rule from
opposite sides.** "Which year is this day in" is every balance question there is,
and it has to have exactly one answer.

| | Refuses | Held by |
|---|---|---|
| overlap | two years sharing a day, so a balance drawn from two allowances | `leave_year_never_overlaps`, an `EXCLUDE USING gist` over `daterange(start_date, end_date, '[]')` |
| gap | a day in no year at all, whose leave draws on a balance nobody opened | `leave_year_leaves_no_gap`, a deferred constraint trigger checking both sides of the row being written |

The exclusion constraint is the tool the Stack table bought Postgres for. A unique
index cannot express it: uniqueness is about equal values, and what this refuses is
2026 against a "2026" somebody typed as running to the thirty first of January
2027 — two different rows, overlapping by a month.

A gap *after* the last year is not a gap. The database ships with 2026 and 2027
and nothing after, and 2028 is not missing — it is next year's decision. The gap
rule is about the space between two years that both exist, which is why it is
checked from both sides of the new row: a year inserted before an existing one is
judged against the one that now follows it, so the order years are created in does
not matter.

**Both rules are deferred, and here that is not the usual reason.** The
intermediate state they permit is moving the boundary *between* two years — taking
2027 from a January start to an April one moves 2026's end as well, and whichever
statement runs first overlaps the other for the length of it. Nothing built so far
performs that operation; the constraints are deferred so that the story which does
is a service method rather than a migration.

**A year may only be closed once it has ended.** That refuses the mistake that
actually happens: it is the third of January, somebody is tidying up, and the year
they reach for is the one that started two days ago. Whether a finished year is
*settled* is HR's judgement and deliberately not a rule — FR 18 lets an absence be
recorded a week late, so they will wait, and a fixed number of days here would be a
policy nobody asked for.

**Nothing reopens a closed year.** Not `LeaveYearService`, which has no method; not
`lms_app`, which cannot write the flag back; not the owner at a psql prompt, which
`keep_a_closed_leave_year_closed()` refuses. Its dates cannot move either — that
would be reopening it by another route, since every figure in the year was
calculated against those days — and it cannot be deleted. The only thing a closed
year will still accept is a better label, which is the same exemption an
entitlement rule in effect makes for its note.

That is deliberate and it is the whole story: a flag the person who set it can turn
back is a flag that says the year was settled until somebody decided otherwise. The
way back is a migration with a reason attached, which is the price the audit log
already charges for its own immutability. `unit/leave-year.test.ts`,
`unit/policy.test.ts` and `integration/leave-year.test.ts` each assert that no
surface anywhere offers a way, which is a strange-looking test and the right one:
the absence is the feature.

**`closed_at` is stamped by the trigger, not by a writer.** The same arrangement
`updated_at` has, and it matters more here because the stamp is the record of the
decision rather than of a housekeeping detail — a year closed from a psql prompt
carries it too. Who closed it is the audit log, by the argument LMS 111 made when
it left `user_role.granted_by` out.

**Closing a year moves the boundary the entitlement rules are judged against, and
that is the seam LMS 203 left.** That story wrote `EarliestOpenDay` as a function
and passed it `NOTHING_IS_CLOSED_YET`, saying the real implementation would be "the
day after the last closed year ends". It now is: `earliestOpenDayFrom()` in
`/features/leave-year/leave-year.service.ts`, one line over `earliestOpenDayOf()` in the
domain. `NOTHING_IS_CLOSED_YET` survives rather than being deleted — it is still
what a fresh database answers, and still what a caller with no leave years to read
passes.

It is read fresh on every write, which is why the type is a function rather than a
date: the rollover of LMS 217 closes a year while the process is running, and a
service holding a boundary read at start up would go on accepting figures into a
year that had since been settled. `integration/entitlement-rule.test.ts` asserts
exactly that — the same service accepts a figure, a year is closed underneath it,
and the next write is refused with nothing rebuilt in between.

**Reading the latest closed year, not the earliest open one.** The difference only
shows if somebody closes 2027 while 2026 is still open. Nothing refuses that and it
would be odd; reading the latest closed end means the boundary is the safe one
either way, because a settled year cannot be reached back into through a hole left
in front of it.

**What closing does since LMS 210.** `leave_ledger_entry` carries a `leave_year_id`
and refuses a write against a closed year, which is where "its balances cannot
drift" stops being about one row and becomes a rule about a year of them — with one
exception, an `ADJUSTMENT`, which §8.9 names as the only way to put a settled figure
right. See [The balance ledger](#the-balance-ledger). `leave_balance` follows the
same rule since LMS 211, because it follows the ledger: an adjustment into a settled
year moves the cached figure like any other entry, and nothing else can.

**Closing still does not perform the rollover, and since LMS 217 there is a rollover
for it not to perform.** "This year is settled" and "these days move" are two
decisions, and a close that silently did both would be a close nobody could audit.
What changed is the direction of the dependency: `YearRollover` calls `close()` as its
first act, because you can only carry what is settled. See [Rolling a year
over](#rolling-a-year-over).

### The public holiday calendar

**`holiday` is the one configuration table that holds somebody else's decisions.**
FR 22, §5.4, LMS 206. Every other table in §5.5 holds what Remat Holdings decided:
what annual leave is worth, who approves unpaid leave, when the year ends. This one
holds what the Republic decided — the Public Holidays Act 2001 (Act 601) as amended
by Act 1071 of 2019, and whatever the Minister for the Interior gazettes during the
year. HR is transcribing, not deciding, and almost everything below follows from
that.

**Ghana's fourteen days for 2026 are seeded by the migration.** Reference data, by
the same argument as the seven leave types and the first two leave years: a
production database is migrated and never seeded, and a leave system that charges
everybody a day for Christmas on its first December is one nobody trusts again.
They divide into three kinds, and the difference is the whole reason a person
maintains this table.

| | Days | Why they are not generated |
|---|---|---|
| fixed by statute | New Year's Day, Constitution Day, Independence Day, May Day, African Union Day, Founders' Day, Kwame Nkrumah Memorial Day, Christmas Day, Boxing Day | they could be, and are the only nine that could |
| computable | Good Friday, Easter Monday, Farmers' Day (first Friday of December) | arithmetic nobody should write twice for nine rows a year |
| not computable at all | Eid al-Fitr, Eid al-Adha | fixed by the Minister after the moon is sighted |

**Only 2026 is seeded, and the empty 2027 is the decision rather than an
oversight.** Two of the fourteen cannot be known for a future year and the rest
could be extrapolated, which would produce a calendar twelve thirteenths right — and
a nearly right holiday calendar is worse than a visibly empty one, because a wrong
row is believed silently while an empty year is a screen with nothing on it. What
makes the empty year safe is that it can be seen: `yearsWithoutHolidays()` reads the
leave years against this table and names any nobody has entered a calendar for, so
somebody is told in November rather than complained to in January.

**Add, edit and remove are all ordinary, which they are on no other configuration
table here.** That is the transcription showing up as three verbs.

*A day is added mid year* because the thing being transcribed changes after the
year has started: a day of national mourning, an election day, a Monday declared in
lieu of a Saturday Boxing Day. Boxing Day 2026 does fall on a Saturday, and nothing
here moves it — the Act grants the Minister that power and does not oblige it, so a
Monday this system invented would be a day off the payroll believed in and the
country did not.

*A day is moved* because the two Eids are projections until the gazette says
otherwise, and they have been a day out before. This is why "edit" is an acceptance
criterion rather than a courtesy.

*A day is removed*, and it is a real delete — `lms_app` holds `DELETE` here, which
it does on only one other table in this half of the schema. The argument that
refused it to `leave_type` and `leave_year` is answered the other way round:
those rows are headings a year of history is filed under, and nothing at all is
filed under a holiday, because a request stores the days it cost rather than which
days those were.

**One holiday to a day.** `holiday_one_per_day` is a unique index on the date, and
it is the load bearing constraint. "Was the office closed on this day" has one
answer, and a day carrying two rows would be subtracted twice by any counter that
joined on it — a request coming back a day cheaper than it was, on the one day of
the year two feasts coincided. The gazette handles a coincidence by naming the day
for both, which is a name and not a second row.

**There is no `leave_year_id` on a holiday.** Which year a day falls in is the
containment search `leave_year` already answers for every other day, and a stored
answer would go wrong the morning somebody moved the company to an April start: the
holiday does not move, the year around it does. `calendarFor(year)` is a range read
over the year's own days.

**A settled leave year keeps its days.** Adding, moving or clearing a holiday inside
a closed year rewrites what every working-day request over it cost, after those
figures were made final. `assertNotInASettledYear()` says so with the earliest day
still open in the message, and `refuse_a_holiday_in_a_settled_year()` says it to
every other writer — which matters here more than usual, because a holiday is
exactly the kind of row somebody fixes by hand at six in the evening. It reads the
same boundary the entitlement figures are judged against, `earliestOpenDayFrom()`,
rather than a second idea of what settled means.

Both ends of a move are judged. Dragging a stale day out of last year and dropping
one into it are two different wrongs, and a check on the new date alone would permit
the first — which is the likelier of the two, because it looks like tidying up.

**What the calendar does not do yet.** It does not count anything: what a day off
costs is the leave calculator of §7.3, reading a working pattern, the leave type's
`counting_basis` and this table, and a `CALENDAR_DAYS` type like maternity leave
does not skip a holiday at all. It does not recalculate: FR 25 gives a day back on
an already approved request when a holiday is declared inside it, "only to working
day leave types", and that needs requests, which is §8. What this story leaves for
it is the audit entries — a recalculation nobody can explain is a recalculation
nobody accepts, and for a removed day the log is the only record the day was ever
there.

### The day calculator

**Three tables were built for one function to read, and `countLeaveDays()` is
where they meet.** FR 21, FR 22, §7.3, LMS 207. The working pattern of FR 23, the
public holiday calendar of FR 22, and the `counting_basis` of the leave type. It is
pure — no database, no clock, no environment — and the pattern and the calendar
arrive as arguments, exactly as `worksOn()` takes a weekday.

**One walk, one branch.** There is a single pass over the days of the period and a
single question inside it: does this day cost a day. A `countWorkingDays()` beside
a `countCalendarDays()` would be two implementations of "which days are in this
period", and the drift would surface as a maternity leave a day longer than the
annual leave over the same fortnight.

| The type says | The pattern is | A holiday is | A fortnight over Christmas 2026 |
|---|---|---|---|
| `WORKING_DAYS` — annual, sick, compassionate | consulted | free, if it lands on a day worked | 9 days |
| `CALENDAR_DAYS` — maternity, paternity | not consulted at all | inside the period like any other day | 12 days |

**The pattern is asked before the calendar, and the order is the answer.** Boxing
Day 2026 falls on a Saturday, so for somebody on a Monday to Friday week it is
reported as a day not worked rather than as a public holiday — it was never going
to cost anything and the gazette had nothing to do with it. That is also what makes
FR 25's recalculation come out right: a holiday declared on a day somebody does not
work gives back nothing.

**Nothing at all is counted, and nought is returned.** A Saturday to Sunday request
against a Monday to Friday pattern costs zero days of annual leave, and zero is what
comes back. That used to be a refusal thrown from here; LMS 303 moved it to
`assertItCostsSomething()` in `/features/leave-request/leave-request.ts`, raised by the submission
validator on the answer this function gave. **The difference is between a fact and a
judgement.** That a period costs nothing is arithmetic, and it is arithmetic FR 25 has
a use for — a recalculation asks what a period costs *now* and compares, and a function
that threw rather than answering would make "it costs nothing now" the one comparison
that could not be made. Whether somebody may *submit* a request for it is a rule about
requests, and it belongs beside [the other two](#dates-that-are-obviously-wrong).

What is left here is total: every period comes back as a number, and `free` says which
days inside it were not charged and why — which is what lets the refusal name the days
without walking the period a second time.

Zero can only happen to a working-day type. Every day counts for a calendar-day one
and a period always holds at least one day, so a maternity leave costing nothing is
not a state the function can produce.

**The number moves only when the pattern or the calendar does.**
`integration/leave-calculator.test.ts` closes the leave year underneath it, retires
the leave type, and adds an entitlement figure, and asserts the answer does not
budge — which is what "reads nothing else" means in the form that matters. What a
period *costs* and whether somebody can *afford* it are two questions, and only the
second one has a figure in it; that one is `leave_balance` and the ledger.

**A period is inclusive at both ends, and a single day is a period.** Somebody
taking Friday off writes the same date twice, which is the most common request there
is. A period running backwards is refused by name rather than counted as nothing:
that is a mistake in the dates, where a period whose days are all free is a mistake
about the kind of leave, and one message for both would send half the people who hit
it to correct the wrong field. A period over two years is refused as a mistyped year
— the same "check the unit" guard `requireWindow()` applies to a notice window, not a
policy about how long leave may be. FR 20a says there is no such policy, and that
guard is the only thing in the request path that could quietly become one; [no maximum
request length](#no-maximum-request-length) is where that is held open.

**And the first of January 2027 costs a day.** Only 2026's gazette is seeded, so
until HR transcribes 2027 New Year's Day is an ordinary Friday. That is the hazard
[the holiday calendar](#the-public-holiday-calendar) left visible on purpose, seen
from the counting end; `yearsAwaitingACalendar()` is what surfaces it in November,
and entering the day fixes it with no release.

**`department.parent_id` exists and nothing writes it.** A hierarchy does not
exist rather than half existing. A story that exposes sub-departments needs what
FR 03 and FR 04 gave reporting lines — a cycle check and a root count — because a
self-referencing parent has exactly the same two failure modes; the
department-rules migration says so, and `refuse_manager_cycle()` reads as a
worked example even though it names `employee` and cannot be reused as it stands.

**Staff are loaded from a spreadsheet with a dry run first, and nothing is
written until it is confirmed.** `StaffImportService.dryRun()` reads the file,
judges every row against the rules that would judge it on the way in, and hands
back a plan: what would be created, what would be changed and to what, what is
already correct, and what would be refused and why, each with the line number the
HR officer's editor shows. `confirm()` takes that plan's fingerprint and applies
exactly it. FR 08.

The whole thing runs through `EmployeeService`, one row at a time, inside one
transaction — that is what `Transactions.allOrNothing()` in `/repositories` is
for, and it is the only transaction any service has needed so far. **The import
therefore cannot drift away from the form.** A rule added to `/features/employee/employee.ts`
is a rule the import gained the same afternoon, and there is no second opinion
about whether a personal address is acceptable in bulk. The cost is a round trip
per row, which for a few hundred rows once at go live is the right side of that
trade by a long way.

Five decisions in there are worth knowing before you meet them.

**The file is a CSV, not an `.xlsx`.** Comma, semicolon — which is what Excel
writes in most of Europe — or tab, sniffed from the heading row, with RFC 4180
quoting and the byte order mark Excel puts on the front stripped. Reading a real
workbook means a dependency and a serial date epoch that is wrong on purpose;
"Save as CSV" is one menu item for HR and no attack surface for us. A story that
must have the workbook brings a parser and hands `Sheet` to the rest unchanged.

**Dates are `YYYY-MM-DD` and nothing else is accepted.** `31/07/2026` and
`07/31/2026` are the same eleven characters meaning two different days, and no
row tells you which convention the file uses. `start_date` is what a first
entitlement is calculated from and `exit_date` is what FR 37a settles a leaver's
final figure from, so guessing wrong is a wrong number in somebody's pay.
Formatting one column costs a minute; unpicking it costs a fortnight.

**A blank cell says nothing; it does not say "clear this".** An empty cell in a
mapped column leaves the field alone on an existing record and at its default on
a new one. Read the other way, a partial spreadsheet of new starters becomes an
instruction that wipes the job title of everybody it touches. Clearing a field is
an ordinary `update()`, one person at a time, by somebody who meant it.

**A file is not a statement about who does *not* work here.** Somebody in the
database and not in the file is left exactly as they are. Half these files are
one team or one intake; reading absence as departure would terminate the company
the first time HR imported the graduate scheme.

**Rejected rows stop the whole import unless you ask otherwise.** An import that
quietly skips the eleven rows it could not read is how a company goes live
believing everybody is in the system. `withoutTheRejectedRows` exists and has to
be said out loud.

**Cycle detection runs in the planner, and the trigger stays where it is.**

| | Covers | Does not cover |
|---|---|---|
| `findManagerCycles()` over the organisation *as it would be* | every loop in the file, named in order with the line numbers, before anything is written | anything that does not go through the import |
| the `employee_no_manager_cycle` constraint trigger | the same loops on every connection, including a bulk `INSERT` | naming them — being deferred, it fires at `COMMIT` with the transaction already rolled back |

That is the division the trigger's own note asks for. Both halves are needed
because the file's loops are the ones nothing else can see: one closed entirely
among rows that are not in the database yet, or closed by a single line through
five records the file never mentions.

**Rows are written nearest the top of the organisation first**, ordered by their
depth in the reporting lines the plan ends with. That one rule satisfies two
constraints that each refuse the obvious answer to the other: `manager_id` is an
ordinary foreign key, so a manager has to exist before the row naming them, and
`EmployeeService.checkManager()` refuses an intermediate loop, so a manager and
their report swapping over has to be written upper first. Writing in final-depth
order gives every row a manager that already exists and a line above it that is
already final, and the plan has proved that final tree acyclic.

**What it cannot do is succeed the head of the organisation**, and nor can
anything else built so far — for exactly the reason `succeedHead()` is wanted
above and not written. Promoting first leaves two rootless records, which
`employee_one_root` refuses immediately, being an index rather than a deferred
trigger; demoting first points the outgoing head at somebody still below them,
which is the loop. So the dry run refuses that one shape of file outright, before
anything is written, and says what to do instead.

**The fingerprint is what makes "confirmed" mean something.** `confirm()` plans
the file again inside the transaction that will do the writing and refuses if the
plan has moved. There is a person reading a report in the middle of that window,
so it is minutes rather than milliseconds — far more likely to be raced than
anything the repositories guard against, not less.

---

### The balance ledger

**Every movement in a balance is a row, and no row ever changes.** FR 27, §5.7,
design principle 1, LMS 210. `leave_ledger_entry` is what makes "why do I have
twelve days rather than fifteen" answerable with a list rather than an assertion:
a date, an amount, a reason, and a name against each line.

**Nine kinds of movement, in two families**, and the division runs through every
rule the table has.

| | Kinds | Sign | Whole days? | Into a settled year? |
|---|---|---|---|---|
| What somebody is owed | `GRANT`, `CARRY_FORWARD`, `ADJUSTMENT`, `EXPIRY`, `LAPSE` | `+`, `+`, either, `−`, `−` | no — §8.6d pro rates to 10.08 | only `ADJUSTMENT`, see below |
| What a request moved | `RESERVATION`, `DEDUCTION`, `RELEASE`, `RECALCULATION` | `−`, `−`, `+`, `+` | yes — FR 24 | never |

**`EXPIRY` and `LAPSE` are two clocks with similar names, and they are two entry
types because they put their days back in different places.** LMS 218, and
`features/leave-type/leave-type.ts` named the collision before either clock existed. `EXPIRY` is
FR 36a: carried days running out in the month HR named, so it takes days back out of
`carried_over` where the carry put them. `LAPSE` is FR 32e: paternity's fourteen days
unused six months after the birth, so it takes days out of `entitled` where the
*grant* put them. Using one for the other would leave a paternity balance reading
`carried_over: -14` on a type that cannot carry a single day — available right, column
false, which is exactly the figure that stops explaining itself. The
immutable-leave-ledger migration anticipated the price: "adding a ninth is a
migration, because the database holds the same list."

**A run of signed days is not the available balance, and nothing sums them into
one.** `RESERVATION -5` followed on approval by `DEDUCTION -5` is five days gone
once, not ten: the second moves them from held to taken. Available is five figures
— `entitled + carriedOver + adjustment − taken − pending` — and which of them each
kind moves is `BUCKETS` in `features/balance/ledger.ts`. `runningTotal()` exists and is named
`after` rather than `balance` for exactly this reason: it answers "what did these
rows do", which is what a history screen shows, and not "what may this person
book", which is `leave_balance` and LMS 211 — see [The cached
balance](#the-cached-balance).

**A correction is a new entry, always an `ADJUSTMENT`, and exactly the opposite of
what it puts right.** `corrects_id` names the row. It has to be an `ADJUSTMENT`
because that is the only kind whose sign is free — putting right a `GRANT` of +20
means −20, which is not a grant — and routing every correction through it is what
lets the other seven keep a fixed sign, and what makes a correction findable as a
correction rather than disguised as an ordinary movement. `LedgerService.correct()`
takes no amount from the caller: a correction somebody could size is one that can
be the wrong size, and "−18 correcting a grant of 20" is a row that looks
reconciled and leaves two days behind.

**A settled leave year takes no new figures — except an adjustment.** §8.9: "If HR
genuinely needs to change a closed year, that is a manual `ADJUSTMENT` entry with a
reason, not a rule edit." This is the one table in the schema whose settled-year
rule has an exception, and it is deliberate. What a closed year refuses is being
*recalculated* — quietly, by a rule or a job, with nobody's name on it. A
deliberate, attributed, permanent correction is not that, and forbidding it would
leave a psql prompt as the only way to fix a settled figure.

**Who wrote it and when are not the writer's to say.** `created_by`,
`created_by_employee_id` and `created_at` are overwritten by a trigger from the
settings `db/recording.ts` puts on the transaction — the same seam the
audit log reads. A `DEFAULT` would only apply to a writer that said nothing, which
is the honest writer; the value of "who posted this" is that nobody could have
chosen it. Dating is the sharper half: a balance is rebuilt in the order the rows
were written, so an entry dated backwards rewrites a settled figure without
changing any existing row, which is the one door the immutability triggers do not
cover.

**It is not the audit log, and is not audited.** `audit_log` records that a row
changed and exists because rows change. This records that days moved and exists
because they cannot be moved any other way. A trigger here would write one entry
per ledger row carrying facts the row already carries — a second copy of an account
whose whole value is that there is one, and a copy that could disagree.

**The one fractional column in the schema.** `days` is `NUMERIC(6,2)`, because
§8.6d pro rates a joiner on 1 July to 20 × 184/365 = 10.08 days and "FR 24 governs
how leave is requested, not how entitlement is held". `unit/migrations.test.ts`
permits it by name and by file, on the condition the table enforces inside the
column: the four request-shaped kinds are held to whole days by
`leave_ledger_entry_requests_move_whole_days`. So the exception buys a fractional
*entitlement*, never fractional *leave*. It comes back from the driver as a string
and becomes a number once, in the repository — `'20.00' + '5.00'` is `'20.005.00'`,
and the typed row makes that impossible to write by accident.

**What is not here.** `leave_request_id` from §5.7, because `leave_request` is §8
and a nullable id with no key behind it is a column nothing can check. Six of the
eight kinds have no writer yet — the rollover posts `GRANT` and `CARRY_FORWARD`,
the request state machine posts `RESERVATION`, `DEDUCTION` and `RELEASE`, the
expiry job posts `EXPIRY`, FR 25's recalculation posts `RECALCULATION` — and each
is a decision about the operation that causes it, so each belongs to that
operation's service and policy. A general `post(anything)` on `LedgerService` would
be a way to reach all six without passing any of those checks.

---

### The cached balance

**`leave_balance` is the sum, kept, so that opening the system is a glance rather
than a wait.** §5.7, design principle 1, LMS 211. One row per employee, per leave
type, per leave year — `leave_balance_one_per_year` makes that literal — holding the
five figures a balance is made of. The ledger can answer "what have I got left" and
is the only thing that can answer it *correctly*; answering it there means adding up
somebody's whole history every time a screen shows a figure.

| Column | Fed by | Type |
|---|---|---|
| `entitled` | `GRANT` | `NUMERIC` — §8.6d pro rates a 1 July joiner to 10.08 |
| `carried_over` | `CARRY_FORWARD` less `EXPIRY` | `NUMERIC` — a proportion of a grant survives a year end |
| `adjustment` | `ADJUSTMENT` | `NUMERIC`, and the only one that goes either way |
| `taken` | `DEDUCTION` less `RECALCULATION` | `INTEGER` — FR 24, a request is whole days |
| `pending` | `RESERVATION` less `RELEASE` and `DEDUCTION` | `INTEGER` — likewise |

**Available is `entitled + carried_over + adjustment − taken − pending`, and is not
a column.** It is a subtraction of the five rather than a sixth fact, it lives in
`features/balance/balance.ts`, and a stored copy would put the formula in two languages.
`taken` and `pending` are positive counts of movements the ledger records as
negative — a `RESERVATION` is −5 days in the ledger and five days pending here —
which is why this subtracts where a naive sum of signed movements would add. It may
go below nought: §8.6b, sick leave, and there is no clamp anywhere.

**The projection exists once, in SQL.** Which of the five columns each of the eight
kinds of movement moves is `rebuild_one_balance_from_the_ledger()`, and nothing else
anywhere computes a balance — not the service, not the domain, not a report. That is
the rule the ledger migration set when it declined to write the first copy: "a total
computed in two places is the drift the cached balance exists to be checked
against". `BUCKETS` in `features/balance/ledger.ts` is the *statement* of the same projection
in the language the screens are written in, and `integration/balance.test.ts` posts
one entry of each kind and asserts that exactly the named columns moved, which is
what keeps the two in step rather than merely both present.

**The cache is recomputed, never nudged.** Posting an entry throws the five figures
away and adds that balance's ledger rows up again. It costs an aggregate over a few
dozen rows — `leave_ledger_entry_balance` is exactly this key — and it buys the
property the story is named for: there is no arithmetic that could be wrong by a
day, because nothing is carried forward from the previous value. A figure that was
somehow wrong is corrected by the next entry posted against it, and §7.4's
reconciliation becomes a call to the same function rather than a second
implementation of the sum. The function takes the balance row's lock in one
statement and computes the sums in the next, which is not fussiness: written as a
single upsert with the aggregate inside it, two transactions posting against one
balance would each read the ledger before either took the lock, and the second would
overwrite the first's total with a sum that was missing a row.

**Nothing above the database writes it, and the type system says so.** `lms_app`
holds SELECT and had its INSERT revoked — the one table in this schema to give the
default privileges back — every column is `never` for insert and update in
`db/schema.ts`, and `refuse_a_balance_written_by_hand()` refuses the owner
connection too, naming the way through rather than only locking the door. A balance
changes because a ledger entry was posted, in that entry's transaction, or it does
not change: there is no service to forget and no psql prompt that can move somebody's
figures without leaving the row that explains them. That is the story's second
acceptance criterion held as a property rather than as a convention, which matters
because six of the eight entry types have no writer yet — a trigger cannot be
forgotten by a story that has not been written.

**There is no CHECK on any of the five figures, on purpose.** `pending >= 0` is true
of every correct history and would still be wrong here: the write it refused would
be the trigger's, and a rolled back trigger takes the *ledger entry* down with it. A
movement that genuinely happened has to be recordable even when the cache of it
looks impossible. That is what §7.4's reconciliation report is for, and §8.6b needs
the latitude anyway.

**It is not audited, and that is the same argument the ledger makes.** `audit_log`
records that a row changed. This changes only because a ledger entry was written, and
that entry is already the account — a trigger here would write a second copy of it
that could disagree.

**What is not here.** The reconciliation job of §7.4, which is the recompute above
plus a schedule, a walk over every balance and somebody to tell — LMS 213. The
writers that fill two of the five columns: `GRANT` is LMS 214's annual run and
`CARRY_FORWARD` is LMS 217's rollover, and both arrived. And the
list of leave types a balance screen should show — `BalanceService` returns the
balances that exist, and which types apply to a person is `entitlement_basis` and FR
05's `gender_restriction`, which is a decision with policy in it and belongs to the
story that builds the screen.

---

### One place a balance changes

**`BalanceService` is the only writer of balance movements.** FR 26, §8.2, LMS 212.
Nine methods, and nothing else in the tree posts a ledger entry — `LedgerService`
reads the account and writes nothing, which is why `adjust` and `correct` moved out
of it. Every story since has taken the arrangement up on its offer rather than
opening a second door: LMS 214 added `grantTheYear`, LMS 217 added `carryForward`,
LMS 218 added `grantForAnEvent` and `lapse`, and every one of them went where the lock,
the rule and the policy already are.

| | Posts | Checks | Locked? |
|---|---|---|---|
| `grantTheYear` | `GRANT` | the year has not been granted already | yes |
| `carryForward` | `CARRY_FORWARD` | the balance has not been carried into already | yes |
| `grantForAnEvent` | `GRANT`, and the event row beside it | nothing — FR 32g grants per occurrence — but the same event is not recorded twice | no |
| `lapse` | `LAPSE`, and closes the event off | the event has not lapsed already | no |
| `reserve` | `RESERVATION` | the days are there, unless the type may be exceeded | yes |
| `commit` | `DEDUCTION` | that many days are held | yes |
| `release` | `RELEASE` | that many days are held | yes |
| `adjust` | `ADJUSTMENT` | nothing about the days — FR 37 moves them by fiat — but the three ids it was given are real ones | no |
| `correct` | `ADJUSTMENT` | nothing — it is the exact opposite of one entry | no |

**Days are stated positive, in all nine.** A reserve of five days is `5` and so is
the release that gives them back; which way the balance moves is the method that was
called. A caller that had to remember a reservation is −5 and a release is +5 would
eventually get one backwards and post a perfectly valid entry meaning the opposite of
what happened. `adjust` is the exception, because FR 37 is signed by nature.

**Approval spends nothing again.** `commit` moves days from `pending` to `taken` and
leaves available exactly where it was — the reserve already took them out. A second
approval of the same five days is refused, because there is nothing held for it to
draw down, and the refusal says how many days actually are held. That is the story's
"my days cannot be deducted twice", and it is a rule rather than a hope: `release`
draws down the same hold and is refused the same way.

**The row is held still for the duration of reserve and validate.** §8.2. Two screens
asking for five days against a balance of five: without the lock both read five, both
find five affordable, both write, and ten days are held. `holdStill()` takes a row
lock before the figure is read and the transaction holds it until the movement is
written, so the second request waits and then re-reads a balance with nothing left in
it. `integration/balance.test.ts` sends both at once and asserts exactly one gets
through — and the test really does fail without the lock, which is worth knowing
about a concurrency test.

The lock is a database function, `hold_one_balance_while_it_is_checked()`, and not a
`FOR UPDATE` in the repository. It cannot be: **every row locking clause Postgres
offers requires UPDATE on the table**, `FOR KEY SHARE` included, and `lms_app` holds
SELECT on `leave_balance` and nothing else. Granting it UPDATE so that it could take a
lock it is never allowed to use would put a privilege in the grant table that exists
to be unused. So the privilege stays off, and the one thing the application
legitimately needs — hold this still while I look at it — has a name.

A balance nothing has moved has no row to lock, and the function opens none. That is
safe rather than a gap: with no row the balance is nought, so either the reserve is
refused, and two refusals do not race, or the type may be exceeded and there is no cap
to race for.

**What decides whether the operation should happen is not here.** This service asks
two questions of every movement — has the actor any standing on this balance, and are
the days there. Whether the request behind it is a valid request is FR 17's notice
period, FR 13's documentation and FR 38a's approval chain, and those belong to the
stories that own requests. Putting them here would make this the service that knows
everything.

---

### Checking the cache against the record

**Every balance is compared with the ledger, and anything that disagrees is reported
rather than repaired.** §7.4, LMS 213. Three stories have taken design principle 1 on
trust — the ledger is the truth, the balance is a cache, and since LMS 211 there is no
way for an application to move one any other way. This is where "if they ever
disagree" stops being a hypothetical.

The failures it exists to catch cannot be reached through the application, which is
the point of everything before it: a trigger disabled during a maintenance window, a
restore from a backup taken between two statements, a migration moving rows with
`session_replication_role` set. Each leaves a balance quietly wrong and a ledger
quietly right, and nothing notices. What notices today is an employee looking at a
figure they know is wrong, which is the sentence the story is written against.

**Three shapes of disagreement, and only one of them is the obvious one.**

| | Looks like | Found by |
|---|---|---|
| The figures have drifted | a cached column out of step with the movements behind it | comparing the five |
| The ledger has movements and there is no cached row | every screen showing that person nought days | the `FULL OUTER JOIN` — a join from `leave_balance` never sees it |
| A cached row has no movements behind it | figures with nothing to explain them | the same join from the other side |

The second is caught even when all five figures happen to agree at nought — a
reservation and the release that gave it back net to nothing, and the row should still
exist because the trigger should have opened it. That is the mildest possible symptom
of the most serious possible fault.

**There is no second copy of the arithmetic.** `what_the_ledger_says` is §5.7's
projection lifted out of `rebuild_one_balance_from_the_ledger()` and given a name, so
the writer and the checker read one definition. A reconciliation that computed its own
expected figures would be the second copy LMS 210 declined to write, with the special
property of being able to agree only with itself — invisible in exactly the case where
the writer's arithmetic was the thing that was wrong. `integration/reconciliation.test.ts`
pins that down by rebuilding every balance the check complains about and asserting the
complaint goes away.

**It alerts and never corrects, and the design is arranged so it could not.** The
comparison is a view, which cannot be written to; `ReconciliationRepository` has two
reads and no writer; the job is handed that rather than the balance repository. The
temptation is real rather than theoretical — the rebuild function is one call away and
would empty the report every night — and giving in to it would destroy the evidence. A
discrepancy is the only sign that something here does not work, and a job that erases
that sign at two every morning guarantees nobody ever finds the cause. Putting a
balance right is a person's decision made after reading the ledger.

**The alert goes to whoever holds an HR role**, read from the roles table rather than
from a configured address, so somebody joining HR starts being told and somebody
leaving stops. A clean run sends nothing at all: a nightly email saying nothing is
wrong is one nobody reads by March, and the one that matters arrives looking exactly
like it. The subject carries the count, because "one balance is out by half a day" and
"four hundred are" are a Monday morning job and a Sunday night phone call. `SYS_ADMIN`
is deliberately not told — a wrong balance is somebody's leave, and a system that mails
it to administrators as a matter of routine has stopped treating it as such.

**Nightly is a cron line, and there is still nowhere to put one.** LMS 401 brought a
server entry point and a route layer; it deliberately did not bring a scheduler, because
hanging the nightly jobs off a web process is the arrangement where they stop running
the day somebody starts a second one. So `BalanceReconciliation.run()` is still written
to be called by the first thing that runs on a timer and is still not itself
scheduled. When there is a process, the line is one call a night, out of hours, as
`theSystem('the nightly balance reconciliation')` — and an HR Officer may run the same
check this afternoon, which is why the policy allows a person as well as the job.

**What is not here.** A record of the runs. "Checked at 02:00, found nothing" is the
difference between no news and "the job has not run since Tuesday", and it is a table
with a screen in it rather than part of this. Noticing that the alert itself has gone
quiet is monitoring, and monitoring is Phase 6.

---

### The annual grant

**A year's entitlement arrives as a `GRANT` ledger entry, once per balance.** FR 30,
LMS 214. Everything before this could record days moving and add them up; nothing had
put any there. This is where a balance stops being nought and somebody can plan a year.

The figure is the entitlement rule in force **on the first day of the leave year**,
resolved by `EntitlementRuleService.entitlementOn` — asking on any other day would
grant a figure that was not in force when the year began, which is why that question
has always taken a date. Nothing about the figure is decided in the job.

**It needed a movement `BalanceService` did not have, so it added one there.** That is
LMS 212's arrangement being taken up on its offer rather than worked around:
`grantTheYear` sits where the lock, the rule and the policy already are, and
`unit/one-writer.test.ts` still passes because there is still one door.

**Running it twice is the design, not a caution.** The realistic failure of an annual
job is not an accidental double invocation — it is failing at employee three hundred on
a January morning, and somebody running it again. So each grant is its own transaction,
the first two hundred and ninety-nine keep theirs, and a second grant against a balance
that already has one is refused inside the lock by `daysToGrant`. Not by the job
remembering: a job that remembers is a job that forgets.

That once-a-year rule belongs to the *annual* grant rather than to `GRANT` entries in
general, which is why the method is named for the year. An event type's entitlement
arrives with the event — FR 32g — and a second confinement in one leave year is
correctly a second grant. That story adds its own method rather than loosening this one.

**Four ways somebody is passed over, and every one of them is reported.**

| | Why | What happens next |
|---|---|---|
| Not employed in the year at all | recorded before they start, or a year they had left before | nothing |
| No entitlement rule | nobody has said what the type is worth to them | HR writes one, FR 31 |
| A rule of nought days | HR has said it is worth nothing | nothing; it was answered |
| Not eligible | FR 05's gender restriction | nothing |

The last two look identical from a balance screen — nought days, no explanation — and
telling them apart is most of what makes a support call two minutes rather than an
afternoon. "The grant ran and Ama has nothing" needs to be a sentence somebody can read
the reason for.

**A part year is granted a part figure**, since LMS 215 — see [Pro rating a part
year](#pro-rating-a-part-year). Somebody who started *on* the first day of the year is
not a joiner, and gets the whole figure with no rule named on the entry: the comparison
is strictly after, and an off by one there would quietly deprive everybody who started
on 1 January of a year of leave.

**Only types with a yearly balance.** `hasRunningBalance`, FR 32g: a quota type's
entitlement arrives with the year and an event type's with the event. A run that granted
a hundred and twenty days of maternity leave to everybody would be a balance screen that
lied to all of them.

**And, as with the reconciliation, it is a class rather than a schedule** — "at the
start of each leave year" is a line in something that runs on a timer, and there is
nowhere yet to put one. An HR Administrator can run it by hand today, which is the same
desk that writes the figures it applies. A run may also name one employee, which is how
a joiner is granted on their first morning rather than next January.

---

### Pro rating a part year

**Somebody who was here for part of the year is granted part of the figure.** FR 29, FR
29a, §8.6d, LMS 215. A joiner on 1 July gets 20 × 184/365 = 10.08 days, posted as an
ordinary `GRANT` — so their balance is right on their first day rather than right after
somebody notices.

**The formula is behind a name, because the formula is not settled.** The story is
marked blocked until LMS 013 delivers it. §8.6d gives the worked example above and it is
the only formula this build has been given in writing, so `BY_CALENDAR_DAYS` implements
it and `THE_RULE_IN_FORCE` points at it. **That is a default, not a decision.**

The indirection buys three things and each is worth more than it costs:

* **Changing the formula is one line.** `THE_RULE_IN_FORCE` moves; nothing that posts a
  grant is edited.
* **Every figure says which rule produced it.** The rule's name goes into the ledger
  entry's reason — `pro rated for 2026-07-01 to 2026-12-31 by the calendar-days rule` —
  so grants made under today's answer stay findable when a different one arrives. That
  matters *because* this is blocked: the figures granted before LMS 013 lands are
  exactly the ones somebody will have to go back to, and finding them should be a query
  rather than an investigation.
* **A second rule proves the seam is real.** `BY_COMPLETED_TWELFTHS` is not in force and
  is not a recommendation. It answers 10 days where the rule in force answers 10.08, so
  a test that swaps the rule proves something — the same argument the migration suite
  makes about an exception that never applies.

The name is in the reason rather than in a column of its own. The person asking "why
have I got 10.08 days" is owed the answer in words they can see; a `pro_rata_rule`
column answers a query instead. It is greppable either way, and the day a report needs
to group by it, a column is a migration away and the reasons already say which rows to
fill it from.

**One formula, both ends of the year, and that falls out rather than being arranged.** A
joiner and a leaver are the same question — what part of this leave year were you
employed for — asked at the two ends. `employedPortionOf` clips the employment to the
year, so a joiner moves the near end in, a leaver moves the far end in, and somebody who
did both in one year moves both. Nothing in the decision or the job knows which of the
three it is looking at, which is the story's second criterion held by there being one
implementation rather than two that agree.

**Whether to pro rate at all is a column, not a rule in code.**
`leave_entitlement_rule.prorate_on_join`, FR 29. Annual leave is pro rated; the three
days of sick leave are not, so a joiner in December gets all three — a sick day is not
something anybody accrues. There is no leave type code compared to anything anywhere in
this story.

**Every day of the year counts the same, worked or not.** This is a proportion of a year
rather than a count of days at a desk, so a part timer on a three day week is owed the
same proportion as anybody else. What their working pattern changes is what a day of
leave *costs* them — FR 23, and the day calculator's business.

**A proportion is rounded to the hundredth of a day**, which is the ledger column's own
precision and the precision §8.6d quotes its example to. A proportion that rounds to
nothing is reported rather than posted, because a ledger entry of no days is not a
movement.

**What is not here.** The final settlement when somebody leaves — FR 37a, which compares
what they were granted with what the part year they actually worked is worth and posts
the difference. The formula it needs is the one above, called with the exit date, and
the decision about what happens to the difference (paid, clawed back, forgiven) is that
story's.

---

### Moving a balance by hand

**HR corrects a wrong figure by posting a new entry, never by editing an old one.** FR
37, §8.9, LMS 216. `BalanceService.adjust()` writes an `ADJUSTMENT` with a signed figure
and a written reason; `BalanceService.correct()` writes the exact opposite of one named
entry. Between them they are the whole of "a mistake is a new row", which is what FR 27
asks for and the reason nothing anywhere in this system updates a ledger entry.

**The figure is signed, and it is the only movement in the system that is.** FR 37 asks
for "positive or negative" by name. A reserve of five days is `5` and so is the release
that gives them back — which way those move is the method that was called — but an
adjustment has no request and no rule behind it to decide a direction from, only
somebody's judgement, so the caller states it. `ADJUSTMENT` is the one entry type whose
sign the ledger leaves free, which is what makes that possible and is why every
correction is routed through it.

**It checks nothing about what is already there, and that is the difference rather than
an omission.** No lock, no limit, no refusal for a balance that would go below nought.
There is nothing for a lock to protect when there is no limit to race for, and where HR
means to put somebody eight days in arrears — days taken that were never recorded — they
mean to do it. Refusing would leave the true figure unrecordable, which is a worse
outcome than a negative number somebody chose.

**A reason is mandatory in three places, and none of them is redundant.** The domain
refuses a blank one with the field name on the message, which is what a form can put
beside an input (NFR USA 03). The column refuses one from a writer that never came
through the service. And there is no default for it anywhere in the tree — a reason that
can be omitted is omitted by the writer with the most to explain. What it may *say* is
unconstrained on purpose: a reason nobody can write freely is a reason everybody writes
"correction" in.

**The three ids are resolved before the entry is written, and only here.** An adjustment
is the one movement whose employee, leave type and leave year are typed by a person —
the annual run and the request story hold records they have already resolved, and
`correct()` takes its key off the row it is putting right. So this is the only place a
mistyped id would otherwise reach a foreign key, and `insert or update on table
"leave_ledger_entry" violates foreign key constraint` is not a sentence a form can show.
`BalanceService.filedUnder()` answers with `LeaveTypeNotFound` or `LeaveYearNotFound`
instead; the employee was already answered by `ownerOf()`, before the transaction, so a
refusal costs nothing.

**A settled leave year accepts it, and accepts nothing else.** §8.9, enforced by
`refuse_a_recalculation_of_a_settled_year()` rather than by a second check in the
service. It is the only way to put a settled figure right, and taking it away would
leave a psql prompt as the alternative.

**The story says HR Officer and the code says HR Administrator.** LMS 216 is written "as
an HR Officer"; §10's authorisation matrix has an ✗ against that column and every other
one. The matrix is what `ledgerPolicy.adjust` follows, for the reason argued under [Who
may do what](#who-may-do-what): an adjustment moves days by fiat and can never be
removed, only compensated by another permanent entry. **This is a real disagreement
between the story and the specification, not a reading of it, and it is worth settling
deliberately rather than by whichever file somebody edits first.** What an Officer meets
meanwhile is an *open* refusal naming the desk that can post one — they can already read
the balance, so the sentence discloses nothing, and somebody asked to fix a figure needs
to know where to take it rather than only that they may not.

---

### Rolling a year over

**Leave somebody did not get round to taking is not lost on the first of January.**
FR 36, FR 36a, §11, LMS 217. `features/leave-year/year-rollover.job.ts` closes the year that ended, carries
what is left of it into the next one as a `CARRY_FORWARD`, and grants the new year.
It is the last piece of Phase 2 and the point at which a balance stops being a thing that
happens once and starts being a thing that continues.

**The order is the argument, not a sequence of convenience.** Closing comes first
*because* you can only carry what is settled: a figure read out of an open year is one
that something can still move — an approval landing on the second of January against
December's balance — and a carry computed from it would be right when it was read and
wrong when it was written. After the close, the ledger's settled-year trigger refuses
every entry type but an `ADJUSTMENT`, so the number cannot change except by a deliberate
correction with somebody's name on it. Carrying then comes before granting, so that a
balance screen never shows the new year's entitlement with last year's days still
missing; both land in the same balance and the order changes nothing but what somebody
sees if they look while the job is running, and on the first working day of January
somebody will.

**Nothing is subtracted from the year that closed, and that is deliberate.** 2026 goes on
saying twenty granted, sixteen taken, four left, forever, and the four appear again in
2027 as `carriedOver`. That is not double counting — the days exist once, in the year they
may now be booked against, the way a bank statement closes a month at a figure and opens
the next at the same one. Posting an `EXPIRY` back into the old year to zero it would be
recalculating a settled year, which is the one thing closing one forbids, and by then it
is impossible anyway. What must never happen is a caller summing `available` across leave
years, which has never been sound: `leave_balance_one_per_year` makes each year its own
balance.

**What carries is a column, read once.** `decideTheCarry()` sees how much is left,
whether the type carries at all, and whether there is a cap — and no leave type code
anywhere. Sick leave does not carry because `carries_over` is false on the statutory sick
figure. Event based types never reach the decision: the job filters on
`hasRunningBalance` before a candidate is built, exactly as the annual grant does, because
FR 32g means a maternity allowance arrives with the confinement and has no year end to
survive.

**Carry over is uncapped and does not expire, which is two unset columns rather than a
rule in code.** `carryover_max_days` and `carryover_expiry_month` are null on every
statutory figure — FR 36a said as data. The job honours a cap where HR sets one, and the
entry says so in words (`capped at 5 of 20 days`), because a column the code ignores is a
setting that lies to whoever fills it in. Expiring carried days is a *second* job on a
second schedule and is not built: it would post `EXPIRY` entries in a named month, which
is why `EXPIRY` moves the `carriedOver` bucket rather than `entitled`, and no figure in
this system sets a month for it to run on.

**The rule that decides is the one that covered the days.** `carries_over` is resolved as
at the **last day of the year being closed**, not the first day of the new one, and FR 31
is why: days earned under a policy that said they carry must not be stripped by a rule
written to take effect after that year ended. Changing the figure for next year is an
insert; changing what last year was worth is not a thing this system permits.

**Two outcomes need a person, and the run names both.** A balance in arrears is neither
carried — a `CARRY_FORWARD` of negative days is refused, because a carry forward adds —
nor quietly written off, which would be the same failure as losing somebody's unused days
pointed the other way. And days still held for a request nobody decided cannot carry
(they are spoken for rather than unused) *and* can never be approved (the ledger refuses a
`DEDUCTION` into a settled year), so the run reports them for somebody to release or
adjust. `needsAttention()` is those two and nothing else; everything else in a rollover was
always going to happen.

**Running it twice does nothing, and says line by line that it did nothing.** The story
asks for it and the first of January is why: the realistic failure is not somebody running
it by accident, it is the run that stopped at employee three hundred and the person who
has to start it again without knowing how far it got. None of the three acts is guarded by
the job remembering anything — the close is refused by `LeaveYearAlreadyClosed`, each
carry by `AlreadyCarried` inside the lock, each grant by `AlreadyGranted` — and all three
refusals are caught and reported as outcomes. That is stronger than "no harm done":
somebody can run it, read the report, and know whether the first run finished.

**It refuses three things before anything is written.** A year that has not ended (the
mistake that actually happens, on the third of January, with the year that started two
days ago); a year with no year after it, refused *before* the close, because closing one
and then finding nowhere to put the days would strand them in a year nobody can reopen;
and one whose successor is already closed, which would otherwise be four hundred
settled-year refusals from the ledger instead of one sentence.

**Granting the new year is `AnnualGrant`, whole and unmodified.** FR 30 is already a job
that grants a year to everybody owed one and refuses to grant one twice. A rollover that
reimplemented it would be a second answer to "what is somebody owed this year" living one
directory away from the first.

**It is a class, not a schedule**, as `annual-grant.ts` and `balance-reconciliation.ts`
are. §11 puts it on the first of January and this build has no process to hang a timer on;
the line to call is `new YearRollover(...).run(theSystem('the year rollover'), closingYearId)`.

---

### Entitlement that arrives with an event

**A child is born, and the days are there.** FR 32g, FR 32e, §8.6aa, LMS 218.
`LeaveEventService.record()` writes a `leave_entitlement_event` row and the `GRANT` it
causes, in one transaction, and `EntitlementExpiry` lapses whatever is left of it when
its time is up. `entitlement_basis` has said since LMS 201 that some types work this
way — "granted per qualifying occurrence, does not reset on 1 January" — and until this
story that column was only ever read to decide what the annual grant and the rollover
should *skip*.

**An event is a row, and the grant names it.** The story's first criterion is a foreign
key: `leave_entitlement_event.granted_entry_id`. It is a table rather than two columns
on `leave_ledger_entry` because when a birth happened is not a fact about a movement in
a balance — `created_at` on the grant is the day somebody typed it, and six months from
*that* is six months from the wrong day. The two rows land together or neither does: a
grant with nothing behind it is a hundred and twenty days nobody can explain, and an
event that granted nothing did the employee no good at all.

**The grant lands in the year the event fell in, never today's.** A birth in December
told to HR in January belongs to December's balance. The service reads the year covering
the day and `refuse_an_event_outside_its_leave_year()` holds the same rule for every
other writer, so the two cannot drift.

**A second occurrence is a second grant, which is exactly the rule `grantTheYear` is
not.** A year is granted once and refused a second time; an event type is granted every
time the event happens, so two bereavements in one leave year are ten days of
compassionate leave rather than five. What is refused is the same event *twice* —
`leave_entitlement_event_one_per_day`, because the duplicate that actually happens is
the second person in HR to hear about a birth not knowing the first already entered it.
Twins are one birth and one grant.

**`LAPSE` is a ninth entry type, and that is the expensive decision in this story.**
`EXPIRY` already means days lapsing and could not be used: it moves `carried_over`,
which is right for FR 36a's clock and false for this one, because an event grant was
never carried. See [The balance ledger](#the-balance-ledger). The cost was a migration
that drops and recreates two CHECK constraints and replaces one view; the alternative
was a paternity balance reading `carried_over: -14` with `available` coming out right,
which is the kind of wrong nobody finds.

**The deadline is stored, not recomputed.** `expires_on` is written when the event is
recorded, from `leave_type.entitlement_expiry_months` — paternity's six, null
everywhere else — and the table refuses to have it rewritten, on the owner connection
too. That is FR 31's argument about closed years applied to a clock: a grant already
made keeps the deadline it was made under, so an Administrator changing the column next
year cannot move a promise already given. The month arithmetic clamps rather than rolls
over: six months after 31 August is 28 February, not 3 March.

**A grant lapses *after* its deadline, not on it.** Somebody whose six months are up on
the fourth may still take the leave on the fourth. Either boundary is arbitrary and
this is the one a person would assume, which is the only argument that matters for a
rule somebody is held to.

**Nothing is lapsed while another grant in the same balance is still live.** There is no
per-grant consumption anywhere in this system — §8.6aa lets one grant be drawn down by
several requests and the balance is what tracks it — so with two live grants the days
cannot be attributed to either. Two births in one year, the first deadline up and the
second not: nothing is taken, the run says why, and the later deadline catches whatever
is still there. The conservative direction is the right one, because a wrong lapse is
found by the person trying to book the leave.

**A grant whose leave year has since been closed is reported rather than posted.** A
December birth runs to June and December's year may have been settled in February; §8.9
lets nothing but an `ADJUSTMENT` into it. Nothing is lost by that — a closed year's
balance cannot be booked against either — and the run says so instead of failing.

**Running the expiry nightly is running it again, which is the operating mode rather
than a nicety.** The event row carries `lapsed_entry_id`, the job's read excludes rows
that have it, and `BalanceService.lapse` closes the row off in the same transaction as
the entry — so a run that dies between the two leaves neither. An event that had
*nothing* left is deliberately **not** closed off: nothing ended it, and a balance is
not finished moving when a deadline passes, so if HR posts a correcting `ADJUSTMENT`
next week those days are still past their deadline and the next run takes them.

**An event is a record of something that happened.** Who, what kind, when, and the
deadline it set cannot be rewritten by anybody — the grant was calculated from them, so
changing one would move a balance with nothing in the ledger to say why. Only the
explanatory `note` and the lapse column may change, and nothing is ever deleted. The
correction for a birth recorded against the wrong person is an `ADJUSTMENT` on each
balance with a reason, which is FR 27 applied to the record rather than to the movement.

**It is a class, not a schedule**, like the three jobs beside it. The line to call is
`new EntitlementExpiry(...).run(theSystem('the entitlement expiry'))`, which judges
deadlines against today; the run takes the day as a parameter so the rule can be asked
about any of them, which is also the only way a test watches six months pass.

---

### Asking for leave

**Quoted before it is charged, and the same number twice.** FR 10, FR 11, §8, LMS 301.
`LeaveRequestService.quote()` says what a period would cost and writes nothing;
`submit()` asks the same question again, inside the transaction that holds the days,
and stores what it counted. Counting twice looks like waste and is the point — the
alternative is a figure handed back to the caller and passed in again at submission, and
a caller that can supply a figure can supply a smaller one. **The day count is never an
input.**

What is between the two calls is a person reading a screen, which is exactly the window
a public holiday could be gazetted in. If one is, the second count is the one that is
charged, and that is the honest behaviour rather than a race: a quote is not a promise.

**A quote is the number and the reason for it.** `LeaveRequestQuote` carries the day
count, the calendar span, the counting basis *in words*, every day inside the period
that cost nothing and why, what the balance holds now and would hold afterwards, who
would decide it, and anything worth saying that is not a refusal. "Nine days off cost
you six" is an assertion; "the sixth of March is Independence Day and the two days after
it are a weekend" is the explanation, and NFR USA 03 asks for the second.

**The counting basis is copied onto the request, and that is the whole of FR 11.** An HR
Administrator may change a leave type's `counting_basis` — it is one dropdown. Without
the copy, every request ever made under the old rule silently restates itself the next
time a screen renders it: last March's fortnight begins reading as fourteen days rather
than ten, beside a ledger still saying ten, and nothing anywhere says which is right. So
`counting_basis`, `days` and `calendar_days` are written at submission and
`refuse_rewriting_what_a_request_cost()` refuses to let any of them move, on the owner
connection too. **Read the request's basis when rendering a request, never the type's.**
They agree today and the whole reason the column exists is the day they do not.

That is the same argument three other tables already make. `leave_entitlement_event`
stores `expires_on` so a type's expiry months cannot move a deadline already given;
`leave_ledger_entry` stores `days` so an entitlement figure cannot restate a grant;
`leave_balance` is a cache checked nightly against the rows it was built from. In each
case it is design principle 1 — **what was recorded is what happened**, and configuration
describes what happens next. The one thing left editable is the `reason`, which explains
rather than decides, exactly as an entitlement event's `note` does.

**Submitting holds the days.** The README has said since Phase 1 that "pending days are
reserved: submitting a request writes a `RESERVATION` entry immediately, and this is what
stops somebody with five days left having three separate five day requests in flight."
`BalanceService.reserve` was built for that in LMS 212 and left unused until now; it is
`reserveForRequest` today, and the request row and its `RESERVATION` are one act.

The two rows are written in the opposite order to a birth and its grant, and which way
round is decided by which way the key points: an event names the grant it caused, so the
entry goes first; a request is *named by* the movements it causes, so the request goes
first. There is deliberately no `reserved_entry_id` on `leave_request` pointing back —
two NOT NULL keys between two tables is a pair neither row can be written first. What
holds the pair together instead is the same division of labour "exactly one default" and
"exactly one root" already have:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_reserves_once`, a unique partial index | a second `RESERVATION` against one request, immediately, on every connection | a request holding nothing |
| `leave_request_holds_its_days`, a deferred constraint trigger | a request that reserved nothing, at `COMMIT` | `TRUNCATE`, which no row trigger sees |

**Deferred is the whole point of the second one.** The request has to exist before an
entry can name it, so between the two statements there is a request holding nothing — a
legitimate intermediate state a per-row check would refuse and a check at commit judges
correctly, because the only state it ever sees is the one that will actually be stored.

**And the ledger finally learned which request a movement is about.** The
immutable-leave-ledger migration refused `leave_request_id` and said why — "a nullable id
with no foreign key behind it would be a column nothing could populate and nothing could
check" — and named the three things it wanted instead: a column, a foreign key, and the
rule that the four request-shaped entry types carry one. All three arrived here, and the
rule is an **equivalence** rather than a requirement: a request movement must have one
and everything else must not. The second half is the one that catches a `GRANT` posted
against a request id because a method was copied from `reserve` — a year's entitlement
filed under a fortnight in March, which looks entirely reasonable.

**Leave over a year end is refused, not split.** A request is one period against one
balance and a balance belongs to one leave year, so the twenty-eighth of December to the
fifth of January is two balances; reserving all ten days against either would be a figure
that reconciles and is wrong. `leave_type.may_be_split` and `assertMayBeSplit()` have
been in the domain since LMS 201 and are what a story offering the split would use — it
is two requests with one approval between them, which is a decision rather than an
arithmetic. What the refusal says is [below](#dates-that-are-obviously-wrong).

**Notice and documentation warn; they do not refuse.** FR 17 is advisory by design —
leave is sometimes needed at short notice, and a system that refused it is a system people
work around — so a short-notice request is submitted and the quote says by how much. FR
13's documentation is an attachment and there is nowhere to attach one until Phase 4.

**The balance is the one that both warns and refuses**, and which it does depends on when
it is asked: the quote reports the shortfall so somebody can decide what to ask for, and
the submission refuses it. Same condition, same error code, two moments — see [days that
are not there](#days-that-are-not-there).

**What this story deliberately does not bring**, each named so it is inherited rather
than rediscovered:

* **No state machine.** `leave_request_status_known` held one value, and that was LMS
  209's rule applied honestly rather than an oversight papered over: a CHECK listing six
  states of which one is reachable is a promise the schema cannot keep. Each story that
  needs a status brings it, with the transition that reaches it and the migration that
  lets the database hold it — exactly as LMS 218 extended `leave_ledger_entry_type_known`
  to admit `LAPSE`. LMS 306 was the first to collect, adding [the three
  endings](#the-days-come-back); the approval story adds `APPROVED`.
* **No approval, withdrawal or cancellation.** All three move `status` and two of them
  release days. `ledgerPolicy.release` is already written and waiting for them. *(The two
  that release arrived in LMS 306, along with refusal, which is the third.)*

---

### Dates that are obviously wrong

**A mistake in the dates is answered while the form is still open, never by an approver
two days later.** FR 16, FR 16a, §8.3, LMS 303. Three shapes of obviously wrong, and
each is refused at the first moment its answer is knowable — which is what "at once"
means in practice, because a person waiting on four queries to be told their end date is
before their start date has been made to wait.

| Refused | By | Knowable after |
|---|---|---|
| The end before the start — also a date written `31/07/2026`, and a period over two years long | `validateLeavePeriod()`, `InvalidLeavePeriod` | nothing at all is read |
| A period that runs past the end of its leave year | `reachesPastTheEndOf()`, `LeaveCrossesAYearEnd` — error code **`CROSS_LEAVE_YEAR`** | the leave year is found |
| A period nothing in which is charged — a range that is entirely weekend and public holiday | `assertItCostsSomething()`, `LeaveCountsNoDays` | the days are counted |

**All three are asked by `quote()` as well as by `submit()`**, because the two share
`resolve()` and `countFor()`. A quote that accepted what a submission would refuse is
precisely the surprise this part of the system exists to prevent, arriving late.

**The refusals are the request's, and the day calculator stays out of it.**
`countLeaveDays()` used to throw for a period that cost nothing; LMS 303 moved that
judgement into `/features/leave-request/leave-request.ts` and left the calculator
[pure and total](#the-day-calculator). A Saturday of annual leave costing nought is
arithmetic about a calendar, and FR 25's recalculation has to be able to ask for it and
get a number. Whether a person may submit a request for it is a rule about requests, and
now it sits in one file, in one voice, beside the other two.

**The cross-year message is two sentences and the second one is the useful one.**

> This request crosses into the 2027 leave year. Submit one request ending 31 December
> 2026, and another starting 1 January 2027.

NFR USA 03. A refusal that only says no leaves somebody at a form doing date arithmetic
to work out what they are allowed to type, and they will get it wrong at exactly the
boundary that produced the refusal. So the two dates they need are in the sentence, and
they are said the way a person says a date — the month spelled out, because `01/01/2027`
and `01/12/2026` are the ambiguity this system refuses [everywhere
else](#things-that-will-bite-you-if-you-do-not-know-them). `formatDay()` is where that
happens.

**Every year and every date in it is read off the record. None of it is written down
here.** The boundary is `leave_year.end_date`, the day to resume on is `dayAfter()` of
it, and the year being crossed into is whatever HR called it — looked up rather than
derived, because §5.4 does not say a leave year is a calendar year and a company running
April to March calls its next one `2027/28`. A hard-coded "the thirty-first of December"
would be right for the database we ship and wrong for the first company that configures
its own year, and nothing would say so. The integration suite renames the seeded 2027 and
asserts the sentence moves with it.

Where nobody has defined the year after this one yet — legitimate, since a gap *after*
the last leave year is next year's decision rather than a hole — the label falls back to
the year part of the day to resume on. The sentence stays true and the two dates in it,
which are the half somebody acts on, stay right.

**And `CROSS_LEAVE_YEAR` is the first refusal here to carry an error code**, because it
is one a form is expected to *do* something with: offer the split as two prefilled
requests rather than only printing the sentence. A message is reworded the first time
somebody reads it aloud; a code is a contract. `OVERLAPPING_REQUEST` is the second, and
is [below](#leave-over-leave-already-booked).

---

### Leave over leave already booked

**One person is in one place on one day.** FR 15, §5.6, LMS 304. The defect is a balance
consumed twice for the same days, and what makes it worth a story of its own is that
nothing about it looks wrong while it happens. Somebody books the second to the tenth of
March, forgets, and books the fifth to the twelfth. Both reserve. Both ledger entries
reconcile, every figure is explainable, and the balance is still incorrect. That is the
one shape of error design principle 1 cannot catch on its own — the record is faithful,
and the request was one nobody should have been allowed to make.

**The constraint is keyed by the employee and the dates, and deliberately not by the
leave type.** A person is away or they are not. Annual leave from the second to the tenth
and sick leave on the fifth are not two absences that happen to share a day; they are one
day with two claims on it, each taking a day off a different balance. Keying by type as
well would permit exactly that and would read as though somebody had thought about it. FR
32b's "sick leave during annual leave is converted" is the real answer to that case, and
it is a conversion with an approver on it — the first request is amended and the days
come back — rather than two rows quietly coexisting.

**The range is inclusive at both ends**, `daterange(start_date, end_date, '[]')`, because
that is what the two dates mean everywhere else in this schema. Leave ending on the tenth
and leave starting on the tenth share the tenth, and a half-open range would let that
through as one day booked twice — the defect itself, arriving through the off-by-one
nobody tests. Leave starting the day *after* is ordinary and is accepted.

| | Covers | Does not cover |
|---|---|---|
| `LeaveRequestService.resolve()`, asking first | naming the leave in the way — its dates, what it cost, its kind — for everybody who is not in a race | two submissions at the same moment, which both see a table with no conflict in it |
| `leave_request_never_overlaps`, a GiST exclusion constraint | the same rule on every connection, evaluated as the row is written | saying which row it collided with; by then the transaction is aborted |

**This is the first constraint in the system where the backstop is a path real users
take.** Everywhere else — the ledger's triggers, the year check — the database half
catches psql and bulk loads while the service half catches everybody. Here the check and
the write are two statements, and no arrangement of application code closes the gap
between them: two tabs, or two clicks, and only the constraint sees the second row land
on the first. So the repository maps `exclusion_violation` back to the same
`LeaveOverlapsAnother` and the same `OVERLAPPING_REQUEST` code the service raises, and
what changes is the second sentence — it says to reload and look rather than pretending
to have looked. **This is what `btree_gist` was enabled for in the baseline**, which
described the shape of it two migrations before the table existed: equality on a scalar
column beside overlap on a range.

**A request blocks the days only while it is still live**, and `LIVE_STATUSES` is the
list of what live means — drafted, waiting to be decided, or agreed. Withdrawn, cancelled
and refused leave has given its days back, and days that came back are days somebody may
book again, which is the ordinary thing to do after a request is turned down.

Today that list holds `SUBMITTED` and nothing else, because [the state
machine](#asking-for-leave) is still the approval story's and `SUBMITTED` is the pending
state. **The list is nonetheless separate from `REQUEST_STATUSES` rather than being read
as "all of them", and that is the point of writing it this early.** The approval story
brings `APPROVED` — live — alongside `WITHDRAWN`, `CANCELLED` and `REFUSED`, which are
not, and a story that extends one list and forgets the other either blocks a fortnight in
March against leave that was refused in January or lets somebody book over leave that was
approved. The same list is the constraint's `WHERE` predicate, currently a tautology and
written anyway for the same reason; the integration suite reads it back out of
`pg_constraint` and asserts the two agree, so neither can be extended alone.

---

### Days that are not there

**Told at once, and told the figure.** FR 14, NFR USA 03, LMS 305. The story is somebody
finding out at the form that they do not have the days, rather than waiting days in an
approver's queue to be turned down for a reason the system knew before they clicked. The
check itself is a comparison; everything interesting about the story is in what the
refusal *says*.

> This is 7 days of Annual Leave and you have 3 left — 4 days more than the balance holds.
> Ask for 3 days or fewer, or speak to HR if the balance itself looks wrong.

**The second sentence is the useful one**, the same way it is in the [cross-year
refusal](#dates-that-are-obviously-wrong). A refusal that only says no leaves somebody
guessing, and the guess it produces is "try six" followed by a second refusal. So the
figure they may actually ask for is in the sentence — and it is **floored to a whole
number**, because §8.6d pro rates a mid year joiner to a fraction and a balance of 2.5 is
two days somebody may book. Telling them to ask for 2.5 would be telling them to do the
one thing `requireWholeDays()` refuses. Where the floor is nought the sentence stops
offering rather than inviting a request for no days.

**And the leave type is named, because a balance is per type.** "You have 3 left" is a
figure somebody will check against the wrong number on their own leave page.

| | Covers | Does not cover |
|---|---|---|
| `assertTheDaysAreThere()`, from the submission path | the sentence — the leave type, the figure, the shortfall, what to ask for instead — for everybody who is not in a race | a balance spent between the read and the write; it holds no lock |
| `daysToReserve()`, inside `BalanceService`'s lock | the same rule against a balance held still, which is the only check that binds | saying anything about leave; it sees a number of days and a balance, and `BalanceOverdrawn` reads accordingly |

This is the same two-altitude arrangement as [the overlap
check](#leave-over-leave-already-booked) and its exclusion constraint, and the division
is the same one: **the check that cannot be beaten is not the check that can speak.**
`daysToReserve()` is handed a figure and a balance and knows nothing about leave types or
periods, which is correct for the ledger and useless to a form. The service's check knows
both, and runs first. The integration suite submits one request past both of them and
asserts they agree on the available figure, the days requested and the shortfall, so
neither can be loosened alone.

**The quote reports rather than refuses**, and that is deliberate. A quote is what
somebody reads to *decide* what to ask for, so it shows `availableNow`, shows
`availableAfter` below nought where that is the truth, and warns. Refusing there would be
declining to tell a person how far short they are. The warning carries `NOT_ENOUGH_DAYS`,
**which is also the refusal's error code** — one condition seen at two moments, so a form
highlights the balance with the same branch either way rather than drawing them as two
unrelated problems. Both messages open with the same clause, from
`daysAgainstTheBalance()`, for the same reason.

**Sick leave is not refused at all.** FR 32a and §8.6b: `exceedable_with_document` makes
the allowance the point at which a medical certificate is asked for rather than a cap, so
the balance goes below nought and the leave is granted. Read off the column by
`balanceMayBeExceededWithDocument()` — which has sat in `/features/leave-type/leave-type.ts` since LMS
201 saying the check "belongs to the submission path, which is the only thing that knows
what the balance is", and this is that path. No leave type code is compared to anything;
design principle 5.

---

### No maximum request length

**Somebody may ask for their whole year's leave in one request.** FR 20a, LMS 309. The
requirement is an absence — "the system does not impose a limit the company has not set"
— and an absence is a thing that has to be *kept*, because the way it ends is nobody
deciding to end it. Somebody tightens a validation bound on a quiet afternoon, and a
system that never had a cap has one.

**Nothing in the path holds a maximum, and that was already true.** LMS 309 added no
behaviour; what it added is the proof, and the reasons written where the next person will
be tempted. The floor and the ceiling are worth seeing side by side:

| | Bound | |
|---|---|---|
| `requireWholeDays()` | `days >= 1` | a floor, and no second half to the sentence |
| `leave_request_costs_at_least_a_day` | `days >= 1` | the same rule where no sentence can reach |
| `leave_request_costs_no_more_than_it_spans` | `days <= calendar_days` | relative — a coherence rule, not a length one |
| `LONGEST_PERIOD_DAYS` | 731 calendar days | a mistyped year, unreachable inside one leave year |

**Three things do limit how much leave somebody can ask for at once, and none of them is
a length rule.** The distinction is the whole requirement, so it is worth being exact:

* **The balance.** FR 26, and the company's own entitlement figure — the limit the
  company *did* set. Twenty-one days against twenty is [refused with the
  figure](#days-that-are-not-there), for being unaffordable rather than for being long.
  Take the balance to exactly nought and nothing objects: the `NOT_ENOUGH_DAYS` warning
  fires on `days > available`, so twenty against twenty is silent, and somebody spending
  their whole entitlement deliberately is not told they are short.
* **The leave year.** FR 16. A request is one period against one balance and a balance
  belongs to one year, so the longest request there can be is a year — [refused and not
  split](#dates-that-are-obviously-wrong) at the boundary.
* **`LONGEST_PERIOD_DAYS`.** The mistyped-year guard, at two years. **It cannot refuse a
  real request**, and that is a property rather than a coincidence: the year rule above
  caps any priced period at 366 days, less than half of it. The unit suite asserts a
  period as long as the longest leave year can be still passes, so a bound lowered far
  enough to bite fails there rather than in front of somebody booking their August.

**The absence is proved by asking for the longest request the rules allow.** The
integration suite puts an entitlement up by hand — FR 37's adjustment, doing exactly what
it is for — and then asks for an entire leave year, two hundred and forty-eight working
days of it, in one request. Any maximum anywhere in the path refuses that whatever number
it holds, so the test passes only if there is nothing. Beside it, the twenty-day case the
story is named for, and a read of `pg_constraint` asserting that no `CHECK` on
`leave_request` bounds the day count by a literal — the database being where a cap would
be most durable and least visible.

---

### The days come back

**A request ends, and what it was holding goes back into what the person may book.** FR
26, §8.2, LMS 306. The story is "the balance I see is what I can actually still book",
and its first two halves were built with [the request
itself](#asking-for-leave): submitting writes a `RESERVATION` in the same transaction, and
available drops the moment it does. This is the third half, and it is the one that keeps
the sentence true over time — a hold that is never released is a balance that only ever
goes down, and after a month of ordinary refusals and changes of mind it stops being a
figure anybody trusts.

**Three endings, one movement.** Days that were held stop being held, whoever decided it
and for whatever reason. `ledgerPolicy.release` has said exactly that since LMS 212 —
"yours to withdraw, your manager's to refuse, HR's to cancel… they share a rule here
because they are one movement" — and this is the story that took it up.

They are nonetheless **three decisions** in `leaveRequestPolicy`, because they are three
different acts:

| | May | Because |
|---|---|---|
| `withdraw()` | the requester, or HR | it is the undoing of submitting, so it is the rule `submit()` already has |
| `refuse()` | the line manager, or HR, and [never the requester](#nobody-approves-their-own-request) | a decision about somebody else's request, which is what a manager is for |
| `cancel()` | HR | an administrative unwinding — leave against the wrong person, a request entered twice |

A single `settle` decision would have to be the union of those, which is
`ledgerPolicy.release` itself — and it would let a manager withdraw a report's leave and
let somebody mark their own leave refused. Both write a perfectly valid `RELEASE` and a
record of something that did not happen. **Which of the three it was is written into the
ledger**, because five days coming back look identical in a balance whether the person
changed their mind, a manager turned it down or HR unwound it, and those are three
different conversations.

**`APPROVED` is deliberately not here**, and [LMS 314](#routing-a-request-to-its-approvers)
is why: approval *commits* days — the hold becomes days taken and available does not move at
all — so it is a different movement with a different entry type, and which desk in FR 38a's
chain may agree needs the chain, the type and how far the request has got.

**The status and the `RELEASE` are one act**, in both directions and held by the database
rather than by the two methods that happen to do it properly:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_releases_once`, a unique partial index | a second `RELEASE` against one request, immediately, on every connection | a request that ended holding its days |
| `leave_request_gives_its_days_back`, a deferred constraint trigger | a request that ended and released nothing, at `COMMIT` | `TRUNCATE`, which no row trigger sees |
| `leave_request_moves_as_the_table_says`, a `BEFORE UPDATE` trigger | a settled request being moved again, or moved anywhere §6 does not permit | — |

That is the exact mirror of the pair [submission
built](#asking-for-leave), and the failure modes mirror too: a request that ends without
releasing is a balance permanently short with nothing to explain it, and a release with
the status left behind is days the next withdrawal gives back again. Neither is a crash
and neither shows up as an inconsistent ledger — both reconcile perfectly, and both are
wrong. The third trigger is the one the other two cannot supply: nothing else stops a
withdrawn request being marked refused a week later, which writes no entry at all and
quietly rewrites what happened to somebody's leave.

**`assertMayBeSettled()` is the sentence and the lock is the guarantee**, which is the
arrangement [the overlap check](#leave-over-leave-already-booked) and [the balance
check](#days-that-are-not-there) both make. What is different here is that the lock
actually closes the window: two endings of one request are two movements on *one*
balance, so `holdStill()` serialises them and the second re-reads a request the first has
already settled. Two submissions are two different requests and no lock can make one see
the other, which is why that one needs a constraint as a real path and this one does not.

**And this is where `LIVE_STATUSES` stopped being a formality.** LMS 304 wrote the list
separately from `REQUEST_STATUSES` when the two held the same single value, and said at
the time that was "the whole point of it existing this early". Three statuses arrived,
none of them joined it, and every query written against it — the overlap probe, the
exclusion constraint's `WHERE`, `blocksTheCalendar()` — started excluding rows without a
line of them changing. Somebody whose leave was refused in January can book those days
again, which is the ordinary thing to do after a refusal.

---

### The state machine

**A request moves through defined states and no others.** §6, LMS 313. The story is a
request in a condition nobody can explain or resolve, and what prevents it is not one
mechanism but three: the moves are a table, one place writes the column, and every move
is on the record.

**The table is the rule, not documentation of it.** `TRANSITIONS` in
`/features/leave-request/leave-request.ts`, keyed by from-status and action, carrying the destination and
the standings that may make it:

| From | Action | To | By |
|---|---|---|---|
| `SUBMITTED` | `WITHDRAW` | `WITHDRAWN` | the requester, or HR |
| `SUBMITTED` | `REFUSE` | `REFUSED` | their line manager, or HR |
| `SUBMITTED` | `CANCEL` | `CANCELLED` | HR |
| `SUBMITTED` | `APPROVE` | `APPROVED` | the desk the chain has it with |

LMS 306 built all three of those and they were all correct — spread over three places.
The from-state lived in `assertMayBeSettled()`, the destination was named at each call
site (`settle(actor, id, 'WITHDRAWN', …)`), and the actor was whichever policy decision
the method happened to call. **Nothing could answer "what can happen to a submitted
request"**, which is exactly the question somebody has when a request is stuck.

**A settled request goes nowhere, and that is written as the absence of a row.**
`WITHDRAWN`, `CANCELLED` and `REFUSED` appear in the `to` column and never in the `from`
column — not a flag on the status, not a separate rule. `refuse_an_impossible_transition()`
says the same where no service can reach, and the integration suite reads it back out of
`pg_get_functiondef` and holds it to the table, the same way the overlap constraint is
held to `LIVE_STATUSES`. Since LMS 314 the trigger is called
`leave_request_moves_as_the_table_says`, because "ends once" is a puzzling thing to read in
an error about leave that has just been agreed.

**The destination is read off the table, which is what makes the table load bearing.**
Before, a caller named it; the table could have said anything and the code would still
have written whatever was asked for. `settlementTo()` is now the only way to find out
where a move lands, and `releaseForRequest` asks it again *inside the lock* — so a request
another connection settled while this one waited is refused rather than settled twice.

**The domain names standings, not roles.** Two of the three moves turn on a
*relationship* — it is your leave, you are the manager it was addressed to — and a table
keyed by role codes could not express either without widening them into "anybody who reads
every record", which is how a manager comes to withdraw a stranger's leave. It is also
what lets the table live in `/domain` at all, which [imports
nothing](#layering-rule): the table says `THEIR_LINE_MANAGER`, and
`/features/leave-request/policy.ts` is the only file that knows which roles satisfy
`LEAVE_ADMINISTRATION`.

**Two questions, and the order they are asked in is a disclosure rule.** The policy
answers *is this your business* and is deliberately **not** given the from-status; the
table then answers *is this move available*. Asking it the other way round reads a
stranger's request state aloud before deciding whether they may see it. Folding the state
into the policy instead collapses both into `NotAuthorised` — somebody withdrawing leave
they have already withdrawn would be told they *may not*, which is untrue, and
`LeaveAlreadySettled` (which names what happened and says the days are already back)
would be unreachable by the one person most likely to need it.

**One writer of the status column.** `LeaveRequestRepository.settle()` issues the only
`UPDATE` that touches `status`, and `BalanceService.releaseForRequest` is its only caller
— the ledger's one-door rule winning where the two meet, because the status and the
`RELEASE` have to land together. The state machine is still the only way in.
`unit/state-machine.test.ts` reads the source and fails on a second writer, the way
`one-writer.test.ts` does for the ledger, because the realistic second writer is an honest
service doing an honest `UPDATE` — a bulk cancellation, an import — that satisfies every
trigger and skips the table.

**Every transition writes an audit entry**, and nothing in the application writes it.
`leave_request_is_audited` fires on the UPDATE inside the same transaction as the status
and the `RELEASE`, carrying `before` and `after` — so the log answers *who moved this out
of `SUBMITTED`, and when* without joining anything, and a rolled-back settlement leaves no
entry at all.

**A note on testing a table.** Once the policy reads `TRANSITIONS`, a test checking the
policy against the table is checking a function against itself — widen a row and both move
together. That is the trap the seven-leave-types suite names as "checking the migration
against a copy of itself", and it is easy to walk into because the check reads like the
important one. So the table is pinned in full, and which desks the policy actually admits
is `unit/policy.test.ts`'s, against hardcoded actors. A widened row fails both.

**`APPROVE` was the row this table was built for**, and [it arrived](#routing-a-request-to-its-approvers)
as the one change the shape predicted: a row here, a status in `REQUEST_STATUSES` and a
migration extending the CHECK. Both tests written to fail when it landed did fail — every
destination used to end the request, and every state still running used to answer every
action — and both were rewritten to say what is true now rather than relaxed.

---

### Routing a request to its approvers

**A request goes to the approvers its leave type names, in order.** FR 38, FR 38a, FR 40,
LMS 314. The chain has been configuration [since LMS 204](#who-approves-each-kind-of-leave) and
nothing read it; the leave-type-approval-chain migration said the routing itself "is FR 48 and
Phase 3… needs the request table to exist". This is the story that reads it.

**Where a request has got to becomes two facts.** `status` says whether it is still being
decided; `awaiting_approval_from` says who is deciding it. Held apart rather than folded
into `AWAITING_MANAGER`, `AWAITING_HR`, `AWAITING_CEO` — and the reason is design principle
5 rather than tidiness. **The number of stages is configuration.** A status per stage means
a fourth desk in `leave_type_approval_step` needs a new status, a new CHECK and new
transitions: a code change and a deployment for the thing FR 31 insists is a form.

**So approval is the one verb that does not always move the status.** A manager approving
stage one of manager-then-HR leaves the request `SUBMITTED` and sends it on; the HR officer
approving it afterwards is the same verb and makes it `APPROVED`. `approvalTo()` is where
the two are told apart, and it reads the destination off `TRANSITIONS` rather than naming
one — the same discipline `settlementTo()` keeps, and it matters for the same reason: a
function that could name `APPROVED` could name it one desk early.

**The three desks are three different kinds of fact**, which is why the domain names
standings and `/features/leave-request/policy.ts` resolves them:

| Desk | Is | Resolved by |
|---|---|---|
| `MANAGER` | a relationship | the reporting line on the record |
| `HR` | a grant, and two codes staff it | `APPROVES_AS_HR` |
| `CEO` | a position | FR 04's one employee with no line manager |

`APPROVES_AS_HR` is its own list rather than a reuse of `MAINTAINS_EMPLOYEE_RECORDS`, for
the reason `MAINTAINS_THE_CALENDAR` is: they agree today for unrelated reasons, and a
shared constant would have made "who maintains employee records" silently decide "who
approves unpaid leave".

**A rank admits nobody.** A line manager has no standing over a request whose chain does
not name `MANAGER` — unpaid leave goes HR then the Chief Executive, §4.3.1, and there is no
manager stage on it at all. HR has none over a request still sitting with a manager. That
is the point of routing rather than a restriction bolted on top of it.

**The last approval commits the days**, and only the last one. A `DEDUCTION` moves the same
days out of `pending` and into `taken`, leaving available exactly where it was — the
movement `BalanceService.commit` had been built and unused for since LMS 212. An
intermediate approval writes no ledger entry at all, because no figure in any balance
moved, and inventing one would be a line in somebody's history recording that nothing
happened.

**And the status and the `DEDUCTION` are one act**, held the way the other two movements
are:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_commits_once`, a unique partial index | a second `DEDUCTION` against one request, on every connection | a request approved holding its days |
| `leave_request_takes_its_days`, a deferred constraint trigger | a request that reached `APPROVED` and committed nothing, at `COMMIT` | `TRUNCATE` |
| `leave_request_waits_at_a_desk`, a `CHECK` | a request being decided with no desk, or one approved or ended still sitting in a queue | — |

**`APPROVED` joined `LIVE_STATUSES` and stayed out of the endings**, which is the payoff of
[writing both lists out](#the-days-come-back) rather than deriving either. Leave that has
been agreed is the most live leave there is — the person will be away — so it blocks the
calendar, and LMS 304's exclusion predicate gained the one word it was written in advance
for. It is not an ending, so it does not release days. A subtraction would have got the
second one wrong and released the days of every approved request in the system.

**Two questions became three, and the order is still a disclosure rule.** The settlement
path asks *may you* then *is this move available*. Approval cannot: **who may approve is
itself a question about the state**, so it asks *may you see this* (skipped for the desk
itself, or the Chief Executive — nobody's manager, no roles — would be refused a request
they are the approver of), then *is there an approval to give*, then *are you the desk*.
That last one is asked again inside the balance lock, and it is not decoration: without it
a manager clicking twice on a two-stage chain would find the request at the HR desk on the
second pass and approve the leave outright.

[LMS 319](#nobody-approves-their-own-request) put a fourth in front of all three, and it is
outside the ordering argument rather than part of it: *is this your own request*, asked as
soon as whose leave it is has been established, because nothing read afterwards could change
the answer.

**What is deliberately not here.** FR 48b — the manager who raised their own request, the
Chief Executive who has nobody above them — is a rule about a reporting line rather than
about a leave type, and is [LMS 320](#routing-round-an-approver-who-cannot-decide): the
stage is skipped to the desk that stands in for it, and the skip is recorded. Taking agreed
leave off the books afterwards is FR 26 and is not any of the three endings: the days are
`taken` by then, so it is a movement against the `DEDUCTION`, and `LeaveCannotBeMoved` is
what somebody reaching for withdraw is told in the meantime. And `leaveRequestPolicy.refuse`
was **not** narrowed to the chain, so a line manager may still refuse unpaid leave they
could not approve — a one-line change to the `REFUSE` row that takes a power away from
managers, which is somebody's decision to make rather than a side effect of building the
routing. What that row did gain, in
[LMS 319](#nobody-approves-their-own-request), is the requester's exclusion this story wrote
onto `THE_DESK_IT_IS_WITH` and therefore onto `APPROVE` alone.

---

### Approving or rejecting at a stage

**A decision says why, and who made it, and on whose behalf.** FR 39, FR 52, LMS 315. The
routing gets a request to the right desk; this is what happens when somebody at that desk
answers. The story is one sentence — the person knows why, and the reason is on the record
rather than in a corridor conversation — and everything below follows from taking it
literally.

**It is a table, not three columns on the request.** `leave_request_decision`, one row per
answer. The create-and-submit migration listed exactly these three as what it was leaving
out — "no `approved_by`, no `decided_at`, no `approval_step`" — and the reason they arrive as
rows is the reason the *status* did not become `AWAITING_HR`: a chain has stages, each stage
is a decision, and **the number of stages is configuration**. The manager's "cover is
arranged" and HR's "your balance covers it" are two sentences about one request; columns hold
one of them, and which one they lose is whichever was written second, silently.

**A refusal must say why; an approval need not.** That asymmetry is the story rather than an
oversight. Somebody told no has to be able to act on it — different dates, cover, an appeal —
and "no" with nothing after it leaves them a conversation to chase. Somebody told yes needs no
account of the yes. `requireAComment()` refuses before a single row is read, so an approver who
forgot the box is told at once and without the refusal depending on whether the id was
anybody's; `validateDecision()` asks again inside the transaction; and
`leave_request_refusal_says_why` asks a third time where no service can reach. Blank is
nothing, which is the half of "required" usually missed and is what
`leave_request_decision_comment_not_blank` is for.

**`on_behalf_of` is the desk, and it is not the same fact as who decided it.** The one column
worth arguing about, because for most rows the two say the same thing twice: only the person a
desk resolves to may *approve* at it. A refusal is different — `TRANSITIONS` admits a line
manager and HR to the `REFUSE` row whichever desk the request is sitting at, which is the
narrowing [LMS 314 deliberately did not make](#routing-a-request-to-its-approvers). So an HR
Officer turning down leave still with a manager is recorded as their act, at the manager's
stage, and the manager reading it can see it was not their decision. One field could not say
that, in exactly the case somebody asks. The one pairing neither column may ever hold is the
requester's own id, whichever desk it names —
[LMS 319](#nobody-approves-their-own-request) refuses that row on every connection.

**Who and when are the database's.** `decided_by`, `decided_by_employee_id` and `decided_at`
are stamped by `stamp_the_decider_on_a_decision()` from the transaction-local setting the
repositories set — the same three lines `leave_ledger_entry` stamps its own by, and for the
same reason: a fact the writer has an interest in is not a fact the writer supplies. A writer
who could name the decider could record a refusal under somebody else's name, and one who
could date it could put a decision before the request it decides.

**Every approval writes a decision; only the last writes a movement.** The asymmetry
`LeaveApproved` is shaped around. A manager approving stage one changes no figure in any
balance — the days were held at submission and are held still — so there is no ledger entry
to post, and it is exactly then that "somebody at a desk said yes" is the only thing that
happened. The two administrative endings write neither: withdrawing is the person taking
their own request back and cancelling is HR unwinding a row that should not be on the books,
and asking somebody to justify changing their mind is not what FR 39 is for. `SettlingAct`
is a union rather than an optional field, so the door cannot be handed a comment for a
withdrawal at all.

**And the decision lands with the move, or neither does**, which is the fourth of a family
whose shape LMS 314 settled:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_gives_its_days_back` | an ending that released nothing | — |
| `leave_request_takes_its_days` | an approval that committed nothing | `TRUNCATE` |
| `leave_request_records_its_decision` | a move at a desk that recorded no decision, including the intermediate one that changes no status at all | a withdrawal or a cancellation, which decide nothing |

It reads the *latest* decision rather than merely checking that one exists, and that is not
belt and braces: it is the check that a decision explains *this* move rather than some
earlier one. LMS 315 also declined a unique index on `(request, desk)` on the grounds that a
chain reordered under a live request could ask the same desk twice — true of the walk it was
written against, and [no longer true](#every-stage-must-approve): `nextUnapproved()` never
returns a desk that has signed, and `leave_request_decision_once_per_desk` now holds that in
the schema.

**Append only, and deliberately not audited.** `refuse_update()` and `refuse_delete()` hold
against the owner as well, and `lms_app` is never granted more than `SELECT` and `INSERT`. A
refusal whose comment can be edited says whatever the last person to look at it wanted it to
say, and the person it was written for has no way of knowing; an approver who put it badly
decides again. There is no audit trigger for the reason [the ledger declined
one](#the-balance-ledger): a row that can never change is already its own history, and it
carries its writer and its instant in its own columns. The `leave_request` row it accompanies
*is* audited, in the same transaction — so the log answers who moved this request and when,
and the table answers what they said about it.

**Why the audit log is not this**, since it already records who moved a request and when. It
has nowhere to put the comment; it cannot say which desk, because `awaiting_approval_from`
moves in the same statement and the entry holds only the before and after; and NFR AUD 02
makes it an investigator's record, read by whoever settles a dispute two years later. The
sentence a manager writes is written *to the requester*, and a record only an administrator
can read is the corridor conversation with extra steps. `decisionsFor()` is the reading half,
decided by the same `leaveRequestPolicy.read` that decides who may see the request — because a
decision is the explanation of a status, and standing to see one without the other is standing
to see half an answer.

**What is deliberately not here.** That somebody is *told* their leave was refused is FR 45's
notification and a story of its own; what this one guarantees is that there is something true
to tell them.

---

### Every stage must approve

**Leave is agreed when every stage has agreed it, and not before.** FR 41, FR 42, LMS 316.
The routing gets a request to the right desks and the decisions record what each said; this
is the story that makes "approved" mean what the employee thinks it means.

Since [LMS 318](#hr-overturns-a-line-managers-decision) the *routing* half of this asks which
stage has **decided** rather than which has approved, so a rejection carries the request on to
the next desk instead of ending it. What is unchanged is the sentence above: a request is
`APPROVED` only where the last stage to decide said yes, and a stage nobody asked has neither
an approval nor a rejection on record.

**The walk asks which stage has not signed, not which desk comes next.** That is the whole
change, and it is one line. LMS 314 walked with `approverAfter(chain, theDeskItWasAt)` — a
question about a *position* in a list — against a cursor on the request. It is right while
the chain stands still, and FR 31 says it need not stand still.

The case it gets wrong is **a stage added in front of a request in flight**. Annual leave
goes manager then HR. A request is with HR because the manager has signed. An administrator
changes the chain to CEO, manager, HR. The desk after HR is nothing, so HR's yes approves the
leave outright, the Chief Executive never sees a request the policy now routes to them, and
the person is told their leave is agreed. That does not arrive as a bug report. It arrives as
somebody on an aeroplane.

`nextUnapproved()` cannot make that mistake, because it is a question about the whole chain:
the first stage in it with no approval recorded. Two things follow that are worth naming
rather than discovering.

**It is only askable because of `leave_request_decision`.** Until [LMS
315](#approving-or-rejecting-at-a-stage) made decisions rows, "has every stage approved" had
no answer in this system — there was a cursor saying where a request had got to and nothing
saying who had actually signed. The two agree until somebody edits a chain.

**And nobody is asked twice.** A desk that has signed is skipped, so a chain reordered
mid-flight cannot send a request back to a desk it came from. That is what retired LMS 315's
caveat and let `leave_request_decision_once_per_desk` be added.

**The cursor stays.** `awaiting_approval_from` is what an approver's queue reads (FR 40) and
what the policy resolves to a person, and it is now a record of where the request was *sent*
rather than the thing that decides where it goes next.

**`approverAfter()` and `isFinalApprover()` are gone rather than kept beside the new walk.**
Two answers to "who is next" is one answer waiting to disagree, and the second one is wrong.
Being last in the list is likewise not the same as being the last to sign, once a stage can
be added in front; whether an approval was the last word is `isTheLastWord()`, which reads
the outcome of the walk rather than the shape of the list.

**And the schema says it too**, because the application is not always the writer:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_is_approved_by_every_stage`, deferred | a request approved with a stage unasked, whatever wrote it | a chain that grows *after* approval |
| `leave_ledger_entry_takes_no_days_for_ended_leave`, deferred | days taken for leave that was refused, withdrawn or cancelled | days taken for a request still being decided |
| `leave_request_decision_once_per_desk`, a unique index | one desk deciding twice on one request | two requests decided by one desk |

The first is judged against the chain **as it stands at the moment of approval** — the same
reading the application makes, and the only one that can be right: a request approved last
March under a two-stage chain is not retrospectively unapproved by a third stage added in
November. Order is deliberately not checked. The rule is that every stage approved, not that
they approved in the order the chain lists them; the order is the routing's, and a check here
would refuse a legitimate approval the afternoon somebody reorders a chain mid-flight.

**Final-stage rejection ends the workflow**, and the earlier approvals do not survive it as
anything but a record. A refusal at any stage — the last included — leaves the request
`REFUSED`, releases the full hold at once (the days were still `pending`, because only the
last approval commits), and the manager's approval stays on the file as what it was: a stage
that agreed to leave the company did not, in the end, give. Nothing moves out of `REFUSED`,
and no `DEDUCTION` was ever written.

**What this story declined to do.** The tempting second trigger is the exact converse of
`leave_request_takes_its_days` — days committed belong to leave that was approved — which
would make a `DEDUCTION` and an `APPROVED` status exist only together. It is truer and
stronger, and it refuses every use of `BalanceService.commit`, the primitive LMS 314 kept on
purpose beside the approval door ("a story that commits days for a reason other than a chain
running out will want it"). Taking a movement away from the ledger is somebody's decision to
make rather than a side effect of tightening the workflow — the same judgement LMS 314 made
about not narrowing `leaveRequestPolicy.refuse` to the chain. So the trigger is about
endings, and the converse is one line for the story that removes the primitive.

**And the person is told where it stands, in a sentence that answers first.**
`progressFor()` reads the four facts that could mislead them — the status, the desk, the
decisions, the chain — and returns one of them: `agreed`. A screen showing the newest
decision would say "approved by your line manager", which is true and is exactly the belief
this story exists to prevent, so the two halves are one string composed once rather than two
fields a screen may show one of.

`agreed` is the status and not an arithmetic over today's chain, which matters for leave
approved under a chain that has since grown: the days are taken, everybody it was routed to
signed, and recomputing the answer would tell the person their leave is not agreed after all.
What was recorded is what happened. `stagesMissing` is where that difference is reported
rather than hidden.

**Still not here.** Being *told* is FR 45's notification. Disputing a refusal is FR 41's
appeal, and it reads these rows rather than adding any.

---

### Days come back on rejection

**Rejection at any stage gives back everything the request was holding, at the moment of the
rejection.** FR 43, LMS 317. The employee asks for the same fortnight again in the next
breath, and nothing and nobody has to release anything first.

**Most of this has held since [LMS 306](#the-days-come-back)**, and it is worth saying so
rather than restating it as new. That story built the three endings as one movement: refusing
writes the `RELEASE` and the status in one transaction, so the days are back before the
approver's screen has finished reloading, and `REFUSED` is not in
`leave_request_never_overlaps`, so the dates stop blocking the calendar in the same instant.
Neither waits on HR, a job, or a nightly anything. What the chain added is that a rejection
can now happen at a *later* stage, and the answer is the same: only the last approval commits,
so a request refused after two approvals was still holding all six days as `pending`.

**What LMS 306 did not say is how many days come back.** `leave_request_gives_its_days_back`
asked whether a `RELEASE` existed, which is the right question asked short. A request that
ends having given back one day of the six it held satisfies it perfectly and leaves five in
`pending` that nothing will ever return — a balance permanently short, against a request that
says it ended, with a ledger that reconciles. That is worse than releasing nothing, because
nobody notices.

So the rule is **widened rather than joined**: `CREATE OR REPLACE` on the function, with the
trigger, its `WHEN` and its constraint name untouched. The rule was "a request that ended gave
its days back"; it is now "gave *its days* back", which is the same sentence read properly
rather than a second one beside it. A separate trigger would be two rules about one act firing
on the same `WHEN`, of which the older is implied by the newer, and `LeaveRequestRepository`
would have to learn a second constraint name to say the same thing about. The same widening
LMS 314 made to `refuse_an_impossible_transition()`.

**It is judged against the request's own `days`**, frozen since submission by
`refuse_rewriting_what_a_request_cost()`, so the figure that has to come back is the figure
that was taken and neither can move. **Not against the balance** — `pending` is per employee,
leave type and leave year, so somebody with two requests in flight has one figure covering
both and nothing about it can say which days are whose. That is the same reason
`LeaveAlreadySettled` guards on the status: a wrong release is "the request state machine's
integrity to keep rather than the balance's".

**And it covers all three endings**, because a withdrawal that gave back one day of six is
the same defect wearing another name. A rule that covered only refusals would be a rule about
which button was pressed rather than about what a request was holding.

Nothing that goes through the door can produce a partial release: `daysToRelease()` refuses to
give back more than is held and is handed the request's own frozen count, so a release is for
the whole hold or it raises `NotEnoughHeld` and nothing is written at all. What the widened
trigger catches is the second writer LMS 306 named and only half-covered — "a data fix in psql
marking a batch REFUSED, a migration correcting somebody's leave" — each of which can as
easily release the wrong figure as none.

**One thing this story did not change, and it is worth knowing.** *Who* may reject was still
`leaveRequestPolicy.refuse` — the line manager or HR — and it was [not the
chain](#routing-a-request-to-its-approvers). So a request sitting at the `CEO` desk could not
be rejected by the Chief Executive unless they happened to be that employee's line manager.
Closing that is one standing on the `REFUSE` row of `TRANSITIONS`, "which hands a power to a
desk that does not have it today — somebody's decision to make rather than a side effect of
giving days back faster".

[LMS 318](#hr-overturns-a-line-managers-decision) is the story that made it, and it went the
other way round: the row now admits `THE_DESK_IT_IS_WITH` and nobody else. A rejection
advances the chain there, so it has to be the desk's — and the Chief Executive gained the
power in the same line that took it from a line manager whose stage the request had already
passed.

**And "at the moment of the rejection" now means the moment of the *last* one.** The days come
back when the rejection ends the request, which is when the stage saying no is the last to
decide. A manager's no partway along the chain moves no figure at all: the days go on being
held while HR looks at it, exactly as an approval partway along leaves them held. What has not
changed is that nothing waits on HR, a job or a nightly anything once the request does end.

---

### Nobody approves their own request

**The person who asked for the leave never decides it, whatever they hold.** FR 48, §8.6a,
LMS 319. Not an ordinary employee, not the HR Officer whose own request lands in the queue she
staffs, not the Head of HR, not the Chief Executive. An approval somebody can give themselves
is a field on a form rather than a decision, and the story is about what the other approvals
in this system are worth.

**Half of it was already true, and the half that was not is the interesting half.**
[LMS 314](#routing-a-request-to-its-approvers) excluded the requester from
`THE_DESK_IT_IS_WITH`, so nobody has been able to *approve* their own leave since — written
for an ordinary case rather than an adversarial one, because unpaid leave goes to the HR desk
first and an HR Officer asking for unpaid leave holds a code that staffs the desk her own
request starts at.

Refusing was open. `TRANSITIONS` admits `LEAVE_ADMINISTRATION` to the `REFUSE` row, which is
right — HR turning down somebody else's leave is what that standing is for — and the same
officer asking for her own leave held it. She could turn her own request down: a `REFUSED`
status, a `RELEASE`, and a decision row at the HR desk with her name against it, recording a
judgement nobody else made.

**So the check moved from the standing to the verb.** `leaveRequestPolicy.notTheirOwn()` is
the first question `mayMove()` asks of `APPROVE` and `REFUSE` — `isADecision()` is the line,
and it is the same one `/features/leave-request/leave-decision.ts` draws for what gets recorded. Written
against the verb it answers both, and answers whatever deciding verb arrives next by default
rather than by somebody remembering. Left on the standing it answered one row of the table.

**Withdrawing and cancelling are deliberately outside it.** Taking back your own request is
the point of withdrawing, and cancelling is HR unwinding a row that should not be on the
books. Neither is a judgement at a desk, which is why neither writes a decision either — and a
rule that caught them would be the system refusing a person the right to change their mind.
The refusal says so, because the likeliest reader wanted their own leave gone and needs to be
pointed at the act that does it rather than sent looking for a colleague.

**It is the one rule here that nothing can be granted to pass.** Every other decision in
`leaveRequestPolicy` has some answer that admits somebody — a role, a reporting line, the desk
a chain has a request sitting on, all of them configuration that HR fills in on a form. This
one compares two ids. `unit/policy.test.ts` puts every role in `ROLE_CODES` on the requester in
turn and asserts both verbs are refused for all of them.

**Asked four times, at four altitudes**, which is the arrangement every rule in this system
that matters has:

| | Where | Catches |
|---|---|---|
| `leaveRequestPolicy.notTheirOwn` | at the top of `approve()` and `refuse()`, before the chain, the type or the state is read | the person at the screen, with the sentence they need |
| the same, inside the balance lock | both doors of `BalanceService` | the answer taken against the row nobody else can move |
| `ledgerPolicy.commit` | the ledger door | anybody moving this balance who has no standing over it at all |
| `leave_request_never_decided_by_the_requester` | `AFTER INSERT` on `leave_request_decision`, every connection | the admin view, the bulk action, the repair script, the psql prompt |

The last of those is the story's "regardless of role, screen or endpoint" in the only form it
can take before there is a screen or an endpoint, and it is complete rather than a second
opinion: `leave_request_records_its_decision` refuses a request that moved at a desk with no
decision behind it, so a self-approval that cannot write a decision row cannot move a request
either. The two triggers are one rule read from both ends.

It is `AFTER INSERT` rather than `BEFORE` for a reason worth knowing before writing the next
one. The column it reads is stamped by a `BEFORE INSERT` trigger, and `BEFORE` triggers fire
in **name order** — so a `BEFORE` trigger named for this rule would run first, read a null
decider every time, and pass everything silently.

**A null decider passes, and that is the system.** `theSystem` is nobody by construction —
`/auth/actor.ts` gives it a null `employeeId` so it matches no record's owner — and it reaches
every table in this schema that way. A rule refusing a null would refuse the annual run with a
sentence about self-approval.

**403 and the log are `Guard.enforce`'s**, as every refusal in this system is: a
`NotAuthorised` carrying the vague message or the open one, with the attempt written to the
denial log first — who, what they held, which verb, whose leave. Turning that into a status
code arrived with [LMS 401](#my-balances) and is `http/problems.ts`: an open refusal is
403 with its own sentence, a silent one is **404 with the words a missing record produces**,
because a 403 would state the very fact the message declines to. What this story settles is
the half that has to be right on the server whatever the interface does.

**The reciprocal is [LMS 320](#routing-round-an-approver-who-cannot-decide).** This story left
such a request waiting at a desk only its own requester staffs — "stuck and visible is the
side to be wrong on" — and FR 48b is where it goes instead.

---

### Routing round an approver who cannot decide

**A stage its own desk cannot answer is skipped to one that can, and nothing is approved by
running out of people to ask.** FR 48, FR 48b, §8.6a, LMS 320. The reciprocal LMS 319 left:
that story refused the requester at four altitudes and the request stopped where it stood.

**A desk is empty in three different ways, because the three resolve to a person by three
different mechanisms.** `features/leave-request/routing.ts` holds the whole of it, and it is
pure — the chain, what each desk amounts to, and nothing else.

| Desk | Cannot answer when | Who that is |
|---|---|---|
| `MANAGER` | the requester has no line manager | FR 04's single root, the Chief Executive |
| `HR` | every HR role is the requester's, or nobody's | the lone HR officer, `lone-hr` in the seed |
| `CEO` | the root is the requester, or there is no root | the Chief Executive asking for unpaid leave |

`DeskStanding` is those three answers rather than a boolean, because the boolean loses the
half a person acts on: "nobody holds an HR role" and "the only person in HR is the one who
asked" are different news and produce different sentences.

**One stand-in each, and the ladder is deliberately not symmetrical.** `STAND_IN_FOR`, and it
is written out rather than derived from an ordering of the three:

*The line manager's stage goes to HR.* There is no second line manager to try — a reporting
line has one person on it — so the stage is skipped rather than restaffed.

*HR's stage goes to the Chief Executive.* "Another HR officer" is not a fallback at all: the
desk is staffed by a *role*, so a second officer already fills it and this branch is reached
only once there is nobody in HR but the requester.

*And the Chief Executive's stage goes back to HR*, which is the one rung pointing downwards
and the reason the table is a table. There is nothing above FR 04's root; the honest second
best is the function that holds the policy the root would have applied.

**A stand-in is one deep.** HR standing in for the manager, and then the Chief Executive
standing in for HR standing in for the manager, is a chain of substitutions nobody configured
and nobody could read off a screen. Where the one stand-in is empty too, the request stops.

**A skipped stage is recorded, and a recorded skip is never reconsidered.**
`leave_request_routing` is append only and holds one row per stage per request: the stage, the
desk that took it, and why in words. It is the same rule LMS 316 gives a decision — a stage
skipped on Monday has had its turn, and a line manager appointed on Wednesday does not send a
request that is already with HR back down. `refuse_an_approval_a_stage_never_gave()` reads it,
which is what lets the one request FR 48b exists to move actually be approved: without that,
a request whose manager stage was skipped could never reach `APPROVED`.

**A stage that went *nowhere* is deliberately not one of those rows.** It is the `UNROUTABLE`
status and the alert instead, and the difference is what makes recovery possible: a skip is
settled for ever, and a stage nobody ever answered has not been dealt with, so re-routing can
reconsider it once somebody is at the desk.

**`UNROUTABLE` is the sixth status, and it is neither an ending nor an approval.** The days
are still held — its `RESERVATION` stands, so it is in `LIVE_STATUSES` and in
`leave_request_never_overlaps` — the leave is still wanted, and what is missing is somebody to
ask. Three moves come out of it and none of them is a decision: the person withdraws it, HR
cancels it, or HR **routes** it, which works the routing out again against the organisation as
it now stands and refuses with `StillNobodyToDecideIt` where nothing has changed.

**Nothing is ever auto approved, and it is held in four places.** The walk returns `DECIDED`
only by stages *deciding*; `isTheLastWord` answers false for an unroutable outcome so no
ledger entry is written; `refuse_an_impossible_transition()` refuses `UNROUTABLE → APPROVED`
on every connection; and `leave_request_is_approved_by_every_stage` still refuses a stage with
neither a decision nor a skip. `unit/routing.test.ts` sweeps all twenty-seven states of the
three desks against three chains and asserts the first of those directly.

**The alert goes to two kinds of reader.** FR 59's `UNROUTABLE` notice reaches the person
whose leave stopped — *nobody has approved or turned it down, and your days are still held* —
and everybody who could change the organisation so that it has not, which is HR and the Chief
Executive. It is written to say what to fix rather than only that something is wrong.

**Deduplication is by desk, never by person.** A chain whose stages collapse onto one desk
asks that person once: the lone HR officer's unpaid leave is HR then the Chief Executive with
the first stage standing in on the second, and one signature settles both. Where two
*different* desks happen to resolve to the same human — the Head of HR reporting to the Chief
Executive — they are still two stages and are asked twice. A walk over a list of offices does
not know which people fill them, and should not.

**What is deliberately not here.** Cover while an approver is themselves away is FR 49 and is
a different question: this story is about a desk that is empty, not one whose occupant is on
holiday. A terminated record staffs nothing — somebody who has left cannot sign in — and that
is the whole of the overlap.

---

### Cancelling a request nobody has approved

**A request that is still being decided is taken back by the person who asked for it, at any
stage, and the whole hold comes straight back.** FR 46, LMS 323. Plans change; a request in
somebody's queue that the employee no longer wants should cost them no days and cost the
approver no time.

**The story's verb is `withdraw()`, and that is not the same word as `cancel()`.** Worth being
plain about, because the story says *cancel* and this system reserves that word:

| The story's word | The method | Whose act |
|---|---|---|
| cancel a request I have not yet had approved | `withdraw()` | the person who asked, or HR on their behalf |
| — | `cancel()` | HR unwinding a row that should not be on the books — the wrong person, entered twice, days in the wrong year |

They are [three endings and three decisions](#the-days-come-back) for a reason, and the ledger
records which of the three happened: five days coming back look identical in a balance whether
somebody changed their mind or HR corrected a mistake, and those are different conversations.
Renaming either to match the backlog would lose that distinction to a synonym.

**The act itself has existed since [LMS 306](#the-days-come-back).** What this story
establishes is the half that could not be proved then, because a request could only ever be
standing at its first desk: **the stage plays no part in it.** `TRANSITIONS` keys a `WITHDRAW`
by the from-status alone, and `SUBMITTED` is the whole of "not yet approved" — a chain of
three with two desks already signed is still a request the employee takes back on their own.

The way that stops being true is one word: `THE_DESK_IT_IS_WITH` added to the `WITHDRAW` row.
It would read like a tightening and would mean an employee holding days they cannot release
until an approver gets round to it, which is the exact waste FR 46 is about. `unit/state-machine.test.ts`
asserts that standing is not on the row, and `integration/leave-request.test.ts` walks a real
withdrawal at every desk in `APPROVER_ROLES` and from the middle and the end of a chain of
three.

**In full, wherever it is taken back from.** An intermediate approval writes no movement at
all — only the last desk commits — so the six days a request has held since submission are the
six that come back, and the approvals it collected on the way cost the employee nothing.

**And out of the queue in the same statement.** The desk goes to null with the status, which
`leave_request_waits_at_a_desk` makes an equivalence rather than a convention — so the
approver queue of Phase 4 cannot be built in a way that shows a withdrawn request, whatever it
queries, because the row it would have to find is one the database will not hold. What an
approver already *said* is untouched:
`leave_request_decision` is append only, so a request taken back after the manager agreed reads
afterwards as exactly that rather than as one nobody looked at.

**What is deliberately not here, and it is two other stories.** Leave that has been
**approved** is not this — the days are `taken` by then, so giving them back is a movement
against the `DEDUCTION` and needs HR — and `LeaveCannotBeMoved` is what somebody reaching for
withdraw on it is told, in words that do not claim the days came back. That is FR 47. Being
*told* the request went away is FR 59, which owns notification for every event in a request's
life and is a story of its own; what this one guarantees is that there is something true to
tell.

**And there is no draft.** The backlog's "while draft or pending" describes a state this system
does not have: a request exists because somebody submitted it, and `REQUEST_STATUSES` holds no
`DRAFT` because [LMS 209's rule](#the-state-machine) is that a status arrives in the
same story as the transition that reaches it — a state nothing can create is a promise the
schema cannot keep. Adding one would be a lifecycle rather than a cancellation, and nothing in
the backlog asks for it.

---

### My balances

**Every leave type, with what was granted, carried over, taken and spoken for, and what is
left — for a leave year the person picks.** FR 53, §7.4, LMS 401. The first story of Phase 4
and the first one anybody outside this repository can see, because it is also the story that
brought the route layer and the client.

Everything the answer is made of has existed since Phase 2. The ledger records the movements,
`leave_balance` keeps the sum, `BalanceService.forEmployee` reads it. What this story adds is
the arrangement of those figures into something a person can read, and **three ways a screen
of correct numbers could still mislead**.

**A leave type with no row is not a leave type with no allowance.** `BalanceRepository.forEmployee`
returns only balances something has moved, says so, and hands the rest of the question over by
name. `linesFor` in `features/balance/balance-statement.ts` is the answer: a type is on the statement
where **anything has moved it**, or where it is **still offered and open to this person**. The
moved limb is asked first, so no rule about retirement or eligibility can hide a figure that
exists — a type HR retired in March stays on the statement of everybody with days in it,
because a figure that exists has to be explainable. The second limb is why sick leave shows
three days to somebody who has not been ill, and why maternity leave is not on a man's
statement at all: a line reading "0 days" against a type he can never request is worse than no
line. FR 05, read off `gender_restriction`.

**A nought that means "not yet" is not a nought that means "none left".** FR 32g divides the
types in two, and compassionate leave reading nought in January is not somebody who has used it
all — it is somebody nothing has happened to. Shown as a bare digit it says the opposite of
what is true, to somebody who is by definition having a bad week. So every line carries
`allowanceInWords`, which says whether the figures are a yearly allowance or something granted
per occasion, and names the expiry where FR 32e gives one.

**The row has to add up.** The backlog asks for five figures; the line carries six. `adjustment`
is the extra one and it is not padding: available is
`entitled + carriedOver + adjustment − taken − pending`, so a screen showing four of those five
terms beside the answer is a subtraction the reader cannot perform — and the missing term is
exactly the one they are querying, because FR 37's manual movements are the figures people ask
about. **And nothing totals the column.** Twenty annual days and three sick days are not
twenty-three of anything.

**Prior years are the ones that were theirs.** `yearsToChooseFrom` has the same two-limbed shape
and for the same reasons: the years they were **employed** for, via the `employedPortionOf` the
pro rata grant already asks — so a joiner does not get the year before they arrived and a leaver
does not get the year after they went — and the years they **hold a balance in**, which is the
safety net for a figure filed somewhere employment does not reach. Asking for a real year that
is neither is a 404 that names the years that are, rather than seven rows of nought that read as
"you have no leave". Next year *is* on the list, because the rollover fills it in the moment
this one closes.

**And the counting basis is on every row, in words.** FR 22, the story's third criterion.
`countingBasisInWords` moved from the request quote to `features/leave-type/leave-type.ts` when this became
its second caller — it is a fact about a type and nothing about a request. It matters more here
than on a quote, because a statement puts annual leave and maternity leave in adjacent rows
where the same "14 days" means a fortnight of work in one and a fortnight of the calendar in the
other.

#### And the route layer, which had to exist first

There were no endpoints before this story. Three phases of services were built and tested
without one deliberately — "LMS 112 put authorisation in the service layer, which is the half
that has to be right whatever the interface does" — so what arrived here is the interface, and
it adds no rule.

**`GET /api/me/balances`, and `me` is not a convenience.** The employee id handed to the service
is `actor.employeeId`, off the verified session cookie, so there is **no way to point this route
at anybody else** whatever is sent. `ledgerPolicy.read` would refuse somebody else's balances
anyway and a `/employees/:id/balances` guarded by it would be correct — but it would be correct
*because the guard is asked*, and a route that cannot name anybody else needs no such argument.
FR 55 and FR 56 are LMS 405, and they are a different route with a rule of their own about who
the subject may be.

**The session cookie carries an employee id and no roles.** `SignedIn.actor` is explicit that an
actor is the answer to "who is this" and never the evidence for it, so the cookie is an id, an
issued-at and an HMAC over both — and `http/identify.ts` re-reads the employee record, the
login and the roles on **every request**. That is stricter than the snapshot this README used to
describe: an `HR_ADMIN` revoked while somebody is working is gone on their next request, and
somebody terminated at nine o'clock is refused at one minute past.

**The mounting order in `http/app.ts` is the authorisation model.** Two sign in routes in
front of `identify`, everything else behind it. A route added behind it cannot be reached
without a session whatever its handler forgets; making one public is an edit to that file, which
somebody reviews.

**A silent refusal is 404, not 403.** `http/problems.ts`, and it is the one translation that
had to be got right: `NOT_AUTHORISED_MESSAGE` is written to be word for word identical to what a
missing record produces, because "two messages that differ are a way of asking the server
whether a record exists" — and 403 means "it is there and you may not", which states the very
fact the sentence declines to. The status has to be as vague as the words are.

**Nothing is recalculated in the browser.** Not `available`, not a day count, not which leave
year today is in. Every figure the screen prints is a field on the wire, and
`integration/balances-api.test.ts` asserts the exact field list so that one going missing is a
failing test rather than a subtraction the client quietly starts doing. A figure computed in a
browser is a second implementation of a rule, running where no test in this repository can
reach, and the first sign the two disagree is somebody planning a fortnight around a number that
was never true.

**And a calendar date stays ten characters.** `2026-12-31` goes from the column to the JSON to
the screen untouched, and `client/src/api.ts` never hands one to `new Date()`. NFR DAT 03: a
leave year runs to a day rather than to an instant, and converting one in a browser is how the
last day of the year becomes the second to last for anybody west of Greenwich.

**The client uses no company colours**, on purpose. LMS 409 brings the brand and the component
library is still "to be confirmed with the designer"; the stylesheet is CSS system colours and
the browser's own font stack, which means it follows the reader's light or dark setting for
nothing. Inventing a palette now would not merely look wrong — it would get signed off, and the
tokens would arrive too late to matter.

### My request history

**Every request somebody has made, with where it has got to and the account of how it got
there.** FR 54, §7.4, LMS 402. The story's "so that" is the whole design brief: *I can check
what happened without relying on memory or email*. Memory is wrong about whether the second
approver ever answered, and an email is a record of what was sent rather than of what is true
now — the message saying a manager approved a request is still in the inbox after HR turned it
down.

**The answer lives in four tables, and any one of them read alone is a true fact and a
misleading screen.** `leave_request.status` says whether a request is being decided,
`awaiting_approval_from` says who is deciding it, `leave_request_decision` says what each desk
said and why, and `leave_type_approval_step` says how many desks there were meant to be. The
pairing that actually misleads people is the one LMS 316 was written about: **the newest
approval, shown on its own, reads as agreement.**

`progressOf` in `features/leave-request/leave-request.ts` already put those four together for FR 41 and this
story restates none of it — every entry carries that function's answer whole. What
`features/leave-request/request-history.ts` adds is the *order*: a progress is a verdict about now, and a
history is the sequence that produced it.

**So the trail contains what has not happened yet**, which is the decision in the story most
worth arguing for, because a trail reads as a list of events and a pending stage is not one. A
list that stops at "approved by your line manager" is read as the last word by somebody with an
aeroplane ticket in the other tab. A list that ends "then HR, who has not been asked yet" cannot
be. Those steps carry a null `at`, which is what tells a screen they have not happened without
it having to know what the four kinds mean.

**Two endings carry no name and no time, and that is reported rather than guessed.** A
withdrawal and a cancellation are not decisions — `features/leave-request/leave-decision.ts` is emphatic that
"a decision recorded for either would put a judgement in front of the requester that nobody
made" — so no row names who did it or when. The tempting substitute is `leave_request.updated_at`,
and it is wrong in a way that would be hard to see: a reworded reason moves that column, so a
request withdrawn in January and tidied up in March would report March. The audit log has both
facts and is deliberately not read — NFR AUD 02 makes it an investigator's record, and this
screen is for the person whose leave it is. **The gap is one story wide**, and what closes it is
recording those two endings as events of their own.

**The decider is named, and `decided_by` is not what names them.** That column holds
`Actor.description`, which `signedInAs` composes as `employee 10` — a handle written so a log
entry can be attributed without a join. "Turned down by employee 10" is not a sentence to show
somebody whose leave was refused, so the service resolves `decided_by_employee_id` against
`EmployeeRepository.findAllById` and the recorded description is the fallback rather than the
answer. Leavers included: a manager who has since resigned still approved what they approved.

**Nothing is re-priced.** `days` and `counting_basis` come off the request as it was submitted,
never off the type as it stands now — FR 11, and a history is where an HR Administrator moving
annual leave to calendar days would otherwise restate last March's fortnight as fourteen days
beside a ledger still saying ten.

**Newest first, which is the reverse of the calendar.** `LeaveRequestRepository.list` orders by
the day the leave starts "because a leave page is read as a calendar"; a history is read the
other way round. The sort is stable and compares one field, so two requests written in one
transaction keep the order the repository gave them rather than needing a tie break on a
`BIGINT` that reaches the domain as a string.

**And an empty year is an answer rather than a refusal**, which is the one place this route
behaves differently from `/api/me/balances`. That one raises `NotOneOfTheirLeaveYears`, because
seven rows of nought read as "you have no leave" to somebody who was not employed yet. An empty
history reads as "you asked for no leave that year", which is exactly what it means. A leave
year id that names nothing is still a 404.

#### A read service beside the write door, not a method on it

`GET /api/me/requests`, and `me` means the same thing it means for balances: the id handed to
the service is `actor.employeeId` off the verified cookie, so the route cannot be pointed at
anybody. FR 55 and FR 56 remain LMS 405's.

`LeaveRequestService` already reads requests, decisions and progress, and the shortest version
of this story is a fourth method calling all three in a loop. `RequestHistoryService` exists
instead for the reason `BalanceStatementService` is not a method on `BalanceService`:

- **That class is the write door.** It holds the balance service, the calculator and the
  notifier because submitting and approving need all three, and every one would have to be
  constructed to serve a screen that only reads. A route layer that had to build an SMTP
  transport to render a list of past leave is one where the read path fails for reasons the read
  path has nothing to do with.
- **A loop over those three methods is a query per row.** `progressFor` re-reads the request,
  the employee, the type and the decisions for each entry, because it answers about *one*
  request from an id. Forty requests is a hundred and sixty round trips for a page.

So the reads are done once, in bulk — six of them for the whole screen — and the domain does the
assembling. `LeaveDecisionRepository.forRequests` is the one new query, and it is
`forRequest` widened by an `in` with the same `ORDER BY id`, because `now()` is identical for
everything written in one transaction and an account sorted by time could reorder itself between
two reads.

**And the client got a second screen**, which is where `App.tsx` had to decide about a router
and deliberately still has not. LMS 401 said the decision was "worth making when there is more
than one place to go"; two places is not where the argument turns, because what a router buys is
*addresses* — a link, a bookmark, the back button — and a URL scheme chosen before the request
form and the team calendar have said what they need to link to is a scheme chosen too early. The
cost is named rather than hidden: **neither screen can be linked to, and the back button leaves
the application.** The story that adds a third screen brings the router. (LMS 403 is that story,
and it did — see below.)

---

### The request form

**The rules arrive while somebody is filling it in, not after they have submitted.** FR 11,
FR 32f, §7.4, LMS 403. The story's "so that" is the whole design brief: *I find out about
documentation or notice before submitting, not after*. The failure it is written against is
concrete and it is a person's afternoon: a fortnight submitted, then a message saying it needed
a certificate nobody mentioned, or that compassionate leave was never anybody's to promise.

**Three criteria, and they become answerable at two different moments.** That is the whole
shape of the story and it is why there are two calls rather than one:

| When | What is true | Where it comes from |
|---|---|---|
| The screen opens | What each kind of leave asks of you | `GET /api/me/request-form` |
| Two dates exist | What this period costs | `GET /api/me/requests/quote` |

`quoteFor` in `features/leave-request/leave-request.ts` already answers the second, and has since
LMS 301 — the day count, the days inside the period that were free and why, what the balance
holds and would hold, and the warnings. **It cannot answer the other two, because a quote needs
a period.** A form built on the quote alone would tell somebody maternity leave needs
documentation on the keystroke after they had settled the dates, and would tell somebody
choosing compassionate leave nothing at all until they had committed to a week. Both are later
than the story asks and later than the facts are available: the rules are properties of the
type, and they were true before anybody opened the page.

So `features/leave-request/request-form.ts` is a second read model beside the history's, and
**one fact is deliberately said twice in two voices**. The standing rule is *this kind of leave
needs documentation*; the quote's `DOCUMENTATION_REQUIRED` warning is *these nine days need it*.
Neither is a duplicate and the second cannot replace the first, because the first is the one
that arrives in time to change what somebody does.

**Compassionate leave's discretion is configuration, not a flag and not an `if`.** The story
names one leave type, which is exactly the shape FR 31 and design principle 5 forbid answering
with a branch. It is answered with the column the business already wrote it in:
`leave_type.description` says *"Granted per occasion. Say what it is for; whether it qualifies
is for your manager and HR to decide."* — and the seven-leave-types migration says why there is
nothing more structural to read: "no list of qualifying relationships anywhere in the system:
that is the approvers' judgement on the reason given."

The `ENTITLEMENT` rule states the structural half from `entitlement_basis` — *granted per
occasion rather than as a yearly allowance, so there is nothing standing to your name until an
occasion arises* — which is the same sentence `allowanceInWords` makes on the balance screen and
for the same reason. Neither knows which type it is about. `unit/request-form.test.ts` ends by
configuring two types with the same code and opposite rules and asserting they say opposite
things; `integration/request-form-api.test.ts` is the other half, and is the only place the
claim can be made about the row the migration actually wrote rather than about a fixture.

**A rule that asks something is marked as one.** `FormRule.asks` divides *fetch a certificate,
give a fortnight's warning, do not leave it more than a week* from *counted in working days,
goes to your line manager then HR*. It is the same division `RequestWarning` draws for a priced
period, and it is what stops the one sentence the story exists for being the fourth bullet in a
list of eight. A type that asks for nothing says nothing rather than saying "no documentation
required": half a list reporting the absence of a rule is a list nobody finishes.

#### The quote is a GET, and the method is load bearing

It writes nothing, reserves nothing, and is documented as safe to call on every keystroke that
changes a date. A POST would say the opposite to every proxy, every log and every developer
reading the route table — and the first person to see `POST /me/requests/quote` beside
`POST /me/requests` would reasonably wonder which of them created something.

`reason` is not one of its parameters, and `LeaveRequestService.quote` now says so in its
signature: it takes `Omit<NewLeaveRequest, 'reason'>`. What a period costs is a question about a
type, two dates and a working pattern. A form pricing a fortnight on every keystroke would
otherwise put a half-written explanation into a query string and from there into an access log.

The browser debounces and drops stale answers, and neither is about the server. A native date
input fires a change for every part of a date somebody types, and two dates typed quickly are
two requests that can land in either order — a screen without the sequence counter shows the
cost of the date somebody has already changed.

#### Refusals had to stop being five hundreds

The refusals a form provokes are the ones carrying the instruction: `LeaveCrossesAYearEnd` names
the two dates to submit instead, `NotEnoughDays` names how many days could be asked for,
`TooLateToRecord` names who can still enter it. Every one of them reached a browser as
"Something went wrong. It has been logged." — because `http/problems.ts` matched `Invalid*` and
`*NotFound` and nothing else. That sends a developer to the logs instead of the person who can
fix it, and it is the exact failure this story is about.

`REFUSED_BY_A_RULE` is a table rather than another prefix test, because these are not a family
with one answer between them. **400** where the answer is to change what was typed — a period
that costs nothing, one that crosses a year end. **409** where what was typed is fine and the
state of the world refuses it — leave already booked, a balance without the days, a retired
type, a settled year. Nothing retyped fixes the second kind.

#### And the third screen brought the router

LMS 402 named the moment: "The story that adds a third screen brings the router." This is it.

It is not a dependency. Three static screens with no parameters and no nesting need the
*address* — a link, a bookmark, a back button that moves between screens instead of leaving the
application — and nothing else a routing library sells. `useSyncExternalStore` over `hashchange`
is that, in a dozen lines, and the tabs became anchors so that middle click, copy-link and
history are the browser's behaviour rather than something `App.tsx` reimplements.

**The hash rather than a path**, because a path needs the server to answer every URL with
`index.html` and `http/app.ts` does not: a reload on `/requests` would hit the API's own 404.
The hash never reaches the server. When the deployment grows a static file server with a
fallback, this becomes the History API and nothing else changes.

#### Still not here

**FR 18 is stated and not enforced.** `assertWithinBackdatingWindow` has existed since LMS 201,
is tested, and is called from nowhere on the request path — so the form says leave can be
entered up to seven days after the fact and the server would accept it from a month back. The
gap predates this story and closing it changes what `submit` accepts, which is LMS 301's rule
rather than this screen's. What this story does is stop the window being invisible.

**No attachment.** FR 13 is a rule the form explains and a document nobody can upload yet:
`storage/` exists and nothing on this path writes to it. "Have it ready — whoever approves this
will ask for it" is the honest sentence until the story that adds the upload.

---

### The approver queue

**One place holding everything waiting on this person, so nothing sits unnoticed.** FR 20,
FR 40, §8.6a, LMS 404. The failure it is written against is a manager going through email to
find out what they owe an answer on, and a request nobody happens to look at.

**The desks are the query, and the query is the disclosure gate.** `desksStaffedBy` in
`features/leave-request/policy.ts` answers which desks somebody staffs, and it is `isAt` — the
question `approve` asks — turned the other way round: that one takes a request and asks *are
you the desk it is sitting on*, and a queue has no request in hand. `MANAGER` is
`actor.isManager` narrowed to that person's own reports; `HR` and `CEO` are staffed for the
whole company, because those desks are. `LeaveRequestRepository.awaiting` builds one `WHERE`
out of the two shapes, and the rows it can return are by construction rows this person may
decide.

So there is no per-row `read` check on top, and adding one would break the one approver §4.3.1
names: FR 32h routes unpaid leave to the Chief Executive, who is nobody's line manager and
holds no role, so `read` would refuse them every request they exist to decide. **Being the desk
is its own reason to be looking** — the same seam `approve` already argues. It is why the
balance figures are read through `BalanceRepository` rather than `BalanceService`, whose
`ledgerPolicy.read` the Chief Executive fails.

**Filtered on the desk and not on the status**, which is [the state
machine](#cancelling-a-request-nobody-has-approved) being taken at its word:
`leave_request_waits_at_a_desk` is an equivalence, so a row at a desk is a row still being
decided and a decided one has left the queue in the same statement that decided it.

#### Own requests are on it and cannot be moved

The story says *never actionable*, and the shape that rules out is a queue that hides them —
one `filter`, and the wrong side to be wrong on. The case is ordinary rather than adversarial:
unpaid leave goes to HR first, so an HR Officer asking for unpaid leave has a request standing
at the desk she staffs. Since
[LMS 320](#routing-round-an-approver-who-cannot-decide) it stands there only while a colleague
in HR can answer it — the stage falls to the Chief Executive once she is the whole of HR — and
her own request is still on her queue, marked, because the desk is genuinely hers.
Filtering it out would make the one request nobody can move the one request nobody can see.

It appears, marked `actionable: false`, carrying `leaveRequestPolicy.notTheirOwn`'s **own**
sentence rather than one written for the screen — so the queue and the approve door cannot
disagree about who may decide what. The sentence names withdrawing, because whoever reads it
wanted their leave gone rather than approved.

#### The context, and one figure the sentence must not get wrong

| | Says | Read from |
|---|---|---|
| Balance | what this would spend against what they have | the request's own type and leave year |
| Team | who else reporting to the same manager is away over the same days | `LIVE_STATUSES`, narrowed by `periodsOverlap` |
| Stage | who has already signed and who comes after this desk | `progressOf`, in the approver's voice |

**`available` already has this request's days out of it.** Submitting reserved them into
`pending`; approving moves the same days into `taken` and changes `available` by nothing. So
the sentence says "approving this leaves 9" and not "9 now, 4 after", which would show the
deduction twice.

**Names in the team line are shown only where the approver may read that person's leave**,
asked per colleague through `Guard.permits` — which answers without logging, because a name
left off a line is not a refused attempt. The manager's desk and the HR desk see names; the
Chief Executive sees the count, which is the half the decision turns on.

**Soonest to start first**, because what makes a pending request urgent is the leave beginning
rather than the request being old. Backdated ones sort to the top by the same rule: they are the
only ones where an answer is already late.

#### Flagged, and both flags say who decides

FR 17 and FR 18, and **notice is measured at the moment the request was made rather than as at
today**. Recomputing it now would shorten it every morning the approver did not answer,
reporting their own delay as the requester's short notice. `startsInDays` is the figure that
does move, and it is urgency rather than a judgement about anybody.

Neither flag is a refusal, and the wording carries that. FR 17 warns and allows through "since
whether short notice is workable is a judgement for the approvers" — this queue is where that
judgement is made, so the sentence says so, or it reads as the system having found something
wrong. `SHORT_NOTICE` is worded close to `quoteFor`'s warning of the same name deliberately:
the requester was told "whoever approves it will see that it was short", and this is that
person seeing it.

**`DOCUMENTATION_REQUIRED` is the obvious third and is not here.** LMS 404 asks for two. The
condition is `documentationRequired` and `quoteFor` has already written the sentence, so the
story that wants it adds a member to `QUEUE_FLAGS` and a branch to `flagsFor`.

#### Still not here

**The tab is offered to everybody**, and somebody who staffs no desk gets the server's own
sentence saying what an approver is. There is deliberately no `canApprove` on `/api/me`:
`integration/balances-api.test.ts` pins that route's fields because "a screen that knew its own
roles would start deciding what to draw from them, and the day the two disagree the server is
right and the page has been lying".

The routes that decide arrived with [LMS 318](#hr-overturns-a-line-managers-decision).

---

### HR overturns a line manager's decision

**Both stages decide before leave is finally confirmed or rejected, and HR's is the last
word.** FR 44, §7.2, LMS 318. A line manager turning leave down is a decision at their stage,
not the end of the request.

**This is the story that made a rejection stop being an ending**, and that is the whole of it.
Until LMS 318 only approval needed every stage — [LMS 316](#every-stage-must-approve) — while a
refusal at *any* desk ended the request and released its days. So a manager's no was final and
HR, the desk FR 38a sends the request to next, never saw it. Now both verbs route: the walk
asks which stage has **decided** rather than which has approved, and the last stage to decide
is the one whose word the request lands on.

| The manager says | HR says | The request | The days |
|---|---|---|---|
| yes | yes | `APPROVED` | taken |
| yes | no | `REFUSED` | back |
| no | yes | `APPROVED` | taken |
| no | no | `REFUSED` | back |

**There is no branch for a refusal anywhere in the walk.** `decisionTo` takes the verb, reads
the destination off `TRANSITIONS` and asks `nextToDecide` where to send it, and that one
function answers all four rows above. The unit suite asserts that overturning a rejection
lands exactly where HR's plain yes would, because if the two ever differ one of them is wrong.

**An override is an ordinary decision that happens to disagree with an earlier stage.** Same
standing — `THE_DESK_IT_IS_WITH` — same door, same lock, same movement. What is different is
two things it asks for that a plain decision does not: a justification, and a line manager's
decision to actually be reversing.

#### Recorded as its own decision value, not as a flag

FR 44's fourth criterion. `OVERTURN_REJECTION` and `OVERTURN_APPROVAL` are values of
`leave_request_decision.action` beside `APPROVE` and `REFUSE`, and the alternative — `action =
'APPROVE'` with a boolean beside it — would sort together, filter together and read identically
in every query that forgot the second column. The fact FR 44 wants readable is exactly the one
that would go missing.

`overrides_decision_id` is the other half, and it is a real foreign key: "the reason stays
visible for ever" is a claim about two rows, the override's justification and what the manager
originally said and why. An equivalence holds the pair together —
`leave_request_decision_override_names_what_it_reverses` — and
`leave_request_decision_reverses_the_same_request` refuses one that names another request's
decision, itself, or a decision that said the same thing.

#### The justification cannot be skipped by pressing the ordinary button

The pairing that makes "mandatory" mean something. A desk about to decide the opposite way to
the line manager is overruling them whether the button said so or not, so:

* a plain `approve` or `refuse` that would contradict them is refused with
  `OverrulingNeedsAnOverride`, naming the verb to use instead;
* an override that contradicts nobody is refused with `NothingToOverturn`, because a record
  saying policy prevailed over a local decision when there was no local decision is a record
  of something that did not happen.

`overrideRequiredFor` is the one place that answers which of the two applies, and the approver
queue reads it too — `approvingIs` and `refusingIs` on each item — so a screen can ask for the
reason before the button rather than after the refusal.

**It reads the line manager's stage and no other.** HR overruling the Chief Executive is not
FR 44's subject, and unpaid leave — HR then the Chief Executive, §4.3.1 — has no manager stage
at all, so HR deciding one has nobody to overrule and is asked for nothing.

#### The dedicated view is the approver queue, narrowed

FR 44's first criterion. A rejection no longer ends a request, so every manager-rejected
request is already sitting at HR's desk with the balance and the team context beside it —
`rejectionsToReview` filters the queue to the items whose `approvingIs` is
`OVERTURN_REJECTION`, and `/api/me/approvals/rejections` is that. A second screen assembled
from its own query would be a second answer to what is waiting on somebody.

What makes it worth being its own view is that the decision on it is a different one: not
*should this leave happen* but *should this manager's answer stand*. Each item carries
`managersDecision` — what they said, in their words, with their name and the date on it.

#### Who is told, and what they are told

FR 44's fifth criterion, and a second event the story needed on the way.

**`STAGE_REFUSED`** goes to the person whose leave it is, and is the counterpart of
`STAGE_APPROVED`. A manager's no no longer ends their request, so the old message — "turned
down, your days are back" — would be wrong in both halves.

**`DECISION_OVERTURNED`** goes to the line manager, and is the one notice in this system
written to somebody other than the person taking the leave. `notification.employee_id` was
built to allow exactly that: "the recipient rather than the subject, and for FR 59 those are
the same person. The approver's queue is FR 60 and would put a different id here." It quotes
the justification whole, in HR's words, because that is what the manager is owed.

A manager who has since left, or a decision row that has somehow gone, does not unpick the
override — a notice nobody can be sent is not a reason to reverse a decision that was made.

#### What this cost elsewhere

**Refusing narrowed to the desk.** `TRANSITIONS` had the `REFUSE` row admitting the line
manager and `LEAVE_ADMINISTRATION` alike, which LMS 314 deliberately left wide. A refusal now
advances the chain, so one made away from the desk would mark a stage decided by somebody who
was never asked. HR unwinding a request that should not be on the books is still `CANCEL`.

**`RELEASING_ACTIONS` is two verbs.** Withdrawing and cancelling — neither is a decision at a
desk. `REFUSE` moved to the door that decides, which writes the `RELEASE` only when the
rejection turns out to be the last word and no movement at all when it does not.

**`leave_request_is_approved_by_every_stage` asks whether each stage has decided.** Weaker
than the rule LMS 316 wrote, and the correct weakening: a stage that has not been asked has
neither an approval nor a rejection on record, so the failure that story was written against —
somebody booking a flight on leave a stage the policy names had not seen — is caught exactly
as before.

**Nothing here reopens a settled request.** No ledger entry type was added, no reservation is
posted twice, and `leave_request_reserves_once` and `leave_request_releases_once` are
untouched. An override is a decision at a live desk.

---
