import { describe, expect, it } from 'vitest';
import { type Actor, holdsAny, isSelf, signedInAs, theSystem } from '../../src/auth/actor.js';
import { auditPolicy } from '../../src/features/audit/policy.js';
import { departmentPolicy } from '../../src/features/department/policy.js';
import { employeePolicy } from '../../src/features/employee/policy.js';
import { MANDATORY_ROLES } from '../../src/features/sign-in/mfa.js';
import { Guard, NOT_AUTHORISED_MESSAGE, NotAuthorised, policyFor } from '../../src/auth/policy.js';
import { rolePolicy } from '../../src/features/role/policy.js';
import {
  ADMINISTERS_ACCESS,
  APPROVES_AS_HR,
  MAINTAINS_EMPLOYEE_RECORDS,
  MAINTAINS_THE_CALENDAR,
  PROVIDES_LOGINS,
  READS_EVERY_RECORD,
  type RoleCode,
  ROLE_CODES,
  SETS_UP_THE_ORGANISATION,
} from '../../src/features/role/roles.js';
import { entitlementRulePolicy } from '../../src/features/entitlement/policy.js';
import type { EntitlementRule } from '../../src/features/entitlement/entitlement-rule.js';
import { holidayPolicy } from '../../src/features/holiday/policy.js';
import { leaveRequestPolicy } from '../../src/features/leave-request/policy.js';
import { leaveTypePolicy } from '../../src/features/leave-type/policy.js';
import { ledgerPolicy } from '../../src/features/balance/policy.js';
import { leaveYearPolicy } from '../../src/features/leave-year/policy.js';
import { signInPolicy } from '../../src/features/sign-in/policy.js';
import { workPatternPolicy } from '../../src/features/work-pattern/policy.js';
import { denialsNowhere } from '../../src/auth/denials.js';
import { recordingDenials } from '../support/recording-denials.js';
import type { Employee } from '../../src/features/employee/employee.js';

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

/**
 * An entitlement rule, with only the two fields the policy reads set honestly.
 *
 * The policy asks which of the three scopes a rule is on and nothing else — a
 * figure is public unless it names a person — so everything else is filler.
 */
function entitlementRule(overrides: Partial<EntitlementRule> = {}): EntitlementRule {
  return {
    id: 'annual-2026',
    leaveTypeId: 'annual',
    employeeId: null,
    departmentId: null,
    entitlementDays: 20,
    prorateOnJoin: false,
    carriesOver: false,
    carryoverMaxDays: null,
    carryoverExpiryMonth: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
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
       ../../src/features/employee/policy.ts, and one somebody will want to move —
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
      expect(employeePolicy.chart(them).allowed).toBe(allowed);
    }
  });

  it('is not opened by managing somebody', () => {
    // A manager may see their reports. That is not a directory.
    expect(employeePolicy.list(manager('akosua')).allowed).toBe(false);
    expect(employeePolicy.search(manager('akosua')).allowed).toBe(false);
  });

  /* FR 09 and LMS 107. The chart names everybody, their job title and who they
     answer to, so it is the staff list with the lines drawn in and goes to the
     same people. Opening it to a manager for their own branch would be the skip
     level read employee-policy.ts declines, arriving through a different door. */
  it('does not let a manager draw their own branch of the chart', () => {
    expect(employeePolicy.chart(manager('akosua')).allowed).toBe(false);
    expect(employeePolicy.chart(manager('akosua')).told).toBeNull();
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

describe('leave types, FR 21 and LMS 201', () => {
  /* The third resource that is about the shape of the organisation rather than
     about a person, and it runs like the other two. What is worth asserting
     separately is the read, because the temptation with this one was to make the
     whole resource an HR Administrator's — the story is theirs — and that would
     have been wrong in the direction that matters. */
  it('are readable by anybody signed in, because the rules are what people plan against', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(leaveTypePolicy.read(them, 'annual').allowed).toBe(true);
      expect(leaveTypePolicy.list(them).allowed).toBe(true);
    }
  });

  it('are written by an HR Administrator and nobody else', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = SETS_UP_THE_ORGANISATION.includes(code);

      expect(leaveTypePolicy.create(them).allowed).toBe(allowed);
      expect(leaveTypePolicy.update(them, 'annual').allowed).toBe(allowed);
      expect(leaveTypePolicy.retire(them, 'annual').allowed).toBe(allowed);
      expect(leaveTypePolicy.reinstate(them, 'annual').allowed).toBe(allowed);
      expect(leaveTypePolicy.setApprovalChain(them, 'annual').allowed).toBe(allowed);
    }
  });

  /* An HR Officer is the one to be deliberate about. They create employee
     records and hand out logins all day, and they still may not move a notice
     window — because that is a decision about what leave costs everybody rather
     than about one person's record. */
  it("are not an HR Officer's to change, though almost everything else is", () => {
    const officer = employee('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(leaveTypePolicy.read(officer, 'annual').allowed).toBe(true);
    expect(leaveTypePolicy.update(officer, 'annual').allowed).toBe(false);
    expect(leaveTypePolicy.update(officer, 'annual').told).toMatch(/HR Administrator/);
  });

  /* Retiring gets its own decision so the log says which of the two happened.
     "Changed the maternity type" and "stopped anybody requesting maternity
     leave" are not the same sentence. */
  it('name retiring apart from editing, so the denial log does too', () => {
    const adwoa = employee('adwoa');

    expect(leaveTypePolicy.update(adwoa, 'annual').action).toBe('update');
    expect(leaveTypePolicy.retire(adwoa, 'annual').action).toBe('retire');
    expect(leaveTypePolicy.reinstate(adwoa, 'annual').action).toBe('reinstate');
    expect(leaveTypePolicy.retire(adwoa, 'annual').resource).toBe('leave type');
  });

  /* And so does saying who approves a type, FR 38a and LMS 204. It is the change
     whose effect nobody sees directly — a request sent to the wrong desk does not
     fail, it waits — so "changed who approves maternity leave" has to be findable
     as its own sentence rather than as another "changed the maternity type". */
  it('name setting the approval chain apart from editing the type', () => {
    const adwoa = employee('adwoa');
    const efua = employee('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(leaveTypePolicy.setApprovalChain(adwoa, 'unpaid').action).toBe('set approval chain');
    expect(leaveTypePolicy.setApprovalChain(adwoa, 'unpaid').resource).toBe('leave type');

    /* Refused openly, like every other write here: somebody who can read the
       chain already knows it exists, so there is nothing for a quiet refusal to
       protect and a great deal for a clear one to explain. */
    expect(leaveTypePolicy.setApprovalChain(efua, 'unpaid').allowed).toBe(false);
    expect(leaveTypePolicy.setApprovalChain(efua, 'unpaid').told).toMatch(/HR Administrator/);
  });
});

