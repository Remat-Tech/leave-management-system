-- Up Migration

-- A password somebody else chose is a password two people know. NFR SEC 01.
--
-- There is one way a password is set today: HR sets it, and reads it out to the person it
-- belongs to. That is right for handing out a first login and wrong for everything after —
-- HR knows it, it was said aloud or typed into a chat window, and nothing has ever obliged
-- the owner to replace it.
--
-- So the account carries whether the password it holds is still somebody else's. Set when HR
-- sets one, cleared when the owner changes it themselves, and while it stands the application
-- refuses every door but the one that changes it.
--
-- FALSE by default rather than TRUE: this is a fact about how the current password came to be
-- there, and the accounts that already exist got theirs in a way nobody recorded. Marking them
-- all would be inventing a history for them.

ALTER TABLE app_user
    ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN app_user.must_change_password IS
    'The password was set by somebody other than its owner and has to be replaced at the '
    'next sign in. NFR SEC 01.';

-- Down Migration

ALTER TABLE app_user DROP COLUMN must_change_password;
