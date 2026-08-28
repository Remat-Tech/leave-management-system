import { describe, expect, it } from 'vitest';
import { type Actor, holdsAny, isSelf, signedInAs, theSystem } from '../../src/auth/actor.js';
import { departmentPolicy } from '../../src/auth/department-policy.js';
import { employeePolicy } from '../../src/auth/employee-policy.js';
import { MANDATORY_ROLES } from '../../src/auth/mfa.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised, policyFor } from '../../src/auth/policy.js';
import { rolePolicy } from '../../src/auth/role-policy.js';
import {
  ADMINISTERS_ACCESS,
  MAINTAINS_EMPLOYEE_RECORDS,
  PROVIDES_LOGINS,
  READS_EVERY_RECORD,
  type RoleCode,
  ROLE_CODES,
  SETS_UP_THE_ORGANISATION,
} from '../../src/auth/roles.js';
import { signInPolicy } from '../../src/auth/sign-in-policy.js';
import { workPatternPolicy } from '../../src/auth/work-pattern-policy.js';
import { denialsNowhere } from '../../src/auth/denials.js';
import { recordingDenials } from '../support/recording-denials.js';
import type { Employee } from '../../src/domain/employee.js';

/**
 * Authorisation, with no database. NFR SEC 02 and NFR SEC 03. §10. LMS 112.
 *
 * This is where the real coverage of the story lives, and that is the dividend
 * of policies being pure functions: the whole matrix of who may do what is
 * arithmetic, so it can be enumerated rather than sampled. An integration suite
 * can show that the services ask; only this can show that the answers are right
 * for everybody.
 *
 * Four properties are worth stating, because each is the kind that stops being
 * true silently:
 *
 *   Every role is tested against every action, by iterating ROLE_CODES rather
 *   than by naming the cases somebody thought of. A fifth role added without a
 *   decision about what it may do fails here.
 *
 *   A refusal that would disclose whether a record exists says nothing.
 *
 *   Being a manager is read off the record and never from a role.
 *
 *   Every refusal reaches the log, with the reason, and with nothing from the
 *   record in it.
 */

/** Somebody who holds nothing beyond the baseline. The ordinary member of staff. */
function employee(id: string, roles: RoleCode[] = ['EMPLOYEE']): Actor {
  return signedInAs(id, { roles, isManager: false });
}

/** The same, with somebody reporting to them. */
function manager(id: string, roles: RoleCode[] = ['EMPLOYEE']): Actor {
  return signedInAs(id, { roles, isManager: true });
}

