-- Up Migration

-- Being told what happened to your leave, rather than refreshing a screen. FR 59, §7.1.
-- LMS 329.
--
-- Every story in Phase 3 so far has ended with the same sentence in its notes, in the
-- future tense. LMS 306: "Being *told* that a request went away — the approver who had it
-- in their queue — is FR 59's". LMS 315: "That somebody is *told* their leave was refused
-- is FR 45 and is a story of its own; what this one guarantees is that there is something
-- true to tell them." LMS 323: "Being *told* the request went away is FR 59, which owns
-- notification for every event in a request's life." This is that story, and this table is
-- the half of it a database can hold.
--
-- ## Why the in-app notice is a row and not a query
--
-- The tempting version of "in app" is a screen that reads `leave_request` and
-- `leave_request_decision` and renders a list. It would work, it would need no migration,
-- and it would be wrong in three ways that all have the same shape: **a notice is a thing
-- that was sent, and the records it was composed from go on changing.**
--
--   **It cannot be read.** "Unread" is a fact about a person and a message, and there is
--   nowhere to put it. A derived list is unread for ever or read for ever, and the bell
--   with a number on it — which is the whole of what the story asks for — cannot be drawn.
--
--   **It rewrites history.** A request that was approved at the manager's desk and later
--   refused by HR would render, today, as one refusal. The employee was told two things on
--   two days, and only one of them survives a derivation.
--
--   **It cannot say what was actually sent.** FR 59 asks for email as well, and "did the
--   email go" is not answerable from a leave request. `emailed_at` and `email_failure`
--   below are the answer to the only support question this feature generates.
--
-- So a notice is written down, once, at the moment it is decided — the same argument
-- `leave_request` makes for storing `days` rather than recounting, and `leave_request_
-- decision` makes for storing the comment rather than inferring one from a status. What
-- was recorded is what happened; the records describe what happens next.
--
-- ## Written after the transaction commits, never inside it
--
-- The story says so in as many words and the schema is arranged to make it easy rather
-- than to enforce it — there is no constraint that can see a transaction boundary. What
-- the schema does is decline to make it hard: **nothing here is deferred, nothing here is
-- checked against `leave_request` beyond the foreign key, and no trigger on `leave_request`
-- looks for a notice.**
--
-- That is a deliberate difference from `leave_request_holds_its_days`, `leave_request_
-- gives_its_days_back` and `leave_request_records_its_decision`, which are three deferred
-- constraint triggers built on exactly the opposite principle: the row and the movement are
-- one act and land together or neither does. A notice is not one act with the thing it
-- describes, and a constraint saying it was would be a constraint requiring the send to
-- happen inside the transaction — which is the thing FR 59 forbids.
--
-- The reason it is forbidden is worth writing down where the table is, because it will read
-- like caution and it is not. An email sent inside the transaction that approves leave is
-- an email that goes out and then gets rolled back: the person is told their leave is
-- agreed, the row says SUBMITTED, and nothing anywhere can reconcile the two. The second
-- reason is smaller and arrives sooner — `BalanceService` sends every movement through a
-- balance row held with `holdStill`, and an SMTP handshake inside that lock is every other
-- request for that balance waiting on a mail server.
--
-- The price is stated plainly rather than mitigated: a process that dies between the COMMIT
-- and the notice loses the notice. That is the right side to be wrong on. The leave record
-- is the truth and the screen shows it; a notice is how somebody finds out without looking.
-- Losing a courtesy is recoverable and telling somebody their leave was approved when it
-- was not is not. FR 59's delivery guarantee, if it is ever wanted, is an outbox written
-- inside the transaction and drained by a job — a table of its own, and a story of its own.
--
-- ## One row per person per thing that happened
--
-- There is deliberately **no unique index on (leave_request_id, event)**, and it is the same
-- decision the decision table made about (request, desk) for the same reason. A chain
-- reordered under a live request can ask the same desk twice — FR 31 lets an HR
-- Administrator do exactly that — so a request can legitimately collect two STAGE_APPROVED
-- notices. A constraint here would refuse the second and, because the notice is written
-- after the commit, would refuse it *after the approval had already happened*: leave
-- approved and the person not told, which is the failure this story exists to prevent.

-- ------------------------------------------------------ one thing somebody was told

