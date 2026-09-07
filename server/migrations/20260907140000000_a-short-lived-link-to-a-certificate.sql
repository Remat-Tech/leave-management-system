-- Up Migration

-- A certificate is fetched through a link that expires, and every fetch is written down.
-- NFR SEC 04, NFR SEC 06. LMS 407.
--
-- LMS 310 served the bytes from a permanent address behind the session. That address is the
-- same one tomorrow, so it survives a copied URL, a bookmark, a shared screen and a browser
-- history — which for a medical certificate is the whole of the story's "not casually
-- available". Here the address is minted per fetch: bound to one person, good for two
-- minutes, and spent once.
--
-- The token itself is never stored. What is kept is its SHA-256, so a reader of this table —
-- a backup, a support query, a leaked dump — holds nothing that opens anything.

-- ------------------------------------------------------ the link, and what it is good for

CREATE TABLE attachment_download_link (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* CASCADE, and it is a rule rather than tidiness: a file taken back off a request takes
       every unspent address for it away in the same statement. FR 12 lets the uploader
       remove a file while it is being decided, and a link that outlived it would be a
       standing address for bytes nobody may reach any more. */
    attachment_id BIGINT NOT NULL REFERENCES leave_request_attachment(id) ON DELETE CASCADE,

    /* Who it was minted for. A link presented by anybody else is refused and recorded. */
    issued_to_employee_id BIGINT NOT NULL REFERENCES employee(id),

    /* SHA-256 of the token, never the token. */
    token_digest TEXT NOT NULL UNIQUE,

    /* Stamped by the trigger below off `now()`, never supplied. A caller that chose its own
       expiry would be a caller that could choose a fortnight, and a clock a minute out of
       step with the database would fail the constraint below on a link that was fine. */
    expires_at TIMESTAMPTZ NOT NULL,

    /* Spent. NULL until it is, and it only ever moves the once. */
    redeemed_at TIMESTAMPTZ,

    /* Stamped rather than supplied, as every table here that records an act. */
    issued_by TEXT NOT NULL,
    issued_by_employee_id BIGINT REFERENCES employee(id),
    issued_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT attachment_download_link_digest_is_a_sha256 CHECK (
        token_digest ~ '^[0-9a-f]{64}$'),

    /* DOWNLOAD_LINK_SECONDS, written out so it reads as the same two minutes. A link with
       an hour on it is the permanent address again, more slowly. The trigger is what makes
       it true; this is what keeps it true if somebody edits the trigger. */
    CONSTRAINT attachment_download_link_is_short_lived CHECK (
        expires_at > issued_at AND expires_at <= issued_at + INTERVAL '2 minutes'),

    CONSTRAINT attachment_download_link_spent_after_it_was_issued CHECK (
        redeemed_at IS NULL OR redeemed_at >= issued_at),

    CONSTRAINT attachment_download_link_issued_by_not_blank CHECK (btrim(issued_by) <> '')
);

/* The only way a link is ever looked up: by the digest of what somebody presented. */
CREATE INDEX attachment_download_link_by_attachment
    ON attachment_download_link (attachment_id, issued_at);

CREATE FUNCTION stamp_who_issued_a_download_link() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.issued_at := now();

    /* Two minutes: long enough to click, short enough that a copied address is spent. */
    NEW.expires_at := now() + INTERVAL '2 minutes';

    NEW.issued_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.issued_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    /* A link is never born spent. */
    NEW.redeemed_at := NULL;

    RETURN NEW;
END
$$;

CREATE TRIGGER attachment_download_link_records_who_issued_it
    BEFORE INSERT ON attachment_download_link
    FOR EACH ROW
    EXECUTE FUNCTION stamp_who_issued_a_download_link();

/* Spent once, and nothing else about it moves. Two fetches racing on one link is the case
   this is here for: the second finds `redeemed_at` already set and is refused in the
   database rather than by whichever query read the row first. */

CREATE FUNCTION spend_a_download_link_and_nothing_else() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.redeemed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Download link % has already been used.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'attachment_download_link_is_spent_once',
                  HINT = 'A link opens a file once. Ask for another. NFR SEC 04.';
    END IF;

    IF NEW.redeemed_at IS NULL
       OR NEW.attachment_id         IS DISTINCT FROM OLD.attachment_id
       OR NEW.issued_to_employee_id IS DISTINCT FROM OLD.issued_to_employee_id
       OR NEW.token_digest          IS DISTINCT FROM OLD.token_digest
       OR NEW.expires_at            IS DISTINCT FROM OLD.expires_at
       OR NEW.issued_by             IS DISTINCT FROM OLD.issued_by
       OR NEW.issued_by_employee_id IS DISTINCT FROM OLD.issued_by_employee_id
       OR NEW.issued_at             IS DISTINCT FROM OLD.issued_at
    THEN
        RAISE EXCEPTION 'Download link % may only be spent, not edited.', OLD.id
            USING ERRCODE = 'restrict_violation',
                  CONSTRAINT = 'attachment_download_link_is_never_rewritten',
                  HINT = 'A link is issued once and used once. Issue another. NFR SEC 04.';
    END IF;

    /* When it was spent is the database's, as when it was issued is. */
    NEW.redeemed_at := now();

    RETURN NEW;
END
$$;

CREATE TRIGGER attachment_download_link_is_only_ever_spent
    BEFORE UPDATE ON attachment_download_link
    FOR EACH ROW
    EXECUTE FUNCTION spend_a_download_link_and_nothing_else();

