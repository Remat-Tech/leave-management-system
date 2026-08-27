-- Up Migration

-- Departments, and every employee in one. Technical Design Document section 5.2.
--
-- The table arrived with the organisation migration and nothing has written to
-- it since except the seed. This is the migration that makes it a record HR
-- maintains rather than a list somebody loaded once: a name that means something,
-- an ending that is deactivation rather than removal, and a department on every
-- employee so that a report by team is a report about everybody.
--
-- One table gains a column, one column loses its nullability, and one privilege
-- is taken away. Everything else here is a tightening.

-- ------------------------------------------------------------------ the name

/* A department is known by its name. It is the only thing about one that anybody
   types, reads on a report, or picks out of a list, so it carries the same two
   rules the employee identifiers carry and for the same reasons.

   Not blank, because NOT NULL says a value arrived and says nothing about
   whether it means anything. A department named '' is a heading that shows
   nothing on every screen it appears on.

   Unique without regard to case, because 'Operations' and 'operations' are one
   department to everybody except a byte comparison. Two rows of them is two
   sets of figures for one team, discovered when they disagree.

   Stored as it was typed and compared folded, so a department keeps the
   capitalisation HR uses on paper. 'Product & Engineering' is not
   'product & engineering' on a report, even though it may not be a second one.

   Dropping the original constraint drops its index with it, so the replacement
   is created first and the table is never left without one. */

ALTER TABLE department
    ADD CONSTRAINT department_name_not_blank CHECK (btrim(name) <> '');

CREATE UNIQUE INDEX department_name_unique ON department (lower(name));
ALTER TABLE department DROP CONSTRAINT department_name_key;

-- --------------------------------------------------------------- maintenance

/* The table had created_at and no updated_at, which was right while nothing
   edited it. Editing one is half of what this story is for, and "when did this
   last change" is the first question asked of a record that looks wrong.

   set_updated_at() is reused rather than copied. The employee-record-rules
   migration named it for the job rather than for the table it first served and
   said the next table wanting this behaviour should attach to it; this is the
   next table. The column is added with a default so the rows already there get
   an honest value rather than a NULL that every reader has to guard. */

ALTER TABLE department
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TRIGGER department_set_updated_at
    BEFORE UPDATE ON department
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------- every employee in a department

/* employee.department_id was nullable, and a nullable one makes the story's
   whole reason conditional: leave is to be reported and planned by team, and an
   employee in no team is a person who appears in no team's figures and in
   nobody's plan. They are not visibly missing either, which is the worse half —
   a headcount by department that quietly adds up to less than the company.

   The seed has always given everybody one, so nothing in the fixture set moves.
   A database that does hold a NULL fails this statement rather than losing the
   row, which is the right way for that to be discovered.

   The index is for the reads this story exists to make possible. Every report by
   team, every team calendar and every "who in Operations is off next week" is a
   lookup by this column, and there was no index on it because until now nothing
   asked. */

ALTER TABLE employee
    ALTER COLUMN department_id SET NOT NULL;

CREATE INDEX idx_employee_department ON employee(department_id);

-- -------------------------------------------------------- the ending one has

/* A department is deactivated, not deleted, so lms_app loses the DELETE the
   organisation migration gave it. That grant was made before anything used the
   table and was never argued for; the story names deactivation as the ending a
   department has, and leaving a live delete path next to it would mean the
   application had two endings, one of them undocumented.

   is_active is what deactivation writes. It was on the table from the start and
   nothing has read it yet; the department service is its first reader.

   Deliberately weaker than employee, which also refuses the owner connection
   through the employee_never_deleted trigger. The difference is what the
   database already guarantees. employee.department_id references this table with
   no cascade, so a department anybody belongs to cannot be deleted by anyone at
   all, and it is now NOT NULL, so belonging is not something an employee can
   quietly stop doing. What remains deletable is a department nobody has ever
   been in — the one created by a typo on a Tuesday afternoon — and being able to
   remove that from the owner connection is worth more than the symmetry.

   If departments later acquire history that outlives them, that judgement
   changes, and the trigger to attach is refuse_delete(). */

REVOKE DELETE ON department FROM lms_app;

-- ----------------------------------------------------- what is not held here

/* parent_id. The column exists, the foreign key points back at this table, and
   nothing writes it: not the seed, not the application, not this migration. A
   department hierarchy is not what this story asks for and inventing one here
   would mean guessing at rules nobody has stated.

   It is worth saying what a story that does expose it has to bring with it,
   because the shape is already known. A self referencing parent is the same
   structure as employee.manager_id, so it has the same two failure modes and
   wants the same two answers: a cycle, which needs a walk upward and a deferred
   constraint trigger of its own, and a count of roots, which needs a partial
   unique index. refuse_manager_cycle() cannot be reused as it stands — it names
   employee and manager_id — but it can be read as a worked example.

   Until then the safety is that the column is only ever NULL, which no walk can
   loop on. */

-- Down Migration

GRANT DELETE ON department TO lms_app;

DROP INDEX IF EXISTS idx_employee_department;
ALTER TABLE employee ALTER COLUMN department_id DROP NOT NULL;

DROP TRIGGER IF EXISTS department_set_updated_at ON department;
ALTER TABLE department DROP COLUMN IF EXISTS updated_at;

ALTER TABLE department ADD CONSTRAINT department_name_key UNIQUE (name);
DROP INDEX IF EXISTS department_name_unique;

ALTER TABLE department DROP CONSTRAINT IF EXISTS department_name_not_blank;
