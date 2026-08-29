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

The schema makes the audit log and the ledger append only in the database itself, uses a GiST exclusion constraint to prevent overlapping leave, writes every change to an audited table from a trigger, and carries a number of CHECK constraints that enforce business rules where they cannot be bypassed. Partial indexes hold the shapes the organisation depends on — one root employee, one default working pattern.

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
for audit snapshots and plpgsql triggers for the append only audit log and
ledger, and all of them have worked for several major versions. Building against a version the host does
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
| `TEST_DATABASE_URL` | Where integration tests build their disposable database. Point it at local Postgres 17; falls back to `DATABASE_MIGRATION_URL` |
| `PORT` | API port, defaults to 3000 |
| `SESSION_SECRET` | Signing key for sessions. Still nothing reads it. LMS 112 put authorisation in the service layer, which is the half that has to be right whatever the interface does; a session is a route layer thing and there are no routes |
| `ALLOWED_EMAIL_DOMAINS` | Comma separated. Sign in is company email only, see NFR SEC 01. Settled at `rematholdings.com` |
| `MFA_CODE_*` | Length and lifetime of the sign in code. Both have safe defaults; a value that is present and nonsense is refused |
| `DISPLAY_TIMEZONE` | The zone instants are *shown* in. NFR DAT 03. Display only: everything is stored in UTC and every leave date has no zone at all, so changing it moves nothing in the database. Defaults to `Africa/Accra`; a name this Node does not know is refused rather than quietly falling back |
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

### Signing in

`SignInService` is the login door. NFR SEC 01, LMS 109 and LMS 110.

```ts
const logins = new SignInService(
  new SignInAccountRepository(db),
  new EmployeeRepository(db),
  new RoleRepository(db),
  createMailer(),
  guard,
);

await logins.provision(hr, employeeId, { password }); // HR gives somebody a login
await logins.setPassword(hr, employeeId, password);   // and sets or resets it

// The door takes no actor. Nobody is anybody until they are through it.
const outcome = await logins.signIn(email, password);

if (outcome.status === 'SIGNED_IN') {
  const { employee, account, actor } = outcome;
} else {
  // A code is in their mailbox. Show the second screen.
  const { employee, account, actor } = await logins.submitCode(email, code);
}
```

