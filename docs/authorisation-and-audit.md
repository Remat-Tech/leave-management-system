# Authorisation and the audit log

Who may do what, how a refusal is phrased, and how every change is recorded.

The shape is in the README under **Where things live**; this is the reasoning
behind it and the full matrix.

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

**A policy is one object per resource type**, in `server/src/features/*/policy.ts`,
made of pure functions from an actor and a record to a `Decision`. So
`features/employee/policy.ts` is the complete answer to "who may see an employee record",
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
| A draft of one. FR 19 | the person planning it, and nobody else at all | the person planning it, and nobody else at all |
| A certificate attached to one. FR 12 | whoever may read the request, plus the desk it is sitting on | yourself, `HR_OFFICER`, `HR_ADMIN` — never the line manager |
| Holding days for leave you are asking for | | yourself, `HR_OFFICER`, `HR_ADMIN` |
| Approving held days into taken days | | your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` — never yourself |
| Giving held days back | | yourself, your line manager, and `HR_OFFICER` / `HR_ADMIN` / `SYS_ADMIN` |
| Sending a request nobody could decide back to an approver. FR 48b | | `HR_OFFICER`, `HR_ADMIN` — never the person who asked |
| Asking for agreed leave to be taken off the books. FR 47 | | the person whose leave it is, and nobody else |
| Answering that ask, and putting the taken days back. FR 47 | | `HR_OFFICER`, `HR_ADMIN` — never the person who asked |
| Roles | your own, and `HR_ADMIN` / `SYS_ADMIN` for anybody's | `HR_ADMIN`, `SYS_ADMIN` |
| Logins: create, set a password | your own account is readable by you | `HR_OFFICER`, `HR_ADMIN`, `SYS_ADMIN` |
| Logins: close, reopen | | `HR_ADMIN`, `SYS_ADMIN` |

Eleven of those lines are decisions rather than defaults, and each is argued in the
policy file that holds it.

**Withdrawing agreed leave is the one pair of rows where the ask is narrower than
the act it undoes.** FR 47. A request nobody has approved is taken back by the
person or by HR on their behalf; one every desk has agreed to is asked for by the
person alone and answered by HR alone, because HR asking and then agreeing would
put one desk on both sides of a conversation that exists to have two. The line
manager is on neither row: the days have already left the balance, and putting
them back is a correction rather than a decision at a desk.

**A draft is the one row the line manager and HR are both kept out of.** FR 19,
LMS 302. Every other read in the table above widens from the person outwards —
their manager, then a role that reads every record — because a request is a thing
that happened and the people around it have standing towards it. A draft is not:
it is leave nobody has asked for, so there is no request for a manager to be the
manager of and nothing for a reader to read. Refused silently, so the refusal does
not disclose that a draft exists. HR may still submit leave on somebody's behalf,
which is FR 18, and may not draft on their behalf — there is no "finish it later"
in that act, and a draft HR left behind would be planning the person never did.

**An attachment is the one row where reading is wider than the request it hangs
on.** FR 12, LMS 310. Every other read here widens outwards from the person by
relationship or by role, and neither reaches FR 04's seat: the Chief Executive is
nobody's line manager and holds no role, so `read` refuses them the unpaid leave
§4.3.1 sends them to decide. That was tolerable while the desk only needed the
dates, which the approver queue supplies by being the desk. It is not tolerable
for the certificate the decision turns on, so `readAttachment` is `read` widened
by `isAt` — the same question the queue asks, asked about one request. Writing
stays exactly as wide as asking for the leave: an approver who wants a document
asks the person for it rather than supplying one on their behalf.

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

**The session is a signed cookie and nothing else.** Since LMS 401. It carries an
employee id, when it was issued, and an HMAC over both — and **no roles**, because
`signIn` hands back an actor that is the *answer* to "who is this" and never the
evidence for it. `http/identify.ts` derives its own on every request; an actor
never arrives over the wire.

There is no session table, so there is nothing to revoke, and signing out clears
the browser's copy rather than invalidating it. That is bounded two ways: the
cookie lives eight hours, and every request re-reads the employee record and the
login, so somebody terminated at nine o'clock is refused at one minute past. What
survives is a stolen cookie for the rest of its life. The answer to that is a
session table, and it is a story with a migration in it.

**Roles are read fresh on every request, and are a snapshot only inside one.**
This was the other way round until LMS 401, which said the price — "a round trip
per decision" — was worth paying once at the route rather than at every policy
check. Revoke `HR_ADMIN` while somebody is working and it is gone on their next
request.

**No CSRF token.** `SameSite=Strict` stands in for one, which is why it is Strict
rather than the usual Lax. The day this API is called from another origin it needs
a token in the same change.

**No rate limit.** Four hundred refusals in a minute are four hundred lines and no
delay. The counter belongs in front of the sign in routes in `http/app.ts`, with
the one unlimited password guesses need. It needs doing, and it is not done.

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

**`AUDITED_ENTITIES` is the list, and what is off it is off it on purpose.** An
integration test reads the tables carrying the trigger straight out of the
catalogue and asserts they are exactly that list, so neither can drift. Three
tables are deliberately absent for two different reasons. `leave_request_decision`
and `leave_request_withdrawal` are append only, so each row is already its own
history and an audit of it would be a second copy. `leave_request_draft` is the
opposite case: a draft is rewritten as often as somebody changes their mind and
thrown away when they do, so auditing it would keep the contents of everything
anybody discarded — which is precisely what a draft exists not to be. FR 19.

### The application supplies the one thing the database cannot know

Which person asked. Every audited write goes through `recording()` in
`server/src/db/recording.ts`, which opens a transaction, puts the writer's name on
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
fields in March. `changedFields()` in `server/src/features/audit/audit.ts` turns the pair
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
