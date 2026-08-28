-- Up Migration

-- The one time code, and what a challenge in progress has to look like.
-- NFR SEC 01. LMS 110.
--
-- Three of the four columns arrived with the organisation migration —
-- mfa_enabled, mfa_code_hash, mfa_code_expires_at — and the
-- sign-in-account-rules migration deliberately left them alone, saying that
-- their rules belonged to the story that would write them. This is that story.
--
-- What a code has to be, to be worth having:
--
--   Hashed, so that a copy of this table is not a list of the codes currently
--   in flight.
--
--   Expiring, so that a code read off a screen or left in a mailbox stops
--   working. The two facts are one fact and are held as a pair.
--
--   Single use, and finite. Consuming a code on success is the application's
--   job and cannot be a constraint; what the database can hold is the counter
--   that makes a wrong guess cost something, because six digits is a million
--   guesses and a million guesses against no counter is not a second factor.
--
-- What is deliberately absent is any rule about *when* a code is required. That
-- is a question about which roles somebody holds, it changes when HR changes it,
-- and it is answered in server/src/auth/mfa.ts. A CHECK constraint that decided
-- it would have to be dropped and rewritten the first time the policy moved.

-- ------------------------------------------------------------ a code, or none

/* A code and its expiry are one fact and arrive and leave together.

   Either is meaningless alone. A hash with no expiry is a code that works for
   ever, which is the one property a one time code exists not to have; an expiry
   with no hash is a challenge nothing can answer. Both states are unreachable
   through the application, and both are what a half written UPDATE leaves
   behind.

   NULL in both is the resting state and is most rows most of the time: nobody is
   half way through signing in. */

ALTER TABLE app_user
    ADD CONSTRAINT app_user_code_and_expiry_together
        CHECK ((mfa_code_hash IS NULL) = (mfa_code_expires_at IS NULL));

/* And a hash that is present is a hash, for the same reason the password hash
   carries this: an empty string is neither a code nor the absence of one, and it
   would be a challenge that no code answers and every code fails. */

ALTER TABLE app_user
    ADD CONSTRAINT app_user_code_hash_not_blank
        CHECK (mfa_code_hash IS NULL OR btrim(mfa_code_hash) <> '');

-- ------------------------------------------------------- guesses, and an end

/* How many wrong answers this challenge has had.

   Without it a six digit code is a million guesses at a door that never tires,
   and "single use" means only that the code is thrown away once somebody gets it
   right — which is no protection at all against the attacker who is going to get
   it right on attempt four hundred thousand. With it, a code is single use in the
   way that matters: a small number of attempts and then it is gone.

   On the row rather than in memory, because the count has to survive a restart,
   has to be the same count for every instance of the application, and has to be
   consistent with the code it is counting against. It is the same row and the
   same transaction as the thing it protects.

   Reset when a code is issued and cleared when one is consumed, both of which are
   the application's job. The column exists so the application has somewhere
   honest to keep it.

   SMALLINT because the ceiling is single digits. The CHECK is not about arithmetic
   overflow, it is about a negative count being nonsense — a value that would make
   "attempts >= the limit" false for ever. */

ALTER TABLE app_user
    ADD COLUMN mfa_code_attempts SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE app_user
    ADD CONSTRAINT app_user_code_attempts_not_negative CHECK (mfa_code_attempts >= 0);

-- ---------------------------------------------------------------- privileges

/* No new table, so no new grant. lms_app already holds the UPDATE on app_user
   that issuing, counting and consuming a code all need, from the organisation
   migration.

   role and user_role are read by the mandatory-for-HR rule and are not written by
   it. lms_app holds SELECT on both from the default privileges, and the INSERT
   and DELETE that assigning a role needs are LMS 111's to use, not this story's. */

-- ------------------------------------------------------------------ the stale

/* Expired codes are not deleted by anything, and that is a decision rather than
   an omission.

   A leftover row holds a hash of a six digit number that stopped working ten
   minutes after it was issued. It is not a credential, it is not readable, and
   nothing reads it: every path checks the expiry before the hash. The next sign
   in overwrites it.

   What it is, is untidy, and it is the kind of untidy that a purge job of the
   sort Phase 5 collects — LMS 514 already exists for attachments — can clear in
   one statement whenever somebody wants the table clean. There is no index for
   that here, because a partial index maintained on every sign in to serve a job
   nobody has written yet costs more than the scan it would save. */

-- Down Migration

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_code_attempts_not_negative;
ALTER TABLE app_user DROP COLUMN IF EXISTS mfa_code_attempts;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_code_hash_not_blank;
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_code_and_expiry_together;