/** A record, with only the fields any policy reads filled in honestly. */
function record(id: string, managerId: string | null = 'kwame'): Employee {
  return {
    id,
    employeeNumber: `RH-${id}`,
    firstName: 'A',
    lastName: 'Person',
    workEmail: `${id}@rematholdings.com`,
    jobTitle: null,
    departmentId: 'operations',
    managerId,
    workPatternId: 'standard',
    startDate: '2026-01-05',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Every role, one at a time, as an actor who holds it and the baseline. */
const EACH_ROLE = ROLE_CODES.map((code) =>
  code === 'EMPLOYEE' ? ['EMPLOYEE', ['EMPLOYEE']] : [code, ['EMPLOYEE', code]],
) as [RoleCode, RoleCode[]][];

/** The roles that are *not* in a group, which is the half a test usually forgets. */
function outside(group: readonly RoleCode[]): RoleCode[] {
  return ROLE_CODES.filter((code) => !group.includes(code));
}

describe('who an actor is', () => {
  it('is nobody when it is the system, so no record can be its own', () => {
    /* The property the null employeeId exists for. A system actor holds every
       role and must still never match a person, or a policy that checks "is this
       mine" would pass for a job running unattended. */
    const jobs = theSystem('nightly reminders');

    expect(jobs.employeeId).toBeNull();
    expect(isSelf(jobs, null)).toBe(false);
    expect(isSelf(jobs, 'ama')).toBe(false);
  });

  it('holds every role when it is the system, rather than a flag policies branch on', () => {
    // A branch in every policy is a branch one policy forgets, and the
    // forgetting is silent. See theSystem().
    const jobs = theSystem('the seed');

    for (const code of ROLE_CODES) {
      expect(holdsAny(jobs, code)).toBe(true);
    }
  });

  it('says what it is for, so a refused job is identifiable in the log', () => {
    expect(theSystem('nightly reminders').description).toContain('nightly reminders');
  });

  it('carries no name and no address for a person, only the id', () => {
    /* The denial log is the thing that reads this, and a log of refusals is a
       poor place to accumulate staff details. See ../../src/auth/denials.ts. */
    const ama = employee('ama');

    expect(ama.description).toContain('ama');
    expect(ama.description).not.toMatch(/@/);
  });

  it('takes a copy of the roles, so a later edit cannot widen an actor in flight', () => {
    const granted: RoleCode[] = ['EMPLOYEE'];
    const ama = signedInAs('ama', { roles: granted, isManager: false });

    granted.push('SYS_ADMIN');

    expect(ama.roles).toEqual(['EMPLOYEE']);
  });
});

describe('an employee record', () => {
  const ama = employee('ama');
  const hers = record('ama');

  it('is readable by the person it is about', () => {
    // The whole reason Actor carries an employeeId: everybody can use the system
    // without anybody granting them anything.
    expect(employeePolicy.read(ama, hers).allowed).toBe(true);
  });

  it('is readable by their line manager, from the record and not from a role', () => {
    /* The story's third criterion cashed in. Akosua holds no role at all; she is
       an approver because the record in hand names her. */
    const akosua = manager('akosua');
    const report = record('kojo', 'akosua');

    expect(akosua.roles).toEqual(['EMPLOYEE']);
    expect(employeePolicy.read(akosua, report).allowed).toBe(true);
  });

  it('is not readable by somebody who merely manages other people', () => {
    /* isManager is true of her, and it buys nothing on this record. Authorisation
       asks "is this person one of my reports", never "do they have the manager
       role" — and this is the test that keeps those different. */
    const akosua = manager('akosua');

    expect(employeePolicy.read(akosua, record('kojo', 'kofi')).allowed).toBe(false);
  });

  it('is not readable by a colleague, whatever they guess', () => {
    // The story. A colleague with an id in hand gets nothing.
    expect(employeePolicy.read(employee('adwoa'), hers).allowed).toBe(false);
  });

  it('is readable by exactly the roles that read everybody', () => {
    for (const [code, roles] of EACH_ROLE) {
      const other = employee('adwoa', roles);

      expect(employeePolicy.read(other, hers).allowed).toBe(READS_EVERY_RECORD.includes(code));
    }
  });

  it('tells a stranger nothing about why, not even which record it was about', () => {
    /* The disclosure this story exists to prevent. A refusal that names the
       record is a refusal that confirms the record. */
    const refusal = employeePolicy.read(employee('adwoa'), hers);

    expect(refusal.told).toBeNull();
    expect(new NotAuthorised({ ...blankAttempt, subject: hers.id }, refusal.told).message).toBe(
      NOT_AUTHORISED_MESSAGE,
    );
  });

  it('is not readable by the manager of the manager', () => {
    /* Direct reports and not the subtree. A deliberate line, argued in
       ../../src/auth/employee-policy.ts, and one somebody will want to move —
       when they do, this test is where the decision is recorded. */
    const kwame = manager('kwame');

    expect(employeePolicy.read(kwame, record('kojo', 'akosua')).allowed).toBe(false);
  });
});

describe('changing an employee record', () => {
  it('is refused for the person it is about, however senior they are', () => {
    /* Reading yours is the point of the system; writing yours is what HR is for.
       A start date is a figure somebody's entitlement is calculated from. */
    for (const [, roles] of EACH_ROLE) {
      const them = employee('ama', roles);
      const decision = employeePolicy.update(them, record('ama'));

      expect(decision.allowed).toBe(MAINTAINS_EMPLOYEE_RECORDS.some((r) => roles.includes(r)));
    }
  });

  it('is allowed for exactly the roles that maintain records', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(employeePolicy.update(them, record('ama')).allowed).toBe(
        MAINTAINS_EMPLOYEE_RECORDS.includes(code),
      );
      expect(employeePolicy.create(them).allowed).toBe(MAINTAINS_EMPLOYEE_RECORDS.includes(code));
      expect(employeePolicy.terminate(them, record('ama')).allowed).toBe(
        MAINTAINS_EMPLOYEE_RECORDS.includes(code),
      );
    }
  });

  it('is refused to a System Administrator, who may read everything and write nothing here', () => {
    // The split the two constants exist to make: keeping the system running is
    // not deciding that somebody has left the company.
    const sys = employee('kofi', ['EMPLOYEE', 'SYS_ADMIN']);

    expect(employeePolicy.read(sys, record('ama')).allowed).toBe(true);
    expect(employeePolicy.update(sys, record('ama')).allowed).toBe(false);
    expect(employeePolicy.terminate(sys, record('ama')).allowed).toBe(false);
  });

  it('says which rule refused, but only to somebody who can already see the record', () => {
    /* The two kinds of refusal, and the reason there are two. A line manager
       looking at their report is told what the rule is; a stranger is not told
       that there is a record at all. */
    const akosua = manager('akosua');
    const report = record('kojo', 'akosua');

    expect(employeePolicy.update(akosua, report).told).toMatch(/HR/);
    expect(employeePolicy.update(employee('adwoa'), report).told).toBeNull();
  });

  it('gives the same nothing for a record you cannot see and a record that is not there', () => {
    /* Both halves of the existence oracle, closed. The service consults
       `search` before reporting a record missing — see
       EmployeeService.findOrRefuse — so an id that is nobody and an id that is
       somebody else produce one indistinguishable refusal. */
    const adwoa = employee('adwoa');

    expect(employeePolicy.search(adwoa).allowed).toBe(false);
    expect(employeePolicy.search(adwoa).told).toBeNull();
    expect(employeePolicy.read(adwoa, record('ama')).told).toBeNull();
  });
});

