import { describe, expect, it } from 'vitest';
import {
  assertCanDeactivate,
  assertCanTakeEmployees,
  type Department,
  DepartmentDeactivated,
  DepartmentStillStaffed,
  InvalidDepartment,
  validateDepartmentChanges,
  validateNewDepartment,
} from '../../src/domain/department.js';

/**
 * The rules for a department, checked without a database. LMS 105.
 *
 * The database holds the same rules as a CHECK and a unique index and refuses
 * the same records; that is asserted in the integration suite. What is asserted
 * here is that the refusal happens before the write and says which field was
 * wrong, because "duplicate key value violates unique constraint
 * department_name_unique" is not something to put in front of an HR officer.
 */

const OPERATIONS: Department = {
  id: '5',
  name: 'Operations',
  parentId: null,
  isActive: true,
  createdAt: new Date('2026-08-27T09:00:00Z'),
  updatedAt: new Date('2026-08-27T09:00:00Z'),
};

const CLOSED: Department = { ...OPERATIONS, name: 'Legacy Operations', isActive: false };

function refusal(fn: () => unknown): InvalidDepartment {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidDepartment) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the department to be refused, but it was accepted.');
}

describe('creating a department', () => {
  it('keeps the name it was given', () => {
    expect(validateNewDepartment({ name: 'Operations' })).toEqual({ name: 'Operations' });
  });

  it('trims the whitespace a copied and pasted name arrives with', () => {
    // A department name comes off a spreadsheet more often than it is typed, and
    // a leading space is not something to make somebody hunt for.
    expect(validateNewDepartment({ name: '  Operations  ' }).name).toBe('Operations');
  });

  it('keeps the capitalisation it was given', () => {
    // Compared folded, stored as written. 'Product & Engineering' is what goes
    // at the top of a report.
    expect(validateNewDepartment({ name: 'Product & Engineering' }).name).toBe(
      'Product & Engineering',
    );
  });

  it('refuses a department with no name, and says which field', () => {
    expect(refusal(() => validateNewDepartment({ name: '   ' })).field).toBe('name');
    expect(
      refusal(() => validateNewDepartment({ name: undefined as unknown as string })).field,
    ).toBe('name');
  });

  it('refuses a name longer than the column holds', () => {
    const error = refusal(() => validateNewDepartment({ name: 'a'.repeat(121) }));

    expect(error.field).toBe('name');
    expect(error.message).toMatch(/120 characters/);
  });
});

describe('editing a department', () => {
  it('changes only the field it was given', () => {
    expect(validateDepartmentChanges({ name: 'Operations & Logistics' })).toEqual({
      name: 'Operations & Logistics',
    });
  });

  it('treats a change mentioning nothing as changing nothing', () => {
    // Not an error. It is the caller having submitted a form they did not touch,
    // and the record should come back as it stands rather than be rewritten.
    expect(validateDepartmentChanges({})).toEqual({});
  });

  it('refuses renaming one to nothing', () => {
    expect(refusal(() => validateDepartmentChanges({ name: '  ' })).field).toBe('name');
  });
});

describe('closing a department', () => {
  it('is allowed once nobody is in it', () => {
    expect(() => assertCanDeactivate(OPERATIONS, 0)).not.toThrow();
  });

  it('is refused while somebody still is, and says how many', () => {
    /* employee.department_id is NOT NULL, so closing a team cannot move the
       people out of it. They would go on being counted under a heading that no
       report offers as a choice, which is the hole this refusal exists to keep
       shut. */
    let thrown: unknown;
    try {
      assertCanDeactivate(OPERATIONS, 4);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DepartmentStillStaffed);
    expect((thrown as DepartmentStillStaffed).headcount).toBe(4);
    // "Move them first" is only actionable if HR knows how many to look for.
    expect((thrown as Error).message).toMatch(/Operations still has 4 people/);
  });

  it('counts one person as a person', () => {
    // The message is read by somebody, so it says "1 person ... move them"
    // rather than "1 people ... move them all".
    const error = (() => {
      try {
        assertCanDeactivate(OPERATIONS, 1);
      } catch (thrown) {
        return thrown as Error;
      }
      throw new Error('Expected a refusal.');
    })();

    expect(error.message).toMatch(/1 person/);
    expect(error.message).not.toMatch(/them all/);
  });

  it('lets an already closed department be closed again', () => {
    /* Deliberately unlike terminating an employee twice, which is refused. There
       the second attempt writes a new exit date over the one a final figure was
       settled from; here it writes the same boolean it already holds. */
    expect(() => assertCanDeactivate(CLOSED, 0)).not.toThrow();
  });
});

describe('who may be put into a department', () => {
  it('anybody, while it is open', () => {
    expect(() => assertCanTakeEmployees(OPERATIONS)).not.toThrow();
  });

  it('nobody, once it is closed', () => {
    // The other end of the same invariant: nothing moves people into a closed
    // team, and nothing closes a team with people in it.
    let thrown: unknown;
    try {
      assertCanTakeEmployees(CLOSED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DepartmentDeactivated);
    expect((thrown as DepartmentDeactivated).departmentId).toBe('5');
    expect((thrown as Error).message).toMatch(/reopen this one/);
  });
});