CREATE TABLE notification (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* Who was told. The recipient rather than the subject, and for FR 59 those are the
       same person — the story is "as an employee, I want to be told when something happens
       to my request". The approver's queue is FR 60 and would put a different id here.

       ON DELETE is absent, which is the default and is right: `employee_never_deleted`
       refuses to remove an employee on any connection. */
    employee_id BIGINT NOT NULL REFERENCES employee(id),

    /* What it is about. NOT NULL, because everything FR 59 names is a thing that happened
       to a leave request and a notice about nothing is not a notice.

       It will have to become nullable the day something else notifies — a balance running
       low, an entitlement about to lapse — and that is a migration rather than a hole left
       open now. The same rule LMS 209 set for `leave_request_status_known`: a column that
       nothing can write is a promise the schema cannot keep. */
    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* Which of the things in FR 59's list this is. The list is closed by
       `notification_event_known` below and held again as NOTICE_EVENTS in
       /domain/notification.ts, and the integration suite reads this constraint back out of
       `pg_constraint` and asserts the two agree.

       Kept as its own column rather than inferred from the subject line, because a screen
       groups and filters by it and a subject is prose. */
    event VARCHAR(30) NOT NULL,

    /* What it said. Stored rather than composed on the way out, which is the whole
       argument at the top of this file: the request the words were composed from goes on
       moving, and a notice is a record of what somebody was actually told.

       Both are the email's, verbatim — one composition, two channels — so that the message
       in the bell and the message in the mailbox can never be two different accounts of the
       same event. /domain/notification.ts is where they are written. */
    subject TEXT NOT NULL,
    body TEXT NOT NULL,

    /* FR 59's in-app half, and the only column on this table a person moves.

       Null until they have seen it, which is what a bell with a number on it counts.
       Nullable rather than a boolean with a default, because "when" is strictly more than
       "whether" and costs the same eight bytes. */
    read_at TIMESTAMPTZ,

    /* FR 59's other half: whether the email went, and when.

       Null means it has not gone. That is either "not attempted yet" — the row is written
       first, so there is a moment where this is honestly null — or "it failed", which
       `email_failure` says. Both are stamped by the sender after the fact, which is why
       this table is one of the few with a column-level UPDATE grant below.

       Recorded at all because it is the answer to the only support question this feature
       generates. "I never got an email about my leave" is asked of HR, not of a log, and a
       row that says the message was composed at 09:14 and the mail server refused it at
       09:14 is the difference between a bug and a mailbox rule. */
    emailed_at TIMESTAMPTZ,

    /* Why it did not, where it did not. The transport's own words, kept rather than
       flattened to a flag — 'Mailbox unavailable' and 'connect ECONNREFUSED' are the same
       flag and two entirely different mornings. */
    email_failure TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* The closed list. Six values, and every one of them is reachable by something this
       system can already do — which is LMS 209's rule applied to an event list rather than
       to a status list.

       FR 59 names an override among the things somebody is told about, and there is
       deliberately no OVERRIDDEN here: nothing in this system overrides a decision yet.
       `REQUEST_ACTIONS` is WITHDRAW, REFUSE, CANCEL and APPROVE, and an HR override of an
       approval is FR 44's story with a transition and a movement of its own. A value in
       this CHECK that no code path can write is a promise the schema cannot keep, and the
       story that brings the override brings the notice with it — which is one line here and
       one branch in the composer.

       APPROVED and STAGE_APPROVED are two values rather than one because they are two
       different pieces of news, and telling them apart is the entire point of the story's
       "so that". "Your line manager approved it, HR still has to" and "your leave is
       agreed" are the sentences somebody with an aeroplane ticket in the other tab is
       choosing between, and a single APPROVED that meant both would be the defect LMS 316
       was written against arriving by email. */
    CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'APPROVED', 'REFUSED', 'WITHDRAWN',
                  'CANCELLED')),

    /* A notice with nothing in it is a bell that rings and says nothing, which is worse
       than silence — the same pairing every NOT NULL in this schema makes with a not-blank
       check, because a subject of one space satisfies the first and defeats it. */
    CONSTRAINT notification_subject_not_blank CHECK (btrim(subject) <> ''),
    CONSTRAINT notification_body_not_blank CHECK (btrim(body) <> ''),

    /* An email went or it did not. Both columns set would be a row claiming both, and the
       reader would have to guess which half to believe. */
    CONSTRAINT notification_email_went_or_did_not CHECK (
        emailed_at IS NULL OR email_failure IS NULL),

    CONSTRAINT notification_email_failure_not_blank CHECK (
        email_failure IS NULL OR btrim(email_failure) <> '')
);

/* What the bell reads: this person's notices, newest first.

   By `id` rather than by `created_at`, the tie break the decision table and the ledger both
   make and for the same reason — `now()` is identical for everything written in one
   transaction, and a list that reorders itself between two reads is one nobody can check
   twice. Two notices in one transaction is not a thing that happens today and the index
   costs nothing to be right about. */
CREATE INDEX notification_for_employee
    ON notification (employee_id, id DESC);

/* And the count on it. Partial, because the unread ones are a small and shrinking part of
   the table and this is the query drawn on every page. */
CREATE INDEX notification_unread_for_employee
    ON notification (employee_id, id DESC)
    WHERE read_at IS NULL;

