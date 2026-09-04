-- Up Migration

-- Documentation that has to arrive with the request. FR 13, FR 32a, §8.6b. LMS 311.
--
-- LMS 310 gave a request somewhere to hang a certificate and nothing that insisted on one.
-- Two rules insist, and they are different thresholds: `documentation`/`documentation_after_days`
-- asks on the length of *this request*, and `exceedable_with_document` asks when it would take
-- the *yearly balance* past its allowance — sick leave's three days.
--
-- Both are answered at submission, which is before the request exists, so evidence has to be
-- able to exist before it too: `leave_request_id` becomes nullable and a file waits under
-- `held_for_employee_id` until the request it evidences is written beside it.

-- ------------------------------------------- what the request was allowed on, on the request

/* Copied onto the row for the reason `counting_basis` is: the balance it was judged against
   has moved by the time anybody reads it, and HR may reword the type's rule tomorrow. What
   this says is what was true when the days were held. */

ALTER TABLE leave_request
    ADD COLUMN evidence_required BOOLEAN NOT NULL DEFAULT FALSE;

/* Body otherwise unchanged from back-dated-requests. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id        IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id      IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id      IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date         IS DISTINCT FROM OLD.start_date
    OR NEW.end_date           IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis     IS DISTINCT FROM OLD.counting_basis
    OR NEW.days               IS DISTINCT FROM OLD.days
    OR NEW.calendar_days      IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at       IS DISTINCT FROM OLD.submitted_at
    OR NEW.late_entry_reason  IS DISTINCT FROM OLD.late_entry_reason
    OR NEW.evidence_required  IS DISTINCT FROM OLD.evidence_required
    THEN
        RAISE EXCEPTION
            'Leave request % was priced when it was submitted and cannot be repriced.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_says_what_it_said',
                  HINT = 'The days are already held in the ledger against these '
                         'figures. Changing the dates is a new request; changing what '
                         'the old one cost is a compensating ADJUSTMENT with a reason '
                         'on it. FR 11, FR 27.';
    END IF;

    RETURN NEW;
END
$$;

-- --------------------------------------------- a file that is waiting for its request

/* `held_for_employee_id` is whose evidence it is, which a row with no request cannot say
   any other way. Set on every row including the ones already attached, so there is one
   answer to that question rather than two paths to it. */

ALTER TABLE leave_request_attachment
    ADD COLUMN held_for_employee_id BIGINT REFERENCES employee(id);

UPDATE leave_request_attachment AS a
    SET held_for_employee_id = r.employee_id
    FROM leave_request AS r
    WHERE r.id = a.leave_request_id;

ALTER TABLE leave_request_attachment
    ALTER COLUMN held_for_employee_id SET NOT NULL;

ALTER TABLE leave_request_attachment
    ALTER COLUMN leave_request_id DROP NOT NULL;

/* Five seats on a request, and five in the pile waiting to be put on one. Partial, because
   NULLs are distinct in a unique index — without the second one a person could stack up
   however many files they liked before ever asking for leave. */

DROP INDEX leave_request_attachment_five_per_request;

CREATE UNIQUE INDEX leave_request_attachment_five_per_request
    ON leave_request_attachment (leave_request_id, slot)
    WHERE leave_request_id IS NOT NULL;

CREATE UNIQUE INDEX leave_request_attachment_five_waiting_per_person
    ON leave_request_attachment (held_for_employee_id, slot)
    WHERE leave_request_id IS NULL;

CREATE INDEX leave_request_attachment_waiting_for
    ON leave_request_attachment (held_for_employee_id, id)
    WHERE leave_request_id IS NULL;

/* A file goes onto a request once and never moves again, and `slot` moves with it: the seat
   it held in the pile is not the seat it takes on the request. Everything else is as frozen
   as it was. Body otherwise unchanged from attachments-on-a-request. */
CREATE OR REPLACE FUNCTION refuse_rewriting_an_attachment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    being_put_on_a_request BOOLEAN :=
        OLD.leave_request_id IS NULL AND NEW.leave_request_id IS NOT NULL;
