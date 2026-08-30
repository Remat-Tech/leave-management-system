-- Up Migration

-- The gazetted public holiday calendar. FR 22, §5.4. LMS 206.
--
-- The leave-type-rules migration named this table before it existed: "Whether a
-- public holiday inside a request is free follows from counting_basis and the
-- `holiday` table, and the calendar does not exist yet." This is that table.
--
-- The story is a day the office was closed. Nobody is charged leave for the
-- twenty fifth of December, and the reason is not that somebody remembered — it
-- is that the twenty fifth of December is a row here, and a WORKING_DAYS leave
-- type does not count a day this table holds.
--
-- ## This is the one configuration table that holds somebody else's decisions
--
-- Every other table in §5.5 holds what Remat Holdings decided: what annual leave
-- is worth, who approves unpaid leave, when the leave year ends. This one holds
-- what the Republic decided, in the Public Holidays Act 2001 (Act 601) as amended
-- by Act 1071 of 2019, and in whatever the Minister for the Interior gazettes
-- during the year. HR is transcribing, not deciding.
--
-- Three consequences run through everything below.
--
--   **Rows are added mid year, and that is normal rather than exceptional.** A day
--   of national mourning, an election day, a Monday declared in lieu of a Saturday
--   Boxing Day. FR 22 asks for a calendar HR maintains, and the reason is that the
--   thing being transcribed changes after the year has started.
--
--   **Rows are edited and removed.** Two of Ghana's holidays — Eid al-Fitr and Eid
--   al-Adha — fall on days nobody can compute, because they follow the sighting of
--   the moon and are fixed by the Minister when it is sighted. The dates seeded
--   below are the projection everybody plans around and not the gazette. When the
--   gazette says otherwise, HR moves the row.
--
--   **A holiday is not a heading anything is filed under.** That is the difference
--   from `leave_type` and `leave_year`, which cannot be deleted by anybody: nothing
--   points a foreign key here and nothing ever will, because what a request stores
--   is the days it cost, worked out when it was counted. So `lms_app` holds DELETE,
--   and the story's "remove" is a real delete rather than a flag.
--
-- ## One row per day, which is a rule about counting rather than about tidiness
--
-- `holiday_one_per_day` is a unique index on the date, and it is the one constraint
-- here that is load bearing. The question this table answers is "was the office
-- closed on this day", which has one answer; a day carrying two rows would be
-- subtracted twice by any counter that joined on it, and a request spanning it
-- would come back a day cheaper than it was. Ghana has coincidences — Eid moves
-- through the calendar and will eventually land on the sixth of March — and the
-- gazette handles them by naming the day for both, which is a name and not a
-- second row.

-- ------------------------------------------------------------------ the table

CREATE TABLE holiday (
    id           BIGSERIAL PRIMARY KEY,

    /* What the gazette calls it. Shown beside the day on a calendar and in the
       line of a leave request that explains why nine days cost seven.

       Not a code, and deliberately not one. `leave_type.code` is a stable handle
       because reports and imports have to refer to a type across a rename; nothing
       refers to a holiday at all, so a code here would be a handle with no holder
       and the first thing somebody would be tempted to branch on. */
    name         VARCHAR(80) NOT NULL,

    /* The day the office was closed.

       DATE and not TIMESTAMPTZ, for the reason every leave date in this schema is
       one: a holiday is a day, not an instant, and a moment would carry a zone that
       moves it across midnight. NFR DAT 03.

       There is no `leave_year_id` beside it, and that absence is a decision. Which
       leave year a holiday falls in is the same question `leave_year` already
       answers for every other day — a containment search on these ten characters —
       and a column holding the answer would be a second copy that goes wrong the
       morning somebody moves a company from a January start to an April one. The
       holiday does not move; the year around it does. */
    holiday_date DATE NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT holiday_name_not_blank CHECK (btrim(name) <> '')
);

/* One holiday to a day. See the note at the head of this file: this is what stops
   a day off being counted twice, not a rule about neatness.

   It is also the whole of the index this table needs. Every read is either "is
   this day a holiday" or "what are the holidays between these two days", and a
   btree on the date serves both — the second as a range scan. A separate index on
   the name would be an index for a search nobody performs on a table with a dozen
   rows a year in it. */

