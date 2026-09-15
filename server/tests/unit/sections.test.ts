import { describe, expect, it } from 'vitest';
import { signedInAs } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { HR_SECTIONS, sectionsFor } from '../../src/features/sign-in/sections.js';
import type { DesksStaffed } from '../../src/features/leave-request/approver-queue.js';
import type { RoleCode } from '../../src/features/role/roles.js';

/**
 * Which sections the rail is told to draw. The hub replaced ten tabs that refused most people.
 *
 * Every assertion here is about what the *policies* answer, not about a list kept beside them:
 * each section names the decision its screen already turns on, so a rule that moves takes the
 * card with it. What must not happen is a card drawn for somebody the screen would refuse.
 */

const guard = new Guard();

/** Somebody who answers at no desk at all. */
const NO_DESKS: DesksStaffed = { desks: [], own: [], managerIds: [], delegated: [] };

function sectionsOf(roles: RoleCode[], staffed: DesksStaffed = NO_DESKS): string[] {
  return sectionsFor(signedInAs('an-employee-id', { roles, isManager: false }), guard, staffed);
}

describe('an ordinary employee', () => {
  it('is offered nothing, so the tab is not drawn at all', () => {
    expect(sectionsOf(['EMPLOYEE'])).toEqual([]);
  });

  it('is not offered the approver queue, because nothing can be waiting on them', () => {
    expect(sectionsOf(['EMPLOYEE'])).not.toContain('approvals');
  });
});

describe('the approver queue', () => {
  /** A desk is a desk however it was come by: a reporting line, an HR role or a delegation. */
  const managerDesk: DesksStaffed = {
    desks: ['MANAGER'],
    own: ['MANAGER'],
    managerIds: ['an-employee-id'],
    delegated: [],
  };

  it('is offered to somebody who answers at one', () => {
    // Being a manager is a reporting line rather than a role, and it configures nothing else.
    expect(sectionsOf(['EMPLOYEE'], managerDesk)).toEqual(['approvals']);
  });

  it('is offered to a delegate covering somebody else’s desk', () => {
    const covering: DesksStaffed = {
      desks: ['HR'],
      own: [],
      managerIds: [],
      delegated: [{ approverId: 'a-colleague', desks: ['HR'] }],
    };

    expect(sectionsOf(['EMPLOYEE'], covering)).toContain('approvals');
  });

  it('comes before the sections, so the rail keeps its order', () => {
    expect(sectionsOf(['EMPLOYEE', 'HR_ADMIN'], managerDesk)[0]).toBe('approvals');
  });
});

describe('HR', () => {
  it('gives an HR Administrator every section', () => {
    expect(sectionsOf(['EMPLOYEE', 'HR_ADMIN'])).toEqual(HR_SECTIONS.map((one) => one.id));
  });

  it('gives an HR Officer the screens they may use and not the ones they may not', () => {
    const offered = sectionsOf(['EMPLOYEE', 'HR_OFFICER']);

    // Reads every record, and keeps the calendar.
    expect(offered).toContain('entitlements');
    expect(offered).toContain('reports');
    expect(offered).toContain('holidays');
    // Setting the organisation up is an HR Administrator's. §10.
    expect(offered).not.toContain('leave-types');
    expect(offered).not.toContain('approval-chains');
    expect(offered).not.toContain('policy');
    expect(offered).not.toContain('adjustments');
    expect(offered).not.toContain('audit');
  });
});

describe('a System Administrator', () => {
  it('is offered what it reads and not what HR configures', () => {
    const offered = sectionsOf(['EMPLOYEE', 'SYS_ADMIN']);

    expect(offered).toContain('audit');
    expect(offered).toContain('reports');
    expect(offered).toContain('entitlements');
    // Reading every record is not the same authority as setting the company up.
    expect(offered).not.toContain('leave-types');
    expect(offered).not.toContain('policy');
    expect(offered).not.toContain('adjustments');
  });
});

describe('the list itself', () => {
  it('offers each section at most once, in one order for everybody', () => {
    const ids = HR_SECTIONS.map((one) => one.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(sectionsOf(['EMPLOYEE', 'HR_ADMIN'])).toEqual(ids);
  });

  it('answers every section for somebody who holds nothing at all', () => {
    // No role, not even the baseline: the question is still answerable, and the answer is none.
    expect(sectionsOf([])).toEqual([]);
  });
});