**Signing in is the only place a person's `actor` is minted.** It is what every
other service method takes as its first argument, and it is minted here because
this is the only code that has just proved who somebody is. See
[Authorisation](#authorisation).

**A login is the employee's work address.** Not a copy of it — the address is
never a parameter, `provision` reads it off the employee record, and the
`sign-in-account-rules` migration carries a corrected work address across to the
login and refuses any other value in the column. Correct somebody's address
through `EmployeeService` and their login moves with it. That is the whole of
"access is tied to the company account".

**Access ends because the employee record says so, not because anything was
revoked.** `signIn` reads the employee at the moment somebody knocks, so
`TERMINATED` closes the door by itself and terminating writes nothing to
`app_user`. A copy of the status on the account would be a second source of truth
wrong in the worst direction: the termination recorded by a path that forgot to
revoke the login leaves the leaver's access open, and nobody finds out until it
is used. `is_active` on the account is a separate, administrative lock — a shared
password, a lost laptop — and is `close()` and `reopen()`.

**Refusals are vague by default and specific once a password is proved.** No
login, no password set and a wrong password all give one identical message,
because three different messages turn the sign in box into a way of finding out
who works here. A leaver, a suspension and a closed account are only reachable
*after* a correct password, so those say plainly what happened: the person has
proved who they are and there is nobody left to keep it from. The real reason is
on `SignInRefused.reason`, for the log. **Nothing that reaches a screen may read
it and turn it back into a message.**

**Passwords are scrypt, from `node:crypto`, with the cost recorded in the hash.**
`server/src/auth/password.ts`, no dependency, per password salt, timing safe
comparison. Storing the parameters is what makes raising them possible later:
existing hashes keep verifying and each is quietly rewritten at the owner's next
sign in, which is the only moment the plain password is legitimately in hand.
Minimum length is twelve and there are no composition rules — length is the
property that costs an attacker something, and `Password1!` is what asking for a
capital and a symbol produces.

### The one time code

Signing in is two steps for anybody who needs a code. `signIn` either opens the
door or sends a code and says so; `submitCode` answers it. Which of the two is
decided here, not by the caller, and `SignInOutcome` is a union so that a caller
cannot forget the second case exists. NFR SEC 01, LMS 110.

**Mandatory for `HR_OFFICER`, `HR_ADMIN` and `SYS_ADMIN`.** Those three can read
everybody's leave records and the medical certificates attached to them; an
ordinary employee's password opens their own leave, an HR Administrator's opens
the company's. Everybody else may turn it on for themselves with `requireCode`.
`stopRequiringCode` refuses for a mandatory role and names the role rather than
saying no.

**Roles are read at sign in, never copied onto the account.** Grant `HR_OFFICER`
this morning and they are asked for a code this afternoon, with nothing else to
update. Same reasoning as employment status, and as the organisation migration's
note about not storing `MANAGER` as a role.

**The mailbox is the factor, and that is the limit of what it buys.** Somebody
who has taken over the company mailbox has both factors, and email is weaker than
an authenticator app or a hardware key. It is the one every member of staff
already has, on the account this system already ties access to, with nothing to
enrol and nothing to lose.

**Hashed at rest with scrypt, exactly as passwords are**, so a copy of `app_user`
taken while people are signing in is not a list of the codes currently in flight.
Ten minutes, six digits, both configurable and both bounded — a length read from
a typo as `1` would be a ten possibility second factor that looks like a working
one, so it is refused rather than shipped.

**Single use, and finite.** The challenge is consumed by the same statement that
stamps the sign in, a reissue replaces the previous code, and five wrong answers
burn it. That last part is not a detail: six digits is a million guesses, and a
limit that leaves the code alive is not a limit. The count is `attempts + 1` in
the database, not read-modify-write, so four guesses arriving at once cost four.

**The message carries no link.** A sign in email with a link in it teaches staff
that clicking links in sign in emails is normal, which is the habit every
phishing attack against them will rely on. It does say what to do about a code
nobody asked for, which is the most valuable sentence in it.

What is not built, and is not hidden anywhere else either: no session or cookie
(LMS 112), **no rate limit or lockout**,
no self service password change or reset, and no recovery codes — somebody locked
out of their company mailbox is locked out of this until IT restores the mailbox.
The rate limiter matters twice over now: a code challenge is answered by address,
so somebody who knows a colleague's address and polls `submitCode` can spend that
colleague's five attempts and make them start again. It grants no access, but it
is a denial of service, and it belongs in front of the route with the rest.

`npm run seed` gives everybody a login and nobody a password, which is the honest
state of a freshly provisioned account. Set one with `setPassword` when you need
to sign in as somebody. Ama Mensah and Efua Owusu hold HR roles in the fixture
set, so they are the two who will ask you for a code — read it in Mailpit.

### Roles

`RoleService` assigns them. §5.3, LMS 111.

```ts
const roles = new RoleService(
  new RoleRepository(db),
  new SignInAccountRepository(db),
  new EmployeeRepository(db),
  guard,
);

await roles.grant(admin, employeeId, 'HR_OFFICER'); // -> everything they now hold
await roles.revoke(admin, employeeId, 'HR_OFFICER');
await roles.forEmployee(admin, employeeId);         // with the date each was granted
await roles.holdersOf(admin, 'SYS_ADMIN');          // who has the master key
await roles.authorityFor(admin, employeeId);        // { roles, isManager }
```

**Four roles, and the set is closed.** `EMPLOYEE`, `HR_OFFICER`, `HR_ADMIN`,
`SYS_ADMIN`, held by a CHECK constraint rather than by everybody remembering, and
`role` is read only to the application. A fifth role is a migration, not a row —
which is right, because a role the authorisation layer has never heard of grants
nothing, and a row that silently grants nothing is a worse failure than a
constraint refusing to store it.

**`MANAGER` is not one of them and cannot become one.** Being a manager is a
relationship: you are one if some employee has your id as their `manager_id`.
It is derived every time it is asked, so moving a reporting line moves the answer
with it and there is nothing to keep in step. `authorityFor` returns it as a
separate field rather than as an entry in `roles`, and that separation is the
point — a single list with `'MANAGER'` in it is the drift the schema has refused
since the table was created. Authorisation asks *"is this person one of my
reports?"*, never *"do they have the manager role?"*.

**`EMPLOYEE` arrives with the login and cannot be taken away.** A trigger grants
it as the `app_user` row is created, so it is true in a production database —
which is migrated and never seeded — and not only where fixtures have run. It is
what *"can see their own leave and ask for more of it"* is called; an account
without it is somebody who can sign in and then do nothing. To stop somebody
signing in, close their account instead.

**The last `SYS_ADMIN` cannot be removed.** It is the one role change nobody can
undo, because the person who would undo it is the person who just stopped
existing. Deferred, so handing the role on in one transaction works in either
order; checked in the service for the message and by the database for the
guarantee, which is what settles two people clicking at once.

**Granting twice is fine; revoking what they never had is not.** Granting the
same role twice leaves the same person with the same power, so it succeeds
quietly. Revoking a role somebody never held means the person doing it has
somebody else in mind, and they should hear about it rather than believe they
have removed access that is still there.

Who may *call* it is [Authorisation](#authorisation), below: an HR Administrator
or a System Administrator, and never the person the roles are about. There is
still no audit trail of who granted what — the date is on the row, there is now
an actor to name, and naming them is LMS 113's table rather than a column added
here on the way past.

---

## Authorisation

**Records are protected on the server, not hidden in the interface.** NFR SEC 02
and NFR SEC 03, §10, LMS 112.

`employee.id` is a bigint from a sequence. The ids either side of yours are your
colleagues', so "a colleague reaches them by guessing a web address" is not a
thought experiment about this schema — it is a `for` loop. Nothing an interface
does can help with that, because the interface is not what answers.

Three pieces, and the shape is the whole point.

```ts
const guard = new Guard();                            // holds the denial log
const { actor } = await logins.signIn(email, password);

await employees.byId(actor, someId);   // the service asks the policy
await employees.list(actor);           // and refuses before it reads anything
```

**An `Actor` is who is asking.** An employee id, the roles they were granted, and
whether anybody reports to them. It is `Authority` from LMS 111 with a name
attached rather than a second shape beside it, and it is minted in exactly one
place — `SignInService`, which has just proved who somebody is. `server/src/auth/actor.ts`.

**A policy is one object per resource type**, in `server/src/auth/*-policy.ts`,
made of pure functions from an actor and a record to a `Decision`. So
`employee-policy.ts` is the complete answer to "who may see an employee record",
readable in a minute by somebody who has never seen the system. Policies never
throw and never touch a database, which is why the whole matrix of who may do
what is enumerated in a unit test rather than sampled in an integration one.

**The service is what invokes them**, before it reads or writes anything. Not a
route, not middleware, not a decorator. A route that forgets to check has
therefore not opened a hole, and neither has a job, a test, an import, or next
year's GraphQL layer — there is no second entrance to guard, which is the only
version of "no role checks scattered in controllers" that is a property rather
than a convention.

Every service method takes the actor as its first argument. That is deliberately
impossible to forget: a call that does not answer "who is this" does not compile.

### Who may do what

| | Reads | Writes |
|---|---|---|
| Employee records | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` | `HR_OFFICER`, `HR_ADMIN` |
| Searching people by number or address | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` | — |
| The organisation chart | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` | — |
| Departments and working patterns | anybody signed in | `HR_ADMIN` |
| Leave types and the rules they carry | anybody signed in | `HR_ADMIN` |
| A company or department entitlement figure | anybody signed in | `HR_ADMIN` |
| An entitlement figure naming a person | that person, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` | `HR_ADMIN` |
| What one person is entitled to | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` | — |
| The whole list of entitlement figures | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` | — |
| A headcount on either | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` | — |
| Roles | your own, and `HR_ADMIN` / `SYS_ADMIN` for anybody's | `HR_ADMIN`, `SYS_ADMIN` |
| Logins: create, set a password | your own account is readable by you | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` |
| Logins: close, reopen | | `HR_ADMIN`, `SYS_ADMIN` |

Four of those lines are decisions rather than defaults, and each is argued in the
policy file that holds it.

**A line manager sees their reports because of the record, never because of a
role.** `employee.managerId` is read off the record in hand, so moving a
reporting line moves the answer with it and there is nothing to keep in step.
Direct reports only — a skip level read is a different power nobody has asked
for, and a subtree is a recursive query on every read of every record. The
organisation chart is the same rule seen from the other end: it is the staff list
with the lines drawn in, so it goes to the people who may read the staff list and
not to a manager for their own branch, which would be that skip level read
arriving through a different door.

**Nobody edits their own record, however senior.** Reading yours is the point of
the system; writing yours is what HR is for. A start date, a department and a
working pattern are figures somebody's entitlement is calculated from, and a
system where the person the figure is about can change it is not one anybody can
settle a dispute with.

**Nobody changes their own roles, and `SYS_ADMIN` is handed on by somebody
holding it.** The first is the story's "so that" taken literally — a power
somebody granted themselves is a power nobody granted — and it costs an attacker
a second account. The second stops "administrators appoint administrators" being
"the lock can be picked from the next room". Neither breaks the bootstrap: the
seed and the migrations run as `theSystem()`, which is nobody and so is never
itself.

**Setting a joiner up is HR's, and closing an account is not.** An HR Officer
creates the record on somebody's first morning and gives them the login in the
same five minutes. Put that behind an administrator and the two minute job
becomes a ticket, and a company that raises a ticket to let a new starter in is a
company where four people in HR know the administrator password by March. The
rule that gets worked around protects nothing. Closing an account is a decision
about somebody — a lost laptop, an investigation — and wants the second pair of
eyes that onboarding does not.

### The two refusals, and the one that says nothing

**A refusal aimed at somebody who cannot see the record at all says nothing** —
one sentence, the same for every resource and every action, and in particular the
same sentence a record that does not exist gets. Being told "you may not read
employee 4471" has learned that employee 4471 is somebody, and a pair of messages
that differ is a working existence oracle you can run down the sequence.

That property needs both halves, so being told a record is *missing* is itself a
permission: `EmployeeService.findOrRefuse()` consults the search policy before it
reports `EmployeeNotFound`. HR gets the useful answer, which is what makes a
mistyped id a five second problem. Everybody else gets one sentence whatever they
type.

**A refusal aimed at somebody who can see the record but may not do that to it
says what the rule is.** A line manager who has just read their report's record
and then tries to change it is told "employee records are changed by HR", which
discloses nothing they did not have. It is the same distinction the sign in door
makes — vague until something is proved, specific once it is.

### Denied attempts are logged

NFR SEC 03. An authorisation layer that refuses silently protects the records and
tells nobody that somebody went looking: the colleague working through ids one at
a time is refused four hundred times and the first anybody hears of it is never.

Every refusal goes through `Guard.enforce()`, which writes it down before it
throws — who, what they held, which resource, which action, which record, and the
policy's reason. **No field of the record is ever in there.** A refused read is a
read that did not happen, and a log that quotes the record has performed the
disclosure the refusal existed to prevent, into a file that is usually less
protected than the database.

The reason is written and never said. `NotAuthorised.attempt` carries it for a
caller that has to record it again; **nothing that reaches a screen may read it
and turn it back into a message**, exactly as with `SignInRefused.reason`.

Allowed attempts are not logged here. "Who read whose record" is a much larger
question; what *changed* a record is the [audit log](#the-audit-log), which is a
different table with a different guarantee.

The default driver writes one JSON line per denial to stderr. That is a stop-gap
and the shape is the part that is right: a log line is rotated away and is not an
audit trail. Moving it to a table is a driver behind the same interface, and
nothing above it changes.

### What is not built

**No session, no cookie, no token.** `signIn` hands back an actor, which is the
*answer* to "who is this" and never the evidence for it. A route layer has to
derive its own from whatever identifies a request; an actor must never arrive
over the wire. `SESSION_SECRET` is still waiting.

**Roles are a snapshot taken at sign in.** Revoke `HR_ADMIN` while somebody is
working and they keep it until they sign in again. Reading `user_role` on every
policy check would be a round trip per decision and still a snapshot, just a
fresher one. Where it genuinely matters the answer is `close()` the account, which
the next sign in cannot survive.

**No rate limit.** Four hundred refusals in a minute are four hundred lines and no
delay. The counter belongs in front of the route with the one unlimited password
guesses need. It needs doing, and it is not done.

**`theSystem()` is a back door with a name on it.** A job, a migration, a seed and
a test fixture all have to write records and none has a person behind them, so
they run as an actor that holds every role and is nobody. `grep -rn theSystem
server/src` is the list of everything that runs unattended, and it should stay
short.

---

## The audit log

**Every change to a record is written down, permanently, by the database.** NFR
AUD 01 and NFR AUD 02, LMS 113.

The story is a dispute two years from now: a balance is wrong, or is said to be,
and nobody remembers how it got that way. What settles it is a row written at the
time by the same statement that made the change, which nobody has been able to
touch since.

```ts
const audit = new AuditService(
  new AuditRepository(db),
  new EmployeeRepository(db),
  new SignInAccountRepository(db),
  guard,
);

await audit.forEmployee(actor, employeeId);   // how this record came to say what it says
await audit.forAccess(actor, employeeId);     // their login and their roles
await audit.forWorkPattern(actor, patternId); // the week, and its seven days
await audit.recent(actor, { actorEmployeeId }); // what one person has been doing
```

### Triggers write the entries. Nothing in the application does.

**There is no method that writes an entry, and there must never be one.** A
trigger on every audited table captures `to_jsonb(OLD)` and `to_jsonb(NEW)`, in
the same transaction as the change. That buys three things a service writing its
own entries cannot have:

**It cannot be forgotten.** The seed, a bulk import, a migration correcting data
and somebody in psql on a Friday afternoon are all recorded. There is no second
way to change a row.

**There is no window.** The change and the record of it commit together or not at
all. An audit trail with a gap in it is wrong exactly when somebody is
investigating a crash.

**It cannot be composed wrongly.** The entry is the row, not somebody's
description of the row.

The table types in `server/src/db/schema.ts` make every column unwritable, so
this is a rule the compiler holds as well as the prose.

### The application supplies the one thing the database cannot know

Which person asked. Every audited write goes through `recording()` in
`server/src/repositories/`, which opens a transaction, puts the writer's name on
it with `SET LOCAL`, and runs the write on that connection. `SET LOCAL` rather
than `SET`, because the connection goes back to a pool and a session-level
setting would attribute the next request's writes to whoever last borrowed it.

It composes with a transaction that is already open: a staff import opens one
around four hundred rows, and `recording()` finds it is already inside one rather
than taking a second connection and blocking on the import's own uncommitted
rows. All four hundred entries are attributed to the officer who confirmed it,
and roll back with the rows if the last line is wrong.

Nothing set means nobody said, and the entry records that in words —
`not named by the writer` — rather than leaving a null for every reader to guard.
A migration and the seed produce those honestly.

### Nothing may be changed once written

| | Covers | Does not cover |
|---|---|---|
| `lms_app` holds no `UPDATE` or `DELETE` | the application, which is the writer an attacker reaches | the owner connection |
| the `audit_log_is_never_changed` / `_deleted` triggers | every connection, owner included | `TRUNCATE`, and a superuser who disables triggers |
| the application never running as the owner | the whole of the above being worth anything | nothing |

The first is the one that matters, and it is the one nobody had to write: the
default privileges grant `SELECT` and `INSERT` on a new table and nothing else,
so the log is append only because nobody ever granted it more.

The triggers are the loud half, and they are triggers rather than a
`DO INSTEAD NOTHING` rule on purpose. A rule would make an `UPDATE` *succeed*
while changing nothing, and a silent success is the worst possible answer to
somebody rewriting history: they believe they have, and nobody finds out either
way. A refusal with SQLSTATE `23001` on it is an error in a log and a question
somebody asks.

### Both states, and no secrets

An entry holds the whole record either side of the change rather than a list of
what moved. That is what settles an argument: "her start date says 2023" is
answered by a snapshot and is not answered by knowing that somebody changed some
fields in March. `changedFields()` in `server/src/domain/audit.ts` turns the pair
back into a readable change.

**No credential is ever in an entry.** A password hash in a table the application
can `SELECT` would make the audit log the cheapest way to steal the credentials
it exists to protect. So the comparison happens on the real values — a reset from
one hash to another is a real change and is recorded — and what is stored says
only `[set]`. That a secret changed is the fact; what it changed to is not.

**Signing in writes nothing.** The sign in stamp and the one time code columns are
noise, and a change to nothing but noise writes no entry at all. Who signed in and
when is an access log, which this is not and which does not exist. The same rule
means two HR officers saving the same form produce one entry, not two.

### Reading it is the same permission as reading the record

The log holds every version of every record, so a policy that let anybody browse
it would undo [Authorisation](#authorisation) entirely — a colleague refused a
record could ask for its history instead and be handed several copies of it.

| | Who |
|---|---|
| One employee record's history | yourself, your line manager, HR — the same standing as reading the record |
| A login's and roles' history | yourself, `HR_ADMIN`, `SYS_ADMIN` |
| A team's or a working pattern's history | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` |
| The whole log | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` |

**Your own history is yours**, and that is the story rather than a concession: an
account of a disputed balance that the person disputing it cannot see is not an
account, it is a reassurance.

`user_role.granted_by` was deliberately never added. LMS 111 left it out and said
why — it wanted an authenticated actor and a place to put it — and this is that
place.

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
    /auth            company email, MFA, the actor, and one policy per resource
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

**A route never contains an authorisation check either.** Every service method
takes an `Actor` and asks the policy for its resource; a route identifies the
request and passes the actor down. See [Authorisation](#authorisation) for why
that is the only arrangement in which forgetting is impossible rather than
merely unlikely.

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

When it arrives it attaches to what LMS 113 already built: `refuse_update()` and
`refuse_delete()` are named for the job rather than for the table, and
`record_in_audit_log()` takes the table it is attached to from `TG_TABLE_NAME`.
An append-only ledger is three triggers and no new machinery. See
[The audit log](#the-audit-log).

**Policy is data, not code.** Every entitlement figure, threshold and notice period lives in a table with an effective date. Nobody should ever ship a release because HR changed an allowance.

**Pending days are reserved.** Submitting a request writes a `RESERVATION` entry immediately. This is what stops somebody with five days left having three separate five day requests in flight.

**Only the state machine moves a request.** All transitions go through one service method with one authorisation check and one audit write. No route mutates `leave_request.status`.

**Counting basis and approval chain vary by leave type.** Annual, sick and compassionate count working days; maternity and paternity count calendar days. Most types go manager then HR; unpaid leave goes HR then CEO. Both are configuration. If either appears as an `if` on a type code, that is a bug.

Since LMS 201 the first half of that is a table, `leave_type`, and since LMS 204
the second is `leave_type_approval_step` beside it. Both are set out further down.
What is still not built is the routing itself — which person a chain's desk
resolves to, and what happens when the request reaches them — which is FR 48.

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
letter. `server/src/domain/time.ts` holds both rules, and there is exactly one
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
declaring its own `RAISE`, and gained a sibling, `refuse_update()`. The Phase 2
ledger should do the same. Both raise `restrict_violation` (SQLSTATE `23001`), so
a caller can tell a refused write from a genuine fault without reading the message
text.

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
`server/src/domain/org-chart.ts` is built around. A chart that quietly drops the
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
FR 23.

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
`resolve()` in `/domain/entitlement-rule.ts`. The repository fetches the
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

*A new rule may not reach back into a closed year.* This is the one the database
cannot decide, because a closed leave year is a row in a table that arrives with
LMS 205. It is held one level up as `assertDoesNotReachIntoAClosedYear`, which
takes the boundary as an argument the way `worksOn` takes a weekday — the domain
knows the rule, the caller brings the fact. Until `leave_year` exists the caller
brings `NOTHING_IS_CLOSED_YET`, which is a truthful statement rather than a stub:
on go live the whole of 2026 is open, and entering the current policy from 1
January is exactly what HR has to be able to do.

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
`/domain/approval-chain.ts` for a type nobody configured and in the migration for
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

**What is not built.** Which *person* a desk resolves to, and what happens when
the request gets there, is FR 48 and Phase 3 — `approverAfter()` is the walk, as a
pure function, so that when the workflow arrives there is nothing left to decide.
The manager who raises their own leave and has to route upwards is FR 48b, and is
about a reporting line rather than a leave type. Cover while an approver is
themselves away is FR 49. Parallel approval is nothing the SRS asks for and is the
one thing `step_order` refuses outright: two rows cannot share a number.

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
therefore cannot drift away from the form.** A rule added to `/domain/employee.ts`
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
npm run walkthrough   # not a test: narrated runs, for reading rather than for a build
npm run chart         # one of them: the organisation chart, which needs no mail
```

Unit tests live in `server/tests/unit` and touch no database, no network and no
fixtures. Anything that needs one of those is an integration test and belongs in
`server/tests/integration`.

**`integration/audit.test.ts` carries LMS 113 rather than supplementing it.**
Almost all of that story is in the database — the triggers that write the entries,
the ones that refuse to change them, the privileges that make the refusals worth
anything — so there is little to prove without one. `unit/audit.test.ts` covers
the reading of an entry, which is a pure function.

**`integration/time.test.ts` carries LMS 114 for the same reason.** Which type a
column is, what a session does to a value on the way past, and what the driver
hands back are all facts about a real server. It also holds the rule for tables
nobody has written yet: any column typed `timestamp without time zone`, any
`*_date` that is not a `date`, and any `*_at` that is not a `timestamptz` fails
there. `unit/time.test.ts` covers the pure half, and `unit/migrations.test.ts`
asks the same question of the SQL so the answer arrives in a second rather than a
minute.

**`unit/leave-type.test.ts` is where LMS 201 is proved and
`integration/leave-type.test.ts` is what stops it being proved against itself.**
The rules are pure functions, so what a threshold means and which fields may not
disagree are settled without a database. What needs one is the half the database
decides: that the seven types of FR 32 really are on a migrated database and
really have the shapes §4.3.1 gives them, that the constraints refuse a row
written straight to the table on the owner connection, that `lms_app` has no way
to delete a type, and that every change is one audit entry naming the
administrator who made it. That suite restores the table from a snapshot taken
before any test touched it, rather than from a list written out in the file —
otherwise the first assertion would be checking the migration against a copy of
itself.

**`unit/entitlement-rule.test.ts` is where LMS 203 is proved, and it is the story's
fourth criterion made good.** "Resolution logic implemented once and unit tested
hard" has two halves: that there is one implementation, and that it is tested
without a database. The resolution tests are written to fail if the rule is ever
reduced to "the latest row wins" or "the narrowest row wins" alone — most of them
carry a rule that would win under one key and lose under the other, and one has a
company figure written *after* a personal one and still losing to it.
`integration/entitlement-rule.test.ts` covers what the database decides: that the
figures are on a migrated database with their dates, that a rule which has taken
effect refuses to be rewritten by the owner connection as well as by the service,
that the fixture reload puts the statutory figures back — and that no view has
appeared to resolve the rule a second time.

That snapshot earns its keep twice over in LMS 202. A type deleted and then put
back by `ensure_statutory_leave_types()` is compared against it column by column,
which is the one comparison worth making: the reference set now exists in two
migrations, and this is what stops the two quietly disagreeing about what a leave
type is. The rest of that story is the things the function refuses to do — it
leaves an edited notice window edited, a reworded name reworded, and a retired
type retired — and `unit/migrations.test.ts` asks the cheap half of the question
without a database, which is that the seven come from a migration rather than
from the fixture seed no production database runs.

**`unit/approval-chain.test.ts` proves LMS 204 without ever naming a leave type.**
Every assertion sets a chain and reads the answer back; not one of them builds a
type called maternity and expects a chain from it, which is the only way to tell a
system that is configured from one with the seven cases written into it.
`unit/migrations.test.ts` guards the same property from the other end, by failing
if any file under `server/src` contains a statutory type code at all once comments
are stripped. `integration/approval-chain.test.ts` covers what the database
decides: that the two unpaid types really go to HR and the Chief Executive on a
migrated database, that the default the domain applies and the default the
migration writes are the same two desks, that a chain cannot acquire a hole or a
repeated desk whoever is writing, and that `lms_app` has no way to rewrite a step
in place.

The suite that empties `leave_type` has to put the chains back, and
`integration/leave-type.test.ts` does — the steps cascade from the type, so a
restore that stopped at the types would hand every later suite a database full of
types nobody can approve leave against. It calls
`ensure_statutory_approval_chains()`, as it calls the function that owns the
figures, so that nothing in a test file knows who approves unpaid leave.

**`unit/policy.test.ts` is where authorisation is actually proved.** Policies are
pure functions, so every role can be enumerated against every action rather than
sampled — a fifth role added without a decision about what it may do fails there.
`integration/authorisation.test.ts` covers the half that needs a database: that
the services ask, that an actor is what signing in produces, that a missing record
and a forbidden one give the same answer, and that the refusals reach the log
carrying nothing from the record.

**`npm run walkthrough` is not a test and is not run by either suite.** It is
`server/tests/walkthrough`, narrated runs against a database each builds and
drops. They print rather than assert, so they are for seeing the thing work
rather than for proving it does.

`sign-in.ts` is the password door, the code, the guesses and the leaver, sending
real mail you can read in Mailpit — start `npm run mail` first. `org-chart.ts` is
FR 09 and needs no mail, so it has `npm run chart` to itself: the organisation
drawn at five levels, then a team lead leaves and the chart says so, then the
same organisation charted without its leavers so you can see what dropping them
would have hidden, then a loop the database refuses and the chart draws anyway.
A chart is a thing you judge by looking at it, which is the one thing an
assertion cannot do.

**Integration tests build their own database and throw it away.** Each run creates
`lms_test_<random>`, applies the migrations to it, runs the suite, and drops it
again, including when the suite fails. Nothing is left behind and no test run can
see another one's rows.

That means integration tests need an owner connection, since creating a database
is not something the application role may do. They apply the real migrations
rather than loading a dumped schema, so every integration run is also a check
that the migrations still apply cleanly to an empty database.

**Point `TEST_DATABASE_URL` at your local Postgres 17, and mind the difference it
makes.** Every test reloads the fixture organisation, which is two dozen
statements, so the suite is several thousand round trips end to end. Against a
Neon branch in London that is **about eleven minutes**; against a local server it
is **under one**. The database does identical work either way — the network is the
whole of the difference, and it is paid once per statement.

It is a key of its own rather than a change to `DATABASE_MIGRATION_URL` so that
migrations still go to Neon while tests stay local, and it falls back to
`DATABASE_MIGRATION_URL` when unset, so continuous integration and anybody
without a local server are unaffected.

On Windows, 17 installed beside a newer version usually sits on **5433** — check
`C:\Program Files\PostgreSQL\17\data\postgresql.conf`. Use 17 rather than
whatever is current: a suite that passes on a version production does not run has
proved less than it appears to.

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
