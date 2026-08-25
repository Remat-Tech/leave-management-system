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
| Database host | Neon | Managed Postgres. Branching gives a disposable database per feature, which makes integration testing cheap |
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
* A Neon account. Development runs against a Neon branch, not a database on your machine
* Optionally, PostgreSQL 17 locally, if you would rather not depend on the network

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

**The database comes from Neon, not from `createdb`.** Create a branch in the Neon console, or with `neonctl branches create`, and copy its connection string into `DATABASE_URL`. Take your own branch rather than sharing one: a migration you are still working on then never lands on somebody else's schema.

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
| `ALLOWED_EMAIL_DOMAINS` | Comma separated. Sign in is company email only, see NFR SEC 01 |
| `SMTP_*` | Mail settings. Points at Mailpit in development |
| `STORAGE_*` | Object storage for attachments. Local directory in development |

**Never commit a real `.env`.** A credential committed once stays in git history after it is deleted.

---

## Project structure

```
/server
  /migrations        numbered SQL migrations, never edited after merge
  /src
    /routes          HTTP only. No business rules live here
    /services        business rules. LeaveRequestService, BalanceService, ...
    /repositories    database access
    /jobs            scheduled work: reminders, rollover, reconciliation
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

---

## Things that will bite you if you do not know them

These are the load bearing decisions. The reasoning is in the Technical Design Document, section 1.

**The ledger is the truth, balances are a cache.** Every day added to or removed from a balance is an immutable row in `leave_ledger_entry`. The `leave_balance` table is a running total kept alongside it for fast reads. If they ever disagree, the ledger wins and the balance is rebuilt. **Never update a balance directly.**

**Policy is data, not code.** Every entitlement figure, threshold and notice period lives in a table with an effective date. Nobody should ever ship a release because HR changed an allowance.

**Pending days are reserved.** Submitting a request writes a `RESERVATION` entry immediately. This is what stops somebody with five days left having three separate five day requests in flight.

**Only the state machine moves a request.** All transitions go through one service method with one authorisation check and one audit write. No route mutates `leave_request.status`.

**Counting basis and approval chain vary by leave type.** Annual, sick and compassionate count working days; maternity and paternity count calendar days. Most types go manager then HR; unpaid leave goes HR then CEO. Both are configuration. If either appears as an `if` on a type code, that is a bug.

**Dates are dates.** Leave dates are calendar dates with no time and no timezone. Everything else is UTC. Mixing these up is the most common source of off by one day bugs in leave systems.

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
npm run test:int      # integration, against a disposable database branch
npm run test:all
```

The fixture set deliberately includes the awkward cases: a five level hierarchy, a manager who is also somebody's report, an employee with no manager, a part timer, a leaver, and a lone HR officer with no colleague to approve their leave. Most defects in this system live at those edges rather than in the happy path.

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
