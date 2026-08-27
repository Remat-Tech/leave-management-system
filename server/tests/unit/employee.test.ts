import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  InvalidEmployee,
  type Employee,
  type NewEmployee,
  validateEmployeeChanges,
  validateNewEmployee,
} from '../../src/domain/employee.js';

/**
 * The rules for an employee record, FR 01 and FR 05, checked without a database.
 *
 * The database holds the same rules as constraints and refuses the same records;
 * that is asserted in the integration suite. What is asserted here is that the
 * refusal happens before the write and names the field, because "null value in
 * column first_name violates not null constraint" is not something to put in
 * front of an HR officer.
 */

const DOMAINS = ['rematholdings.com'];

const JOINER: NewEmployee = {
  employeeNumber: 'RH-0100',
  firstName: 'Esi',
  lastName: 'Nyarko',
  workEmail: 'esi.nyarko@rematholdings.com',
  jobTitle: 'Operations Officer',
  startDate: '2026-09-01',
};

/** A stored record, for the change rules that need one to check against. */
const STORED: Employee = {
  id: '1',
  employeeNumber: 'RH-0100',
  firstName: 'Esi',
  lastName: 'Nyarko',
  workEmail: 'esi.nyarko@rematholdings.com',
  jobTitle: 'Operations Officer',
  departmentId: null,
  managerId: null,
  workPatternId: '1',
  startDate: '2026-09-01',
  exitDate: null,
  employmentType: 'FULL_TIME',
  employmentStatus: 'ACTIVE',
  gender: null,
  createdAt: new Date('2026-08-27T09:00:00Z'),
  updatedAt: new Date('2026-08-27T09:00:00Z'),
};

function refusal(fn: () => unknown): InvalidEmployee {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidEmployee) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the record to be refused, but it was accepted.');
}

describe('creating an employee record', () => {
  it('keeps every field FR 01 asks for', () => {
    const record = validateNewEmployee(
      {
        ...JOINER,
        employmentType: 'PART_TIME',
        employmentStatus: 'ACTIVE',
        gender: 'FEMALE',
        exitDate: null,
      },
      DOMAINS,
    );

    expect(record).toMatchObject({
      employeeNumber: 'RH-0100',
      firstName: 'Esi',
      lastName: 'Nyarko',
      workEmail: 'esi.nyarko@rematholdings.com',
      jobTitle: 'Operations Officer',
      startDate: '2026-09-01',
      employmentType: 'PART_TIME',
      employmentStatus: 'ACTIVE',
      exitDate: null,
      gender: 'FEMALE',
    });
  });

  it('defaults a new joiner to full time and active', () => {
    const record = validateNewEmployee(JOINER, DOMAINS);

    expect(record.employmentType).toBe('FULL_TIME');
    expect(record.employmentStatus).toBe('ACTIVE');
  });

  it('trims the whitespace a copied and pasted field arrives with', () => {
    const record = validateNewEmployee(
      { ...JOINER, employeeNumber: '  RH-0100  ', firstName: ' Esi ', lastName: 'Nyarko ' },
      DOMAINS,
    );

    expect(record.employeeNumber).toBe('RH-0100');
    expect(record.firstName).toBe('Esi');
    expect(record.lastName).toBe('Nyarko');
  });

  it.each(['employeeNumber', 'firstName', 'lastName', 'workEmail', 'startDate'] as const)(
    'refuses a record with no %s, and says which',
    (field) => {
      const error = refusal(() => validateNewEmployee({ ...JOINER, [field]: '   ' }, DOMAINS));

      expect(error.field).toBe(field);
    },
  );

  it('refuses a field longer than the column holds, rather than letting the database truncate it', () => {
    const error = refusal(() =>
      validateNewEmployee({ ...JOINER, firstName: 'a'.repeat(81) }, DOMAINS),
    );

    expect(error.field).toBe('firstName');
    expect(error.message).toMatch(/80 characters/);
  });
});

describe('the work address', () => {
  it('refuses a personal address at provisioning, NFR SEC 01', () => {
    // The door that matters more of the two. Refusing this at login only stops
    // the person signing in; refusing it here stops the record existing.
    expect(() =>
      validateNewEmployee({ ...JOINER, workEmail: 'esi.nyarko@gmail.com' }, DOMAINS),
    ).toThrow(/not a company address/);
  });

  it('refuses a subdomain of the company domain', () => {
    expect(() =>
      validateNewEmployee({ ...JOINER, workEmail: 'esi@hr.rematholdings.com' }, DOMAINS),
    ).toThrow(/not a company address/);
  });

  it('stores the address folded to lower case', () => {
    const record = validateNewEmployee(
      { ...JOINER, workEmail: 'Esi.Nyarko@RematHoldings.com' },
      DOMAINS,
    );

    expect(record.workEmail).toBe('esi.nyarko@rematholdings.com');
  });
});

describe('the enumerated fields', () => {
  it.each(EMPLOYMENT_TYPES)('accepts an employment type of %s', (employmentType) => {
    expect(validateNewEmployee({ ...JOINER, employmentType }, DOMAINS).employmentType).toBe(
      employmentType,
    );
  });

  it.each(EMPLOYMENT_STATUSES.filter((status) => status !== 'TERMINATED'))(
    'accepts an employment status of %s',
    (employmentStatus) => {
      expect(validateNewEmployee({ ...JOINER, employmentStatus }, DOMAINS).employmentStatus).toBe(
        employmentStatus,
      );
    },
  );

  it('refuses a value that is merely the right word in the wrong case', () => {
    // 'Active' would satisfy a NOT NULL varchar and then fail every comparison
    // against 'ACTIVE' quietly, for the life of the record.
    const error = refusal(() =>
      validateNewEmployee(
        { ...JOINER, employmentStatus: 'Active' as NewEmployee['employmentStatus'] },
        DOMAINS,
      ),
    );

    expect(error.field).toBe('employmentStatus');
  });
});