describe('searching for people', () => {
  it('is HR, because a lookup by number or address is a staff list', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = READS_EVERY_RECORD.includes(code);

      expect(employeePolicy.search(them).allowed).toBe(allowed);
      expect(employeePolicy.list(them).allowed).toBe(allowed);
      expect(employeePolicy.warnings(them).allowed).toBe(allowed);
    }
  });

  it('is not opened by managing somebody', () => {
    // A manager may see their reports. That is not a directory.
    expect(employeePolicy.list(manager('akosua')).allowed).toBe(false);
    expect(employeePolicy.search(manager('akosua')).allowed).toBe(false);
  });
});

describe('importing staff', () => {
  it('needs the same standing as creating one record at a time', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(employeePolicy.importStaff(employee('adwoa', roles)).allowed).toBe(
        MAINTAINS_EMPLOYEE_RECORDS.includes(code),
      );
    }
  });
});

describe('departments and working patterns', () => {
  it('are readable by anybody signed in, because every screen shows them', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(departmentPolicy.read(them, 'operations').allowed).toBe(true);
      expect(departmentPolicy.list(them).allowed).toBe(true);
      expect(workPatternPolicy.read(them, 'standard').allowed).toBe(true);
      expect(workPatternPolicy.list(them).allowed).toBe(true);
    }
  });

  it('are written by an HR Administrator and nobody else', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = SETS_UP_THE_ORGANISATION.includes(code);

      expect(departmentPolicy.create(them).allowed).toBe(allowed);
      expect(departmentPolicy.update(them, 'operations').allowed).toBe(allowed);
      expect(departmentPolicy.close(them, 'operations').allowed).toBe(allowed);
      expect(departmentPolicy.reopen(them, 'operations').allowed).toBe(allowed);

      expect(workPatternPolicy.create(them).allowed).toBe(allowed);
      expect(workPatternPolicy.update(them, 'standard').allowed).toBe(allowed);
      expect(workPatternPolicy.makeDefault(them, 'standard').allowed).toBe(allowed);
      expect(workPatternPolicy.remove(them, 'standard').allowed).toBe(allowed);
    }
  });

  it('keep the headcount back, because a count of people is about people', () => {
    /* The one read here that is not open. "How many are still employed in Legal"
       answered for everybody is a redundancy watch, and a small count on an
       unusual working week is close to naming somebody. */
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = READS_EVERY_RECORD.includes(code);

      expect(departmentPolicy.headcount(them, 'operations').allowed).toBe(allowed);
      expect(workPatternPolicy.headcount(them, 'standard').allowed).toBe(allowed);
    }
  });

  it('refuse a write openly, because there is nobody to keep the team name from', () => {
    const adwoa = employee('adwoa');

    expect(departmentPolicy.close(adwoa, 'operations').told).toMatch(/HR Administrator/);
    expect(workPatternPolicy.update(adwoa, 'standard').told).toMatch(/HR Administrator/);
  });
});

