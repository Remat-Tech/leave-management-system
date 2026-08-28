import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  BASELINE_ROLE,
  LastSystemAdministrator,
  orderRoles,
  readAssignableRoleCode,
  readRoleCode,
  RoleCannotBeRevoked,
  ROLE_CODES,
  RoleNotHeld,
  UnknownRole,
} from '../../src/auth/roles.js';

/**
 * Roles, §5.3, LMS 111.
 *
 * The rules, with no database. Two properties are worth pinning down here and
 * both are the kind that stop being true quietly: that the set of roles is
 * closed, and that MANAGER never becomes one of them.
 */

describe('the four roles', () => {
  it('is exactly the set the story names', () => {
    expect(ROLE_CODES).toEqual(['EMPLOYEE', 'HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN']);
  });

  it('does not include MANAGER, and never can', () => {
    /* The story's third criterion. Being a manager is a relationship — you are
       one if some employee has your id as their manager_id — and holding it here
       as well would be two sources of truth that disagree the moment somebody
       changes team. */
    expect(ROLE_CODES).not.toContain('MANAGER');
  });

  it('offers everything but the baseline as a choice', () => {
    // EMPLOYEE is not a tick box. Everybody with a login has it, and offering it
    // unticked would be a lie about what the system does.
    expect(ASSIGNABLE_ROLES).toEqual(['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN']);
    expect(ASSIGNABLE_ROLES).not.toContain(BASELINE_ROLE);
  });
});

describe('reading a role code', () => {
  it.each([...ROLE_CODES])('accepts %s', (code) => {
    expect(readRoleCode(code)).toBe(code);
  });

  it('forgives the case and spacing a form introduces', () => {
    expect(readRoleCode('  hr_admin  ')).toBe('HR_ADMIN');
  });

  it('refuses MANAGER with the reason rather than a list', () => {
    /* The one wrong answer somebody will actually try, and the one where "that is
       not a role" on its own would leave them looking for where to grant it. */
    const error = new UnknownRole('MANAGER');

    expect(error.message).toMatch(/not a role/i);
    expect(error.message).toMatch(/reports to them/i);
    expect(error.message).toMatch(/who reports to whom/i);
  });

  it.each([
    ['a role that does not exist', 'PAYROLL_ADMIN'],
    ['a near miss', 'HR_ADMINISTRATOR'],
    ['manager in any case', 'manager'],
    ['empty', ''],
    ['nothing at all', undefined],
    ['a number', 4],
  ])('refuses %s', (_label, value) => {
    expect(() => readRoleCode(value)).toThrow(UnknownRole);
  });

  it('lists the real roles when refusing something unrecognised', () => {
    expect(() => readRoleCode('PAYROLL_ADMIN')).toThrow(/EMPLOYEE, HR_OFFICER/);
  });
});

describe('reading a role somebody may be given or lose', () => {
  it.each([...ASSIGNABLE_ROLES])('accepts %s', (code) => {
    expect(readAssignableRoleCode(code)).toBe(code);
  });

  it('refuses the baseline, and says what was probably meant', () => {
    const error = new RoleCannotBeRevoked(BASELINE_ROLE);

    expect(() => readAssignableRoleCode('EMPLOYEE')).toThrow(RoleCannotBeRevoked);
    expect(error.message).toMatch(/close their account/i);
  });

  it('still refuses an unknown code', () => {
    expect(() => readAssignableRoleCode('MANAGER')).toThrow(UnknownRole);
  });
});

describe('ordering roles', () => {
  it('reads as an escalation rather than as an alphabet', () => {
    /* Alphabetically HR_ADMIN comes before HR_OFFICER, which is the reverse of
       what it means. The most significant role is last wherever it is shown. */
    expect(orderRoles(['SYS_ADMIN', 'EMPLOYEE', 'HR_OFFICER'])).toEqual([
      'EMPLOYEE',
      'HR_OFFICER',
      'SYS_ADMIN',
    ]);
  });

  it('is the same order however the database returned them', () => {
    expect(orderRoles(['HR_ADMIN', 'EMPLOYEE'])).toEqual(orderRoles(['EMPLOYEE', 'HR_ADMIN']));
  });

  it('drops anything it does not recognise', () => {
    // Cannot happen: role_code_known refuses it. If it ever does, the safe
    // reading of a role nothing understands is that it grants nothing.
    expect(orderRoles(['EMPLOYEE', 'MANAGER', 'ROOT'])).toEqual(['EMPLOYEE']);
  });

  it('gives nothing back for nobody', () => {
    expect(orderRoles([])).toEqual([]);
  });
});

describe('what a refusal says', () => {
  it('explains why the last administrator cannot go', () => {
    const { message } = new LastSystemAdministrator();

    expect(message).toMatch(/only System Administrator/i);
    // The instruction, not just the objection.
    expect(message).toMatch(/give somebody else the role first/i);
  });

  it('says there is nothing to take away when they never had it', () => {
    expect(new RoleNotHeld('HR_OFFICER').message).toMatch(/do not hold HR_OFFICER/i);
  });
});
