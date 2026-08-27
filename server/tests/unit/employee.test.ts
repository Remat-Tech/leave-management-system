import { describe, expect, it } from 'vitest';
import {
  AlreadyTerminated,
  assertNoManagerCycle,
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_TYPES,
  GENDERS,
  InvalidEmployee,
  ManagerCycle,
  type Employee,
  type NewEmployee,
  planTermination,
  type ReportingLines,
  validateEmployeeChanges,
  validateNewEmployee,
  warnAboutReportingLines,
} from '../../src/domain/employee.js';

/**
 * The rules for an employee record, FR 01 to FR 06, checked without a
 * database.
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
  // Whether id 7 is anybody, whether they have left, and whether department 5
  // is a department still open are all questions for the service. Here they are
  // references and nothing more.
  departmentId: '5',
  managerId: '7',
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
  departmentId: '5',
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

describe('the department, LMS 105', () => {
  /**
   * Only the half that needs nothing but the record in hand. Whether the id is a
   * department, and whether it is one still open, are questions about another
   * table and belong to the service.
   */

  it('keeps the team it was given', () => {
    expect(validateNewEmployee(JOINER, DOMAINS).departmentId).toBe('5');
  });

  it('refuses a record that does not say which team', () => {
    // The type already forbids this. The check is for the callers TypeScript
    // does not see: a JSON body, a bulk import, anything at the end of a wire.
    const unsaid: Partial<NewEmployee> = { ...JOINER };
    delete unsaid.departmentId;

    const error = refusal(() => validateNewEmployee(unsaid as NewEmployee, DOMAINS));

    expect(error.field).toBe('departmentId');
    expect(error.message).toMatch(/reported and planned by team/);
  });

  it('has no null to mean anybody is outside the teams', () => {
    /* Unlike the line manager, where null is the head of the organisation and is
       a real thing to say. Nobody is outside the departments, including them, so
       there is no meaning to give null and it is refused with everything else
       that is not an id. */
    const error = refusal(() =>
      validateNewEmployee({ ...JOINER, departmentId: null as unknown as string }, DOMAINS),
    );

    expect(error.field).toBe('departmentId');
  });

  it('refuses an empty string rather than reading it as no team', () => {
    expect(
      refusal(() => validateNewEmployee({ ...JOINER, departmentId: ' ' }, DOMAINS)).field,
    ).toBe('departmentId');
  });

  it('moves somebody between teams as an ordinary edit', () => {
    expect(validateEmployeeChanges({ departmentId: '9' }, STORED, DOMAINS)).toEqual({
      departmentId: '9',
    });
  });

  it('leaves the team alone when the change does not mention it', () => {
    expect(validateEmployeeChanges({ jobTitle: 'Operations Manager' }, STORED, DOMAINS)).toEqual({
      jobTitle: 'Operations Manager',
    });
  });

  it('refuses taking somebody out of a team rather than moving them', () => {
    // The column is NOT NULL because everybody is in some team. Clearing it is a
    // caller error, not an instruction, exactly as it is for the work pattern.
    const error = refusal(() =>
      validateEmployeeChanges({ departmentId: null as unknown as string }, STORED, DOMAINS),
    );

    expect(error.field).toBe('departmentId');
  });
});

