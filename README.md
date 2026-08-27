# Leave Management System

Internal leave management for **Remat Holdings**. Staff request leave, managers and HR approve it, and balances are tracked per person, per leave type, per leave year.

Not a general HR system. It does not do payroll, timesheets, attendance or performance.

---

## Documentation

| Document | What it is for |
|---|---|
| Software Requirements Specification | What the system must do. Requirement IDs like `FR 32a` are referenced throughout the code and the issue tracker |
| Technical Design Document | How it is built. Schema, state machine, edge cases, API design |
| Business Overview | Plain language explanation for HR and management |
| Policy Answers and Residual Items | Every leave policy decision on record |
| Product Backlog | 111 stories in six build phases |

Work is tracked in GitHub Issues, grouped by Phase and Epic on the project board. Story IDs (`LMS 214`) appear in branch names and commit messages.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | The system is full of enums and signed day amounts where a typo becomes a wrong balance. Types catch that class of bug at compile time |
| Runtime | Node.js 22 LTS | Long term support, matches the deployment target |
| API | Express 5 | Mature, unopinionated, well understood. This is a conventional REST API and needs nothing clever |
| Database | PostgreSQL 17 | Transactional integrity on the balance ledger, recursive queries for the org tree, range exclusion constraints for overlapping leave, JSONB for audit snapshots. See the Technical Design Document, section 4 |
| Database host | Neon, London (`eu-west-2`) | Managed Postgres, for production as well as development. Branching gives a disposable database per feature, which makes integration testing cheap. London is the nearest region to Accra; that puts staff data outside Ghana, which is dealt with in the Technical Design Document, section 4 |
| Migrations | node-pg-migrate | Plain SQL migrations. The schema is the source of truth |
| Query layer | Kysely | Type safe queries without an ORM that wants to own the schema |
| Front end | React 19 with Vite | Standard, fast to build with, easy to hire for |
| UI components | *to be confirmed with the designer* | Must accept company fonts and colours as tokens. See LMS 409 |

### Why no ORM

The schema uses `CREATE RULE` to make the ledger and audit tables append only, a GiST exclusion constraint to prevent overlapping leave at the database level, partial indexes, and a number of CHECK constraints that enforce business rules where they cannot be bypassed.

Most ORMs cannot express any of that, so adopting one means either fighting it or dropping the protections. Migrations are therefore hand written SQL, and Kysely reads the resulting types rather than generating the schema.

**The rule: the SQL is the source of truth. No library generates or owns the schema.**

---

## Local setup

### Prerequisites

* Node.js 22 or later
* A Neon account, for the shared development branch and for anything that has to
  look exactly like production
* PostgreSQL **17** locally, for fast test runs

### Why the Postgres version is pinned

**Every environment runs PostgreSQL 17.** Neon for development and production,
a `postgres:17` container in continuous integration, and 17 on your machine.
Install 17 specifically, not whatever is current: on Windows it sits happily
alongside a newer version on a different port.

The point is that the versions match, not that they are recent. Nothing here
needs anything newer. The load bearing features are recursive CTEs for the org
tree, `daterange` with a GiST exclusion constraint for overlapping leave, `jsonb`
for audit snapshots and `CREATE RULE` for the append only ledger, and all of them
have worked for several major versions. Building against a version the host does
not offer is an avoidable way to lose a day, and a managed host is always a
release or so behind.

Keep a local database even though development can run entirely on Neon. Every
integration run creates and drops a real database, and doing that across a
network costs seconds per test and real money per developer. Local is for the
fast loop; Neon is for sharing, for staging, and for looking like production.

### Getting started

```bash
git clone git@github.com:Remat-Tech/leave-management-system.git
cd leave-management-system

npm install

cp .env.example .env
# fill in DATABASE_URL and the other values, see below

npm run migrate up      # create the schema
npm run seed            # load fixture data
npm run dev             # api on :3000, web on :5173
```

**An empty database is all you need to start.** The schema is the migrations and
the fixtures are the seed, so nothing is ever imported or copied between
environments.

Locally that is `createdb lms_dev` against your Postgres 17. On Neon it is a
branch, made in the console or with `neonctl branches create`; take your own
rather than sharing one, so a migration you are still working on never lands on
somebody else's schema. Either way, put the connection string in `DATABASE_URL`
and run `npm run migrate up`.

**Use the direct connection string, not the pooled one.** The pooled host has `-pooler` in it. Migrations take a session level advisory lock so that two runs cannot collide, and a session lock does not survive a transaction pooler, so migrations run through `-pooler` fail intermittently and for reasons that are hard to see. Pooled is for the application. Direct is for migrations.

Neon requires TLS. With `sslmode=require` the driver prints a warning saying it is treating that as `verify-full`; that is the stricter behaviour, the connection is verified against the system certificate store, and nothing is wrong.

