-- Up Migration

-- The two org-wide policy settings the screen needs beside the Chief Executive.
-- FR 44, FR 48c, NFR SEC 06. LMS 505.
--
-- Columns rather than key/value, as identify-the-ceo-by-configuration argued: "the next
-- setting is a column and a migration".

ALTER TABLE organisation_setting
    ADD COLUMN overrides_are_allowed BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN attachment_retention_months INT;

/* FR 44. TRUE is what the system already did, so a migrated database decides leave today the
   way it decided it yesterday. FALSE makes a line manager's word final. */

/* NFR SEC 06. NULL is kept indefinitely, which is what the system does now. A window is a
   whole number of months; zero would mean "delete on upload". */
ALTER TABLE organisation_setting
    ADD CONSTRAINT organisation_setting_retention_is_a_period
    CHECK (attachment_retention_months IS NULL OR attachment_retention_months > 0);

-- ---------------------------------------------------------------- privileges

/* Already held from identify-the-ceo-by-configuration. Restated so this file says what the
   application may do to the row it just widened. */

GRANT SELECT, INSERT, UPDATE ON organisation_setting TO lms_app;


-- Down Migration

ALTER TABLE organisation_setting
    DROP CONSTRAINT organisation_setting_retention_is_a_period;

ALTER TABLE organisation_setting
    DROP COLUMN attachment_retention_months,
    DROP COLUMN overrides_are_allowed;
