-- Up Migration

-- Every session reads and writes in UTC, and reads dates as YYYY-MM-DD.
-- NFR DAT 03. LMS 114.
--
-- The story is an employee whose leave never appears to shift by a day. That is
-- two rules with nothing in common except how easily they are confused:
--
--   An instant is an instant. `created_at`, `occurred_at`, `last_login_at` and
--   `mfa_code_expires_at` are moments in time, they are TIMESTAMPTZ, and
--   PostgreSQL already stores every one of them as UTC whatever the session is
--   set to. That half was never in doubt and this migration does not change it.
--
--   A leave date is a day. `start_date` and `exit_date` are DATE, they have no
--   time and no timezone, and the day somebody left is the same day in Accra, in
--   London and on a laptop somebody has set to Tokyo.
--
-- So what is left to settle is not how values are *stored*. It is what the
-- session does to them on the way past, which is where the off by one day
-- actually comes from, and there are three places it does something:
--
--   **TimeZone decides how a TIMESTAMPTZ is rendered as text.** Same instant,
--   different characters. That would be cosmetic if nothing kept the text — but
--   the audit log does. record_in_audit_log() snapshots the row with to_jsonb(),
--   which renders every TIMESTAMPTZ using the session's zone, so the same
--   change made by a process in London and by a process in Accra is stored as
--   two different strings. changedFields() in server/src/domain/audit.ts
--   compares those strings. An audit entry that reports a change because the
--   seed ran on somebody's laptop is an audit entry nobody believes.
--
--   **TimeZone decides what today is.** current_date and now()::date are the
--   session's day, not the world's. Nothing reads them yet; Phase 2 and Phase 3
--   are full of "is this request in the past", and the first one written on a
--   host set to something else is wrong for a few hours a day, which is the
--   shape of bug that survives a test suite.
--
--   **DateStyle decides how a DATE is rendered as text.** This one is load
--   bearing today. server/src/db/index.ts registers a type parser that hands a
--   DATE back as the characters the server sent, precisely so that no Date is
--   ever built at UTC midnight and read back somewhere else — and every
--   comparison above it is a string comparison that assumes those characters are
--   YYYY-MM-DD. A host with DateStyle set to German or Postgres sends
--   01.09.2026, the parser passes it through untouched, and every date rule in
--   /domain quietly starts comparing the day of the month first. ISO, YMD is
--   what makes the assumption true rather than usually true.
--
-- Three layers set it, and it is worth knowing which covers what.
--
--   | | Covers | Does not cover |
--   |---|---|---|
--   | the pool, in server/src/db/index.ts | every connection the application opens, whatever the host is set to and whether or not this migration has run | anything that is not this application |
--   | ALTER ROLE lms_app, below | every connection by the application role, psql included | the owner connection |
--   | ALTER DATABASE, below | every connection to this database, owner included — migrations, the seed, somebody looking at a row on a Friday | a host that will not permit it, where it warns and the first two still hold |
--
-- Both settings are scoped to this database rather than to the cluster, as the
-- CONNECT grant in the restricted-application-role migration is, so that a
-- developer's other databases on the same local server are untouched and a
-- rollback takes the setting with it.

DO $$
BEGIN
    EXECUTE format(
        'ALTER ROLE lms_app IN DATABASE %I SET TimeZone = %L',
        current_database(), 'UTC');

    EXECUTE format(
        'ALTER ROLE lms_app IN DATABASE %I SET DateStyle = %L',
        current_database(), 'ISO, YMD');
END
$$;

/* The owner connection too, which is the half that matters for the audit log:
   the seed and a migration correcting data both write rows that a trigger
   snapshots, and neither of them goes anywhere near the pool.

   Permitted to fail, and only this one. ALTER DATABASE needs ownership of the
   database, which the migration role has on Neon and on an ordinary local
   install and might not have somewhere nobody has tried yet. A warning there is
   right where a failure would not be: the application's own connections are
   already covered twice over by the time this statement runs, so what is lost is
   the seed and psql rather than the running system, and refusing to migrate at
   all would be a worse answer to a smaller problem. */

DO $$
BEGIN
    EXECUTE format(
        'ALTER DATABASE %I SET TimeZone = %L',
        current_database(), 'UTC');

    EXECUTE format(
        'ALTER DATABASE %I SET DateStyle = %L',
        current_database(), 'ISO, YMD');
EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING
        'Could not set TimeZone and DateStyle on database %. The application is '
        'unaffected — it sets both per connection — but the seed, migrations and '
        'psql will use this host''s settings, and an audit snapshot written by '
        'one of them will render its timestamps in whatever zone the host is in. '
        'Set them by hand as the database owner. NFR DAT 03.',
        current_database();
END
$$;

/* What holds the rule for tables that do not exist yet.

   No trigger and no constraint, because there is nothing here to attach one to:
   this is a rule about DDL, and the only thing in PostgreSQL that sees DDL is an
   event trigger, which needs a superuser and is therefore not available on a
   managed host. It is held by server/tests/integration/time.test.ts instead,
   which reads information_schema and refuses any column typed `timestamp
   without time zone` and any column named `*_date` that is not a `date`.

   That covers the tables of Phase 2 and Phase 3 — the ledger, the request, the
   balance — on the day they are written rather than the day somebody notices,
   which is what this story is actually for. A leave request whose start is a
   timestamp is the off by one day bug already shipped. */

-- Down Migration

DO $$
BEGIN
    EXECUTE format(
        'ALTER ROLE lms_app IN DATABASE %I RESET TimeZone', current_database());
    EXECUTE format(
        'ALTER ROLE lms_app IN DATABASE %I RESET DateStyle', current_database());
END
$$;

DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I RESET TimeZone', current_database());
    EXECUTE format('ALTER DATABASE %I RESET DateStyle', current_database());
EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'Could not reset TimeZone and DateStyle on database %.', current_database();
END
$$;
