-- Up Migration

-- Evidence attached to a request. FR 12, NFR SEC 07. LMS 310.
--
-- Bytes live behind `Storage`; `storage_key` is the handle it issued. NFR SEC 04.
-- `content_type` is sniffed server side, never read off the extension.
-- Five per request is a slot rather than a count, so a race cannot make it six.
-- `PENDING` is a file the scanner could not be reached for: kept, not downloadable,
-- and it satisfies no documentation rule.

CREATE TABLE leave_request_attachment (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    leave_request_id BIGINT NOT NULL REFERENCES leave_request(id),

    /* Which of the five seats on this request. Freed when a file is removed. */
    slot SMALLINT NOT NULL,

    /* A label for a screen. Never a path, and never read to decide what the file is. */
    filename TEXT NOT NULL,

    /* What the bytes say they are. NFR SEC 07. */
    content_type TEXT NOT NULL,

    size_bytes INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,

    /* PENDING | CLEAN | INFECTED. NFR SEC 07. */
    scan_status VARCHAR(10) NOT NULL,
    scan_signature TEXT,
    scanned_by TEXT,
    scanned_at TIMESTAMPTZ,

    /* Stamped by the trigger below, never supplied by the writer. */
    uploaded_by TEXT NOT NULL,
    uploaded_by_employee_id BIGINT REFERENCES employee(id),
    uploaded_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT leave_request_attachment_slot_is_one_of_five CHECK (
        slot BETWEEN 1 AND 5),

    /* Read back out of `pg_constraint` by the suite, against `ACCEPTED_CONTENT_TYPES`. */
    CONSTRAINT leave_request_attachment_content_type_accepted CHECK (
        content_type IN (
            'application/pdf',
            'image/jpeg',
            'image/png',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),

    /* MAX_UPLOAD_MB, written out so it reads as the same 10 MB. */
    CONSTRAINT leave_request_attachment_size_within_the_cap CHECK (
        size_bytes > 0 AND size_bytes <= 10 * 1024 * 1024),

    CONSTRAINT leave_request_attachment_checksum_is_a_sha256 CHECK (
        checksum_sha256 ~ '^[0-9a-f]{64}$'),

    /* The shape `KEY_PATTERN` holds in storage/storage.ts. */
    CONSTRAINT leave_request_attachment_storage_key_is_a_key CHECK (
        storage_key ~ '^[0-9a-f]{64}$'),

    CONSTRAINT leave_request_attachment_filename_is_a_name CHECK (
        btrim(filename) <> ''
        AND length(filename) <= 255
        AND filename !~ '[/\\]'
        AND filename NOT IN ('.', '..')),

    CONSTRAINT leave_request_attachment_scan_status_known CHECK (
        scan_status IN ('PENDING', 'CLEAN', 'INFECTED')),

    /* An equivalence, so "has this been scanned" has two answers. */
    CONSTRAINT leave_request_attachment_verdict_is_stamped CHECK (
        (scan_status = 'PENDING') = (scanned_at IS NULL)
        AND (scan_status = 'PENDING') = (scanned_by IS NULL)),

    CONSTRAINT leave_request_attachment_signature_names_an_infection CHECK (
        scan_signature IS NULL OR scan_status = 'INFECTED')
);

/* FR 12. The sixth file has nowhere to sit, whoever got there first. */
CREATE UNIQUE INDEX leave_request_attachment_five_per_request
    ON leave_request_attachment (leave_request_id, slot);

CREATE INDEX leave_request_attachment_by_request
    ON leave_request_attachment (leave_request_id, id);

-- ------------------------------------------------------- who attached it, and when

/* The three lines `stamp_the_writer_on_a_withdrawal()` writes, differently named. */

CREATE FUNCTION stamp_the_uploader_on_an_attachment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.uploaded_at := now();

    NEW.uploaded_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.uploaded_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER leave_request_attachment_records_its_uploader
    BEFORE INSERT ON leave_request_attachment
    FOR EACH ROW
    EXECUTE FUNCTION stamp_the_uploader_on_an_attachment();

-- ------------------------------------------------ and the file itself never changes

/* Only the verdict moves, and only out of PENDING. NFR SEC 07. */

CREATE FUNCTION refuse_rewriting_an_attachment() RETURNS trigger
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

CREATE TRIGGER leave_request_attachment_is_the_file_it_was
    BEFORE UPDATE ON leave_request_attachment
    FOR EACH ROW
    EXECUTE FUNCTION refuse_rewriting_an_attachment();

/* No audit trigger, and `AUDITED_ENTITIES` must not gain this table: the row is already
   frozen, and jsonb snapshots would copy every certificate's filename. NFR AUD 01. */

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT come from the default privilege; restated for legibility. UPDATE is
   the verdict alone, held there by the trigger. DELETE takes a wrong file back off. */

GRANT SELECT, INSERT, UPDATE, DELETE ON leave_request_attachment TO lms_app;

-- Down Migration

-- The rows go and the bytes do not: storage is not this migration's to empty. Whatever is
-- left is unreferenced and is NFR SEC 06's to sweep.

DROP TRIGGER IF EXISTS leave_request_attachment_is_the_file_it_was ON leave_request_attachment;
DROP TRIGGER IF EXISTS leave_request_attachment_records_its_uploader ON leave_request_attachment;

DROP INDEX IF EXISTS leave_request_attachment_by_request;
DROP INDEX IF EXISTS leave_request_attachment_five_per_request;

DROP TABLE IF EXISTS leave_request_attachment;

DROP FUNCTION IF EXISTS refuse_rewriting_an_attachment();
DROP FUNCTION IF EXISTS stamp_the_uploader_on_an_attachment();
