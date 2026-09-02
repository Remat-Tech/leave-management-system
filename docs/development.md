# Development

Setting the project up, the conventions it follows, and how it is tested.

The README has the short version; this is the detail behind it.

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
npm run web:install     # the client is its own npm project, see below

cp .env.example .env
# fill in DATABASE_URL and the other values, see below
# SESSION_SECRET is not optional: openssl rand -base64 32

npm run migrate up      # create the schema
npm run seed            # load fixture data

npm run api             # the API, on :3000
npm run web             # the client, on :5173, in a second terminal
```

Open <http://localhost:5173>. The client proxies `/api` to the API, so everything
happens on one origin — which is what lets the session cookie be `SameSite=Strict`
and the API carry no CORS at all. Sign in as any seeded employee once HR has set
them a password; `npm run seed` creates the logins but no passwords, because
`SignInService.setPassword` is the only thing that sets one and there is no self
service reset.

**`client/` is a separate npm project**, with its own `package.json` and its own
`node_modules`. Deliberately: the server runs on Node with no DOM and no JSX, and
one `tsconfig` covering both would have to be loose enough to let a server file
reach for `window`. Two projects, two `tsconfig`s, one `eslint.config.mjs` with a
`client/**` block that has the browser globals in it and nothing else does.

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
| `NODE_ENV` | `development` or `production`. It decides one thing that matters: whether the session cookie is marked `Secure`. A browser will not store a `Secure` cookie from `http://localhost`, so signing in would silently do nothing in development |
| `PORT` | API port, defaults to 3000. Read since LMS 401, which is when there was first a server to listen on it |
| `SESSION_SECRET` | Signs the session cookie. Read since LMS 401. **No default, and the process will not start without one** — a default signing key is a system that runs perfectly well in production while anybody can mint a cookie for anybody. Under 32 characters is refused too |
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

The check lives in `server/src/features/sign-in/company-email.ts`. Use it at provisioning
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
`server/src/features/sign-in/password.ts`, no dependency, per password salt, timing safe
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
    main.ts          the composition root. Builds everything once, then listens
    /features        one folder per feature — see "Where things live" above
    /auth            the policy kernel: Actor, Guard, Decision, the denial log
    /db              the connection, the Kysely types, recording(), transactions
    /shared          dates and whole-day arithmetic
    /http            the Express app, identify, and the error handler
    /mail            outbound notification transport
    /storage         attachment bytes, behind one interface
  /tests
    /unit            no database, no network. 1,598 tests in about 4 seconds
    /integration     one disposable database per file, run in parallel
    /walkthrough     narrated runs, for reading rather than for a build
/client              its own npm project: React 19, Vite, its own tsconfig
  /src
    api.ts           the only place the client talks to the server
    /features        one folder per area: requests, balances, approvals, admin
/docs                the long-form reference, split out of this file
```

`/http` holds the app assembly, the middleware that turns a request into an
`Actor`, and the error-to-status translation. Nothing in it decides anything —
see the layering rule below, and `http/app.ts`, where the **order things are
mounted in** is the one security property a route layer has to get right by itself.

### Layering rule

Grouping by feature does not remove the layers; it puts each feature's copy of
them in one folder. Within a feature: `routes.ts` does HTTP, `*.service.ts` does
business rules, `*.db.ts` does database access, and the plain `*.ts` files are the
rules themselves.

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

LMS 313 adds `unit/state-machine.test.ts` beside it, which is three criteria in one
file because they are one design: the table pinned in full, the source read for a
second writer of `status`, and the split between the two questions the policy and the
table each answer. Its integration half asserts that the trigger permits exactly the
endings the table holds, and that every move lands in the audit log with the person who
made it and the state it came from.

LMS 314 puts the walk in that same unit file, against chains written out by hand —
manager-then-HR, HR-then-CEO, one desk, three desks, and a chain changed under a waiting
request. That is deliberate: `approvalTo()` is a function of a list of desks, so proving it
against a leave type would be proving less. Which desks the policy actually admits is
`unit/policy.test.ts`'s, against hardcoded actors, including the case that makes the
requester's exclusion necessary — an HR Officer asking for unpaid leave holds a code that
staffs the desk it starts at. What needs a database is in `integration/leave-request.test.ts`
and is the story itself: that annual leave starts with the manager and unpaid leave starts
with HR because of rows the migration wrote, that rewriting a chain moves where the next
request starts with no deployment, that the last approval writes a `DEDUCTION` and the ones
before it write nothing, and that leave which has been agreed still blocks its own days.

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
decorative.** Every date in `/shared/time.ts` is built at UTC midnight, which is
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

**Integration tests build their own databases and throw them away.** The run
migrates one template, `lms_template_<random>`; each test *file* then copies it as
`lms_test_<random>` and drops the copy when it finishes. Everything is dropped at
the end, including when the suite fails, and a copy left behind by a killed worker
is swept on the next run. No file can see another's rows.

That means integration tests need an owner connection, since creating a database
is not something the application role may do. They apply the real migrations
rather than loading a dumped schema, so every integration run is also a check
that the migrations still apply cleanly to an empty database.

**A database per file is what lets the files run in parallel**, which is most of
what the suite costs. They used to share one database and so had to run one at a
time: 31 files, about 46 minutes of work end to end. Copying a template costs
about a second a file and the same work now finishes in **about four and a half
minutes**.

One caveat worth knowing if you add a migration that sets one: `CREATE DATABASE
... TEMPLATE` does **not** copy `ALTER DATABASE` settings, which live in
`pg_db_role_setting` keyed by the database's OID. `server/tests/setup/test-database.ts`
replays them from the template, so the UTC timezone and ISO date style the
timestamps migration sets are carried onto every copy.

**Point `TEST_DATABASE_URL` at your local Postgres 17, and mind the difference it
makes.** Every test reloads the fixture organisation, which is about 170ms of
statements, so the suite is several thousand round trips end to end. Against a
Neon branch in London that is many minutes of pure latency; against a local server
a round trip is a fraction of a millisecond. The database does identical work
either way — the network is the whole of the difference, and it is paid once per
statement.

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

Since [LMS 319](#nobody-approves-their-own-request) the defect is refused rather
than merely designed against: Ama's own request sitting at the HR desk she is
admits nobody, at four altitudes down to the table the decision is written to. The
half FR 48b still owes is the *routing* — where that request goes instead — so
today it waits at a desk nobody can fill, which is stuck and visible rather than
signed by the person who asked.

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