describe('assigning roles', () => {
  const hrAdmin = employee('ama', ['EMPLOYEE', 'HR_ADMIN']);
  const sysAdmin = employee('kofi', ['EMPLOYEE', 'SYS_ADMIN']);

  it('is administrators, and enforces the sentence LMS 111 left unenforced', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(rolePolicy.grant(them, 'kojo', 'HR_OFFICER').allowed).toBe(
        ADMINISTERS_ACCESS.includes(code),
      );
      expect(rolePolicy.revoke(them, 'kojo', 'HR_OFFICER').allowed).toBe(
        ADMINISTERS_ACCESS.includes(code),
      );
    }
  });

  it('hands the master key on only from somebody holding it', () => {
    /* Otherwise "administrators appoint administrators" is "the lock can be
       picked from the next room". The database refuses the last SYS_ADMIN being
       removed; this is the other end of the same concern. */
    expect(rolePolicy.grant(hrAdmin, 'kojo', 'SYS_ADMIN').allowed).toBe(false);
    expect(rolePolicy.revoke(hrAdmin, 'kojo', 'SYS_ADMIN').allowed).toBe(false);

    expect(rolePolicy.grant(sysAdmin, 'kojo', 'SYS_ADMIN').allowed).toBe(true);
    expect(rolePolicy.revoke(sysAdmin, 'kojo', 'SYS_ADMIN').allowed).toBe(true);
  });

  it('says it was the role and not the person, so an administrator is not left guessing', () => {
    expect(rolePolicy.grant(hrAdmin, 'kojo', 'SYS_ADMIN').told).toMatch(/System Administrator/);
  });

  it('refuses everybody their own roles, whatever they hold', () => {
    /* The story's "so that", taken literally: a power somebody granted themselves
       is a power nobody granted. It also costs an attacker a second account. */
    expect(rolePolicy.grant(sysAdmin, 'kofi', 'HR_ADMIN').allowed).toBe(false);
    expect(rolePolicy.revoke(sysAdmin, 'kofi', 'SYS_ADMIN').allowed).toBe(false);
    expect(rolePolicy.grant(hrAdmin, 'ama', 'HR_OFFICER').allowed).toBe(false);
    expect(rolePolicy.grant(sysAdmin, 'kofi', 'HR_ADMIN').told).toMatch(/your own roles/i);
  });

  it('does not refuse the system, which is nobody and so is never itself', () => {
    // The bootstrap. A seed or a migration granting the first role is not
    // somebody granting themselves anything.
    const jobs = theSystem('the seed');

    expect(rolePolicy.grant(jobs, 'kwame', 'SYS_ADMIN').allowed).toBe(true);
  });

  it('lets anybody read their own roles and nobody else read them', () => {
    const ama = employee('ama');

    expect(rolePolicy.read(ama, 'ama').allowed).toBe(true);
    expect(rolePolicy.read(ama, 'kojo').allowed).toBe(false);
    expect(rolePolicy.read(hrAdmin, 'kojo').allowed).toBe(true);
  });

  it('does not let a line manager see what their report holds', () => {
    // Routing an approval needs to know somebody is a report. It does not need
    // to know they are also an HR Administrator.
    expect(rolePolicy.read(manager('akosua'), 'kojo').allowed).toBe(false);
  });

  it('keeps the list of who holds a role to the people who could act on it', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(rolePolicy.holders(employee('adwoa', roles), 'SYS_ADMIN').allowed).toBe(
        ADMINISTERS_ACCESS.includes(code),
      );
    }
  });

  it('leaves the four roles themselves open, being four codes and four names', () => {
    expect(rolePolicy.list(employee('adwoa')).allowed).toBe(true);
  });
});