CREATE UNIQUE INDEX holiday_one_per_day ON holiday (holiday_date);

-- ---------------------------------------------- a settled year keeps its days

/* The rule this story inherits from LMS 205, and the reason it is here rather
   than left to the service.

   Adding the twenty fifth of December 2026 to the calendar in 2028 changes what
   every WORKING_DAYS request over that day cost. If 2026 has been closed, those
   figures are final — that is the whole of what closing a year means — and a row
   written here would make them quietly wrong rather than refusing anything.
   Removing one does the same in the other direction, and moving one does both at
   once, so all three are refused and both sides of a move are judged.

   It is the same rule `assertDoesNotReachIntoAClosedYear` holds for entitlement
   figures, arriving at the same table from a different direction. There it is a
   check one level up, because the boundary lives in another table and no
   constraint on `leave_entitlement_rule` can see it. Here the trigger can simply
   read `leave_year`, so it does, and the refusal holds for a psql prompt as well
   as for the service — which matters because a holiday is exactly the kind of row
   somebody fixes by hand at six in the evening.

   A day in no leave year at all is not settled and is not refused. The database
   ships with 2026 and 2027 and nothing after; a holiday in 2029 is a calendar
   somebody is getting ahead on, and the year will be drawn around it later. */

CREATE FUNCTION refuse_a_holiday_in_a_settled_year() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    settled leave_year%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        SELECT * INTO settled
          FROM leave_year
         WHERE is_closed
           AND OLD.holiday_date BETWEEN start_date AND end_date;

        IF FOUND THEN
            RAISE EXCEPTION
                'Holiday "%" is on %, which is inside %, a leave year that was closed on %.',
                OLD.name, OLD.holiday_date, settled.label, settled.closed_at
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'holiday_leaves_settled_years_alone',
                      HINT = 'Every request over that day was counted against the '
                             'calendar as it stood, and a closed year is never '
                             'recalculated. FR 22, §5.4.';
        END IF;
    END IF;

    IF TG_OP <> 'DELETE' THEN
        SELECT * INTO settled
          FROM leave_year
         WHERE is_closed
           AND NEW.holiday_date BETWEEN start_date AND end_date;

        IF FOUND THEN
            RAISE EXCEPTION
                'Holiday "%" would fall on %, which is inside %, a leave year that was closed on %.',
                NEW.name, NEW.holiday_date, settled.label, settled.closed_at
                USING ERRCODE = 'restrict_violation',
                      CONSTRAINT = 'holiday_leaves_settled_years_alone',
                      HINT = 'A day added to a settled year would change what leave '
                             'over it cost, after the figures were made final. '
                             'FR 22, §5.4.';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END
$$;

CREATE TRIGGER holiday_leaves_settled_years_alone
    BEFORE INSERT OR UPDATE OR DELETE ON holiday
    FOR EACH ROW
    EXECUTE FUNCTION refuse_a_holiday_in_a_settled_year();

-- --------------------------------------------------------------- maintenance

/* set_updated_at() and record_in_audit_log() reused, as every table since the
   department rules has reused them.

   The audit entries are worth more here than the row count suggests. A holiday
   added in March changes what a request approved in February cost — FR 25's
   recalculation — and "who added the twenty eighth of December, and when" is the
   question a disputed recalculation turns on. There is no other record of it: the
   row itself says only what the calendar says today. */

CREATE TRIGGER holiday_set_updated_at
    BEFORE UPDATE ON holiday
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER holiday_is_audited
    AFTER INSERT OR UPDATE OR DELETE ON holiday
    FOR EACH ROW EXECUTE FUNCTION record_in_audit_log();

-- ---------------------------------------------------------------- privileges

