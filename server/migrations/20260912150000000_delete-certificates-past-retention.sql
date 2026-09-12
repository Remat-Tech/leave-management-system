-- Up Migration

-- Certificates deleted once the retention window has passed. NFR SEC 06, LMS 514.
--
-- The bytes go and the row stays, so history still says a file was there.

ALTER TABLE leave_request_attachment
    ADD COLUMN file_deleted_at TIMESTAMPTZ;

/* 24 months unless HR chooses otherwise. NULL was never acted on, so it becomes the default. */
ALTER TABLE organisation_setting
    ALTER COLUMN attachment_retention_months SET DEFAULT 24;

UPDATE organisation_setting
   SET attachment_retention_months = 24
 WHERE attachment_retention_months IS NULL;

/* The required-documentation body, plus: a deleted file stays deleted. */
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

    IF OLD.file_deleted_at IS NOT NULL
       AND NEW.file_deleted_at IS DISTINCT FROM OLD.file_deleted_at THEN
        RAISE EXCEPTION 'The file on attachment % was already deleted.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'leave_request_attachment_file_is_deleted_once',
                  HINT = 'A deleted file cannot come back. NFR SEC 06.';
    END IF;

    RETURN NEW;
END
$$;


-- Down Migration

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

ALTER TABLE organisation_setting
    ALTER COLUMN attachment_retention_months DROP DEFAULT;

ALTER TABLE leave_request_attachment
    DROP COLUMN file_deleted_at;
