# Backup and restore

LMS 604. NFR AVL 02: recovery point 24 hours, recovery time 4 hours.

---

## What runs

`.github/workflows/backup.yml`, daily at 01:00 UTC, or by hand from Actions → Backup → Run workflow.

1. `npm run backup` dumps production and writes a manifest from the same snapshot.
2. `npm run restore` loads the dump into a new database on a clean Postgres 17 container and verifies it.
3. Both files are encrypted with `BACKUP_PASSPHRASE` and kept as an artifact for 35 days.

**A failed run means no backup that day.** GitHub emails whoever last edited the schedule. Act on the same day.

### What verified means

Each check compares the restore with the manifest:

* every table's row count and content hash
* every trigger, and whether it is enabled
* every `lms_app` privilege: tables, functions, default privileges, `CONNECT`
* database and `lms_app` settings (`TimeZone`, `DateStyle`)
* how many balances disagree with the ledger

Any difference fails the restore and lists what differs.

### Secrets

Set under Settings → Secrets and variables → Actions.

| Secret | Value |
|---|---|
| `PRODUCTION_DATABASE_MIGRATION_URL` | Production owner connection. Direct endpoint, not `-pooler` |
| `BACKUP_PASSPHRASE` | Long and random. **Also keep it in the password manager.** Without it the backups cannot be read |

---

## Recovery point

| Source | Loses at most |
|---|---|
| Neon point in time restore, inside the plan's history window | minutes |
| Last green Backup run | 24 hours |

Use Neon first when the loss is inside its window. Use this procedure when it is not, or when Neon itself is unavailable.

---

## Restore procedure

Target: service back within 4 hours.

1. **Stop writes.** Stop the API. Set `JOBS_ENABLED=false`.
2. **Pick the backup.** Actions → Backup → latest green run.
   ```bash
   gh run download <run-id> -n lms-backup-<run-id> -D restore
   ```
3. **Decrypt** both files.
   ```bash
   cd restore
   for f in *.gpg; do gpg --decrypt --output "${f%.gpg}" "$f"; done
   ```
4. **Create the new server.** A new Neon project or branch on Postgres 17.
   * `BACKUP_RESTORE_URL` = its owner connection, direct endpoint
   * `PG_BIN` = a folder with `pg_restore` 17
5. **Restore and verify.**
   ```bash
   npm run restore -- restore/<name>.manifest.json lms
   ```
   Wait for `Restored and verified`. If you get a list of differences instead, stop and investigate.
6. **Give `lms_app` a password.** Connect to the new `lms` database:
   ```sql
   ALTER ROLE lms_app WITH PASSWORD '...';
   ```
7. **Confirm the schema is current.** Set `DATABASE_MIGRATION_URL` to the new owner URL, then run `npm run migrate up`. It should apply nothing.
8. **Point the application at it.** Set `DATABASE_URL` (`lms_app`, pooled) and `DATABASE_MIGRATION_URL`. Start the API, then set `JOBS_ENABLED=true`.
9. **Check.** Sign in as HR. Open a balance and the audit log. Run the balance reconciliation.
10. **Record it** in the log below. Include which backup was used, how long it took, and what was lost.

---

## Rehearsing locally

```bash
npm run backup                                  # DATABASE_MIGRATION_URL
npm run restore -- backups/<name>.manifest.json # BACKUP_RESTORE_URL
```

`integration/backup.test.ts` covers the same path on every CI run.

---

## Not covered

* **Attachment files.** Only the local storage driver exists. The rows restore; the file contents do not. When the production object storage driver is built, turn on bucket versioning or replication for it.
* **`.env` secrets.** Keep them in the password manager.

---

## Restore log

| Date | Backup | Into | Result | Time |
|---|---|---|---|---|
| 2026-09-14 | Seeded local database, `npm run backup` | New database, local Postgres 17 | Verified: 32 tables, 231 rows | 1s |