/* SELECT and INSERT arrive from the default privileges of the
   restricted-application-role migration. UPDATE and DELETE are granted, and this
   is the second table in the configuration half of the schema to hold DELETE —
   `leave_entitlement_rule` is the other, for its drafts.

   The argument is the same one that refused it to `leave_type` and `leave_year`,
   answered the other way. Those rows are headings: a year of balances is filed
   under a leave year and every request under a type, so deleting one takes a year
   of history with it. Nothing is filed under a holiday. What a request stores is
   the number of days it cost, worked out against the calendar of the day it was
   counted, so a holiday that turns out never to have been gazetted can simply go
   — and leaving it in the table because the schema had no way to remove it would
   be charging nobody for a day the office was open. */

GRANT UPDATE, DELETE ON holiday TO lms_app;

-- ------------------------------------------------ the 2026 gazette, as data

/* Ghana's public holidays for 2026, as reference data with an owner.

   Reference data by the same argument as the seven leave types, the standard
   Monday to Friday week and the first two leave years: a production database is
   migrated and never seeded, and a leave system that charges everybody a day for
   Christmas on its first December is one nobody trusts again.

   Fourteen days, from the Public Holidays Act 2001 (Act 601) as amended by the
   Public Holidays (Amendment) Act 2019 (Act 1071), which is the amendment that
   added Constitution Day and Founders' Day and renamed the twenty first of
   September. They divide into three kinds, and the difference is the whole reason
   this table is maintained by a person:

     **Fixed by statute.** New Year's Day, Constitution Day, Independence Day, May
     Day, African Union Day, Founders' Day, Kwame Nkrumah Memorial Day, Christmas
     Day and Boxing Day. The same date every year, and the only ones a calculation
     could produce.

     **Computable, but not by arithmetic anybody should write twice.** Good Friday
     and Easter Monday follow the ecclesiastical full moon; Farmers' Day is the
     first Friday of December.

     **Not computable at all.** Eid al-Fitr and Eid al-Adha are fixed by the
     Minister after the moon is sighted. The dates here are the projection the
     whole country plans around, and they have been a day out before. HR moves the
     row when the gazette says so, which is the story's "edit" and is the reason it
     is an acceptance criterion rather than a courtesy.

   ## Only 2026, and that is deliberate

   2027 is not seeded, and it is not an omission. Two of the fourteen cannot be
   known for 2027 and the rest could be extrapolated, which would produce a
   calendar that is twelve thirteenths right — and a holiday calendar that is
   nearly right is worse than one that is visibly empty, because a wrong row is
   believed silently while an empty year is a screen with nothing on it. It is the
   same argument this schema makes everywhere about stubs, applied to data.

   What makes the empty year safe is that it can be seen: `yearsWithoutHolidays()`
   in ../src/domain/holiday.ts reads the leave years against this table and names
   any that nobody has entered a calendar for. Filling 2027 in from the gazette is
   then HR's afternoon rather than a release, which is FR 31's argument and FR 22's
   own "maintain".

   ## What it does about a holiday on a Saturday

   Nothing, on purpose. Boxing Day 2026 falls on a Saturday, and the Minister may
   or may not declare the Monday after it. A rule here that moved weekend holidays
   to the following working day would be this migration inventing law: the Act
   grants that power to the Minister and does not oblige it, and a Monday this file
   invented would be a day off that the payroll believed in and the country did
   not. When it is declared, HR adds it — which is the story's "added mid year",
   and the case it was written for. */

CREATE FUNCTION ensure_the_gazetted_holidays() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    /* Whoever the caller said they were, kept and put back, as its three siblings
       do it. A holiday that reappeared should say where it came from. */
    named_by TEXT := current_setting('lms.audit.actor', true);
    inserted INTEGER;
