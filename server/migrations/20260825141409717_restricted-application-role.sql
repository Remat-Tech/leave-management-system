-- Up Migration

-- The application connects as lms_app, never as the owner. NFR AUD 02.
--
-- An application running as the owner can UPDATE or DELETE its own audit trail,
-- which defeats the point of keeping one. The CREATE RULE statements planned for
-- leave_ledger_entry and audit_log stop the application doing it by accident;
-- these grants stop it doing so at all.
--
-- The role is created here without a password, so it cannot authenticate. The
-- password is set out of band and lives only in .env. See the README.
--
-- Role existence is cluster state rather than schema state, so this is the one
-- statement in the migration that is not strictly about this database. It is
-- guarded so that a fresh Neon branch can be brought up by migration alone.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_app') THEN
        CREATE ROLE lms_app LOGIN;
    END IF;
END
$$;

-- Connect and look, nothing more. No CREATE on the schema, so the application
-- cannot add tables of its own outside a migration.
DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO lms_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO lms_app;

-- The important half.
--
-- Every future table gives lms_app SELECT and INSERT and nothing else. A table
-- that genuinely needs UPDATE or DELETE must say so explicitly in the migration
-- that creates it.
--
-- Read that in the direction that matters: leave_ledger_entry and audit_log are
-- append only because nobody granted them anything more, not because somebody
-- remembered to take it away. Forgetting the explicit grant on an ordinary table
-- produces a loud permission error; the reverse arrangement, granting everything
-- and revoking on those two, fails silently and leaves the ledger writable.
--
-- FOR ROLE is resolved from current_user because migrations run as the owner,
-- which is neondb_owner on Neon and postgres on a local install.

DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'GRANT SELECT, INSERT ON TABLES TO lms_app',
        current_user);

    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'GRANT USAGE, SELECT ON SEQUENCES TO lms_app',
        current_user);
END
$$;

-- Down Migration

DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE SELECT, INSERT ON TABLES FROM lms_app',
        current_user);

    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
        'REVOKE USAGE, SELECT ON SEQUENCES FROM lms_app',
        current_user);
END
$$;

REVOKE USAGE ON SCHEMA public FROM lms_app;

DO $$
BEGIN
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM lms_app', current_database());
END
$$;

DROP ROLE IF EXISTS lms_app;