describe('leave years, §5.4 and LMS 205', () => {
  /* Open to read, and it has to be. When the leave year ends is the single most
     planned-around date in the system — it is when unused annual leave carries
     over or is lost, FR 36 — and an employee who cannot find out when their year
     ends is one who finds out by losing days. */
  it('are readable by anybody signed in, because everybody plans around the year end', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(leaveYearPolicy.read(them, '2026').allowed).toBe(true);
      expect(leaveYearPolicy.list(them).allowed).toBe(true);
    }
  });

  it('are written by an HR Administrator and nobody else', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = SETS_UP_THE_ORGANISATION.includes(code);

      expect(leaveYearPolicy.create(them).allowed).toBe(allowed);
      expect(leaveYearPolicy.update(them, '2026').allowed).toBe(allowed);
      expect(leaveYearPolicy.close(them, '2026').allowed).toBe(allowed);
    }
  });

  /* Closing is named apart from editing, and it is the case where that matters
     most: it is irreversible. There is no reopen in this system, so the denial
     log has to be able to say which of the two somebody attempted. */
  it('name closing apart from editing, because only one of them is final', () => {
    const adwoa = employee('adwoa');

    expect(leaveYearPolicy.update(adwoa, '2026').action).toBe('update');
    expect(leaveYearPolicy.close(adwoa, '2026').action).toBe('close');
    expect(leaveYearPolicy.close(adwoa, '2026').resource).toBe('leave year');
  });

  /* There is no reopen decision, and its absence is the story. A policy method
     for it would be the first half of a route to undoing a lock. */
  it('offer no decision that could undo a close', () => {
    expect(Object.keys(leaveYearPolicy).filter((name) => /reopen|unclose/i.test(name))).toEqual([]);
  });

  it("are not an HR Officer's to close, though almost everything else is", () => {
    const efua = employee('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(leaveYearPolicy.read(efua, '2026').allowed).toBe(true);
    expect(leaveYearPolicy.close(efua, '2026').allowed).toBe(false);
    expect(leaveYearPolicy.close(efua, '2026').told).toMatch(/HR Administrator/);
  });
});

describe('the public holiday calendar, FR 22 and LMS 206', () => {
  /* Open to read, and this one barely needs arguing: a public holiday is in the
     national gazette and on the front page of every newspaper in Accra. There is
     nothing to protect and a fortnight in December to plan around. */
  it('is readable by anybody signed in, because it is published in the gazette', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(holidayPolicy.read(them, '25-dec').allowed).toBe(true);
      expect(holidayPolicy.list(them).allowed).toBe(true);
    }
  });

  /**
   * The one that is different from every other table in §5.5, and the test is
   * written against {@link MAINTAINS_THE_CALENDAR} rather than against a list of
   * codes so that widening or narrowing it is one edit in ../../src/features/role/roles.ts.
   *
   * Leave types, entitlement figures and leave years are all
   * {@link SETS_UP_THE_ORGANISATION}, because each holds a decision about what
   * leave costs everybody. This holds no decision at all — it is a transcription
   * of the Public Holidays Act and of whatever the Minister gazetted this week —
   * so it is HR's desk rather than an administrator's.
   */
  it('is kept by HR rather than by an administrator, which no other table here is', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = MAINTAINS_THE_CALENDAR.includes(code);

      expect(holidayPolicy.create(them).allowed).toBe(allowed);
      expect(holidayPolicy.update(them, '25-dec').allowed).toBe(allowed);
      expect(holidayPolicy.remove(them, '25-dec').allowed).toBe(allowed);
    }
  });

  /* The comparison worth making explicitly, because it is the one that looks like
     an inconsistency until the reason is stated. The same officer who may not
     move a notice window may add a day of national mourning to the calendar. */
  it('is an HR Officer to write, where a leave year is not', () => {
    const efua = employee('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(holidayPolicy.create(efua).allowed).toBe(true);
    expect(leaveYearPolicy.create(efua).allowed).toBe(false);
    expect(leaveTypePolicy.create(efua).allowed).toBe(false);
  });

  /* And a system administrator may not, which is the other end of the same
     argument: keeping the calendar is HR's job rather than a power that comes with
     being able to reach the database. */
  it('is not a System Administrator to write, who runs the system rather than HR', () => {
    const kofi = employee('kofi', ['EMPLOYEE', 'SYS_ADMIN']);

    expect(holidayPolicy.read(kofi, '25-dec').allowed).toBe(true);
    expect(holidayPolicy.create(kofi).allowed).toBe(false);
    expect(holidayPolicy.create(kofi).told).toMatch(/HR Officer/);
  });

  /* Removing is named apart from editing, because only one of the two puts a
     working day back into everybody's leave. "Moved Eid al-Fitr to the twenty
     first" and "took Eid al-Fitr off the calendar" are not the same sentence. */
  it('names removing apart from editing, so the denial log does too', () => {
    const adwoa = employee('adwoa');

    expect(holidayPolicy.update(adwoa, '25-dec').action).toBe('update');
    expect(holidayPolicy.remove(adwoa, '25-dec').action).toBe('remove');
    expect(holidayPolicy.remove(adwoa, '25-dec').resource).toBe('holiday');
  });
});