/* Everything one request has been told about, which is what a request's own page shows
   beside its decisions. */
CREATE INDEX notification_for_request
    ON notification (leave_request_id, id);

-- ------------------------------------------- what was said is never said differently

/* The same shape `refuse_rewriting_what_a_request_cost()` has, and for a stronger reason.

   A leave request freezes what it cost because an HR Administrator may change the
   configuration it was priced from. A notice freezes what it *said* because somebody has
   already read it. A subject edited afterwards is a record of a message nobody sent, and
   the person it was sent to has no way of knowing — which is exactly the argument
   `leave_request_decision_is_never_changed` makes about an approver's comment, applied to
   the sentence built out of it.

   `read_at` is the one column that moves, and it moves in both directions on purpose:
   marking something unread to come back to it is an ordinary thing to want, and a rule
   against it would be this file having an opinion about how somebody reads their post.

   `emailed_at` and `email_failure` move once, from null. They are stamped after the send
   rather than at the insert because the row is written first — see the note at the top on
   what is written when — and a second stamp would be a delivery recorded twice or a failure
   quietly replaced by a success. */

CREATE FUNCTION refuse_rewriting_a_notice() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.leave_request_id IS DISTINCT FROM OLD.leave_request_id
       OR NEW.event IS DISTINCT FROM OLD.event
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
            'Notice % is a record of what somebody was told, so it is not edited.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'notification_is_never_reworded',
                  HINT = 'Whoever this was sent to has already read it. If the news has '
                         'changed, what changed is the request — and the change writes its '
                         'own notice. FR 59.';
    END IF;

    IF (OLD.emailed_at IS NOT NULL AND NEW.emailed_at IS DISTINCT FROM OLD.emailed_at)
       OR (OLD.email_failure IS NOT NULL AND NEW.email_failure IS DISTINCT FROM OLD.email_failure)
    THEN
        RAISE EXCEPTION
            'Notice % has already recorded what became of its email.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'notification_email_outcome_is_recorded_once',
                  HINT = 'A message is sent once. Sending it again is a new notice, so '
                         'that what somebody received and when stays answerable. FR 59.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER notification_is_never_reworded
    BEFORE UPDATE ON notification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_rewriting_a_notice();

CREATE TRIGGER notification_is_never_deleted
    BEFORE DELETE ON notification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A notice is never removed. What somebody was told about their leave, and when, is '
        'half of every dispute about whether they knew — and the other half is the request, '
        'which is never deleted either. Mark it read. FR 59.'
    );

-- ------------------------------------------------------------- and it is not audited

/* There is deliberately no audit trigger, which is the third table in this schema to
   decline one and the first to decline it for this reason.

   `leave_ledger_entry` and `leave_request_decision` declined because a row that can never
   change is already its own history. This one can change, in exactly one column that a
   person moves: `read_at`. So the question is not whether there is history to keep but
   whether anybody should keep it, and the answer is no — an audit entry every time somebody
   glances at their notifications is how a log that matters becomes a log nobody reads, which
   is the argument `Guard.permits` already makes about not recording buttons that were never
   pressed.

   What a notice records is derived from records that *are* audited. `leave_request` has been
   audited since LMS 301 and answers who moved it and when; this says what the person was
   told about it. AUDITED_ENTITIES in /domain/audit.ts is the list that must not gain this
   table, and the integration suite reads the triggers back out of the catalogue and asserts
   the two agree. */

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the restricted-application-role
   migration. UPDATE is granted on three columns and no others.

   Column-level rather than table-level, which is the first time this schema has needed the
   distinction and is worth the extra clause. Every other GRANT UPDATE here is on a table
   whose editable columns are most of it; this table is a record of what was said, and the
   only things about it that legitimately move afterwards are whether it has been read and
   what became of its email. The trigger above holds the same rule against the owner
   connection, and the two are layers rather than duplicates: the grant stops the writer an
   attacker actually reaches, the trigger stops the honest mistake at a psql prompt.

   No DELETE, so `notification_is_never_deleted` is a backstop rather than the barrier. */

GRANT UPDATE (read_at, emailed_at, email_failure) ON notification TO lms_app;


-- Down Migration

/* The notices go with the table, and nothing has to be unpicked first: a notice moves no
   figure and holds no day, so a balance that reconciled before this is dropped reconciles
   after it and every request keeps the status it had. What is lost is the record of what
   people were told, which is the honest price of removing the table that holds it. */

DROP TRIGGER IF EXISTS notification_is_never_deleted ON notification;
DROP TRIGGER IF EXISTS notification_is_never_reworded ON notification;

DROP TABLE IF EXISTS notification;

DROP FUNCTION IF EXISTS refuse_rewriting_a_notice();