/* There is deliberately no `_is_never_deleted` trigger here, unlike every other table that
   records an act. A link is not the record — `attachment_access` is — and the CASCADE above
   has to be able to take one away when the file goes. `lms_app` holds no DELETE on it, so
   the only thing that ever removes one is that cascade. */

-- ------------------------------------------------------------- who opened what, and when

/* The story's fourth criterion, and it is a different table from `audit_log` on purpose.
   The audit log records what *changed* a record, and reading a certificate changes nothing;
   NFR AUD 01's triggers would have nothing to fire on. It is also the one read in this
   system worth keeping — "who saw my medical certificate" is the question the story exists
   to be able to answer, and `docs/authorisation-and-audit.md` says everywhere else that
   allowed reads are not logged. This is the exception, written down.

   No filename, no bytes, no storage key. Which file, who, when, and what happened. */

CREATE TABLE attachment_access (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    /* Neither of these is a foreign key, and that is the decision this table turns on. The
       file may be removed and its links go with it; the account of who read it may not.
       "Who saw my medical certificate" answered only for certificates still on the system
       is not an answer. So these are the ids of what it was about, kept whether or not
       either still exists. */
    attachment_id BIGINT NOT NULL,

    /* Every access goes through a link, so there is always one to name. */
    link_id BIGINT NOT NULL,

    /* ISSUED | DOWNLOADED | EXPIRED | ALREADY_USED | REFUSED. */
    outcome VARCHAR(12) NOT NULL,

    /* NFR USA 03. The sentence, on the outcomes that have something to explain. */
    because TEXT,

    accessed_by TEXT NOT NULL,
    accessed_by_employee_id BIGINT REFERENCES employee(id),
    accessed_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT attachment_access_outcome_known CHECK (
        outcome IN ('ISSUED', 'DOWNLOADED', 'EXPIRED', 'ALREADY_USED', 'REFUSED')),

    /* An equivalence, so "why was this refused" has one answer rather than two. */
    CONSTRAINT attachment_access_refusal_says_why CHECK (
        (outcome IN ('ISSUED', 'DOWNLOADED')) = (because IS NULL)),

    CONSTRAINT attachment_access_by_not_blank CHECK (btrim(accessed_by) <> '')
);

CREATE INDEX attachment_access_by_attachment
    ON attachment_access (attachment_id, accessed_at DESC, id DESC);

CREATE INDEX attachment_access_by_reader
    ON attachment_access (accessed_by_employee_id, accessed_at DESC);

CREATE FUNCTION stamp_who_reached_for_an_attachment() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.accessed_at := now();

    NEW.accessed_by := coalesce(
        nullif(btrim(current_setting('lms.audit.actor', true)), ''),
        'not named by the writer'
    );

    NEW.accessed_by_employee_id :=
        nullif(btrim(coalesce(current_setting('lms.audit.actor_employee_id', true), '')), '')::BIGINT;

    RETURN NEW;
END
$$;

CREATE TRIGGER attachment_access_records_who_reached_for_it
    BEFORE INSERT ON attachment_access
    FOR EACH ROW
    EXECUTE FUNCTION stamp_who_reached_for_an_attachment();

/* Append only, on every connection, exactly as `audit_log` is. A log of who read a medical
   certificate that the reader can edit afterwards is not a log. */

CREATE TRIGGER attachment_access_is_never_changed
    BEFORE UPDATE ON attachment_access
    FOR EACH ROW
    EXECUTE FUNCTION refuse_update(
        'Who opened a certificate is a fact, not a record to correct. NFR SEC 04.'
    );

CREATE TRIGGER attachment_access_is_never_deleted
    BEFORE DELETE ON attachment_access
    FOR EACH ROW
    EXECUTE FUNCTION refuse_delete(
        'Who opened a certificate is a fact, not a record to remove. NFR SEC 04.'
    );

/* Neither table joins `AUDITED_ENTITIES`. The link table is already frozen by its own
   trigger, and the access log is itself the record — auditing it would keep a second copy
   of every read. NFR AUD 01. */

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT come from the default privilege; restated for legibility. UPDATE on the
   link is spending it, held to `redeemed_at` by the trigger. Nothing has DELETE, and the
   access log has no UPDATE at all. */

GRANT SELECT, INSERT, UPDATE ON attachment_download_link TO lms_app;
GRANT SELECT, INSERT ON attachment_access TO lms_app;

-- Down Migration

-- The log goes with the links it names. What is lost is the account of who read what, which
-- is why this is a rollback and not a cleanup.

DROP TRIGGER IF EXISTS attachment_access_is_never_deleted ON attachment_access;
DROP TRIGGER IF EXISTS attachment_access_is_never_changed ON attachment_access;
DROP TRIGGER IF EXISTS attachment_access_records_who_reached_for_it ON attachment_access;

DROP INDEX IF EXISTS attachment_access_by_reader;
DROP INDEX IF EXISTS attachment_access_by_attachment;

DROP TABLE IF EXISTS attachment_access;

DROP FUNCTION IF EXISTS stamp_who_reached_for_an_attachment();

DROP TRIGGER IF EXISTS attachment_download_link_is_only_ever_spent ON attachment_download_link;
DROP TRIGGER IF EXISTS attachment_download_link_records_who_issued_it ON attachment_download_link;

DROP INDEX IF EXISTS attachment_download_link_by_attachment;

DROP TABLE IF EXISTS attachment_download_link;

DROP FUNCTION IF EXISTS spend_a_download_link_and_nothing_else();
DROP FUNCTION IF EXISTS stamp_who_issued_a_download_link();
