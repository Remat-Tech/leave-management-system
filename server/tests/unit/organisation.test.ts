import { describe, expect, it } from 'vitest';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import type { Actor } from '../../src/auth/actor.js';
import type { Employee } from '../../src/features/employee/employee.js';
import {
  ChiefExecutiveCannotBeCleared,
  ChiefExecutiveHasLeft,
  isReadyForGoLive,
  type OrganisationSettings,
  readChiefExecutiveId,
  whyTheyCannotBeNamed,
} from '../../src/features/organisation/organisation.js';
import { organisationPolicy } from '../../src/features/organisation/policy.js';
import { ROLE_CODES, type RoleCode } from '../../src/features/role/roles.js';

/** Who the Chief Executive is, as rules. FR 48c, FR 04, §4.3.1, LMS 321. */

describe('naming somebody', () => {
  it('takes an employee id', () => {
    expect(readChiefExecutiveId('17')).toBe('17');
    expect(readChiefExecutiveId('  17  ')).toBe('17');
  });

  /* The setting is changed, never cleared: an empty seat is a stage no request can be sent
     to, and FR 48b already routes round one whose holder has left. */
  it('refuses an empty box rather than writing a null through', () => {
    for (const nothing of ['', '   ', null, undefined, 17]) {
      expect(() => readChiefExecutiveId(nothing)).toThrow(ChiefExecutiveCannotBeCleared);
    }
  });

  it('refuses somebody who has left', () => {
    expect(whyTheyCannotBeNamed(employee('TERMINATED'))).toBeInstanceOf(ChiefExecutiveHasLeft);
  });

  it('and accepts anybody still here, whatever their job title says', () => {
    expect(whyTheyCannotBeNamed(employee('ACTIVE', 'Head of Facilities'))).toBeNull();
    expect(whyTheyCannotBeNamed(employee('ACTIVE', null))).toBeNull();
  });

  /* The whole of the story. A title is a label somebody edits on a Tuesday; the setting names
     a record. Nothing in this feature reads `jobTitle` at all, and this is that assertion. */
  it('never reads a job title to decide who they are', () => {
    const chiefExecutive = employee('ACTIVE', 'Chief Executive Officer');
    const retitled = { ...chiefExecutive, jobTitle: 'Group Chief Executive' };

    expect(whyTheyCannotBeNamed(retitled)).toEqual(whyTheyCannotBeNamed(chiefExecutive));
  });
});

describe('being ready to go live', () => {
  it('is somebody being named', () => {
    expect(isReadyForGoLive(settings('17'))).toBe(true);
  });

  it('and is not a database nobody has configured', () => {
    expect(isReadyForGoLive(settings(null))).toBe(false);
  });

  /* Named and since departed is a configured organisation with a succession to do, which is a
     different sentence and a different fix. FR 48b routes their desk round in the meantime. */
  it('and stays true once somebody has been named, whatever became of them', () => {
    expect(isReadyForGoLive(settings('17'))).toBe(true);
  });
});

describe('who may change it', () => {
  /* SETS_UP_THE_ORGANISATION, which is the HR Administrator alone. Narrower than the roles
     that maintain employee records on purpose: an officer edits people, and this edits where
     every unpaid request in the company is sent. */
  it('is the HR Administrator', () => {
    expect(organisationPolicy.nameTheChiefExecutive(who('HR_ADMIN'), '17').allowed).toBe(true);
  });

  it('and is nobody else, including an HR Officer', () => {
    const others = ROLE_CODES.filter((code) => code !== 'HR_ADMIN');

    for (const code of others) {
      expect(organisationPolicy.nameTheChiefExecutive(who(code), '17').allowed, code).toBe(false);
    }
  });

  /* Refused openly, because saying so discloses nothing and the person needs to know who to
     ask. */
  it('and says so, rather than refusing silently', () => {
    const refusal = organisationPolicy.nameTheChiefExecutive(who('HR_OFFICER'), '17');

    expect(refusal.told).toContain('HR Administrator');
  });

  it('and the system may, as it may everything', () => {
    expect(organisationPolicy.nameTheChiefExecutive(theSystem('a migration'), '17').allowed).toBe(
      true,
    );
  });
});

describe('who may see it', () => {
  /* The request form already tells the person asking that unpaid leave goes to the Chief
     Executive, so the name behind that desk is not a disclosure. */
  it('is everybody signed in', () => {
    for (const code of ROLE_CODES) {
      expect(organisationPolicy.read(who(code)).allowed, code).toBe(true);
    }
  });
});

function settings(chiefExecutiveId: string | null): OrganisationSettings {
  return { chiefExecutiveId, updatedAt: new Date('2026-09-03T00:00:00Z') };
}

function who(...roles: RoleCode[]): Actor {
  return signedInAs('99', { roles, isManager: false });
}

function employee(
  employmentStatus: Employee['employmentStatus'],
  jobTitle: string | null = 'Chief Executive Officer',
): Employee {
  return {
    id: '17',
    employeeNumber: 'RH-0001',
    firstName: 'Kwame',
    lastName: 'Asante',
    workEmail: 'kwame.asante@rematholdings.com',
    jobTitle,
    departmentId: '1',
    managerId: null,
    workPatternId: '1',
    startDate: '2014-02-03',
    exitDate: employmentStatus === 'TERMINATED' ? '2026-08-31' : null,
    employmentType: 'FULL_TIME',
    employmentStatus,
    gender: 'MALE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