describe('the gender marker, FR 05', () => {
  it('is optional, and absent by default', () => {
    expect(validateNewEmployee(JOINER, DOMAINS).gender).toBeNull();
  });

  it.each(GENDERS)('accepts %s, for the eligibility check', (gender) => {
    expect(validateNewEmployee({ ...JOINER, gender }, DOMAINS).gender).toBe(gender);
  });

  it('can be cleared again once recorded', () => {
    const changes = validateEmployeeChanges({ gender: null }, { ...STORED, gender: 'FEMALE' }, [
      ...DOMAINS,
    ]);

    expect(changes.gender).toBeNull();
  });

  it('refuses a value the eligibility rules have no meaning for', () => {
    const error = refusal(() =>
      validateNewEmployee({ ...JOINER, gender: 'UNKNOWN' as NewEmployee['gender'] }, DOMAINS),
    );

    expect(error.field).toBe('gender');
  });
});

describe('the dates', () => {
  it('refuses a start date that is not a calendar date', () => {
    const error = refusal(() =>
      validateNewEmployee({ ...JOINER, startDate: '01/09/2026' }, DOMAINS),
    );

    expect(error.field).toBe('startDate');
  });

  it('refuses a date that looks right but never happened', () => {
    // Shape alone would accept both of these.
    expect(() => validateNewEmployee({ ...JOINER, startDate: '2026-02-31' }, DOMAINS)).toThrow(
      /not a real date/,
    );
    expect(() => validateNewEmployee({ ...JOINER, startDate: '2026-13-01' }, DOMAINS)).toThrow(
      /not a real date/,
    );
  });

  it('keeps a date as the day it is, with no time and no timezone', () => {
    // The value that goes to the database is the string that arrived, not an
    // instant it was turned into and turned back from.
    expect(validateNewEmployee({ ...JOINER, startDate: '2026-09-01' }, DOMAINS).startDate).toBe(
      '2026-09-01',
    );
  });

  it('refuses an exit date before the start date', () => {
    const error = refusal(() =>
      validateNewEmployee(
        { ...JOINER, exitDate: '2026-08-31', employmentStatus: 'TERMINATED' },
        DOMAINS,
      ),
    );

    expect(error.field).toBe('exitDate');
    expect(error.message).toMatch(/before the start date/);
  });

  it('refuses a terminated record with no exit date', () => {
    // FR 06 keeps the record and FR 37a settles the final figure from this date,
    // so a leaver without one is a record that cannot be finished.
    const error = refusal(() =>
      validateNewEmployee({ ...JOINER, employmentStatus: 'TERMINATED' }, DOMAINS),
    );

    expect(error.field).toBe('exitDate');
  });

  it('allows an exit date on somebody still active, who is serving notice', () => {
    const record = validateNewEmployee({ ...JOINER, exitDate: '2026-12-31' }, DOMAINS);

    expect(record.employmentStatus).toBe('ACTIVE');
    expect(record.exitDate).toBe('2026-12-31');
  });
});

describe('maintaining a record', () => {
  it('changes only the fields it was given', () => {
    const changes = validateEmployeeChanges({ jobTitle: 'Operations Manager' }, STORED, DOMAINS);

    expect(changes).toEqual({ jobTitle: 'Operations Manager' });
  });

  it('tells clearing a field apart from leaving it alone', () => {
    // Omitted and null are different instructions all the way down to the
    // UPDATE. Conflating them is how a colleague's edit gets silently reverted.
    expect(validateEmployeeChanges({}, STORED, DOMAINS)).toEqual({});
    expect(validateEmployeeChanges({ jobTitle: null }, STORED, DOMAINS)).toEqual({
      jobTitle: null,
    });
  });

  it('treats a job title of nothing but spaces as clearing it', () => {
    expect(validateEmployeeChanges({ jobTitle: '   ' }, STORED, DOMAINS).jobTitle).toBeNull();
  });

  it('checks a rule spanning fields against the record as it will be', () => {
    // The status is changing and the exit date is not, so neither half of the
    // rule can be judged from the change alone.
    const error = refusal(() =>
      validateEmployeeChanges({ employmentStatus: 'TERMINATED' }, STORED, DOMAINS),
    );

    expect(error.field).toBe('exitDate');
  });

  it('accepts terminating somebody when the exit date comes with it', () => {
    const changes = validateEmployeeChanges(
      { employmentStatus: 'TERMINATED', exitDate: '2026-11-30' },
      STORED,
      DOMAINS,
    );

    expect(changes).toEqual({ employmentStatus: 'TERMINATED', exitDate: '2026-11-30' });
  });

  it('refuses to clear the exit date of somebody already terminated', () => {
    const leaver: Employee = {
      ...STORED,
      employmentStatus: 'TERMINATED',
      exitDate: '2026-07-31',
    };

    const error = refusal(() => validateEmployeeChanges({ exitDate: null }, leaver, DOMAINS));

    expect(error.field).toBe('exitDate');
  });

  it('refuses to take away a working pattern rather than replace it', () => {
    // The column is NOT NULL because everybody works some week. Clearing it is
    // a caller error, not an instruction.
    const error = refusal(() => validateEmployeeChanges({ workPatternId: null }, STORED, DOMAINS));

    expect(error.field).toBe('workPatternId');
  });

  it('refuses a personal address on a change, as well as on a create', () => {
    expect(() => validateEmployeeChanges({ workEmail: 'esi@gmail.com' }, STORED, DOMAINS)).toThrow(
      /not a company address/,
    );
  });
});
