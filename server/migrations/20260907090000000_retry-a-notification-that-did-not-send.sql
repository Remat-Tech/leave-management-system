-- Up Migration

-- A failed send is retried with backoff rather than dropped. FR 59, §7.1., LMS 331.
--
-- No new table. The notice row is the outbox: it already records what was said and what
-- became of the email, and what it lacked was when to try again.
--
-- The notification migration named this as the missing piece — "FR 59's delivery guarantee,
-- if it is ever wanted, is an outbox written inside the transaction and drained by a job".
-- The transaction half stays as it was, and stays for the same reason: a send inside the
-- approving transaction is an email that goes out and then gets rolled back.

-- ---------------------------------------------------- when to try again, and how often

ALTER TABLE notification
    /* Sends made, delivered or not. Zero until the first is tried. */
    ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0,
    /* When the next send is due. Null means none is: delivered, given up, or not yet tried. */
    ADD COLUMN email_next_attempt_at TIMESTAMPTZ,
    /* When the last permitted attempt failed. */
    ADD COLUMN email_gave_up_at TIMESTAMPTZ;

/* A notice can now fail twice and succeed on the third try, so the two columns stop being
   exclusive: `email_failure` becomes the last failure, and `emailed_at` still means delivered. */

ALTER TABLE notification
    DROP CONSTRAINT notification_email_went_or_did_not;

/* Rows written before this migration have no attempt count. One send was made either way, so
   they get one, and the ones that failed are made due now — a notice dropped by the build that
   could not retry is what this story exists to pick up. Before the constraints below, which
   would otherwise refuse every one of them. */

UPDATE notification
SET email_attempts = 1,
    email_next_attempt_at = CASE WHEN email_failure IS NOT NULL THEN now() END
WHERE emailed_at IS NOT NULL OR email_failure IS NOT NULL;

ALTER TABLE notification
    ADD CONSTRAINT notification_email_attempts_not_negative CHECK (email_attempts >= 0),

    /* Nothing is recorded about a send nobody tried. */
    ADD CONSTRAINT notification_email_outcome_needs_an_attempt CHECK (
        email_attempts > 0
        OR (emailed_at IS NULL AND email_failure IS NULL
            AND email_next_attempt_at IS NULL AND email_gave_up_at IS NULL)),

    /* Delivered is the end of it. */
    ADD CONSTRAINT notification_delivered_is_the_end CHECK (
        emailed_at IS NULL OR (email_next_attempt_at IS NULL AND email_gave_up_at IS NULL)),

    /* And so is giving up. */
    ADD CONSTRAINT notification_giving_up_is_the_end CHECK (
        email_gave_up_at IS NULL OR email_next_attempt_at IS NULL),

    /* A retry due, or an abandonment, always says why. */
    ADD CONSTRAINT notification_a_failure_says_why CHECK (
        (email_next_attempt_at IS NULL AND email_gave_up_at IS NULL)
        OR email_failure IS NOT NULL);

/* The queue the job drains. Partial, because a due notice is a rare row. */

CREATE INDEX notification_due_for_another_try
    ON notification (email_next_attempt_at)
    WHERE email_next_attempt_at IS NOT NULL;

-- --------------------------------------- what was said is still never said differently

/* The wording rule is unchanged. The delivery rule changes in one place: `email_failure` may
   be rewritten while the send is still being retried, because each attempt fails its own way.

   What replaces "recorded once" is three narrower rules — a message is delivered once, a
   finished delivery stays finished, and an attempt is never unmade. */

CREATE OR REPLACE FUNCTION refuse_rewriting_a_notice() RETURNS trigger
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

    IF OLD.emailed_at IS NOT NULL AND NEW.emailed_at IS DISTINCT FROM OLD.emailed_at THEN
        RAISE EXCEPTION
            'Notice % has already been delivered.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'notification_email_is_delivered_once',
                  HINT = 'A message is sent once. Sending it again is a new notice, so '
                         'that what somebody received and when stays answerable. FR 59.';
    END IF;

    IF (OLD.emailed_at IS NOT NULL OR OLD.email_gave_up_at IS NOT NULL)
       AND (NEW.email_attempts IS DISTINCT FROM OLD.email_attempts
            OR NEW.email_failure IS DISTINCT FROM OLD.email_failure
            OR NEW.email_next_attempt_at IS DISTINCT FROM OLD.email_next_attempt_at
            OR NEW.email_gave_up_at IS DISTINCT FROM OLD.email_gave_up_at) THEN
        RAISE EXCEPTION
            'Notice % has finished being delivered, one way or the other.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'notification_delivery_is_finished_once',
                  HINT = 'It was delivered, or it was given up on. Either way there is no '
                         'further attempt to record. FR 59, LMS 331.';
    END IF;

    IF NEW.email_attempts < OLD.email_attempts THEN
        RAISE EXCEPTION
            'Notice % has had % sends, and that count is never wound back.',
            OLD.id, OLD.email_attempts
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'notification_email_attempts_only_rise',
                  HINT = 'How many sends have been made is what the backoff is measured '
                         'from. LMS 331.';
    END IF;

    RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- privileges

/* Restated whole rather than added to, so the grant reads as the list it is. The three new
   columns are the retry's. No DELETE, as before. */

GRANT UPDATE (read_at, emailed_at, email_failure, email_attempts, email_next_attempt_at,
              email_gave_up_at) ON notification TO lms_app;


-- Down Migration

/* The retry columns go and the exclusive pair comes back. A notice that failed and was
   redelivered would break that constraint, so the failure is cleared off anything that did
   eventually arrive — the delivery is the fact worth keeping.

   The rule against rewriting a notice comes off for that and goes straight back, which is the
   deliberate act with a written reason the notification migration asks for. Grants on the
   dropped columns go with the columns. */

DROP TRIGGER IF EXISTS notification_is_never_reworded ON notification;

DROP INDEX IF EXISTS notification_due_for_another_try;

ALTER TABLE notification
    DROP CONSTRAINT IF EXISTS notification_a_failure_says_why,
    DROP CONSTRAINT IF EXISTS notification_giving_up_is_the_end,
    DROP CONSTRAINT IF EXISTS notification_delivered_is_the_end,
    DROP CONSTRAINT IF EXISTS notification_email_outcome_needs_an_attempt,
    DROP CONSTRAINT IF EXISTS notification_email_attempts_not_negative;

ALTER TABLE notification
    DROP COLUMN IF EXISTS email_gave_up_at,
    DROP COLUMN IF EXISTS email_next_attempt_at,
    DROP COLUMN IF EXISTS email_attempts;

UPDATE notification SET email_failure = NULL WHERE emailed_at IS NOT NULL;

ALTER TABLE notification
    ADD CONSTRAINT notification_email_went_or_did_not CHECK (
        emailed_at IS NULL OR email_failure IS NULL);

CREATE OR REPLACE FUNCTION refuse_rewriting_a_notice() RETURNS trigger
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
