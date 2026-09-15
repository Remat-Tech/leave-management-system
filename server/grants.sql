-- Runtime privileges for the application role, lms_app.
--
-- Run ONCE, by hand, against a new database, after migrations.
-- Not part of the deploy: ALTER DEFAULT PRIVILEGES below means tables
-- created by later migrations inherit these grants automatically.
--
-- Per table restrictions live in the migration that creates the table.
-- See the reclassification and recalculation migrations, which grant
-- only SELECT and INSERT because those tables are append only.
GRANT USAGE ON SCHEMA public TO lms_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO lms_app;

GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public TO lms_app;

-- NFR AUD 02: append only at the privilege level, not by convention.
REVOKE UPDATE, DELETE ON leave_ledger_entry FROM lms_app;
REVOKE UPDATE, DELETE ON audit_log          FROM lms_app;
REVOKE UPDATE, DELETE ON leave_request_reclassification FROM lms_app;
REVOKE UPDATE, DELETE ON leave_request_recalculation    FROM lms_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO lms_app;