describe('the line manager, FR 02 and FR 04', () => {
  /**
   * Only the half of the rule that needs nothing but the record in hand. Whether
   * the id is anybody, whether they have left, and whether somebody else is
   * already the head of the organisation are all questions about other rows, so
   * they belong to the service and are asserted in the integration suite.
   */

  it('keeps the line it was given', () => {
    expect(validateNewEmployee(JOINER, DOMAINS).managerId).toBe('7');
  });

  it('refuses a record that does not say who it reports to', () => {
    // The type already forbids this. The check is for the callers TypeScript
    // does not see: a JSON body, the seed, anything at the end of a wire.
    const unsaid: Partial<NewEmployee> = { ...JOINER };
    delete unsaid.managerId;

    const error = refusal(() => validateNewEmployee(unsaid as NewEmployee, DOMAINS));

    expect(error.field).toBe('managerId');
    expect(error.message).toMatch(/head of the organisation/);
  });

  it('accepts null, which is the head of the organisation saying so', () => {
    // Deliberate, and different from having forgotten. How many records may say
    // it is FR 04 and is the service's question, not this one's.
    expect(validateNewEmployee({ ...JOINER, managerId: null }, DOMAINS).managerId).toBeNull();
  });

  it('refuses an empty string rather than reading it as nobody', () => {
    // An empty select box is a form that has not been filled in. Inferring "no
    // manager" from it is how a routing black hole gets created by a stray
    // click, so it is refused and the route layer maps its own blanks knowingly.
    const error = refusal(() => validateNewEmployee({ ...JOINER, managerId: '  ' }, DOMAINS));

    expect(error.field).toBe('managerId');
  });

  it('tells leaving a line alone apart from cutting it', () => {
    // The same distinction the rest of the record keeps, and it matters more
    // here than anywhere: omitted is "do not touch the manager", null is "this
    // person now reports to nobody".
    expect(validateEmployeeChanges({}, STORED, DOMAINS)).toEqual({});
    expect(validateEmployeeChanges({ managerId: null }, STORED, DOMAINS)).toEqual({
      managerId: null,
    });
  });

  it('moves a reporting line onto somebody else', () => {
    expect(validateEmployeeChanges({ managerId: '9' }, STORED, DOMAINS)).toEqual({
      managerId: '9',
    });
  });

  it('refuses an employee as their own line manager', () => {
    // employee_not_own_manager says the same at the database. It is said here so
    // the refusal names the box rather than the constraint.
    const error = refusal(() => validateEmployeeChanges({ managerId: STORED.id }, STORED, DOMAINS));

    expect(error.field).toBe('managerId');
    expect(error.message).toMatch(/their own line manager/);
  });

  it('lets the head of the organisation go on being it', () => {
    // STORED already has no manager. Saying so again is not a second one.
    expect(validateEmployeeChanges({ managerId: null }, STORED, DOMAINS).managerId).toBeNull();
  });
});

describe('a reporting line never loops, FR 03', () => {
  /**
   * The judgement, given a walk somebody else did. The walk itself needs the
   * table and lives in the service; the integration suite proves that half, and
   * proves the deferred trigger that catches what never reaches the service at
   * all.
   *
   * `chain` throughout is the line above the *proposed manager*, nearest first
   * and starting with them. A loop is that chain reaching the employee whose
   * manager is being set.
   */

  /** Kwame at the top, then Yaw, Akosua, Kofi, Adwoa at the bottom. */
  const person = (id: string, firstName: string, lastName: string, number: string): Employee => ({
    ...STORED,
    id,
    firstName,
    lastName,
    employeeNumber: number,
  });

  const KWAME = person('1', 'Kwame', 'Asante', 'RH-0001');
  const YAW = person('3', 'Yaw', 'Boateng', 'RH-0003');
  const AKOSUA = person('7', 'Akosua', 'Darko', 'RH-0007');
  const KOFI = person('10', 'Kofi', 'Boateng', 'RH-0010');
  const ADWOA = person('11', 'Adwoa', 'Frimpong', 'RH-0011');

  /** Walking up from Adwoa, who is at the bottom of the seeded branch. */
  const ABOVE_ADWOA = [ADWOA, KOFI, AKOSUA, YAW, KWAME];

  function cycle(fn: () => unknown): ManagerCycle {
    try {
      fn();
    } catch (error) {
      if (error instanceof ManagerCycle) {
        return error;
      }
      throw error;
    }
    throw new Error('Expected the line to be refused, but it was accepted.');
  }

  it('accepts a manager the employee is not already above', () => {
    // Abena moving under Adwoa. Nothing in Adwoa's line is Abena, so the line
    // still terminates at Kwame.
    const abena = person('12', 'Abena', 'Sarpong', 'RH-0012');

    expect(() => assertNoManagerCycle(abena, ABOVE_ADWOA)).not.toThrow();
  });

  it('refuses a loop between two people', () => {
    // Kofi being given Adwoa, who already reports to him.
    const error = cycle(() => assertNoManagerCycle(KOFI, ABOVE_ADWOA));

    expect(error.loop.map((one) => one.employeeNumber)).toEqual(['RH-0011', 'RH-0010']);
  });

  it('refuses a three level loop, and names the person in the middle', () => {
    // Akosua -> Kofi -> Adwoa -> Akosua. The one the acceptance criteria asks
    // for, and the one a two person check would miss: neither Akosua and Adwoa
    // nor Kofi and Adwoa are directly related, so the loop only appears once the
    // walk has gone up twice.
    const error = cycle(() => assertNoManagerCycle(AKOSUA, ABOVE_ADWOA));

    expect(error.loop.map((one) => one.employeeNumber)).toEqual(['RH-0011', 'RH-0010', 'RH-0007']);
    // Naming Kofi is the point. "That would create a cycle" leaves an HR
    // officer looking at two records that are each perfectly reasonable.
    expect(error.message).toContain('Kofi Boateng (RH-0010)');
    expect(error.message).toMatch(/Adwoa Frimpong \(RH-0011\) already reports to Akosua Darko/);
  });

  it('stops the loop at the employee rather than carrying the whole line', () => {
    // Yaw and Kwame are above Akosua and are not part of the loop. Including
    // them would name two people who have done nothing wrong.
    const error = cycle(() => assertNoManagerCycle(AKOSUA, ABOVE_ADWOA));

    expect(error.loop.map((one) => one.firstName)).not.toContain('Kwame');
    expect(error.loop.map((one) => one.firstName)).not.toContain('Yaw');
  });

  it('refuses inverting the whole organisation onto the head of it', () => {
    // Kwame given a manager from the bottom of his own tree. Every line in the
    // company runs through this loop.
    const error = cycle(() => assertNoManagerCycle(KWAME, ABOVE_ADWOA));

    expect(error.loop).toHaveLength(5);
  });

  it('treats the degenerate loop of one as a loop', () => {
    // Adwoa given herself. validateEmployeeChanges refuses this earlier with a
    // message about the field, and employee_not_own_manager refuses it at the
    // database, so this is the third of three. It is asserted because a rule
    // that is right for the general case and wrong for the smallest one is the
    // usual shape of an off by one.
    const error = cycle(() => assertNoManagerCycle(ADWOA, ABOVE_ADWOA));

    expect(error.loop).toEqual([ADWOA]);
  });

  it('accepts a walk that found nobody, because that is a different problem', () => {
    // An id that is nobody gives an empty chain. The service turns that into
    // ManagerNotFound; it is not this rule's to report.
    expect(() => assertNoManagerCycle(ADWOA, [])).not.toThrow();
  });

  it('still says something usable when it has no names to give', () => {
    // How the repository raises it: the deferred trigger fires at COMMIT with
    // the transaction rolled back, so there is no state left to walk.
    expect(new ManagerCycle().message).toMatch(/close a loop/);
    expect(new ManagerCycle().loop).toEqual([]);
  });
});

