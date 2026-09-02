import { describe, expect, it } from 'vitest';
import {
  type FormRuleKind,
  formFor,
  requestableLeaveTypeFor,
  rulesFor,
} from '../../src/features/leave-request/request-form.js';
import {
  type LeaveType,
  type NewLeaveType,
  validateNewLeaveType,
} from '../../src/features/leave-type/leave-type.js';

/**
 * What a kind of leave asks of somebody, before they have typed anything. LMS 403, FR 13, FR 17, FR 18, FR 32f.
 *
 * All of it is pure, so this is where the story's second and third criteria are proved.
 * ../integration/request-form-api.test.ts shows the same sentences arriving over a socket
 * against the seven types a migrated database actually holds — which is the only place the
 * claim "compassionate leave says it is at the approvers' discretion" can be made about the
 * shipped configuration rather than about a fixture.
 *
 * The property nearly every test below is about: **a rule is a field, and no rule is a branch
 * on a code.** Nothing here builds a type by name and expects a sentence from it. Every case
 * sets the column the rule is about and reads the answer back, because a test asserting that
 * maternity leave demands documentation would be asserting the migration and would pass
 * against an implementation that had hard coded the word 'MATERNITY' — which is precisely
 * what design principle 5 and FR 31 forbid.
 *
 * The other thing being pinned is the **split between asking and explaining**. The story is
 * about somebody finding out in time to act, so a rule that wants a document or a fortnight's
 * warning has to be marked as one, and a rule describing how the leave is counted has to not
 * be. Getting that backwards produces a form that is technically complete and buries the one
 * sentence the story was written for.
 */

const SOUND: NewLeaveType = {
  code: 'ANNUAL',
  name: 'Annual Leave',
  countingBasis: 'WORKING_DAYS',
  entitlementBasis: 'QUOTA',
};

