-- Up Migration

-- An approver is reminded every day until they decide. FR 50, FR 60, LMS 330.
--
-- No new table. A reminder is a notice like any other, so the daily one is an event on
-- `notification`, and "has this person already been reminded about this request today" is a
-- question that table answers. A reminder moves no day and decides nothing.

-- ------------------------------------------------------ one thing somebody was told

/* FR 59's list gains the reminder, written to whoever the request is waiting on. FR 50. */

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED', 'STILL_WAITING'));

/* What the job reads each morning: the reminders sent since a given instant, so a second
   run in one day tells nobody twice. Partial, because reminders are a small part of the
   table and this is the only query that asks for them across everybody. */

CREATE INDEX notification_reminders_sent
    ON notification (created_at DESC, employee_id, leave_request_id)
    WHERE event = 'STILL_WAITING';


-- Down Migration

-- The reminders go, and nothing else moves: a reminder held no day and decided nothing, so
-- every request keeps the status and the desk it had. What is lost is the record of who was
-- chased about what.

DROP INDEX IF EXISTS notification_reminders_sent;

ALTER TABLE notification
    DROP CONSTRAINT notification_event_known;

/* The rule against removing a notice comes off for this and goes straight back, which is
   the deliberate act with a written reason that the notification migration asks for. */

DROP TRIGGER IF EXISTS notification_is_never_deleted ON notification;

DELETE FROM notification WHERE event = 'STILL_WAITING';

CREATE TRIGGER notification_is_never_deleted
    BEFORE DELETE ON notification
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'A notice is never removed. What somebody was told about their leave, and when, is '
        'half of every dispute about whether they knew — and the other half is the request, '
        'which is never deleted either. Mark it read. FR 59.'
    );

ALTER TABLE notification
    ADD CONSTRAINT notification_event_known CHECK (
        event IN ('SUBMITTED', 'STAGE_APPROVED', 'STAGE_REFUSED', 'APPROVED', 'REFUSED',
                  'WITHDRAWN', 'CANCELLED', 'DECISION_OVERTURNED', 'UNROUTABLE',
                  'WITHDRAWAL_ASKED', 'WITHDRAWAL_GRANTED', 'LEAVE_AMENDED',
                  'WITHDRAWAL_REFUSED', 'REASSIGNED'));
