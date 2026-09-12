-- Up Migration

-- HR's wording for the emails the system sends. FR 61, LMS 512.
-- One row per email HR has reworded. No row is the original wording, which lives in code.

CREATE TABLE notification_template (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT notification_template_one_per_email UNIQUE (name),
    CONSTRAINT notification_template_subject_not_blank CHECK (btrim(subject) <> ''),
    CONSTRAINT notification_template_subject_is_one_line CHECK (position(E'\n' IN subject) = 0),
    CONSTRAINT notification_template_body_not_blank CHECK (btrim(body) <> '')
);

CREATE TRIGGER notification_template_set_updated_at
    BEFORE UPDATE ON notification_template
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

/* NFR AUD 01. Who reworded which email, and back again. */
CREATE TRIGGER notification_template_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON notification_template
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT come from the default privileges. DELETE puts the original back. */
GRANT UPDATE, DELETE ON notification_template TO lms_app;


-- Down Migration

DROP TABLE notification_template;
