-- Up Migration

-- The organisation: who exists, who they report to, and who they sign in as.
-- Technical Design Document sections 5.2 and 5.3.

CREATE TABLE department (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120) NOT NULL UNIQUE,
    parent_id   BIGINT REFERENCES department(id),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Which weekdays this pattern works. Drives working day counts for annual,
   sick and compassionate leave. */
CREATE TABLE work_pattern (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL UNIQUE,   /* 'Standard Mon-Fri' */
    is_default  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE work_pattern_day (
    work_pattern_id BIGINT NOT NULL REFERENCES work_pattern(id) ON DELETE CASCADE,
    day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), /* ISO: 1=Mon */
    is_working_day  BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (work_pattern_id, day_of_week)
);

CREATE TABLE employee (
    id                BIGSERIAL PRIMARY KEY,
    employee_number   VARCHAR(40) NOT NULL UNIQUE,
    first_name        VARCHAR(80) NOT NULL,
    last_name         VARCHAR(80) NOT NULL,
    work_email        VARCHAR(160) NOT NULL UNIQUE,
    job_title         VARCHAR(120),
    department_id     BIGINT REFERENCES department(id),
    manager_id        BIGINT REFERENCES employee(id),  /* FR 02; NULL only for the root */
    work_pattern_id   BIGINT NOT NULL REFERENCES work_pattern(id),
    start_date        DATE NOT NULL,  /* the day employment begins, which is
                                         what entitlement is pro rated from */
    exit_date         DATE,
    employment_type   VARCHAR(30) NOT NULL DEFAULT 'FULL_TIME',
        /* FULL_TIME | PART_TIME | CONTRACT | INTERN */
    employment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        /* ACTIVE | SUSPENDED | TERMINATED */
    gender            VARCHAR(20),  /* FR 05: eligibility checks only, nullable */
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT employee_not_own_manager CHECK (id <> manager_id),
    CONSTRAINT employee_exit_after_start CHECK (exit_date IS NULL OR exit_date >= start_date)
);

CREATE INDEX idx_employee_manager ON employee(manager_id);
CREATE INDEX idx_employee_status ON employee(employment_status)
    WHERE employment_status = 'ACTIVE';

/* Cycle prevention, FR 03. The CHECK above catches only self reference. A full
   cycle (A -> B -> C -> A) is caught in the service layer by walking up from
   the proposed manager to the root. See Technical Design Document section 5.2. */

CREATE TABLE app_user (
    id                  BIGSERIAL PRIMARY KEY,
    employee_id         BIGINT NOT NULL UNIQUE REFERENCES employee(id),
    company_email       VARCHAR(160) NOT NULL UNIQUE,  /* sign in identifier */
    password_hash       VARCHAR(255),
    mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    mfa_code_hash       VARCHAR(255),
    mfa_code_expires_at TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at       TIMESTAMPTZ
);

CREATE TABLE role (
    id    BIGSERIAL PRIMARY KEY,
    code  VARCHAR(40) NOT NULL UNIQUE,
    name  VARCHAR(80) NOT NULL
);

CREATE TABLE user_role (
    user_id  BIGINT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    role_id  BIGINT NOT NULL REFERENCES role(id),
    PRIMARY KEY (user_id, role_id)
);

/* MANAGER is deliberately absent. Being a manager is a relationship: you are
   one if some employee has your id as their manager_id. Holding it as a role
   too would create two sources of truth that drift the moment somebody changes
   team. Authorisation asks "is this person one of my reports?", never "do I
   have the manager role?". */

INSERT INTO role (code, name) VALUES
    ('EMPLOYEE',   'Employee'),
    ('HR_OFFICER', 'HR Officer'),
    ('HR_ADMIN',   'HR Administrator'),
    ('SYS_ADMIN',  'System Administrator');

-- Privileges for the application role.
--
-- Default privileges from the restricted-application-role migration already
-- gave lms_app SELECT and INSERT on each of these. Only the tables it must also
-- change are widened, and only as far as they need.

GRANT UPDATE, DELETE ON department, work_pattern, work_pattern_day TO lms_app;
GRANT UPDATE ON app_user TO lms_app;

/* Removing a role from somebody is a DELETE on the join table. */
GRANT DELETE ON user_role TO lms_app;

/* employee gets UPDATE but never DELETE. FR 06 requires that records are
   deactivated rather than removed, so that leave history survives the person
   leaving. Withholding the privilege is what makes that true rather than
   merely intended. */
GRANT UPDATE ON employee TO lms_app;

/* role is reference data, seeded above and not edited at runtime, so lms_app
   keeps only the SELECT and INSERT it already had. */

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lms_app;

-- Down Migration

DROP TABLE IF EXISTS user_role;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS app_user;
DROP TABLE IF EXISTS employee;
DROP TABLE IF EXISTS work_pattern_day;
DROP TABLE IF EXISTS work_pattern;
DROP TABLE IF EXISTS department;