BEGIN
    IF NEW.filename            IS DISTINCT FROM OLD.filename
    OR NEW.content_type        IS DISTINCT FROM OLD.content_type
    OR NEW.size_bytes          IS DISTINCT FROM OLD.size_bytes
    OR NEW.checksum_sha256     IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.storage_key         IS DISTINCT FROM OLD.storage_key
    OR NEW.held_for_employee_id IS DISTINCT FROM OLD.held_for_employee_id
    OR NEW.uploaded_by         IS DISTINCT FROM OLD.uploaded_by
    OR NEW.uploaded_at         IS DISTINCT FROM OLD.uploaded_at
    OR (NOT being_put_on_a_request
        AND (NEW.leave_request_id IS DISTINCT FROM OLD.leave_request_id
             OR NEW.slot          IS DISTINCT FROM OLD.slot))
    THEN
        RAISE EXCEPTION
            'Attachment % is the file that was uploaded and cannot be made into another.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_is_the_file_it_was',
                  HINT = 'Remove it and attach the right file. FR 12.';
    END IF;

    IF OLD.scan_status <> 'PENDING' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
        RAISE EXCEPTION
            'Attachment % was already scanned and called %.', OLD.id, OLD.scan_status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_is_scanned_once',
                  HINT = 'A verdict is given once. NFR SEC 07.';
    END IF;

    RETURN NEW;
END
$$;

/* The two ids have to agree. `leave_request_draft_stays_with_whose_it_is` said the same
   thing about a draft: evidence that changed hands would put somebody's medical certificate
   on another person's request with no policy asked. */

CREATE FUNCTION evidence_stays_with_whose_it_is() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.leave_request_id IS NOT NULL
    AND NEW.held_for_employee_id IS DISTINCT FROM (
        SELECT employee_id FROM leave_request WHERE id = NEW.leave_request_id)
    THEN
        RAISE EXCEPTION
            'Attachment % is held for one person and the request it names is another’s.',
            NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_stays_with_whose_it_is',
                  HINT = 'Evidence goes on the request it evidences. FR 12, NFR SEC 07.';
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_attachment_stays_with_whose_it_is
    BEFORE INSERT OR UPDATE ON leave_request_attachment
    FOR EACH ROW
    EXECUTE FUNCTION evidence_stays_with_whose_it_is();

-- ------------------------------------ and a request that needed evidence has to have it

/* The rule the story is, held where no writer can get around it. FR 13, FR 32a, NFR SEC 07.
   `CLEAN` and nothing else, which is `attachmentSatisfiesADocumentationRule` said in SQL:
   a file nothing has looked at is not evidence of anything.

   Deferred, because the request row is written before the files are put on it and both
   happen in one transaction — the question is only answerable at the end of it. */

CREATE FUNCTION refuse_a_request_that_needed_evidence_and_has_none() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.evidence_required
    AND NOT EXISTS (
        SELECT 1 FROM leave_request_attachment
        WHERE leave_request_id = NEW.id AND scan_status = 'CLEAN')
    THEN
        RAISE EXCEPTION
            'Leave request % needs supporting documentation and has none that has been '
            'scanned and found clean.', NEW.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_that_needed_evidence_has_it',
                  HINT = 'Attach the certificate and ask again. FR 13, FR 32a.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_that_needed_evidence_has_it
    AFTER INSERT OR UPDATE ON leave_request
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_request_that_needed_evidence_and_has_none();

/* The same rule from the other side. A file may still be taken back off a request that is
   being decided — FR 12 — but not the one holding it up. */

CREATE FUNCTION refuse_removing_the_last_of_the_evidence() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.leave_request_id IS NOT NULL
    AND EXISTS (
        SELECT 1 FROM leave_request
        WHERE id = OLD.leave_request_id AND evidence_required)
    AND NOT EXISTS (
        SELECT 1 FROM leave_request_attachment
        WHERE leave_request_id = OLD.leave_request_id AND scan_status = 'CLEAN')
    THEN
        RAISE EXCEPTION
            'Leave request % was allowed through because that file was on it.',
            OLD.leave_request_id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_is_what_it_was_allowed_on',
                  HINT = 'Attach the replacement first, then remove this one. FR 13.';
    END IF;

    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER leave_request_attachment_is_what_it_was_allowed_on
    AFTER DELETE ON leave_request_attachment
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION refuse_removing_the_last_of_the_evidence();

