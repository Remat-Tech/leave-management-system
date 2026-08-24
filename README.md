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
* PostgreSQL 17 running locally
* A Neon account, for the shared development branch

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

### Environment variables

Everything lives in `.env`, which is git ignored. `.env.example` lists every key with a safe placeholder. Add a key there whenever you add one to `.env`, otherwise the next person's setup fails silently.

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
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

Every schema change is a migration. No exceptions, no running SQL by hand in a client.

```bash
npm run migrate create add-something    # new migration file
npm run migrate up                      # apply
npm run migrate down                    # roll back one
```

Once a migration is merged it is never edited. Fix a mistake with a new migration.

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