### Environment variables

Everything lives in `.env`, which is git ignored. `.env.example` lists every key with a safe placeholder. Add a key there whenever you add one to `.env`, otherwise the next person's setup fails silently.

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Connection for the running application, as the restricted `lms_app` role |
| `DATABASE_MIGRATION_URL` | Connection for migrations only, as the owner role. Never used by the application |
| `PORT` | API port, defaults to 3000 |
| `SESSION_SECRET` | Signing key for sessions |
| `ALLOWED_EMAIL_DOMAINS` | Comma separated. Sign in is company email only, see NFR SEC 01. Settled at `rematholdings.com` |
| `SMTP_*` | Mail settings. Points at Mailpit in development |
| `STORAGE_*` | Object storage for attachments. Local directory in development |

**Never commit a real `.env`.** A credential committed once stays in git history after it is deleted.

### Who may sign in

**`rematholdings.com`, and nothing else.** Sign in is by company address only, so
a personal address is refused when an employee record is created and again at
login. Those are two doors into the same building and both are locked. NFR SEC
01.

The list is configuration rather than code, so adding a subsidiary's domain is
an environment change, not a release. Two things about it are not negotiable in
passing:

**Matching is exact.** `hr.rematholdings.com` is a different domain and is
refused unless somebody adds it deliberately. Otherwise anyone able to create a
subdomain could mint themselves a company identity.

**An empty list is not "no restriction".** The application refuses to start.
An allow list that has been emptied by accident must lock everybody out, never
let everybody in.

The check lives in `server/src/auth/company-email.ts`. Use it at provisioning
and at login both; NFR SEC 01 asks for both, and only one of them is the door an
attacker knocks on.

---

## Local development services

### Mail