-- Down Migration

DROP TRIGGER IF EXISTS leave_request_attachment_is_what_it_was_allowed_on
    ON leave_request_attachment;
DROP TRIGGER IF EXISTS leave_request_that_needed_evidence_has_it ON leave_request;
DROP TRIGGER IF EXISTS leave_request_attachment_stays_with_whose_it_is
    ON leave_request_attachment;

DROP FUNCTION IF EXISTS refuse_removing_the_last_of_the_evidence();
DROP FUNCTION IF EXISTS refuse_a_request_that_needed_evidence_and_has_none();
DROP FUNCTION IF EXISTS evidence_stays_with_whose_it_is();

/* Back to the body attachments-on-a-request left. */
CREATE OR REPLACE FUNCTION refuse_rewriting_an_attachment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.leave_request_id IS DISTINCT FROM OLD.leave_request_id
    OR NEW.slot             IS DISTINCT FROM OLD.slot
    OR NEW.filename         IS DISTINCT FROM OLD.filename
    OR NEW.content_type     IS DISTINCT FROM OLD.content_type
    OR NEW.size_bytes       IS DISTINCT FROM OLD.size_bytes
    OR NEW.checksum_sha256  IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.storage_key      IS DISTINCT FROM OLD.storage_key
    OR NEW.uploaded_by      IS DISTINCT FROM OLD.uploaded_by
    OR NEW.uploaded_at      IS DISTINCT FROM OLD.uploaded_at
    THEN
        RAISE EXCEPTION
            'Attachment % is the file that was uploaded and cannot be made into another.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_is_the_file_it_was',
                  HINT = 'Remove it and attach the right file. FR 12.';
    END IF;

    IF OLD.scan_status <> 'PENDING' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
        RAISE EXCEPTION
            'Attachment % was already scanned and called %.', OLD.id, OLD.scan_status
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_is_scanned_once',
                  HINT = 'A verdict is given once. NFR SEC 07.';
    END IF;

    RETURN NEW;
END
$$;

/* A file waiting for a request has nowhere to go in the old shape. */
DELETE FROM leave_request_attachment WHERE leave_request_id IS NULL;

DROP INDEX IF EXISTS leave_request_attachment_waiting_for;
DROP INDEX IF EXISTS leave_request_attachment_five_waiting_per_person;
DROP INDEX IF EXISTS leave_request_attachment_five_per_request;

CREATE UNIQUE INDEX leave_request_attachment_five_per_request
    ON leave_request_attachment (leave_request_id, slot);

ALTER TABLE leave_request_attachment
    ALTER COLUMN leave_request_id SET NOT NULL;

ALTER TABLE leave_request_attachment
    DROP COLUMN held_for_employee_id;

/* Back to the body back-dated-requests left. */
CREATE OR REPLACE FUNCTION refuse_rewriting_what_a_request_cost() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.employee_id       IS DISTINCT FROM OLD.employee_id
    OR NEW.leave_type_id     IS DISTINCT FROM OLD.leave_type_id
    OR NEW.leave_year_id     IS DISTINCT FROM OLD.leave_year_id
    OR NEW.start_date        IS DISTINCT FROM OLD.start_date
    OR NEW.end_date          IS DISTINCT FROM OLD.end_date
    OR NEW.counting_basis    IS DISTINCT FROM OLD.counting_basis
    OR NEW.days              IS DISTINCT FROM OLD.days
    OR NEW.calendar_days     IS DISTINCT FROM OLD.calendar_days
    OR NEW.submitted_at      IS DISTINCT FROM OLD.submitted_at
    OR NEW.late_entry_reason IS DISTINCT FROM OLD.late_entry_reason
    THEN
        RAISE EXCEPTION
            'Leave request % was priced when it was submitted and cannot be repriced.',
            OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_says_what_it_said',
                  HINT = 'The days are already held in the ledger against these '
                         'figures. Changing the dates is a new request; changing what '
                         'the old one cost is a compensating ADJUSTMENT with a reason '
                         'on it. FR 11, FR 27.';
    END IF;

    RETURN NEW;
END
$$;

ALTER TABLE leave_request
    DROP COLUMN evidence_required;