describe('entitlement figures, FR 31 and LMS 203', () => {
  /* The first configuration table with a person-shaped field on it, so it is the
     first one where "readable by anybody signed in" is not the whole answer. The
     policy reads the row rather than the table. */
  const companyWide = entitlementRule({ id: 'annual-2026' });
  const forOperations = entitlementRule({ id: 'ops-2026', departmentId: 'operations' });
  const forAdwoa = entitlementRule({ id: 'adwoa-2026', employeeId: 'adwoa' });

  it('let anybody read a company figure, because it is what people plan against', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('kwame', roles);

      expect(entitlementRulePolicy.read(them, companyWide).allowed).toBe(true);
      expect(entitlementRulePolicy.read(them, forOperations).allowed).toBe(true);
    }
  });

  /* "Kwame gets twenty five" is a fact about Kwame's contract, not a rule
     everybody plans against, and the refusal says nothing — being told that rule
     41 is not yours is being told rule 41 is somebody's. */
  it('keep a figure naming a person to that person and to HR', () => {
    for (const [code, roles] of EACH_ROLE) {
      const somebodyElse = employee('kwame', roles);
      const allowed = READS_EVERY_RECORD.includes(code);

      expect(entitlementRulePolicy.read(somebodyElse, forAdwoa).allowed).toBe(allowed);
    }

    expect(entitlementRulePolicy.read(employee('adwoa'), forAdwoa).allowed).toBe(true);
    expect(entitlementRulePolicy.read(employee('kwame'), forAdwoa).told).toBeNull();
  });

  it('keep the whole list back, because a list of exceptions names who has one', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('kwame', roles);

      expect(entitlementRulePolicy.list(them).allowed).toBe(READS_EVERY_RECORD.includes(code));
    }
  });

  /* Somebody's own figure is theirs by right, their manager approves their leave
     and cannot decide it blind, and everybody else is refused without being told
     the person exists. Direct reports only, as everywhere else. */
  it('let somebody, their manager and HR ask what they are entitled to', () => {
    const adwoa = record('adwoa', 'kofi');

    expect(entitlementRulePolicy.entitlementOf(employee('adwoa'), adwoa).allowed).toBe(true);
    expect(entitlementRulePolicy.entitlementOf(manager('kofi'), adwoa).allowed).toBe(true);
    expect(entitlementRulePolicy.entitlementOf(employee('abena'), adwoa).allowed).toBe(false);
    expect(entitlementRulePolicy.entitlementOf(employee('abena'), adwoa).told).toBeNull();

    for (const [code, roles] of EACH_ROLE) {
      const them = employee('abena', roles);

      expect(entitlementRulePolicy.entitlementOf(them, adwoa).allowed).toBe(
        READS_EVERY_RECORD.includes(code),
      );
    }
  });

  it('are set by an HR Administrator and nobody else', () => {
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('kwame', roles);
      const allowed = SETS_UP_THE_ORGANISATION.includes(code);

      expect(entitlementRulePolicy.create(them).allowed).toBe(allowed);
      expect(entitlementRulePolicy.correct(them, 'annual-2027').allowed).toBe(allowed);
      expect(entitlementRulePolicy.withdraw(them, 'annual-2027').allowed).toBe(allowed);
    }
  });

  /* Three decisions rather than one, so the denial log says which was attempted.
     "Added a rule", "corrected next January's figure" and "withdrew it" are three
     different sentences about somebody's pay. */
  it('name adding, correcting and withdrawing apart, so the denial log does too', () => {
    const adwoa = employee('adwoa');

    expect(entitlementRulePolicy.create(adwoa).action).toBe('create');
    expect(entitlementRulePolicy.correct(adwoa, '1').action).toBe('correct');
    expect(entitlementRulePolicy.withdraw(adwoa, '1').action).toBe('withdraw');
    expect(entitlementRulePolicy.create(adwoa).resource).toBe('entitlement rule');
  });

  it('refuse a write openly, because the company figures are not a secret', () => {
    expect(entitlementRulePolicy.create(employee('adwoa')).told).toMatch(/HR Administrator/);
    expect(entitlementRulePolicy.correct(employee('adwoa'), '1').told).toMatch(/HR Administrator/);
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

describe('the audit log', () => {
  const hers = record('ama');

  it('gives somebody the history of their own record, which is the point of it', () => {
    /* "So that if a balance is ever disputed there is an account of how it got
       there" is written from the point of view of the person disputing it. An
       account they cannot see is not an account. */
    expect(auditPolicy.forEmployee(employee('ama'), hers).allowed).toBe(true);
  });

  it('gives a line manager the same standing over a report that they have over the record', () => {
    const akosua = manager('akosua');

    expect(auditPolicy.forEmployee(akosua, record('kojo', 'akosua')).allowed).toBe(true);
    expect(auditPolicy.forEmployee(akosua, record('kojo', 'kofi')).allowed).toBe(false);
  });

  it('refuses a colleague, exactly as reading the record does', () => {
    /* The rule this policy exists to keep: without it, somebody refused a record
       could ask for its history instead and be handed several copies of it. */
    for (const [, roles] of EACH_ROLE) {
      const other = employee('adwoa', roles);

      expect(auditPolicy.forEmployee(other, hers).allowed).toBe(
        employeePolicy.read(other, hers).allowed,
      );
    }
  });

  it('says nothing when it refuses a record, so the log is not an existence oracle', () => {
    const adwoa = employee('adwoa');

    expect(auditPolicy.forEmployee(adwoa, hers).told).toBeNull();
    expect(auditPolicy.browse(adwoa).told).toBeNull();
  });

  it('keeps the history of a login and its roles narrower than the record', () => {
    /* When a password was reset and who gave somebody HR powers is the material
       of an investigation, not of approving leave. A line manager is deliberately
       not here even though they may read the record's history. */
    const akosua = manager('akosua');

    expect(auditPolicy.forAccess(employee('ama'), 'ama').allowed).toBe(true);
    expect(auditPolicy.forAccess(akosua, 'kojo').allowed).toBe(false);

    for (const [code, roles] of EACH_ROLE) {
      expect(auditPolicy.forAccess(employee('adwoa', roles), 'kojo').allowed).toBe(
        ADMINISTERS_ACCESS.includes(code),
      );
    }
  });

  it('keeps who renamed a team to HR, even though the team itself is open', () => {
    /* The current name of Operations is on every screen. "Yaw renamed it on 3
       March" is an administrative fact about a colleague. */
    for (const [code, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);
      const allowed = READS_EVERY_RECORD.includes(code);

      expect(departmentPolicy.read(them, 'operations').allowed).toBe(true);
      expect(auditPolicy.forOrganisation(them, 'department', 'operations').allowed).toBe(allowed);
    }
  });

  it('keeps the whole log to the people who may read every record', () => {
    // Browsing without naming a record is every record at once.
    for (const [code, roles] of EACH_ROLE) {
      expect(auditPolicy.browse(employee('adwoa', roles)).allowed).toBe(
        READS_EVERY_RECORD.includes(code),
      );
    }
  });
});

/**
 * Moving a balance. FR 26, FR 37, §10. LMS 210, and the three that arrived with
 * LMS 212.
 *
 * Five decisions about one table, and they are five rather than one because they are
 * five different acts by different people. Reading your leave, moving it by fiat,
 * asking for some, approving somebody else's, and giving days back are not the same
 * question with a different verb on it.
 *
 * The two worth reading closely are `commit`, which is the only refusal in this
 * system aimed at somebody's own record on purpose, and `reserve`, which is the only
 * place a line manager's standing over a report does *not* carry.
 */
describe('moving a balance, FR 26 and LMS 212', () => {
  /** Ama's balance. Akosua is her line manager. */
  const hers = { employeeId: 'ama', managerId: 'akosua' };

  /**
   * Her request, sitting at a desk. FR 38a, FR 44. LMS 318.
   *
   * Refusing takes one of these since LMS 318, as approving has since LMS 314: a rejection
   * advances the chain, so it belongs to the desk the request is on rather than to a role.
   */
  const atDesk = (awaiting: 'MANAGER' | 'HR' | 'CEO') => ({
    ...hers,
    awaiting,
    chiefExecutiveId: 'yaw',
  });

  const atManager = atDesk('MANAGER');
  const atHrDesk = atDesk('HR');

  it('is read by the same three standings the employee record has', () => {
    expect(ledgerPolicy.read(employee('ama'), hers).allowed).toBe(true);
    expect(ledgerPolicy.read(manager('akosua'), hers).allowed).toBe(true);

    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.read(employee('adwoa', roles), hers).allowed).toBe(
        READS_EVERY_RECORD.includes(code),
      );
    }
  });

  /* §10 has an ✗ against every column but one, HR Officer included. An adjustment
     moves days by fiat and can never be removed, only compensated. */
  it('is moved by hand only by an HR Administrator', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.adjust(employee('adwoa', roles), hers).allowed).toBe(
        SETS_UP_THE_ORGANISATION.includes(code),
      );
    }

    expect(ledgerPolicy.adjust(employee('ama'), hers).allowed).toBe(false);
    expect(ledgerPolicy.adjust(manager('akosua'), hers).allowed).toBe(false);
  });

  /**
   * Granting a year of entitlement. FR 30, LMS 214.
   *
   * The same rule as `adjust`, and not a copy of it by accident: a grant and an
   * adjustment are the same act from the balance's point of view — days arriving with
   * no request behind them and no way to take them back. What differs is who chose the
   * figure, and writing the figure is `entitlementRulePolicy.create`, which is an HR
   * Administrator's. Letting an Officer apply figures only an Administrator may write
   * would put a year's entitlement one desk below the decision behind it.
   */
  it('is granted for a year only by an HR Administrator', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.grant(employee('adwoa', roles), hers).allowed).toBe(
        SETS_UP_THE_ORGANISATION.includes(code),
      );
    }

    expect(ledgerPolicy.grant(employee('ama'), hers).allowed).toBe(false);
    expect(ledgerPolicy.grant(manager('akosua'), hers).allowed).toBe(false);
    expect(ledgerPolicy.grant(theSystem('the annual grant'), hers).allowed).toBe(true);
  });

  /* And it agrees with the rule for an adjustment for every actor there is, which is
     the claim the paragraph above makes and the thing that would silently stop being
     true if one of them were widened. */
  it('and by exactly the people who may move a balance by hand', () => {
    for (const [, roles] of EACH_ROLE) {
      const them = employee('adwoa', roles);

      expect(ledgerPolicy.grant(them, hers).allowed).toBe(ledgerPolicy.adjust(them, hers).allowed);
    }
  });

  /**
   * Carrying last year's unused days into the new one. FR 36, LMS 217.
   *
   * The same desk as a grant, for the reason the policy gives: whether a type carries
   * at all is `leave_entitlement_rule.carries_over`, and writing that rule is an HR
   * Administrator's. It is a decision of its own rather than a reuse so that the two
   * sentences are separable in the log, which is why it is enumerated separately here.
   */
  it('is carried into a new year only by an HR Administrator', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.carryForward(employee('adwoa', roles), hers).allowed).toBe(
        SETS_UP_THE_ORGANISATION.includes(code),
      );
    }

    expect(ledgerPolicy.carryForward(employee('ama'), hers).allowed).toBe(false);
    expect(ledgerPolicy.carryForward(manager('akosua'), hers).allowed).toBe(false);
    expect(ledgerPolicy.carryForward(theSystem('the year rollover'), hers).allowed).toBe(true);
  });

  /**
   * Recording something that happened, and the entitlement it brings. FR 32g, LMS 218.
   *
   * The one grant in this file that is **not** an Administrator's alone, so it is the
   * one worth enumerating rather than sampling. The argument is that this desk is not
   * applying a policy to the company — it is recording one fact about one person, told
   * to whoever in HR answered the telephone — and the figure it produces still comes
   * from an entitlement rule only an Administrator may write.
   *
   * SYS_ADMIN failing here is the half that would go unnoticed. Being able to reach the
   * database is not the same as keeping the employee records, and a grant is days.
   */
  it('is granted for an event by either HR desk, and by nobody else', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.grantForAnEvent(employee('adwoa', roles), hers).allowed).toBe(
        MAINTAINS_EMPLOYEE_RECORDS.includes(code),
      );
    }

    expect(ledgerPolicy.grantForAnEvent(employee('ama'), hers).allowed).toBe(false);
    expect(ledgerPolicy.grantForAnEvent(manager('akosua'), hers).allowed).toBe(false);
    expect(ledgerPolicy.grantForAnEvent(theSystem('a staff import'), hers).allowed).toBe(true);
  });

  /**
   * Lapsing an event grant that was not used in time. FR 32e, LMS 218.
   *
   * Back to an Administrator's, and the line between this and the recording above is
   * the line the policy keeps everywhere: recording that something happened to one
   * person is the employee-record desk, and applying a rule that takes days *off*
   * people is the desk that writes the rule.
   */
  it('is lapsed only by an HR Administrator', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.lapse(employee('adwoa', roles), hers).allowed).toBe(
        SETS_UP_THE_ORGANISATION.includes(code),
      );
    }

    expect(ledgerPolicy.lapse(employee('ama'), hers).allowed).toBe(false);
    expect(ledgerPolicy.lapse(manager('akosua'), hers).allowed).toBe(false);
    expect(ledgerPolicy.lapse(theSystem('the entitlement expiry'), hers).allowed).toBe(true);
  });

  /**
   * And the two are a different desk from each other, for every actor there is.
   *
   * The story's authorisation decision, said as the one property that would not
   * survive somebody quietly aligning them: there is an actor — the HR Officer — who
   * may record a birth and may not lapse what it granted. Widen `lapse` to
   * MAINTAINS_EMPLOYEE_RECORDS, or narrow `grantForAnEvent` to
   * SETS_UP_THE_ORGANISATION, and this is what fails.
   */
  it('and an HR Officer may record an event without being able to lapse one', () => {
    const officer = employee('efua', ['EMPLOYEE', 'HR_OFFICER']);

    expect(ledgerPolicy.grantForAnEvent(officer, hers).allowed).toBe(true);
    expect(ledgerPolicy.lapse(officer, hers).allowed).toBe(false);
    expect(ledgerPolicy.grant(officer, hers).allowed).toBe(false);
  });

  describe('holding days for leave that has been asked for', () => {
    it('is the asking person’s, and HR’s on their behalf', () => {
      expect(ledgerPolicy.reserve(employee('ama'), hers).allowed).toBe(true);

      for (const [code, roles] of EACH_ROLE) {
        expect(ledgerPolicy.reserve(employee('adwoa', roles), hers).allowed).toBe(
          MAINTAINS_EMPLOYEE_RECORDS.includes(code),
        );
      }
    });

    /**
     * And a line manager's is the one standing that does not carry here.
     *
     * They may read the balance, because deciding a request needs it, and they may
     * approve. Asking for leave on somebody's behalf is not a thing anybody has
     * asked for, and a manager who could reserve a report's days could quietly
     * reduce what that person may book without approving anything.
     */
    it('and not their line manager’s', () => {
      expect(ledgerPolicy.read(manager('akosua'), hers).allowed).toBe(true);
      expect(ledgerPolicy.reserve(manager('akosua'), hers).allowed).toBe(false);
    });
  });

  describe('turning held days into taken days', () => {
    /**
     * Nobody approves their own leave, and this is the one refusal in the system
     * aimed at somebody's own record deliberately.
     *
     * The seed fixtures are built to expose exactly this failure by name. A
     * self-approval that reached the ledger would be indistinguishable afterwards
     * from one somebody granted.
     */
    it('is refused to the person whose leave it is, and said out loud', () => {
      const refusal = ledgerPolicy.commit(employee('ama'), hers);

      expect(refusal.allowed).toBe(false);
      expect(refusal.told).toMatch(/approver/);
    });

    it('is their line manager’s, and anybody who reads every record', () => {
      expect(ledgerPolicy.commit(manager('akosua'), hers).allowed).toBe(true);

      for (const [code, roles] of EACH_ROLE) {
        expect(ledgerPolicy.commit(employee('adwoa', roles), hers).allowed).toBe(
          READS_EVERY_RECORD.includes(code),
        );
      }
    });

    /* Being a manager is read off the record, never from a role — so somebody else's
       manager is nobody here. */
    it('and not somebody else’s manager', () => {
      expect(ledgerPolicy.commit(manager('kofi'), hers).allowed).toBe(false);
    });
  });

  describe('giving held days back', () => {
    /* The widest of the three, and the same three standings as reading: yours to
       withdraw, your manager's to refuse, HR's to cancel. Wide is the safe direction
       for the one movement that cannot take anything from anybody. */
    it('is any of the three standings that may read the balance', () => {
      expect(ledgerPolicy.release(employee('ama'), hers).allowed).toBe(true);
      expect(ledgerPolicy.release(manager('akosua'), hers).allowed).toBe(true);

      for (const [code, roles] of EACH_ROLE) {
        expect(ledgerPolicy.release(employee('adwoa', roles), hers).allowed).toBe(
          READS_EVERY_RECORD.includes(code),
        );
      }
    });

    it('and nobody else', () => {
      expect(ledgerPolicy.release(employee('adwoa'), hers).allowed).toBe(false);
      expect(ledgerPolicy.release(manager('kofi'), hers).allowed).toBe(false);
    });
  });

  /**
   * Checking every balance against the ledger. §7.4, LMS 213.
   *
   * The only decision in this file that names no record, because the reconciliation
   * names none: it reads every balance there is, which is every employee's leave in one
   * answer. The same rule `auditPolicy.browse` uses, for the same reason.
   */
  it('is checked against the ledger by anybody who may read every record', () => {
    for (const [code, roles] of EACH_ROLE) {
      expect(ledgerPolicy.reconcile(employee('adwoa', roles)).allowed).toBe(
        READS_EVERY_RECORD.includes(code),
      );
    }

    /* Being somebody's manager is not a way in. A reconciliation is not their reports'
       balances, it is everybody's. */
    expect(ledgerPolicy.reconcile(manager('akosua')).allowed).toBe(false);
    expect(ledgerPolicy.reconcile(theSystem('the nightly reconciliation')).allowed).toBe(true);
  });

  /* Refused openly, and it is the one refusal in this file where that needs no
     argument: there is no record named, so there is no existence to disclose, and the
     person meeting it is asking a reasonable question at the wrong desk. */
  it('and tells somebody refused it which desk it belongs to', () => {
    const refusal = ledgerPolicy.reconcile(employee('adwoa'));

    expect(refusal.subject).toBeNull();
    expect(refusal.told).toMatch(/whole company/);
  });

  /**
   * Every movement says why it refused, and reading does not.
   *
   * The distinction ./policy.ts is built on. Somebody asking after a balance that is
   * not theirs has not been shown that the person exists, so the refusal says
   * nothing. Somebody who has been allowed to read a balance and is then refused a
   * movement on it has already seen the record, so telling them which desk does it
   * discloses nothing and is the difference between a boundary and a wall.
   *
   * The list is every movement rather than the four it started as, because a movement
   * added without a sentence on its refusal is the failure this test exists to catch:
   * somebody meeting the generic refusal on their own balance has no idea which desk
   * to walk to.
   */
  it('says which rule refused a movement, and nothing at all about a refused read', () => {
    const adwoa = employee('adwoa');

    expect(ledgerPolicy.read(adwoa, hers).told).toBeNull();

    for (const decision of [
      ledgerPolicy.adjust(adwoa, hers),
      ledgerPolicy.reserve(adwoa, hers),
      ledgerPolicy.commit(adwoa, hers),
      ledgerPolicy.release(adwoa, hers),
      ledgerPolicy.grant(adwoa, hers),
      ledgerPolicy.carryForward(adwoa, hers),
      ledgerPolicy.grantForAnEvent(adwoa, hers),
      ledgerPolicy.lapse(adwoa, hers),
    ]) {
      expect(decision.allowed).toBe(false);
      expect(decision.told).not.toBeNull();
      expect(decision.because).not.toBeNull();
    }
  });

  /**
   * Asking for leave, and seeing what somebody asked for. FR 10, LMS 301.
   *
   * Three decisions with three different widths, and the widths are the story: reading
   * is the balance's three standings, asking is narrower than reading, and rewording is
   * narrower still.
   */
  describe('a leave request', () => {
    it('is read by exactly the people who may read the balance it moves', () => {
      expect(leaveRequestPolicy.read(employee('ama'), hers).allowed).toBe(true);
      expect(leaveRequestPolicy.read(manager('akosua'), hers).allowed).toBe(true);

      for (const [code, roles] of EACH_ROLE) {
        expect(leaveRequestPolicy.read(employee('adwoa', roles), hers).allowed).toBe(
          READS_EVERY_RECORD.includes(code),
        );
      }
    });

    /* And it agrees with the ledger for every actor there is, which is the claim the
       policy file makes: a request is why a figure is what it is, and standing to see
       one without the other would be standing to see half an explanation. */
    it('and agrees with the ledger about that, for everybody', () => {
      for (const [, roles] of EACH_ROLE) {
        const them = employee('adwoa', roles);

        expect(leaveRequestPolicy.read(them, hers).allowed).toBe(
          ledgerPolicy.read(them, hers).allowed,
        );
      }

      expect(leaveRequestPolicy.read(manager('akosua'), hers).allowed).toBe(
        ledgerPolicy.read(manager('akosua'), hers).allowed,
      );
    });

    /* FR 18 puts HR on it: somebody who was away and could not ask is entered
       afterwards. Everybody else asks only for themselves. */
    it('is asked for by the person taking it, and by HR on their behalf', () => {
      expect(leaveRequestPolicy.submit(employee('ama'), hers).allowed).toBe(true);

      for (const [code, roles] of EACH_ROLE) {
        expect(leaveRequestPolicy.submit(employee('adwoa', roles), hers).allowed).toBe(
          MAINTAINS_EMPLOYEE_RECORDS.includes(code),
        );
      }
    });

    /**
     * And never by their line manager, which is the one place their standing over a
     * report does not carry.
     *
     * The same rule `ledgerPolicy.reserve` holds and for the same reason: a manager who
     * could ask for leave on somebody's behalf could reduce what that person may book
     * without ever approving anything. They may read it, and that pair — read yes, ask
     * no — is what would quietly stop being true if somebody widened this to the three
     * standings the read has.
     */
    it('and never by their line manager, who may nonetheless read it', () => {
      expect(leaveRequestPolicy.read(manager('akosua'), hers).allowed).toBe(true);
      expect(leaveRequestPolicy.submit(manager('akosua'), hers).allowed).toBe(false);
      expect(leaveRequestPolicy.submit(manager('akosua'), hers).told).toMatch(/FR 18/);
    });

    /**
     * And the reason is the author's alone, which is narrower than submitting.
     *
     * The one place in this file where being able to create something does not carry
     * the right to edit it. The reason is what an approver decides on, and unlike every
     * figure on the row no trigger can refuse a change to it — the field is
     * deliberately editable — so this decision is the whole of the protection.
     */
    it('and is reworded only by the person who asked for it', () => {
      expect(leaveRequestPolicy.reword(employee('ama'), hers).allowed).toBe(true);
      expect(leaveRequestPolicy.reword(manager('akosua'), hers).allowed).toBe(false);

      for (const [, roles] of EACH_ROLE) {
        expect(leaveRequestPolicy.reword(employee('adwoa', roles), hers).allowed).toBe(false);
      }
    });

    /* A refused read says nothing, because somebody asking after leave that is not
       theirs has not been shown that the person exists. The other two say which desk,
       because anybody reaching them can already read the balance. */
    it('says nothing about a refused read, and why about the rest', () => {
      const adwoa = employee('adwoa');

      expect(leaveRequestPolicy.read(adwoa, hers).told).toBeNull();

      for (const decision of [
        leaveRequestPolicy.submit(adwoa, hers),
        leaveRequestPolicy.reword(adwoa, hers),
      ]) {
        expect(decision.allowed).toBe(false);
        expect(decision.told).not.toBeNull();
        expect(decision.because).not.toBeNull();
      }
    });

    /* And the decisions there are. `approve` arrived with LMS 314 and is the one whose
       subject is not a `BalanceOwner`: it takes the desk the request is sitting on as well,
       which is what stops it being "a way to reach the transition without passing the check
       that knows which desk FR 38a's chain has the request sitting on" — the sentence this
       file refused it with for two stories. */
    it('and the decisions it holds are these twelve', () => {
      expect(Object.keys(leaveRequestPolicy).sort()).toEqual([
        'approve',
        'cancel',
        /* FR 44, LMS 318. `decide` dispatches on the verb, and `override` is the two verbs
           that disagree with a line manager. */
        'decide',
        'notTheirOwn',
        'override',
        'queue',
        'read',
        'refuse',
        'resource',
        'reword',
        /** FR 48b, LMS 320. Putting a request nobody could decide back into its chain. */
        'route',
        'submit',
        'withdraw',
      ]);
    });

    /**
     * And the three endings are three different desks, which is the point of them being
     * three decisions rather than one.
     *
     * A single `settle` would have to be the union — `ledgerPolicy.release` — and would
     * let a manager withdraw a report's leave and let somebody mark their own leave
     * refused. Both write a valid RELEASE and a record of something that did not happen.
     */
    it('and the three endings are decided by three different desks', () => {
      /* Ama asked for the leave and Akosua is her line manager. */
      const ama = employee('ama');
      const akosua = manager('akosua');

      /* Withdrawing is the undoing of submitting, so it is the requester's — and, by
         the same FR 18 argument, HR's on their behalf. Not the manager's: emptying
         somebody's calendar without refusing anything leaves no decision on the
         record. */
      expect(leaveRequestPolicy.withdraw(ama, hers).allowed).toBe(true);
      expect(leaveRequestPolicy.withdraw(akosua, hers).allowed).toBe(false);

      /* Refusing is a decision about somebody else's request. Not the requester's:
         taking back your own leave is withdrawing it, and `reasonForRelease` writes
         which of the two happened into the ledger. */
      expect(leaveRequestPolicy.refuse(akosua, atManager).allowed).toBe(true);
      expect(leaveRequestPolicy.refuse(ama, atManager).allowed).toBe(false);

      /* Cancelling is HR unwinding something that should not be on the books, and is
         the narrowest of the three: neither the requester's nor the manager's. */
      expect(leaveRequestPolicy.cancel(ama, hers).allowed).toBe(false);
      expect(leaveRequestPolicy.cancel(akosua, hers).allowed).toBe(false);
    });

    /* And which roles carry each, read off the role lists rather than written out — the
       same way every other decision in this file is checked, so a role added to
       MAINTAINS_EMPLOYEE_RECORDS reaches all three without this test being edited. */
    it('and the roles that carry them are the ones that maintain records', () => {
      for (const [code, roles] of EACH_ROLE) {
        const holder = employee('adwoa', roles);
        const carries = MAINTAINS_EMPLOYEE_RECORDS.includes(code);

        expect(leaveRequestPolicy.withdraw(holder, hers).allowed).toBe(carries);
        expect(leaveRequestPolicy.cancel(holder, hers).allowed).toBe(carries);

        /* FR 44, LMS 318. Refusing left that pair, and is now the desk's rather than a
           role's: holding HR_OFFICER is standing at the HR desk and at no other. */
        expect(leaveRequestPolicy.refuse(holder, atManager).allowed).toBe(false);
        expect(leaveRequestPolicy.refuse(holder, atHrDesk).allowed).toBe(
          APPROVES_AS_HR.includes(code),
        );
      }
    });

    /**
     * And approving one is decided by the chain, not by rank. FR 38, FR 38a, FR 40. LMS 314.
     *
     * The three desks resolve to a person three different ways — a reporting line, a pair of
     * granted roles, and the one employee FR 04 leaves without a manager — and this is where
     * that is pinned against hardcoded actors rather than against `TRANSITIONS`. The table
     * says `THE_DESK_IT_IS_WITH`; only these cases say who that turns out to be.
     */
    describe('and approving one', () => {
      /** Ama's request, waiting on a desk. Akosua manages her; Yaw is the Chief Executive. */
      function at(awaiting: 'MANAGER' | 'HR' | 'CEO') {
        return { ...hers, awaiting, chiefExecutiveId: 'yaw' };
      }

      it('is the line manager’s while it is sitting with the manager', () => {
        expect(leaveRequestPolicy.approve(manager('akosua'), at('MANAGER')).allowed).toBe(true);
      });

      /* And HR does not get to reach past them. A request still with a manager is one the
         manager has not seen, which is the stage the chain exists to insist on — so holding
         HR_OFFICER is not standing here, even though it is standing to cancel the request
         outright. */
      it('and not HR’s, while it is still sitting with the manager', () => {
        for (const [, roles] of EACH_ROLE) {
          expect(leaveRequestPolicy.approve(employee('adwoa', roles), at('MANAGER')).allowed).toBe(
            false,
          );
        }
      });

      /* HR is a granted role and two codes staff it, which is `APPROVES_AS_HR`. A separate
         list from the one that maintains employee records, so that widening one cannot
         quietly widen the other — read off the list here rather than written out, exactly as
         every other role check in this file is. */
      it('and is HR’s once it reaches the HR desk, for the roles that staff it', () => {
        for (const [code, roles] of EACH_ROLE) {
          expect(leaveRequestPolicy.approve(employee('adwoa', roles), at('HR')).allowed).toBe(
            APPROVES_AS_HR.includes(code),
          );
        }
      });

      /* And the manager has no standing at the HR stage either. The chain is a sequence and
         each desk answers for its own stage. */
      it('and not the line manager’s once it has moved past them', () => {
        expect(leaveRequestPolicy.approve(manager('akosua'), at('HR')).allowed).toBe(false);
      });

      /**
       * The Chief Executive is a position and is compared by id. FR 04.
       *
       * Nobody holds a role that says Chief Executive — the leave-type-approval-chain
       * migration is emphatic that turning the three desks into three role codes is the trap
       * — so the desk resolves to the one employee with no line manager, and holding every
       * role in the system is not standing at it.
       */
      it('and is the Chief Executive’s at the CEO desk, by who they are rather than what they hold', () => {
        expect(leaveRequestPolicy.approve(employee('yaw'), at('CEO')).allowed).toBe(true);

        for (const [, roles] of EACH_ROLE) {
          expect(leaveRequestPolicy.approve(employee('adwoa', roles), at('CEO')).allowed).toBe(
            false,
          );
        }
      });

      /* And where there is no root at all — which `employee_one_root` says cannot happen and
         a half-loaded database makes real — nobody is at that desk. `isSelf` refuses two
         nulls for the same reason: nobody is not somebody. */
      it('and is nobody’s where the company has no Chief Executive on record', () => {
        expect(
          leaveRequestPolicy.approve(employee('yaw'), {
            ...hers,
            awaiting: 'CEO',
            chiefExecutiveId: null,
          }).allowed,
        ).toBe(false);
      });

      /**
       * And the requester is never at the desk, however they got there.
       *
       * The case that makes this necessary is ordinary rather than adversarial: unpaid leave
       * goes to the HR desk first, and an HR Officer asking for unpaid leave holds a code
       * that staffs it. Without the exclusion they would approve their own first stage on the
       * way past. `ledgerPolicy.commit` refuses the same thing at the ledger door, and both
       * are asked.
       */
      it('and is never the person who asked for it, even at a desk they staff', () => {
        expect(
          leaveRequestPolicy.approve(employee('ama', ['EMPLOYEE', 'HR_OFFICER']), at('HR')).allowed,
        ).toBe(false);

        expect(ledgerPolicy.commit(employee('ama', ['EMPLOYEE', 'HR_OFFICER']), hers).allowed).toBe(
          false,
        );
      });

      /* And a request waiting on nobody — approved, or ended — admits nobody. There is no
         desk, so there is nobody at it. */
      it('and is nobody’s when the request is waiting on no desk at all', () => {
        const nowhere = { ...hers, awaiting: null, chiefExecutiveId: 'yaw' };

        expect(leaveRequestPolicy.approve(manager('akosua'), nowhere).allowed).toBe(false);
        expect(
          leaveRequestPolicy.approve(employee('adwoa', ['EMPLOYEE', 'HR_ADMIN']), nowhere).allowed,
        ).toBe(false);
      });

      /* Refused openly, naming the chain. Anybody reaching this can already read the
         request, and the person most likely to meet it is an approver at the wrong stage of
         a chain they cannot see. */
      it('and says why, and how the chains run', () => {
        const refusal = leaveRequestPolicy.approve(manager('akosua'), at('HR'));

        expect(refusal.told).toContain('approval chain');
        expect(refusal.told).toContain('unpaid leave goes to HR');
        expect(refusal.because).not.toBeNull();
      });
    });

    /**
     * And nobody decides their own request, whatever they hold. FR 48, §8.6a. LMS 319.
     *
     * The rule with no answer that admits anybody, and this is where that claim is pinned
     * exhaustively rather than sampled — which is exactly what a pure policy is for. Ama asks
     * for the leave; Ama holding every role in the system in turn is still refused both of
     * the verbs that are a decision.
     *
     * The cases that make it necessary are ordinary rather than adversarial, and both are
     * about HR asking for their own leave: the desk unpaid leave starts at is staffed by a
     * code an HR Officer holds, and `LEAVE_ADMINISTRATION` is on the `REFUSE` row whichever
     * desk the request is sitting at. Before LMS 319 the first was closed and the second was
     * not.
     */
    describe('and deciding one', () => {
      /** Ama's request, at the desk her own roles would staff. */
      const atHr = { ...hers, awaiting: 'HR' as const, chiefExecutiveId: 'kwame' };

      it('is never the requester’s, whatever roles they hold', () => {
        for (const [, roles] of EACH_ROLE) {
          const ama = employee('ama', roles);

          expect(leaveRequestPolicy.approve(ama, atHr).allowed).toBe(false);
          expect(leaveRequestPolicy.refuse(ama, atManager).allowed).toBe(false);
        }
      });

      /* And it is refused by the same rule in both cases rather than by two that agree, which
         is the property the `REFUSE` row could not have while the exclusion lived on
         `THE_DESK_IT_IS_WITH` — a standing that row does not name. */
      it('and is refused by the one rule, in the same words', () => {
        const ama = employee('ama', ['EMPLOYEE', 'HR_ADMIN']);

        for (const decision of [
          leaveRequestPolicy.approve(ama, atHr),
          leaveRequestPolicy.refuse(ama, atManager),
          leaveRequestPolicy.notTheirOwn(ama, hers, 'APPROVE'),
          leaveRequestPolicy.notTheirOwn(ama, hers, 'REFUSE'),
        ]) {
          expect(decision.allowed).toBe(false);
          expect(decision.told).toBe(leaveRequestPolicy.notTheirOwn(ama, hers, 'APPROVE').told);
          expect(decision.told).toContain('whatever roles they hold');
          expect(decision.because).toContain('nobody decides their own request');
        }
      });

      /* And the log says which verb was attempted, because "Ama was refused a decision on her
         own request" is two different attempts and only one of them is somebody clicking the
         button their own queue showed them. */
      it('and the attempt is logged as the verb it was', () => {
        const ama = employee('ama', ['EMPLOYEE', 'HR_OFFICER']);

        expect(leaveRequestPolicy.approve(ama, atHr).action).toBe('approve');
        expect(leaveRequestPolicy.refuse(ama, atManager).action).toBe('refuse');
        expect(leaveRequestPolicy.notTheirOwn(ama, hers, 'REFUSE').subject).toBe('ama');
      });

      /**
       * And the two verbs that are not a decision are untouched, which is half the rule.
       *
       * Withdrawing your own request is the point of withdrawing — a rule that caught it
       * would refuse a person the right to change their mind — and cancelling is HR unwinding
       * a row that should not be on the books. `isADecision` is the line, and it is the same
       * line ../../src/features/leave-request/leave-decision.ts draws for what gets recorded.
       */
      it('and leaves withdrawing and cancelling exactly where they were', () => {
        expect(leaveRequestPolicy.withdraw(employee('ama'), hers).allowed).toBe(true);

        for (const [code, roles] of EACH_ROLE) {
          const ama = employee('ama', roles);

          expect(leaveRequestPolicy.withdraw(ama, hers).allowed).toBe(true);
          expect(leaveRequestPolicy.cancel(ama, hers).allowed).toBe(
            MAINTAINS_EMPLOYEE_RECORDS.includes(code),
          );
        }
      });

      /* And deciding somebody else's request is not touched either. The rule is about who the
         leave is for and nothing else, so the manager, HR and the desk keep every standing
         they had — which is what makes this a check rather than a narrowing. */
      it('and refuses nobody who is deciding somebody else’s', () => {
        expect(leaveRequestPolicy.refuse(manager('akosua'), atManager).allowed).toBe(true);
        expect(
          leaveRequestPolicy.approve(employee('efua', ['EMPLOYEE', 'HR_OFFICER']), atHr).allowed,
        ).toBe(true);
        expect(leaveRequestPolicy.notTheirOwn(manager('akosua'), hers, 'REFUSE').allowed).toBe(
          true,
        );
      });

      /* And the system passes it by being nobody rather than by being excused, which is the
         property `theSystem`'s null employeeId exists for. A rollover deciding five hundred
         requests is not any of them. */
      it('and lets the system through, which is nobody', () => {
        const job = theSystem('the year rollover');

        expect(leaveRequestPolicy.notTheirOwn(job, hers, 'APPROVE').allowed).toBe(true);
        expect(
          leaveRequestPolicy.notTheirOwn(
            job,
            { employeeId: null as never, managerId: null },
            'REFUSE',
          ).allowed,
        ).toBe(true);
      });
    });

    /* Every one of the three is refused openly. Anybody reaching them can already read
       the request, so there is no existence to disclose and the person meeting the
       refusal is doing legitimate work at the wrong window. */
    it('and each of them says why, and names the desk that can', () => {
      for (const decision of [
        leaveRequestPolicy.refuse(employee('ama'), atManager),
        leaveRequestPolicy.cancel(employee('ama'), hers),
        leaveRequestPolicy.withdraw(manager('akosua'), hers),
      ]) {
        expect(decision.allowed).toBe(false);
        expect(decision.told).not.toBeNull();
        expect(decision.because).not.toBeNull();
      }
    });
  });

  /* The system is nobody, so it matches no owner and no manager — and holds every
     role, so it passes every role check. Both halves matter: a rollover posting for
     five hundred people is not any of them. */
  it('lets the system through by its roles and never by being somebody', () => {
    const job = theSystem('the year rollover');

    expect(ledgerPolicy.adjust(job, hers).allowed).toBe(true);
    expect(ledgerPolicy.commit(job, { employeeId: 'ama', managerId: null }).allowed).toBe(true);
    expect(ledgerPolicy.commit(job, { employeeId: null as never, managerId: null }).allowed).toBe(
      true,
    );
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