describe('logins', () => {
  it('are created and reset by HR, so that a joiner is not waiting on a ticket', () => {
    /* The boundary that was argued about. A rule that turns a two minute job into
       a ticket is a rule that produces a shared administrator password by March. */
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = PROVIDES_LOGINS.includes(code);

      expect(signInPolicy.provision(them, 'kojo').allowed).toBe(allowed);
      expect(signInPolicy.setPassword(them, 'kojo').allowed).toBe(allowed);
    }

    expect(
      signInPolicy.provision(employee('ama', ['EMPLOYEE', 'HR_OFFICER']), 'kojo').allowed,
    ).toBe(true);
  });

  it('are closed and reopened a rank above that', () => {
    // Not the joining process: a decision about somebody. A lost laptop, an
    // investigation.
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = ADMINISTERS_ACCESS.includes(code);

      expect(signInPolicy.close(them, 'kojo').allowed).toBe(allowed);
      expect(signInPolicy.reopen(them, 'kojo').allowed).toBe(allowed);
    }

    expect(signInPolicy.close(employee('ama', ['EMPLOYEE', 'HR_OFFICER']), 'kojo').allowed).toBe(
      false,
    );
  });

  it('are never reset by the account holder, because self service change is not built', () => {
    /* Setting your own password is a different feature with a different shape —
       it has to ask for the current one — and letting it in through this door
       would build the dangerous half without the safe half. */
    expect(signInPolicy.setPassword(employee('ama'), 'ama').allowed).toBe(false);
  });

  it('let anybody see their own, and turn their own code on', () => {
    const adwoa = employee('adwoa');

    expect(signInPolicy.read(adwoa, 'adwoa').allowed).toBe(true);
    expect(signInPolicy.changeCodeSetting(adwoa, 'adwoa').allowed).toBe(true);
    expect(signInPolicy.read(adwoa, 'ama').allowed).toBe(false);
    expect(signInPolicy.changeCodeSetting(adwoa, 'ama').allowed).toBe(false);
  });

  it('are not findable by address except to HR', () => {
    /* The disclosure signIn() is deliberately vague about, reached from inside
       instead. */
    for (const [code, roles] of EACH_ROLE) {
      expect(signInPolicy.search(employee('adwoa', roles)).allowed).toBe(
        PROVIDES_LOGINS.includes(code),
      );
    }
  });
});

describe('the groups of roles the policies are written in terms of', () => {
  it('agrees with the one time code rule about who reads everybody', () => {
    /* Two files stating the same fact for different reasons: mfa.ts says these
       three must answer a code *because* they can read everybody's records, and
       the employee policy is what makes that true. If they ever disagree, one of
       them is wrong and a code has quietly become optional for somebody who can
       read the company's leave. */
    expect([...READS_EVERY_RECORD]).toEqual([...MANDATORY_ROLES]);
  });

  it('never puts the baseline role in a group, so holding nothing grants nothing', () => {
    for (const group of [
      READS_EVERY_RECORD,
      MAINTAINS_EMPLOYEE_RECORDS,
      SETS_UP_THE_ORGANISATION,
      ADMINISTERS_ACCESS,
      PROVIDES_LOGINS,
    ]) {
      expect(group).not.toContain('EMPLOYEE');
    }
  });

  it('names only roles that exist', () => {
    // A group naming a fifth role would be a rule nothing can satisfy.
    for (const group of [
      READS_EVERY_RECORD,
      MAINTAINS_EMPLOYEE_RECORDS,
      SETS_UP_THE_ORGANISATION,
      ADMINISTERS_ACCESS,
      PROVIDES_LOGINS,
    ]) {
      for (const code of group) {
        expect(ROLE_CODES).toContain(code);
      }
    }
  });

  it('leaves somebody outside every group, or the groups mean nothing', () => {
    for (const group of [
      READS_EVERY_RECORD,
      MAINTAINS_EMPLOYEE_RECORDS,
      SETS_UP_THE_ORGANISATION,
      ADMINISTERS_ACCESS,
      PROVIDES_LOGINS,
    ]) {
      expect(outside(group).length).toBeGreaterThan(0);
    }
  });
});