Nothing this system sends in development reaches a real mailbox. Outbound mail
goes to [Mailpit](https://mailpit.axllent.org), which accepts every message and
delivers none of them.

```bash
npm run mail            # SMTP on 1025, read what was sent at http://localhost:8025
```

The first run downloads a single Mailpit binary into `.tools/`, which is git
ignored. There is nothing to install and nothing to uninstall; delete the
directory and it is gone. The version is pinned in `scripts/mailpit.mjs` so
everybody runs the same build.

Leave it running while you work on anything that notifies. `SMTP_HOST` and
`SMTP_PORT` in `.env.example` already point at it.

**`MAIL_OVERRIDE_RECIPIENT` is the safety net, and it matters most where Mailpit
is not.** When it is set, every message goes to that one address instead of the
real recipient, and the intended recipient is preserved in an
`X-Intended-Recipient` header rather than thrown away. Set it in any environment
pointed at a copy of real staff data, so that testing notifications cannot mail
actual colleagues. Leave it blank in production.

### Attachment storage

Attachments go through the `Storage` interface in `server/src/storage`. In
development `STORAGE_DRIVER=local` writes them to `.storage`, which is git
ignored. Production will set a different driver and change nothing else.

```ts
const storage = createStorage(); // the only place that knows which driver runs

const { key, size, checksumSha256 } = await storage.put(bytes);
const bytes = await storage.get(key);
await storage.delete(key); // succeeds whether or not it was there
```

**Nothing above the interface may know where a file lives.** `put` issues the
key; callers never choose one, never build a path, and never learn whether the
bytes went to a disk or a bucket. Store the key on the attachment row and pass
it back. If a path, a bucket name or a directory ever appears outside
`server/src/storage`, that is the bug.

This is a security property, not housekeeping. Keys are 32 random bytes, so an
attachment cannot be found by guessing, and it is never addressable except to
code that has already checked the caller's authorisation. Keys arrive back from
the database, so the local driver validates every one before touching the
filesystem: a key shaped like `../../etc/passwd` is refused rather than
resolved. NFR SEC 04.

**The storage directory must never sit under anything the web server serves.**
These files are medical certificates. A directory reachable by URL makes every
one of them public.

---

## Project structure

```
/server
  /migrations        numbered SQL migrations, never edited after merge
  /seeds             the fixture organisation
  /src
    /routes          HTTP only. No business rules live here
    /services        business rules. LeaveRequestService, BalanceService, ...
    /repositories    database access
    /domain          the types and rules a record obeys, with no dependencies
    /db              the connection and the table types Kysely reads
    /jobs            scheduled work: reminders, rollover, reconciliation
    /auth            company email, sessions, MFA
    /mail            outbound notification transport
    /storage         attachment bytes, behind one interface
  /tests
/client
  /src
    /features        one folder per area: requests, balances, approvals, admin
    /components      shared UI
/docs                the specification documents listed above
```

### Layering rule

Routes do HTTP. Services do business rules. Repositories do database access.

A route never contains a leave rule. A service never touches an HTTP request object. This matters most for `LeaveRequestService`, which is otherwise where every special case will accumulate.

`/domain` sits under all three. It holds what a record is and what makes one
valid, as plain types and pure functions that import nothing and touch nothing,
so the rules can be read in one place and tested without a database. A service
decides *when* to apply a rule; the domain says what the rule *is*.

**Only `/db` and `/repositories` import Kysely or `pg`.** Above that line nothing
knows what the query layer is, which is the same arrangement as `/storage` and
for the same reason.

---

## Things that will bite you if you do not know them

These are the load bearing decisions. The reasoning is in the Technical Design Document, section 1.

**The ledger is the truth, balances are a cache.** Every day added to or removed from a balance is an immutable row in `leave_ledger_entry`. The `leave_balance` table is a running total kept alongside it for fast reads. If they ever disagree, the ledger wins and the balance is rebuilt. **Never update a balance directly.**

**Policy is data, not code.** Every entitlement figure, threshold and notice period lives in a table with an effective date. Nobody should ever ship a release because HR changed an allowance.

**Pending days are reserved.** Submitting a request writes a `RESERVATION` entry immediately. This is what stops somebody with five days left having three separate five day requests in flight.

**Only the state machine moves a request.** All transitions go through one service method with one authorisation check and one audit write. No route mutates `leave_request.status`.

**Counting basis and approval chain vary by leave type.** Annual, sick and compassionate count working days; maternity and paternity count calendar days. Most types go manager then HR; unpaid leave goes HR then CEO. Both are configuration. If either appears as an `if` on a type code, that is a bug.

**Dates are dates.** Leave dates are calendar dates with no time and no timezone. Everything else is UTC. Mixing these up is the most common source of off by one day bugs in leave systems.

The driver is set up to help rather than hinder that. `server/src/db` registers a
type parser so a Postgres `date` arrives as the string `'2026-07-31'` instead of
being turned into a `Date` at midnight UTC and then read back in whatever
timezone the process happens to run in. Compare them as strings; for `YYYY-MM-DD`
that is the same comparison. `timestamptz` is left alone, because those really
are instants.

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
the job rather than the table and reads `TG_TABLE_NAME` for its message. The
Phase 2 ledger and audit tables are append only for the same reason and should
attach to it rather than each declaring their own `RAISE`. It raises
`restrict_violation` (SQLSTATE `23001`), so a caller can tell a refused delete
from a genuine fault without reading the message text.

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

**`department.parent_id` exists and nothing writes it.** A hierarchy does not
exist rather than half existing. A story that exposes sub-departments needs what
FR 03 and FR 04 gave reporting lines — a cycle check and a root count — because a
self-referencing parent has exactly the same two failure modes; the
department-rules migration says so, and `refuse_manager_cycle()` reads as a
worked example even though it names `employee` and cannot be reused as it stands.

---

## Database migrations

**No schema change happens outside a migration. Ever.** No `CREATE TABLE` in a database client, no `ALTER` run against a server by hand, no quick fix in psql that you intend to write up properly later.

This is not bureaucracy. A change that is not a migration does not exist on anybody else's machine. Local and production drift apart within a fortnight, and by the time somebody notices, nobody knows what the correct state was.

Migrations are plain SQL, applied by [node-pg-migrate](https://github.com/salsita/node-pg-migrate), and live in `server/migrations`. Every file has an `-- Up Migration` section and a `-- Down Migration` section that reverses it.

```bash
npm run migrate create add-something    # new migration file
npm run migrate up                      # apply everything pending
npm run migrate down                    # roll back one
```

Which migrations have been applied is recorded in the `pgmigrations` table. That table is how a database knows what state it is in, so do not edit it by hand either.

**Write the down section, and prove it runs.** Do `up`, then `down`, then `up` again before you open the pull request. A down section that has never been executed is not a rollback, it is a guess.

Once a migration is merged it is never edited. Fix a mistake with a new migration.

---

## Database roles

There are two connections and they are not interchangeable.

| Role | Used by | Holds |
|---|---|---|
| owner (`neondb_owner` on Neon) | migrations, nothing else | ownership of every object |
| `lms_app` | the running application | `CONNECT`, `USAGE` on the schema, and `SELECT`/`INSERT` on tables |

**The application never runs as the owner.** An application connected as the owner can `UPDATE` or `DELETE` rows in `audit_log` and `leave_ledger_entry`, which is precisely the thing an audit trail exists to make impossible. NFR AUD 02.

**`lms_app` gets `SELECT` and `INSERT` on new tables and nothing else.** This is set once, as a default privilege, so it applies to every table a future migration creates. A table that genuinely needs `UPDATE` or `DELETE` must be granted it explicitly in the migration that creates it:

```sql
GRANT UPDATE, DELETE ON leave_request TO lms_app;
```

That is the right way round. The ledger and the audit log are append only because nobody ever granted them more, rather than because somebody remembered to take it away. Forget the explicit grant on an ordinary table and you get a loud permission error the first time you run it. Arrange it the other way, granting everything and revoking on those two, and forgetting is silent and leaves the ledger writable.

**The role's password is not in a migration, and cannot be.** The migration creates `lms_app` without one, so it exists but cannot authenticate. Set the password out of band and record it only in `.env`:

```sql
ALTER ROLE lms_app WITH PASSWORD '...';
```

Rolling that migration back drops the role and its password together, so after a `down` you set the password again before the application can connect.

---

## Formatting and linting

Prettier decides layout, ESLint finds problems, and a pre commit hook runs both over staged files. The point is that review attention goes on whether the logic is right rather than on where the brackets are.

```bash
npm run lint            # report problems
npm run lint:fix        # fix the ones that can be fixed
npm run format          # rewrite files
npm run format:check    # report without rewriting
```

The hook installs itself during `npm install`, which runs husky through the `prepare` script. It runs `lint-staged`, so only what you actually staged is touched. Formatting is corrected and restaged silently; a problem ESLint cannot fix stops the commit and tells you why.

**Migrations and prose are excluded.** Nothing rewrites `server/migrations`, because a merged migration is never edited. Markdown is excluded too: reflowing a hand laid out table produces a large diff that says nothing about the content.

**Line endings are LF everywhere**, fixed by `.gitattributes` rather than left to each person's `core.autocrlf`. Without that, a Windows checkout arrives as CRLF, every file fails `prettier --check`, and the hook spends its time fighting the person instead of helping them.

---

## Testing

```bash
npm test              # unit
npm run test:watch    # unit, re-running as you edit
npm run test:int      # integration, against a disposable database
npm run test:all      # both
```

Unit tests live in `server/tests/unit` and touch no database, no network and no
fixtures. Anything that needs one of those is an integration test and belongs in
`server/tests/integration`.

**Integration tests build their own database and throw it away.** Each run creates
`lms_test_<random>`, applies the migrations to it, runs the suite, and drops it
again, including when the suite fails. Nothing is left behind and no test run can
see another one's rows.

That means integration tests need `DATABASE_MIGRATION_URL`, the owner connection,
since creating a database is not something the application role may do. They apply
the real migrations rather than loading a dumped schema, so every integration run
is also a check that the migrations still apply cleanly to an empty database.

The fixture set deliberately includes the awkward cases: a five level hierarchy, a manager who is also somebody's report, an employee with no manager, a part timer, a leaver, and a lone HR officer with no colleague to approve their leave. Most defects in this system live at those edges rather than in the happy path.

```bash
npm run seed                        # the organisation, thirteen people
npm run seed -- --scenario lone-hr  # the same, with one person as all of HR
```

Seeding clears what it owns first, so running it twice gives you the same
organisation rather than a second copy. It connects as the owner, not as
`lms_app`, because it truncates and the application role deliberately holds
neither `TRUNCATE` nor `DELETE` on `employee`.

| Who | Why they are in there |
|---|---|
| Kwame Asante, CEO | The only employee with no manager. Every upward walk has to stop somewhere |
| Akosua Darko, Kofi Boateng | Managers who are also somebody's report. Breaks anything assuming approvers and requesters are different people |
| Abena Sarpong | Part time, Wednesdays off. A pattern of merely "weekends off" would let a hard coded weekend pass every test |
| Kojo Antwi | Left in July, still on the books. FR 06 keeps the record; FR 37a needs exactly this shape to calculate a leaver figure |
| Ama Mensah, Efua Owusu | HR, so an HR person's own request has a colleague to decide it |

**The `lone-hr` scenario is the one worth remembering.** Ama is then the whole
HR function, so her own leave has nobody in HR left to approve it and must fall
to the CEO. That is the reciprocal routing of FR 48b. Get it wrong and an HR
officer approves their own leave, which is the defect the rule exists to stop.

`server/tests/integration/seed.test.ts` asserts each of these edges, so removing
one has to be a decision rather than an accident.

Concurrency tests matter more than they look. Two approvers deciding one request, and two requests submitted against a thin balance, are the defects that never appear in manual testing and only surface as a balance that is quietly wrong.

---

## Build order

Phases are in the Product Backlog and are not a suggestion.

1. **Foundation.** Employees, hierarchy, logins
2. **The numbers.** Leave types, entitlements, the ledger, balances
3. **The workflow.** Requests, approvals, overrides, notifications
4. **Self service.** Balance screens, history, team calendar, attachments
5. **Administration.** The settings screens that let HR run this without a developer
6. **Hardening.** Security, concurrency, backups, acceptance

Phase 2 comes before Phase 3 deliberately. An approval workflow sitting on wrong balances is worse than no system at all, because people will believe the number on the screen.

---