BEGIN
    PERFORM set_config(
        'lms.audit.actor',
        coalesce(nullif(btrim(named_by), ''), 'ensure_the_gazetted_holidays()'),
        true);

    INSERT INTO holiday (name, holiday_date)
    SELECT * FROM (VALUES
        ('New Year''s Day',            DATE '2026-01-01'),
        ('Constitution Day',           DATE '2026-01-07'),
        ('Independence Day',           DATE '2026-03-06'),
        ('Eid al-Fitr',                DATE '2026-03-20'),
        ('Good Friday',                DATE '2026-04-03'),
        ('Easter Monday',              DATE '2026-04-06'),
        ('May Day',                    DATE '2026-05-01'),
        ('African Union Day',          DATE '2026-05-25'),
        ('Eid al-Adha',                DATE '2026-05-27'),
        ('Founders'' Day',             DATE '2026-08-04'),
        ('Kwame Nkrumah Memorial Day', DATE '2026-09-21'),
        ('Farmers'' Day',              DATE '2026-12-04'),
        ('Christmas Day',              DATE '2026-12-25'),
        ('Boxing Day',                 DATE '2026-12-26')
    ) AS gazetted (name, holiday_date)
    /* Guarded on the day and on the name, and the second half is what makes this
       safe to run against a database HR has been using.

       The day alone would be enough for a calendar nobody had touched. It is not
       enough for the case this function exists for: somebody moves Eid al-Fitr to
       the twenty first because the gazette said so, the calendar is later restored
       from a backup taken before that, and a guard reading only the date would put
       the twentieth back beside it — two rows for one feast, on a table whose whole
       rule is one row per day.

       The name is compared within its own calendar year, because 'Christmas Day'
       is the name of a day in every year and a guard that ignored the year would
       refuse to put 2026's back on a database where somebody had entered 2027's. */
    WHERE NOT EXISTS (
        SELECT 1 FROM holiday existing
         WHERE existing.holiday_date = gazetted.holiday_date
            OR (lower(existing.name) = lower(gazetted.name)
                AND EXTRACT(YEAR FROM existing.holiday_date)
                    = EXTRACT(YEAR FROM gazetted.holiday_date))
    );

    GET DIAGNOSTICS inserted = ROW_COUNT;

    PERFORM set_config('lms.audit.actor', coalesce(named_by, ''), true);

    RETURN inserted;
END
$$;

/* Nobody but the owner may run it, as with its siblings. lms_app holds INSERT on
   the table and HR adds holidays through the service, so this withholds no power
   it has elsewhere; restoring reference data is an operator's job, done knowingly. */

REVOKE EXECUTE ON FUNCTION ensure_the_gazetted_holidays() FROM PUBLIC;

DO $$
DECLARE
    inserted INTEGER;
BEGIN
    inserted := ensure_the_gazetted_holidays();

    RAISE NOTICE 'Wrote % public holiday(s).', inserted;
END
$$;

-- ------------------------------------------------------ what is not here yet

/* **The counting.** What a day off costs is the leave calculator of §7.3, and it
   reads three things: the working pattern of FR 23, the `counting_basis` of the
   leave type, and this table. A WORKING_DAYS request skips a day held here; a
   CALENDAR_DAYS one — maternity leave, which is a hundred and twenty consecutive
   days — does not, and that is FR 21 rather than an oversight. None of it is
   stubbed here, because a counting function on a table with no requests to count
   would be a rule nothing exercises.

   **The recalculation.** FR 25: a holiday declared inside a leave request that has
   already been approved gives the day back, "only to working day leave types".
   That is a read of `leave_type.counting_basis` and needs nothing added to either
   table — the point of having settled the basis first — but it needs requests,
   which is §8. The audit entries above are what will make a recalculation
   explicable when it happens.

   **Recurrence.** There is no `is_annual` column and no rule that generates next
   year's rows from this year's, and the reason is the two Eids: a generator would
   be right about nine of the fourteen, silent about two, and would have to be
   overridden for three. A flag that half the rows set and nothing reads would be
   the wrong shape stored in the right place, which is harder to remove than
   nothing. What the next year actually needs is somebody with the gazette open,
   and FR 22 says as much.

   **Days in lieu.** See the note above the seed. Moving a weekend holiday to the
   Monday after is the Minister's to declare, and a rule here would be this file
   inventing law. */

-- Down Migration

DROP FUNCTION IF EXISTS ensure_the_gazetted_holidays();

DROP TRIGGER IF EXISTS holiday_is_audited ON holiday;
DROP TRIGGER IF EXISTS holiday_set_updated_at ON holiday;
DROP TRIGGER IF EXISTS holiday_leaves_settled_years_alone ON holiday;

DROP FUNCTION IF EXISTS refuse_a_holiday_in_a_settled_year();

DROP TABLE IF EXISTS holiday;
