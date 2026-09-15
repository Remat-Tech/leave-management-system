-- Up Migration

-- Somebody who has forgotten their password, and the code that lets them set a new one.
-- NFR SEC 01.
--
-- Until now a forgotten password was an administrator with a terminal, which is the shape of
-- thing that gets done by whoever is free and written down nowhere. The mailbox is already
-- what this system trusts — it is the second factor at sign in — so it is what answers here
-- too, and the same rules apply: hashed at rest, single use, ten minutes, five wrong answers
-- and it is gone.
--
-- **Its own columns rather than the sign in code's.** The two are the same mechanism and
-- emphatically not the same permission: one proves somebody already holding the password is
-- at the mailbox, and the other hands out a new password to whoever answers. Sharing the
-- columns would mean a code issued for one purpose could be spent on the other, and the
-- direction that goes wrong is the expensive one — a sign in code, intercepted, becoming a
-- password reset.
--
-- No link, for the reason the sign in code carries none: an email that trains staff to click
-- a link and type a password is the exact habit every phishing attempt against them relies on.

ALTER TABLE app_user
    ADD COLUMN reset_code_hash       VARCHAR(255),
    ADD COLUMN reset_code_expires_at TIMESTAMPTZ,
    ADD COLUMN reset_code_attempts   SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE app_user
    ADD CONSTRAINT app_user_reset_code_is_whole
        CHECK ((reset_code_hash IS NULL) = (reset_code_expires_at IS NULL));

COMMENT ON COLUMN app_user.reset_code_hash IS
    'A single use code emailed to somebody who has forgotten their password. Hashed as the '
    'password is, so a copy of this table is not a list of the codes in flight. NFR SEC 01.';

-- Down Migration

ALTER TABLE app_user DROP CONSTRAINT app_user_reset_code_is_whole;

ALTER TABLE app_user
    DROP COLUMN reset_code_hash,
    DROP COLUMN reset_code_expires_at,
    DROP COLUMN reset_code_attempts;