describe('the standing check on reporting lines, FR 02 and FR 04', () => {
  /**
   * The other half of the warning HR gets. The refusals above fire in front of
   * whoever is drawing a bad line; this fires for a line that was fine when it
   * was drawn and is not any more, which nothing at write time can see.
   */

  const CEO: Employee = { ...STORED, id: '1', employeeNumber: 'RH-0001', firstName: 'Kwame' };
  const LEAVER: Employee = {
    ...STORED,
    id: '2',
    employeeNumber: 'RH-0002',
    firstName: 'Kojo',
    lastName: 'Antwi',
    managerId: '1',
    employmentStatus: 'TERMINATED',
    exitDate: '2026-07-31',
  };
  const REPORT: Employee = {
    ...STORED,
    id: '3',
    employeeNumber: 'RH-0003',
    firstName: 'Adwoa',
    managerId: '2',
  };

  const SOUND: ReportingLines = { total: 3, rootless: [CEO], reportingToLeavers: [] };

  it('says nothing at all about an organisation whose lines are sound', () => {
    // The useful shape of a passing check: an empty list, not a list of
    // reassurances somebody has to read past to find the one that matters.
    expect(warnAboutReportingLines(SOUND)).toEqual([]);
  });

  it('warns when a second record has no line manager, and names them both', () => {
    const warnings = warnAboutReportingLines({ ...SOUND, rootless: [CEO, REPORT] });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('SECOND_ROOT');
    expect(warnings[0].employeeIds).toEqual(['1', '3']);
    // Naming them is the point. "Somebody has no manager" is not something an
    // HR officer can act on.
    expect(warnings[0].message).toContain('RH-0001');
    expect(warnings[0].message).toContain('RH-0003');
  });

  it('warns when nobody is the head of the organisation', () => {
    const warnings = warnAboutReportingLines({ ...SOUND, rootless: [] });

    expect(warnings.map((warning) => warning.code)).toEqual(['NO_ROOT']);
    // Not "somebody forgot the CEO". With manager_id a foreign key to the same
    // table and no NULL in it, every upward walk is infinite over a finite set.
    expect(warnings[0].message).toMatch(/loops back on itself/);
  });

  it('says nothing about an empty table, which is not a broken organisation', () => {
    expect(warnAboutReportingLines({ total: 0, rootless: [], reportingToLeavers: [] })).toEqual([]);
  });

  it('warns about somebody whose manager has left, and says when they left', () => {
    const warnings = warnAboutReportingLines({
      ...SOUND,
      reportingToLeavers: [{ employee: REPORT, manager: LEAVER }],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('MANAGER_HAS_LEFT');
    expect(warnings[0].employeeIds).toEqual(['3', '2']);
    expect(warnings[0].message).toContain('2026-07-31');
  });

  it('reports every problem it finds rather than the first one', () => {
    // A list HR works through, not an exception that stops at the earliest
    // failure and hides the other four.
    const warnings = warnAboutReportingLines({
      total: 3,
      rootless: [CEO, REPORT],
      reportingToLeavers: [{ employee: REPORT, manager: LEAVER }],
    });

    expect(warnings.map((warning) => warning.code)).toEqual(['SECOND_ROOT', 'MANAGER_HAS_LEFT']);
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

describe('deactivating a record, FR 06', () => {
  const LEAVER: Employee = {
    ...STORED,
    employmentStatus: 'TERMINATED',
    exitDate: '2026-11-30',
  };

  it('is a status and a date, and nothing else', () => {
    // The whole of what "deactivated" means. Every other field is left as it is,
    // because keeping the record is the point of not deleting it.
    expect(planTermination(STORED, { exitDate: '2026-11-30' })).toEqual({
      employmentStatus: 'TERMINATED',
      exitDate: '2026-11-30',
    });
  });

  it('cannot record the status without the date', () => {
    // Not a rule that is checked so much as a shape that cannot express it: the
    // two arrive together or not at all. A TERMINATED record with no exit date
    // is one FR 37a cannot settle a final figure from.
    const error = refusal(() =>
      planTermination(STORED, { exitDate: undefined as unknown as string }),
    );

    expect(error.field).toBe('exitDate');
  });

  it('refuses an exit date before the day they started', () => {
    const error = refusal(() => planTermination(STORED, { exitDate: '2026-08-31' }));

    expect(error.field).toBe('exitDate');
    expect(error.message).toMatch(/before the start date/);
  });

  it('refuses an exit date that never happened', () => {
    expect(() => planTermination(STORED, { exitDate: '2026-02-31' })).toThrow(/not a real date/);
  });

  it('refuses to terminate somebody who has already left, and says when they did', () => {
    // Through a general update this would be a silent overwrite of the first
    // exit date, which is how a leaver's final figure changes months after it
    // was agreed.
    let thrown: unknown;
    try {
      planTermination(LEAVER, { exitDate: '2026-12-31' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AlreadyTerminated);
    expect((thrown as AlreadyTerminated).exitDate).toBe('2026-11-30');
  });

  it('ends a suspended employment as readily as an active one', () => {
    // Being suspended is not being gone. People do leave from it, and refusing
    // would leave the record stuck in a status nothing can move it out of.
    const suspended: Employee = { ...STORED, employmentStatus: 'SUSPENDED' };

    expect(planTermination(suspended, { exitDate: '2026-11-30' }).employmentStatus).toBe(
      'TERMINATED',
    );
  });

  it('accepts an exit date still to come, for paperwork done in advance', () => {
    // HR does the Friday paperwork for a Sunday exit. Refusing would push them
    // to wait or to enter a date that is not the real one, and the exit date is
    // what the final figure is calculated from.
    expect(planTermination(STORED, { exitDate: '2099-01-01' }).exitDate).toBe('2099-01-01');
  });

  it('leaves correcting a termination to an ordinary edit', () => {
    // The record was never deleted, so somebody terminated by mistake goes back
    // to ACTIVE with the exit date cleared. There is no re-creation, no new id,
    // and no history left pointing at a row that is gone.
    expect(
      validateEmployeeChanges({ employmentStatus: 'ACTIVE', exitDate: null }, LEAVER, DOMAINS),
    ).toEqual({ employmentStatus: 'ACTIVE', exitDate: null });
  });
});
