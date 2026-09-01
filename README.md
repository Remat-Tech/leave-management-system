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
| The public holiday calendar | anybody signed in | `HR_OFFICER`, `HR_ADMIN` |
| Every movement in one person's balance | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` | `HR_ADMIN` only, for an adjustment |
| Every balance in the company, checked against the ledger | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` | — |
| Granting a year's entitlement | | `HR_ADMIN` only |
| Carrying last year's unused days forward | | `HR_ADMIN` only |
| Recording an event and granting what it brings | | `HR_OFFICER`, `HR_ADMIN` |
| Lapsing an unused event grant | | `HR_ADMIN` only |
| A leave request | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` | yourself, `HR_OFFICER`, `HR_ADMIN` — and only the person who asked may reword one |
| Holding days for leave you are asking for | | yourself, `HR_OFFICER`, `HR_ADMIN` |
| Approving held days into taken days | | your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` — never yourself |
| Giving held days back | | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` |
| Roles | your own, and `HR_ADMIN` / `SYS_ADMIN` for anybody's | `HR_ADMIN`, `SYS_ADMIN` |
| Logins: create, set a password | your own account is readable by you | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` |
| Logins: close, reopen | | `HR_ADMIN`, `SYS_ADMIN` |

Ten of those lines are decisions rather than defaults, and each is argued in the
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

**The holiday calendar is the one configuration table an HR Officer may write.**
Leave types, entitlement figures and leave years are all `HR_ADMIN`, because each
holds a decision about what leave costs everybody. The gazetted holidays are not
Remat's decision at all — they are the Republic's, published in the national
gazette — and HR is transcribing rather than deciding. The failure the wider rule
would cause is the concrete one: a holiday declared on a Tuesday for the Friday of
the same week is a two minute job, and behind an administrator it becomes a ticket
that leaves the calendar a week behind the country by March, which charges somebody
a day of annual leave for an afternoon nobody worked. `SYS_ADMIN` is deliberately
not on it either: keeping the calendar is HR's job, not a power that comes with
being able to reach the database.

**Granting a year is the same desk that writes the figures, and so is carrying one
forward.** LMS 214 and LMS 217. A grant and an adjustment are the same act from the
balance's point of view — days arriving with no request behind them and no way to take
them back — and what differs is that a rule written in advance chose the figure rather
than somebody this morning. Writing that rule is `entitlementRulePolicy.create` and is
an HR Administrator's, so applying it is too: letting an Officer apply figures only an
Administrator may write would put a year's entitlement one desk below the decision
behind it. `ledgerPolicy.carryForward` is the same argument about
`leave_entitlement_rule.carries_over`, and it is its own decision rather than a reuse of
`grant` for the reason the file has no `post` at all — "carried 2026 forward" and
"granted 2027" are two sentences somebody may need to find separately.

**Recording a birth is the employee-record desk, and lapsing what it granted is not.**
LMS 218, and it is the one grant in this system an HR Officer may post. The two above
apply a *policy* to everybody at once; recording an event is one fact about one person,
told to whoever in HR answered the telephone, and the figure still comes from an
entitlement rule only an Administrator may write. The practical half is the one the
holiday calendar makes: a new father with fourteen days he cannot book because an
Administrator has not been in this week is the system failing at the only moment it was
ever going to matter to him. `ledgerPolicy.lapse` goes back to `HR_ADMIN`, because
`leave_type.entitlement_expiry_months` is what decides that those days run out and
writing it is an Administrator's — and because of the direction: a wrong grant leaves
somebody with days they did not earn, which a report catches, while a wrong lapse takes
days off somebody who was going to use them, and they find out when they try to book.

**Moving a balance by hand is narrower than anything else in this system, and only
an `HR_ADMIN` may.** §10's matrix has an ✗ against every other column including HR
Officer, and it is right: an adjustment moves days by fiat, with no request and no
rule behind it, and it can never be removed — only compensated by another entry
that is itself permanent. Correcting an earlier entry is decided by the same rule
rather than a separate one, because whoever can post an adjustment can already post
its opposite, and a split would suggest somebody might hold one and not the other.
Reading a balance follows the employee record's rule exactly: yours, your direct
reports', or a role that reads everybody — a ledger is somebody's history, not a
published calendar.

**The three movements a leave request causes are three decisions, not one.** LMS 212.
Asking for leave is yours, and HR's on your behalf where FR 18 says somebody was off
sick and could not ask; a line manager is deliberately not on it, and it is the one
place their standing over a report does not carry — a manager who could reserve a
report's days could quietly reduce what that person may book without approving
anything. Approving is the mirror image: their manager's or HR's, and **never the
person whose leave it is**, which is the only refusal in this system aimed at
somebody's own record on purpose. Giving days back is any of the three, because it is
the one movement that cannot take anything from anybody.

None of those decides whether the request itself is legitimate — the notice period,
the documentation, whether this is the approver FR 38a's chain is waiting on. Those
belong to the request and approval stories and are asked first. What the balance asks
of anybody moving it is the narrower question: have you any standing here at all.

**A request is read by three people, asked for by two, and reworded by one.** LMS 301,
and the three widths are the decision. Reading follows the balance exactly — yours, your
line manager's, or a role that reads everybody — because a request is *why* a figure is
what it is, and standing to see one without the other is standing to see half an
explanation. Asking is narrower: yours, and HR's on your behalf under FR 18, and
deliberately not your line manager's, for the reason `ledgerPolicy.reserve` gives about
somebody who could reduce what you may book without ever approving anything. Rewording
is narrower still and is the author's alone, which is the one place in this system where
being able to create something does not carry the right to edit it — the reason is the
account an approver decides on, and unlike every figure on the row no trigger can refuse
a change to it, because the field is deliberately editable.

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

What is still not built is the routing itself — which person a chain's desk
resolves to, and what happens when the request reaches them — which is FR 48.

**Everything is a whole number of days.** FR 24. Half days are settled between an
employee and their manager, come off no balance, and are not in this system at all.
There is no fraction anywhere: not in a column, not in a field, not in an argument.

Since LMS 209 that is a rule rather than a habit, and it is held up in three places
because it can be broken in three ways.

| | Holds | Checked by |
|---|---|---|
| `domain/whole-days.ts` | `isWholeDays()`, the one predicate every figure in days is asked | `unit/whole-days.test.ts`, over every entry point that takes one |
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

Since LMS 215 that calculation exists: `domain/pro-rata.ts`, and it is the one place in
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
`/services/leave-year-service.ts`, one line over `earliestOpenDayOf()` in the
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
`assertItCostsSomething()` in `/domain/leave-request.ts`, raised by the submission
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
`domain/leave-type.ts` named the collision before either clock existed. `EXPIRY` is
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
kind moves is `BUCKETS` in `domain/ledger.ts`. `runningTotal()` exists and is named
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
settings `repositories/recording.ts` puts on the transaction — the same seam the
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
`domain/balance.ts`, and a stored copy would put the formula in two languages.
`taken` and `pending` are positive counts of movements the ledger records as
negative — a `RESERVATION` is −5 days in the ledger and five days pending here —
which is why this subtracts where a naive sum of signed movements would add. It may
go below nought: §8.6b, sick leave, and there is no clamp anywhere.

**The projection exists once, in SQL.** Which of the five columns each of the eight
kinds of movement moves is `rebuild_one_balance_from_the_ledger()`, and nothing else
anywhere computes a balance — not the service, not the domain, not a report. That is
the rule the ledger migration set when it declined to write the first copy: "a total
computed in two places is the drift the cached balance exists to be checked
against". `BUCKETS` in `domain/ledger.ts` is the *statement* of the same projection
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

**Nightly is a cron line, and there is nowhere yet to put one.** This build has no
server entry point, no route layer and no scheduler, so `BalanceReconciliation.run()`
is written to be called by the first thing that runs on a timer and is not itself
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
FR 36, FR 36a, §11, LMS 217. `jobs/year-rollover.ts` closes the year that ended, carries
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
judgement into `/domain/leave-request.ts` and left the calculator
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
`balanceMayBeExceededWithDocument()` — which has sat in `/domain/leave-type.ts` since LMS
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
| `refuse()` | the line manager, or HR | a decision about somebody else's request, which is what a manager is for |
| `cancel()` | HR | an administrative unwinding — leave against the wrong person, a request entered twice |

A single `settle` decision would have to be the union of those, which is
`ledgerPolicy.release` itself — and it would let a manager withdraw a report's leave and
let somebody mark their own leave refused. Both write a perfectly valid `RELEASE` and a
record of something that did not happen. **Which of the three it was is written into the
ledger**, because five days coming back look identical in a balance whether the person
changed their mind, a manager turned it down or HR unwound it, and those are three
different conversations.

**`APPROVED` is deliberately not here.** Approval *commits* days — the hold becomes days
taken and available does not move at all — so it is a different movement with a different
entry type, and which desk in FR 38a's chain may agree needs the chain, the type and how
far the request has got. `BalanceService.commit` has been built and waiting for it since
LMS 212.

**The status and the `RELEASE` are one act**, in both directions and held by the database
rather than by the two methods that happen to do it properly:

| | Covers | Does not cover |
|---|---|---|
| `leave_request_releases_once`, a unique partial index | a second `RELEASE` against one request, immediately, on every connection | a request that ended holding its days |
| `leave_request_gives_its_days_back`, a deferred constraint trigger | a request that ended and released nothing, at `COMMIT` | `TRUNCATE`, which no row trigger sees |
| `leave_request_ends_once`, a `BEFORE UPDATE` trigger | a settled request being moved again, or moved anywhere but an ending | — |

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

**The application never runs as the owner.** An application connected as the owner could reach `audit_log` and `leave_ledger_entry` in ways nothing else can, which is precisely what an audit trail exists to make impossible. NFR AUD 02.

Both tables also refuse an `UPDATE` or a `DELETE` by trigger, which holds against the owner too — so the owner's real power is not the write itself but dropping the trigger first. That is a deliberate act in a migration with an author and a review on it, which is the most a database can offer. The two protections are layers rather than duplicates: the privileges stop the writer an attacker actually reaches, and the triggers stop the honest mistake at a psql prompt.

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

**`integration/leave-request.test.ts` carries the half of LMS 301 that a pure
function cannot reach**, and the test it exists for is one: submit a request,
change the leave type's counting basis underneath it, and read the request back
unchanged. FR 11 is a claim about what happens to yesterday's records when
somebody edits configuration today, so it cannot be proved without a real leave
type to edit and a real row to re-read. The same suite is where the request and
its `RESERVATION` are shown to be one act — a foreign key, a deferred trigger and
a rollback are not properties any pure function has.
`unit/leave-request.test.ts` covers what a quote says and what a request has to
carry, and neither file names a leave type by its code.

Since LMS 304 the same suite carries the overlap rule, and there the database half
is a path real users take rather than a backstop for psql: the service is asked to
book over leave it has already booked, and separately the owner connection is, which
is the racing second submission made deterministic. It also reads
`leave_request_never_overlaps` back out of `pg_constraint` and asserts its `WHERE`
predicate is exactly `LIVE_STATUSES` — the check that fails on the afternoon the
approval story adds a status to one list and not the other.

Since LMS 305 it also carries the balance refusal, and what needs a database there
is that the figure in the sentence is the one in the table: it holds six days
against the balance and asserts the *next* refusal names fourteen rather than the
entitlement. The same suite submits one over-long request past both checks — the
service's and `daysToReserve()`'s, reached by going straight to the door — and
asserts the two agree on the available figure, the days requested and the
shortfall, so [neither can be loosened alone](#days-that-are-not-there).
`unit/leave-request.test.ts` covers the sentence, which is most of that story.

LMS 309 leans on the same suite for a requirement that is an absence: [no maximum
request length](#no-maximum-request-length) is proved by asking for an entire leave
year at once, having first put the entitlement up by hand so the balance is not what
answers. A cap anywhere in the path refuses that whatever value it holds, so the test
passes only if there is nothing — which is the same trick `unit/one-writer.test.ts`
plays on a second ledger writer, done by behaviour instead of by reading source.

And since LMS 306 it carries [the three endings](#the-days-come-back), where the
database half is again a real path rather than a psql backstop. The test the story
exists for is one: submit a fortnight, be refused the same fortnight, withdraw the
first, and book it. That cannot be written without a real exclusion constraint and a
real balance, and it is the assertion that `LIVE_STATUSES` stopped being a
tautology. Beside it the suite reads `leave_request_status_known` back out of
`pg_constraint` and asserts it admits exactly `REQUEST_STATUSES`, and drives all
three database guarantees from the owner connection — a status moved with no
`RELEASE`, a settled request moved again, and a second `RELEASE` against one
request.

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

**`integration/leave-year.test.ts` carries most of LMS 205, because most of that
story is in the database.** The rules that keep a day in exactly one year are an
exclusion constraint and a deferred trigger, and the lock is a third trigger, so
the assertions that matter are made against the owner connection: an overlap
refused, a gap refused, a boundary moved in one transaction and the same move
refused as two, and a closed year that will not reopen, will not move its dates
and will not be deleted for anybody. `unit/leave-year.test.ts` proves the pure half
— which year a day is in, what a gap looks like from either side, and the boundary
a closed year sets — including the leap day, because a year boundary is exactly
where day arithmetic goes wrong.

Three suites assert that **nothing anywhere can reopen a closed year**, by looking
for the absence rather than for a behaviour: the domain exports nothing that could,
the policy offers no decision, and neither service nor repository has a method.
That is an odd-looking test and the right one, because the absence is the feature —
a lock with an undo is not a lock.

**`integration/holiday.test.ts` proves the two halves of LMS 206 a unit test
cannot**: that Ghana's fourteen days for 2026 are on a database nothing has seeded,
and that a settled leave year keeps its days against the owner connection as well as
against the service. It also exercises the three verbs as privileges rather than
only as rules — `lms_app` really holds `DELETE` here, and a story that could not
remove a day would be one where the first mistake is permanent.
`unit/holiday.test.ts` proves the pure half: one row to a day, both ends of a move
judged separately, and the leave years nobody has entered a calendar for.

**`unit/leave-calculator.test.ts` is where LMS 207 is proved**, because the
calculator is a pure function and every case is arithmetic. Two of its tests read
the source rather than call it, and both are the story rather than cleverness: one
asserts the file never mentions `.code`, which is design principle 5 as a check
rather than a paragraph, and the other asserts its import list, which is "pure, with
no database access beyond patterns and holidays" said in the only way that stays
true. `integration/leave-calculator.test.ts` adds what a unit test cannot reach —
the real seeded gazette, the real Monday to Friday week, the real part timer with
Wednesdays off, and a fortnight over the actual Christmas coming out at the number
somebody would get counting off a wall calendar.

That part timer is not a fixture invented for that suite. The seed has carried her
since LMS 106, with the reason written beside her: "The counting tests in Technical
Design Document section 7.3 need a pattern that is not simply weekends off, or a bug
that assumes Saturday and Sunday are the only non working days passes every test."

**`unit/leave-calculator-cases.test.ts` proves the answers, which is not the same
as proving the rules.** LMS 208. A calculator can obey every rule in its own
description and still be a day out over Christmas, so this one is a single table of
worked examples: seventeen rows, each carrying the period, the week, the calendar in
force, the arithmetic written out in words, and both totals — what it costs as
annual leave and what the same days cost as maternity leave. Any row can be checked
against a wall calendar without running anything, which is the only kind of test
that settles an argument about a number.

The awkward cases are the point: a holiday that lands on a weekend (Boxing Day 2026
is a Saturday, and a calculator that subtracted holidays from a weekday count would
take it off twice), the same midweek holiday priced for somebody who works
Wednesdays and somebody who does not, 31 December into 1 January, and February in a
leap year against February in one that is not — one day more, both ways.

Three sweeps run over the whole table, and each catches a class of error no single
row can.

| Sweep | Catches |
|---|---|
| invariants — counted days plus free days is the whole period | a day that fell out of the walk entirely, which any single wrong total can hide |
| four process timezones | a `getDay()` where a `getUTCDay()` belongs — everybody's weekend a day out, quietly |
| additivity — a year whole against a year month by month | an off by one at a period boundary, which twelve periods expose twelve times |

**Two of the four zones are west of Greenwich, and that is load bearing rather than
decorative.** Every date in `/domain/time.ts` is built at UTC midnight, which is
still the same day everywhere east of Greenwich and the day before everywhere west
of it. A sweep that only ran eastward would give a clean bill of health for exactly
the bug it was written to find; the eastern two are kept because the opposite
mistake — a date built at local midnight and read back at UTC — fails there and
nowhere else.

**`integration/ledger.test.ts` carries most of LMS 210, because the story's central
claim is one only a database can make.** That an entry cannot be changed or removed
is not a property of the application declining to try: the assertions that matter
are run on the *owner* connection, because an immutability the migration user can
step around is a convention and FR 27 asks for a property. The same suite proves
that a writer supplying `created_by` or `created_at` is overruled by the trigger,
that the eight kinds the domain knows are the eight the column accepts, and that a
settled leave year takes an `ADJUSTMENT` and nothing else — §8.9's exception, which
is the one rule in this schema most likely to be tidied away by somebody who has
read the holiday rules and assumed this table works the same way.

`unit/ledger.test.ts` proves the pure half, and two of its tests look for an absence
rather than a behaviour, which is the shape the closed-year suites already use: the
module exports no verb that changes an entry, and `correctionFor()` takes no amount
from the caller. Both are the feature. A ledger with an edit is not a ledger, and a
correction somebody can size is one that can be the wrong size.

**`integration/balance.test.ts` carries nearly all of LMS 211, for a reason that is
not the ledger's.** There the central claim was one only a database can make; here
the central *arithmetic* is one only a database performs. The projection is SQL,
deliberately and once, so the only place it can be asked whether it is right is
against a server: one entry of each of the eight kinds, and the columns that
actually moved compared with the columns `BUCKETS` says should have. The same suite
proves that the balance moves inside the entry's transaction and rolls back with it,
that two transactions posting against one balance lose neither, that no connection
writes a figure by hand, and that every figure can be deleted outright and comes
back identical — which is what "the ledger is the truth, balances are a cache"
means when it is a property rather than a slogan.

`unit/balance.test.ts` carries the arithmetic of both stories: the five figures and
what they add up to, and since LMS 212 the three rules a movement has to pass. One of
its tests asserts that the domain exports nothing that turns ledger entries into a
balance — a `balanceFrom(entries)` would be twenty testable lines and a second
implementation of the sum, which is the drift the cache exists to be checked against.
Whoever adds one has to argue with that test first.

**`integration/leave-event.test.ts` carries most of LMS 218, and the unit suite beside
it carries two arithmetic rules.** The split is the annual grant's, for the same reason:
when a grant runs out and what is left when it does are pure functions, and everything
the story is actually about is a claim only a database can make. That the grant and the
event cannot come apart is a foreign key and a rollback. That `LAPSE` lands in
`entitled` rather than `carried_over` is a CHECK constraint and a view, and the only
place to ask whether that is right is against a migrated server. That the expiry can be
run every night is a guarded update rather than care. The suite also holds the two
awkward cases that would otherwise never be exercised: two births in one leave year,
where nothing may be lapsed while the second is still live, and a grant stranded by a
year somebody closed underneath it. `unit/leave-event.test.ts` spends most of its length
on the month arithmetic, because six months after 31 August is the case that is wrong on
exactly the dates nobody tests.

**`unit/year-rollover.test.ts` proves what carries and `integration/year-rollover.test.ts`
proves that it survives a boundary.** LMS 217 splits along the same line the annual grant
does, for the same reason: what carries is a pure function of three facts and none of them
needs a server, while the two criteria the job exists for are claims a database has to
make. That the three acts happen in *that order* is only visible in the rows afterwards —
a settled year, a `CARRY_FORWARD` in the year ahead of it, a `GRANT` beside it — and
"safely re-runnable" is a property of a lock rather than of care: the suite runs the whole
job twice and asserts the ledger and every balance are byte for byte what they were, then
asserts the second run *said* it did nothing, which is the half that lets somebody find out
whether the first one finished. It also holds the two things only a real database can
settle: that a rule taking effect in the new year does not strip last year's days (FR 31,
and the reason the resolution date is the last day of the closing year), and that a
half-finished run is finished rather than repeated. Its fixture defines a 2025 with
entitlement figures of its own, because a year can only be closed once it has ended — which
turns out to be the only shape in which the resolution date is visible at all.

**`integration/adjustment.test.ts` is LMS 216 read end to end, and is deliberately
thin where the two suites above are thick.** That an entry can never be changed or
removed is `integration/ledger.test.ts`'s, and that an `ADJUSTMENT` moves the
`adjustment` column and no other is `integration/balance.test.ts`'s against `BUCKETS`;
repeating either here would be two suites that could disagree. What is left is the
story as somebody in HR meets it — a positive and a negative in one balance netting to
what they add up to, a reason that survives trimmed to the screen the employee reads
it on, an adjustment picked out of a history that also has a grant in it, and a
correction that leaves both rows standing so the figure is still explained. It also
holds the two things the story changed: that a mistyped leave type or leave year is
answered with a sentence rather than a foreign key and writes nothing, and that an HR
Officer is refused *openly* and told which desk can — which is where the story's own
"as an HR Officer" and §10's matrix disagree, asserted rather than left as prose.

**`unit/pro-rata.test.ts` proves two different things and keeps them apart**, because
LMS 215 is a story shipped under a block. One half is that §8.6d's formula is right —
the 1 July joiner, a leap year, an April to March leave year — and that half will
outlive whatever LMS 013 decides. The other is that swapping the rule works, which is
what the block is being survived with: the candidate rule answers 10 where the rule in
force answers 10.08, so a test that swaps them can tell whether the swap did anything.

**`unit/annual-grant.test.ts` is nearly all refusals, and that is the shape of the
story rather than a bias in the file.** Granting twenty days to somebody owed twenty
days is the easy half. The four ways somebody is passed over are where a run goes
quietly wrong, and three of them look identical from a balance screen — nought days, no
explanation. `integration/annual-grant.test.ts` covers the two halves arithmetic cannot
have: that the grant lands as a ledger entry the cache follows by itself, and that
running the job again grants nobody a second year while finishing anybody the first run
did not reach.

**`integration/reconciliation.test.ts` has to manufacture the fault it is about.** The
cache follows the ledger by trigger, in one transaction, on every connection — so
there is no way through the application to produce the drift the job exists to find,
which is the point of the three stories before it. The suite makes it two ways, each a
real failure wearing a costume: the trigger disabled while an entry is written, which
is what a maintenance window does, and the cache written by hand through the seam the
rebuild function uses, which is what a restore from a mid-statement backup leaves
behind. The assertion the story turns on is a negative one and is repeated
deliberately: after every run, the balance is exactly as wrong as it was. A
reconciliation that quietly put things right would pass every other test in the file.

**`unit/one-writer.test.ts` proves the criterion that cannot be proved by running
anything.** "Only writer of balance movements" is a claim about code that does not
exist, so it is checked by reading the source: nothing outside three named files
posts a ledger entry, nothing else holds a `LedgerRepository`, `LedgerService` writes
nothing, and nothing but the one writer consults the three rules. The failure it
guards against is not a rogue `UPDATE` — the database has refused those since LMS 211
— it is an honest second service posting an honest `DEDUCTION` without the lock that
made the first one safe.

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