/** A stored record, built through the same validation a real one goes through. */
function stored(overrides: Partial<NewLeaveType> = {}): LeaveType {
  return {
    id: '1',
    ...validateNewLeaveType({ ...SOUND, ...overrides }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** The one rule of a kind, or undefined. */
function ruleOf(type: LeaveType, kind: FormRuleKind) {
  return rulesFor(type).find((rule) => rule.kind === kind);
}

/** What one kind of rule says, or the empty string where there is no such rule. */
function said(type: LeaveType, kind: FormRuleKind): string {
  return ruleOf(type, kind)?.inWords ?? '';
}

function kindsOf(type: LeaveType): FormRuleKind[] {
  return rulesFor(type).map((rule) => rule.kind);
}

describe('documentation, explained before anything is submitted', () => {
  it('says so for a type that always needs it, and says to have it ready', () => {
    const said_ = said(stored({ documentation: 'ALWAYS' }), 'DOCUMENTATION');

    expect(said_).toContain('needs supporting documentation');
    expect(said_).toContain('before you submit');
  });

  it('names the length on both sides of a threshold, so `after 2 days` cannot be read as `2 days`', () => {
    /* FR 13, and `documentationRequired` compares with `>`: two days is fine and the third
       is not. That is the half of the rule a sentence usually drops. */
    const said_ = said(
      stored({ documentation: 'AFTER_DAYS', documentationAfterDays: 2 }),
      'DOCUMENTATION',
    );

    expect(said_).toContain('More than 2 days needs supporting documentation');
    expect(said_).toContain('2 days or fewer needs none');
  });

  it('says nothing at all where a type asks for nothing', () => {
    /* Silence rather than "no documentation is required". A list where half the lines report
       the absence of a rule is a list nobody reads to the end of, and the person this story
       is about is the one who does need a certificate. */
    expect(kindsOf(stored({ documentation: 'NOT_REQUIRED' }))).not.toContain('DOCUMENTATION');
  });

  it('asks something, rather than merely explaining', () => {
    expect(ruleOf(stored({ documentation: 'ALWAYS' }), 'DOCUMENTATION')?.asks).toBe(true);
  });

  it('is a different rule from an exceedable allowance, and both can be absent together', () => {
    /* FR 13 against FR 32a — the pair most likely to be merged into one sentence. Sick leave
       has the second and not the first: a four day absence by somebody who has taken none all
       year needs nothing, and the ninth day of the year needs a certificate. A form saying
       "sick leave needs documentation" would be wrong for most people who read it. */
    const sick = stored({ documentation: 'NOT_REQUIRED', exceedableWithDocument: true });

    expect(kindsOf(sick)).not.toContain('DOCUMENTATION');
    expect(said(sick, 'EVIDENCE_IF_EXCEEDED')).toContain('is not refused');
    expect(said(sick, 'EVIDENCE_IF_EXCEEDED')).toContain('still granted');
  });

  it('says the balance goes below nought, because §8.6b says it will', () => {
    expect(said(stored({ exceedableWithDocument: true }), 'EVIDENCE_IF_EXCEEDED')).toContain(
      'below nought',
    );
  });
});

describe('notice and backdating, which look symmetrical and are not', () => {
  it('says notice is expected and that less is allowed anyway', () => {
    /* FR 17 is explicitly a warning rather than a bar. A sentence that only said "14 days'
       notice is expected" would stop somebody who needed leave in four days from asking at
       all, which is the opposite of what the requirement asks for. */
    const said_ = said(stored({ minNoticeCalendarDays: 14 }), 'NOTICE');

    expect(said_).toContain("14 days' notice is expected");
    expect(said_).toContain('not refused');
  });

  it('says nothing about notice where a type expects none', () => {
    expect(kindsOf(stored({ minNoticeCalendarDays: 0 }))).not.toContain('NOTICE');
  });

  it('says backdating refuses, and names who can still enter it', () => {
    /* FR 18, the window that does refuse, and the person who hits it cannot use the escape
       hatch themselves — so the sentence has to name HR. */
    const said_ = said(stored({ maxBackdateCalendarDays: 7 }), 'BACKDATING');

    expect(said_).toContain('up to 7 days');
    expect(said_).toContain('only HR');
  });

  it('says so plainly where nothing may be backdated at all', () => {
    expect(said(stored({ maxBackdateCalendarDays: 0 }), 'BACKDATING')).toContain(
      'cannot be entered once it has started',
    );
  });

  it('marks both as asking something', () => {
    const type = stored({ minNoticeCalendarDays: 14, maxBackdateCalendarDays: 7 });

    expect(ruleOf(type, 'NOTICE')?.asks).toBe(true);
    expect(ruleOf(type, 'BACKDATING')?.asks).toBe(true);
  });
});

describe('the type in its own words. FR 32f', () => {
  it('carries the description through unchanged', () => {
    /* The story's second criterion, and this is where it is met. The discretion on
       compassionate leave is `leave_type.description` — the seven-leave-types migration is
       explicit that there is no list of qualifying relationships anywhere in the system,
       "that is the approvers' judgement on the reason given" — so what this has to prove is
       that HR's sentence reaches the form as HR wrote it. */
    const written =
      'Granted per occasion. Say what it is for; whether it qualifies is for your ' +
      'manager and HR to decide.';

    expect(said(stored({ description: written }), 'DESCRIPTION')).toBe(written);
  });

  it('puts it first, because it is the only line somebody chose to write', () => {
    expect(kindsOf(stored({ description: 'Anything at all.' }))[0]).toBe('DESCRIPTION');
  });

  it('explains rather than asks', () => {
    /* Knowing that a manager decides whether it qualifies is not something to go and do
       before submitting. It changes what somebody expects, not what they fetch. */
    expect(ruleOf(stored({ description: 'Anything.' }), 'DESCRIPTION')?.asks).toBe(false);
  });

  it('leaves the rule out entirely where a type has no description, or a blank one', () => {
    /* Nullable column, and a row edited down to a space would otherwise render as an empty
       bullet on the form. */
    expect(kindsOf(stored({ description: null }))).not.toContain('DESCRIPTION');
    expect(kindsOf(stored({ description: '   ' }))).not.toContain('DESCRIPTION');
  });
});

describe('what a nought would mean, said before there is one on screen. FR 32g', () => {
  it('calls a quota type a yearly allowance', () => {
    expect(said(stored({ entitlementBasis: 'QUOTA' }), 'ENTITLEMENT')).toContain(
      'yearly allowance',
    );
  });

  it('says an event type has nothing standing until an occasion arises', () => {
    /* The structural half of the same fact the description states in words: for a type
       granted per occasion there is no allowance to draw on, so what somebody gets is
       settled when they ask. Derived from `entitlement_basis` and from nothing else. */
    const said_ = said(stored({ entitlementBasis: 'EVENT' }), 'ENTITLEMENT');

    expect(said_).toContain('per occasion');
    expect(said_).toContain('nothing standing to your name until an occasion arises');
  });

  it('names the expiry where a grant has one', () => {
    /* FR 32e, paternity's six months, and the only type with one today. */
    expect(
      said(stored({ entitlementBasis: 'EVENT', entitlementExpiryMonths: 6 }), 'ENTITLEMENT'),
    ).toContain('usable within 6 months of it');
  });

  it('says nothing about expiry where there is none', () => {
    expect(said(stored({ entitlementBasis: 'EVENT' }), 'ENTITLEMENT')).not.toContain(
      'usable within',
    );
  });
});

describe('counting and approval', () => {
  it('says which days cost nothing, for a working days type', () => {
    /* FR 11, FR 22, and it is on the form so that "9 days away, 7 charged" is expected
       rather than queried. */
    expect(said(stored({ countingBasis: 'WORKING_DAYS' }), 'COUNTING')).toContain('cost nothing');
  });

  it('says every day counts, for a calendar days type', () => {
    expect(said(stored({ countingBasis: 'CALENDAR_DAYS' }), 'COUNTING')).toContain(
      'weekends and public holidays included',
    );
  });

  it('names the chain in the order a person reads it', () => {
    /* FR 38a. The whole point of the type carrying a chain: unpaid leave goes to HR then the
       Chief Executive because that is what its chain says, and nothing here knows which type
       it is looking at. */
    expect(said(stored({ approvalChain: ['HR', 'CEO'] }), 'APPROVAL')).toBe(
      'Goes to HR then the Chief Executive.',
    );
    expect(said(stored({ approvalChain: ['MANAGER', 'HR'] }), 'APPROVAL')).toBe(
      'Goes to your line manager then HR.',
    );
  });

  it('marks both as explaining rather than asking', () => {
    const type = stored();

    expect(ruleOf(type, 'COUNTING')?.asks).toBe(false);
    expect(ruleOf(type, 'APPROVAL')?.asks).toBe(false);
  });
});

describe('two types configured oppositely behave oppositely', () => {
  it('says opposite things about two types sharing a code', () => {
    /* Design principle 5, stated as something that can fail — the same shape
       ../unit/leave-type.test.ts ends on. If any sentence above were a branch on `code`,
       these two would say the same thing. */
    const one = requestableLeaveTypeFor(
      stored({
        code: 'SAME',
        name: 'One',
        documentation: 'ALWAYS',
        minNoticeCalendarDays: 14,
        countingBasis: 'WORKING_DAYS',
        approvalChain: ['MANAGER', 'HR'],
      }),
    );

    const other = requestableLeaveTypeFor(
      stored({
        code: 'SAME',
        name: 'Other',
        documentation: 'NOT_REQUIRED',
        minNoticeCalendarDays: 0,
        countingBasis: 'CALENDAR_DAYS',
        approvalChain: ['HR', 'CEO'],
      }),
    );

    expect(one.rules.map((rule) => rule.kind)).toContain('DOCUMENTATION');
    expect(other.rules.map((rule) => rule.kind)).not.toContain('DOCUMENTATION');

    expect(one.rules.map((rule) => rule.kind)).toContain('NOTICE');
    expect(other.rules.map((rule) => rule.kind)).not.toContain('NOTICE');

    expect(one.approvedBy).not.toBe(other.approvedBy);
  });
});

describe('the type as the form holds it', () => {
  it('carries the figures as well as the sentences', () => {
    /* A form does two things with one fact: it says the window and it bounds an input. A
       client that had only prose would have to parse "7 days" back out of a sentence. */
    const type = requestableLeaveTypeFor(
      stored({ minNoticeCalendarDays: 14, maxBackdateCalendarDays: 7 }),
    );

    expect(type.minNoticeCalendarDays).toBe(14);
    expect(type.maxBackdateCalendarDays).toBe(7);
  });

  it('carries the documentation columns a client may branch on', () => {
    const type = requestableLeaveTypeFor(
      stored({ documentation: 'AFTER_DAYS', documentationAfterDays: 3 }),
    );

    expect(type.documentation).toBe('AFTER_DAYS');
    expect(type.documentationAfterDays).toBe(3);
  });
});

describe('the form', () => {
  it('keeps the order it was given, which is the order the caller decided', () => {
    /* §7.4's `display_order`, applied by the service. Sorting here as well would be a second
       opinion about an order somebody already made a decision about. */
    const form = formFor({
      employeeId: '9',
      types: [stored({ code: 'B', name: 'Second' }), stored({ code: 'A', name: 'First' })],
    });

    expect(form.types.map((type) => type.name)).toEqual(['Second', 'First']);
  });

  it('is a form with nothing on it where somebody may ask for nothing', () => {
    /* FR 05, and a real state: every type retired, or a record that makes somebody eligible
       for none. An answer rather than a refusal. */
    expect(formFor({ employeeId: '9', types: [] }).types).toEqual([]);
  });
});
