# Leave Management System

Internal leave management for **Remat Holdings**. Staff request leave, managers and
HR approve it, and balances are tracked per person, per leave type, per leave year.

Not a general HR system. It does not do payroll, timesheets, attendance or performance.

---

## Quick start

Needs Node.js 22+ and PostgreSQL **17** locally (17 specifically — every
environment runs it).

```bash
npm install
npm run web:install          # the client is its own npm project

cp .env.example .env         # fill in DATABASE_URL; SESSION_SECRET is not optional
npm run migrate up           # create the schema
npm run seed                 # load the fixture organisation

npm run api                  # the API, on :3000
npm run web                  # the client, on :5173, in a second terminal
```

Then open <http://localhost:5173>.

Use the **direct** Neon connection string for migrations, not the `-pooler` one —
a session-level advisory lock does not survive a transaction pooler.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Unit tests. No database. ~1,600 tests in about 4 seconds |
| `npm run test:int` | Integration tests, a disposable database per file, in parallel |
| `npm run test:all` | Both |
| `npm run migrate up` | Apply migrations |
| `npm run seed` | Load the fixture organisation |
| `npm run lint` / `npm run format` | ESLint / Prettier |

## Where things live

**One folder per feature, holding everything that feature owns.**

```
server/src/features/holiday/
  holiday.ts          the rules: types, validation, pure functions
  holiday.db.ts       the SQL, and constraint names mapped to errors
  holiday.service.ts  the door: asks the policy, validates, calls the repository
  policy.ts           who may do what
```

The suffix never repeats the folder. One policy is `policy.ts`, one router is
`routes.ts`, background work is `*.job.ts`.

What is shared stays out of `features/`: `auth/` the policy kernel, `db/` the
connection and transactions, `shared/` dates, `http/` the Express app, plus
`mail/` and `storage/`.

**A story should touch one folder.** If it touches four, either the feature
boundaries are wrong or the story is really several.

### The rules that matter

* **Routes do HTTP, services do rules, `*.db.ts` does SQL.** A route never
  contains a leave rule and never contains an authorisation check.
* **Every service method takes an `Actor` and asks its policy.** That is the only
  arrangement in which forgetting is impossible rather than merely unlikely.
* **The SQL is the source of truth.** No library generates or owns the schema, and
  no schema change happens outside a migration.
* **Only `db/` and `*.db.ts` import Kysely or `pg`.**
* **Comments carry the first sentence and the requirement reference**, not the
  argument. Reasoning belongs in the design document and the commit message.

## Stack

TypeScript on Node 22, Express 5, PostgreSQL 17 on Neon (London), node-pg-migrate
for plain SQL migrations, Kysely for typed queries, React 19 with Vite.

No ORM: the schema uses an append-only audit log and ledger, a GiST exclusion
constraint for overlapping leave, triggers, and CHECK constraints. Most ORMs
cannot express any of that.

## Documentation

| Document | What it is for |
|---|---|
| [Development](docs/development.md) | Setup in full, environment variables, migrations, roles, testing |
| [Leave rules](docs/domain-rules.md) | Every rule about types, days, balances and requests, and why |
| [Authorisation and audit](docs/authorisation-and-audit.md) | Who may do what, and how changes are recorded |

The specification documents — requirements, technical design, business overview,
policy decisions, backlog — are tracked separately. Requirement IDs (`FR 32a`) and
story IDs (`LMS 214`) appear throughout the code, branch names and commit messages.