describe('the guard', () => {
  const about = policyFor('employee');
  const adwoa = employee('adwoa');

  it('lets an allowed decision through without writing anything down', () => {
    /* Only refusals are logged. "Who read whose record" is a much larger
       question, it belongs in the audit log of LMS 113, and answering half of it
       here would produce a file that looks like an access log and is not one. */
    const denials = recordingDenials();

    new Guard(denials).enforce(about.allow(adwoa, 'read', 'adwoa'));

    expect(denials.entries).toHaveLength(0);
  });

  it('writes a refusal down before it throws, with the reason and the roles', () => {
    // The story's third criterion. Every field here is what somebody asking
    // "should she have been able to do that" needs and cannot get elsewhere.
    const denials = recordingDenials();
    const guard = new Guard(denials);

    expect(() => guard.enforce(about.refuse(adwoa, 'read', 'ama', 'not their record'))).toThrow(
      NotAuthorised,
    );

    const attempt = denials.last()!;

    expect(attempt.employeeId).toBe('adwoa');
    expect(attempt.roles).toEqual(['EMPLOYEE']);
    expect(attempt.resource).toBe('employee');
    expect(attempt.action).toBe('read');
    expect(attempt.subject).toBe('ama');
    expect(attempt.because).toBe('not their record');
    expect(attempt.at).toBeInstanceOf(Date);
  });

  it('writes the reason down and does not say it', () => {
    /* The whole of "recorded accurately, reported vaguely". The moment something
       downstream turns `because` back into a message, the vagueness has bought
       nothing. */
    const denials = recordingDenials();

    try {
      new Guard(denials).enforce(about.refuse(adwoa, 'read', 'ama', 'not their record'));
    } catch (error) {
      expect((error as Error).message).toBe(NOT_AUTHORISED_MESSAGE);
      expect((error as Error).message).not.toContain('not their record');
      expect((error as Error).message).not.toContain('ama');
    }

    expect(denials.last()!.because).toBe('not their record');
  });

  it('carries the attempt on the error, for a caller that has to log it again', () => {
    const guard = new Guard(denialsNowhere());

    try {
      guard.enforce(about.refuse(adwoa, 'terminate', 'ama', 'not HR'));
    } catch (error) {
      expect((error as NotAuthorised).attempt.action).toBe('terminate');
    }
  });

  it('says what the rule is when the policy chose to', () => {
    const guard = new Guard(denialsNowhere());

    expect(() =>
      guard.enforce(about.refuseOpenly(adwoa, 'update', 'ama', 'not HR', 'Ask HR.')),
    ).toThrow('Ask HR.');
  });

  it('answers a screen without logging, because an unoffered button is not an attempt', () => {
    /* Otherwise the denial log fills with the ordinary business of rendering a
       page, and a log that matters becomes a log nobody reads. */
    const denials = recordingDenials();
    const guard = new Guard(denials);

    expect(guard.permits(about.refuse(adwoa, 'update', 'ama', 'not HR'))).toBe(false);
    expect(guard.permits(about.allow(adwoa, 'read', 'adwoa'))).toBe(true);
    expect(denials.entries).toHaveLength(0);
  });
});

/** A denied attempt with nothing in it, for the one test that builds an error by hand. */
const blankAttempt = {
  at: new Date(),
  actor: 'employee adwoa',
  employeeId: 'adwoa',
  roles: [] as RoleCode[],
  resource: 'employee',
  action: 'read',
  subject: null as string | null,
  because: 'a reason',
};
