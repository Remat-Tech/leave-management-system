/**
 * What a kind of leave asks of somebody, said before they have typed anything. LMS 403, FR 13, FR 17, FR 18, FR 32f, FR 32a, FR 32g, FR 11, FR 22, FR 38a.
 */

import {
  approvalChainInWords,
  countingBasisInWords,
  countingBasisLabel,
  grantExpires,
  hasRunningBalance,
  type LeaveType,
} from '../leave-type/leave-type.js';

/**
 * The kinds of thing a leave type says about itself.
 *
 * A closed set rather than free prose, because a screen groups by it and a client that had
 * to recognise a sentence would be reading the words. What each one *says* is composed here
 * from the columns; what it *is* is this token.
 */
export const FORM_RULE_KINDS = [
  /** The type in its own words, as HR wrote them. FR 32f. */
  'DESCRIPTION',
  /** FR 13. Something has to be attached, always or past a length. */
  'DOCUMENTATION',
  /** FR 32a, §8.6b. Going past the allowance asks for evidence instead of refusing. */
  'EVIDENCE_IF_EXCEEDED',
  /** FR 17. How much warning is expected. A warning, never a bar. */
  'NOTICE',
  /** FR 18. How late leave that has already started may still be entered. */
  'BACKDATING',
  /** FR 32g. A yearly allowance, or days that arrive with an occasion. */
  'ENTITLEMENT',
  /** FR 11, FR 22. Which days inside a period cost anything. */
  'COUNTING',
  /** FR 38a. Who decides it. */
  'APPROVAL',
] as const;

export type FormRuleKind = (typeof FORM_RULE_KINDS)[number];

/** One rule, in the words somebody at the form reads. NFR USA 03. */
export interface FormRule {
  kind: FormRuleKind;
  inWords: string;
  /**
   * Whether this rule asks something of the person rather than only telling them how the
   * leave works.
   *
   * The story's failure is somebody finding out about documentation or notice *after* they
   * have submitted, so the form leads with the rules that can still change what they do —
   * fetch a certificate, move the dates, expect a question — and keeps the rest as the
   * explanation underneath. It is the same division {@link RequestWarning} draws for a
   * priced period: something worth telling somebody, that is not a refusal.
   */
  asks: boolean;
}

/**
 * A kind of leave a person may ask for, with everything the form needs to talk about it.
 *
 * The columns are carried alongside the sentences rather than only the sentences, because a
 * form does two different things with the same fact: it *says* the backdating window and it
 * *sets the earliest date the picker will accept*. A screen that had only prose would have
 * to parse "7 days" back out of a sentence to do the second.
 */
export interface RequestableLeaveType {
  leaveTypeId: string;
  code: string;
  name: string;
  /** FR 22, in two words, for the line under the day count. */
  countingBasis: LeaveType['countingBasis'];
  countingBasisLabel: string;
  isPaid: boolean;
  /** FR 17, FR 18. Days, for a date input's bounds as well as for the sentences below. */
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  /** FR 13, FR 32a. What a client branches on, where {@link FormRule.inWords} is what it shows. */
  documentation: LeaveType['documentation'];
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  /** FR 38a. "your line manager, then HR". */
  approvedBy: string;
  rules: FormRule[];
}

/** The form, before a single date has been chosen. */
export interface RequestForm {
  employeeId: string;
  /** In `display_order`. §7.4, and the order the balance screen already uses. */
  types: RequestableLeaveType[];
}

/**
 * Everything one type asks of somebody, in the order a person needs it.
 *
 * ## Why this exists beside `quoteFor`
 *
 * `quoteFor` in ./leave-request.ts already answers "what would this cost, and is there
 * anything worth telling me", and that is the whole of the story's first criterion. It
 * cannot be the whole of the other two, because **a quote needs a period**. A form that had
 * only a quote would tell somebody that maternity leave needs documentation on the keystroke
 * after they had settled the dates, and would tell somebody choosing compassionate leave
 * nothing at all until they had committed to a week — which is later than the story asks and
 * later than the facts are available. The rules are a property of the type; they are known
 * the moment it is picked.
 *
 * So one fact is deliberately said twice, in the two voices that already exist here. The
 * standing rule is *this kind of leave needs documentation*; the quote's `DOCUMENTATION_REQUIRED`
 * warning is *these nine days need it*. Neither is a duplicate of the other and the second
 * cannot replace the first, because the first is the one that arrives in time to change what
 * somebody does.
 *
 * ## Every sentence is read off a column
 *
 * FR 31 — "No leave rule shall require a code change or a deployment" — and design principle
 * 5. Nothing below looks at `type.code`, so a type HR adds next year explains itself the
 * moment the row exists.
 *
 * Compassionate leave's discretion is the case worth naming, because it is the story's
 * second criterion and it is not a flag. It is `leave_type.description`, which is where the
 * business put it: the seven-leave-types migration is explicit that there is "no list of
 * qualifying relationships anywhere in the system: that is the approvers' judgement on the
 * reason given", and the row says so in words — *whether it qualifies is for your manager and
 * HR to decide*. The `ENTITLEMENT` rule states the structural half of the same thing from
 * `entitlement_basis`, without either sentence knowing which type it is about.
 *
 * ## Silence where a type asks nothing
 *
 * A type needing no documentation produces no `DOCUMENTATION` rule rather than one saying so.
 * Eight lines of which half report the absence of a rule is a list nobody finishes reading,
 * and the one it matters for — the person checking whether they need a certificate — is
 * better served by a short list they read than a long one they skim.
 */
export function rulesFor(type: LeaveType): FormRule[] {
  const rules: FormRule[] = [];

  /* FR 32f. The type in the words HR wrote, first, because it is the only line on the card
     somebody chose to write about this leave rather than a sentence composed from a column.
     Trimmed and checked for emptiness rather than only for null: the column is nullable and
     a row edited down to a space is a rule that would render as a blank bullet. */
  const described = type.description?.trim() ?? '';
  if (described !== '') {
    rules.push({ kind: 'DESCRIPTION', inWords: described, asks: false });
  }

  /* FR 13. The story's third criterion, and the reason it is first among the asks. */
  const documents = documentationInWords(type);
  if (documents !== null) {
    rules.push({ kind: 'DOCUMENTATION', inWords: documents, asks: true });
  }

  /* FR 32a. A different rule from the one above and said separately, because they answer
     different questions — see `documentationRequired`, which is emphatic that the length of
     the request and the state of the balance are not the same threshold. Sick leave has this
     one and not the other, and somebody reading a single merged sentence would take the
     three day allowance for a three day limit. */
  if (type.exceedableWithDocument) {
    rules.push({
      kind: 'EVIDENCE_IF_EXCEEDED',
      inWords:
        `Going past your ${type.name.toLowerCase()} allowance is not refused — it asks for ` +
        `documentation instead, and the leave is still granted. The balance goes below ` +
        `nought and that is correct.`,
      asks: true,
    });
  }

  /* FR 17. Warned about and allowed through, which the sentence has to say, because a person
     four days short of it will otherwise stop rather than submit. */
  if (type.minNoticeCalendarDays > 0) {
    rules.push({
      kind: 'NOTICE',
      inWords:
        `${days(type.minNoticeCalendarDays)}' notice is expected. Less is allowed and is ` +
        `not refused — whoever approves it will see that it was short.`,
      asks: true,
    });
  }

  /* FR 18. The other window, and the asymmetry is the SRS's: this one refuses. The escape
     hatch is named because the person who hits it cannot use it themselves. */
  rules.push({
    kind: 'BACKDATING',
    inWords:
      type.maxBackdateCalendarDays > 0
        ? `Leave that has already started can be entered up to ${days(type.maxBackdateCalendarDays)} ` +
          `after the fact. Further back than that, only HR can put it on the record, with a reason.`
        : `This cannot be entered once it has started. Ask HR to put it on the record.`,
    asks: true,
  });

  /* FR 32g. What a nought means, before there is a nought on screen to misread — the same
     sentence `allowanceInWords` makes on the balance screen, and the same argument: an event
     type's nought before the occasion and a quota type's nought after a year of leave are
     opposite pieces of news. */
  rules.push({ kind: 'ENTITLEMENT', inWords: entitlementInWords(type), asks: false });

  /* FR 11, FR 22. What the day count on the quote will have been reached by, said before it
     appears, so that "9 days off, 7 days charged" is expected rather than queried. */
  rules.push({
    kind: 'COUNTING',
    inWords: `Counted in ${countingBasisInWords(type.countingBasis)}.`,
    asks: false,
  });

  /* FR 38a. Last, because it is what happens after the form rather than something to do at
     it — and `chainInWords` was written for exactly this line. */
  rules.push({
    kind: 'APPROVAL',
    inWords: `Goes to ${approvalChainInWords(type)}.`,
    asks: false,
  });

  return rules;
}

/**
 * One kind of leave, as the form holds it.
 *
 * `requestable` is `LeaveTypeService.requestable`'s word for the same idea — a type this
 * person may actually file new leave against — rather than a name invented here.
 */
export function requestableLeaveTypeFor(type: LeaveType): RequestableLeaveType {
  return {
    leaveTypeId: type.id,
    code: type.code,
    name: type.name,
    countingBasis: type.countingBasis,
    countingBasisLabel: countingBasisLabel(type.countingBasis),
    isPaid: type.isPaid,
    minNoticeCalendarDays: type.minNoticeCalendarDays,
    maxBackdateCalendarDays: type.maxBackdateCalendarDays,
    documentation: type.documentation,
    documentationAfterDays: type.documentationAfterDays,
    exceedableWithDocument: type.exceedableWithDocument,
    approvedBy: approvalChainInWords(type),
    rules: rulesFor(type),
  };
}

/**
 * The form, from the types a service has already narrowed to this person.
 *
 * Pure, and assembled here rather than in the service for the reason `quoteFor` and
 * `statementFor` are: what somebody is told before they commit to a fortnight is a rule about
 * what they are owed an explanation of, and it should be testable without a database.
 *
 * The eligibility filtering is *not* here. FR 05 needs the employee's record and a policy in
 * front of reading it, so `LeaveTypeService.offeredTo` does it and this is handed the answer
 * — the same division `statementFor` makes about the leave year it is given.
 */
export function formFor(input: { employeeId: string; types: readonly LeaveType[] }): RequestForm {
  return {
    employeeId: input.employeeId,
    types: input.types.map(requestableLeaveTypeFor),
  };
}

/**
 * FR 13. What this type asks for by way of paperwork, or null where it asks for none.
 *
 * The two branches are the two the column has. `AFTER_DAYS` names the length on both sides
 * of the threshold, because "documentation after 2 days" is read by half of people as "2
 * days needs it" — the comparison in `documentationRequired` is `>`, and the sentence should
 * not be the place that ambiguity survives.
 */
function documentationInWords(type: LeaveType): string | null {
  switch (type.documentation) {
    case 'ALWAYS':
      return (
        `Every request of this kind needs supporting documentation, whatever its length. ` +
        `Have it ready before you submit — whoever approves it will ask for it.`
      );
    case 'AFTER_DAYS':
      return type.documentationAfterDays === null
        ? null
        : `More than ${days(type.documentationAfterDays)} needs supporting documentation. ` +
            `${sentenceCase(days(type.documentationAfterDays))} or fewer needs none.`;
    default:
      return null;
  }
}

/** FR 32g, FR 32e. Whether the days are standing to somebody's name, or arrive with an occasion. */
function entitlementInWords(type: LeaveType): string {
  if (hasRunningBalance(type)) {
    return 'A yearly allowance, granted at the start of the leave year.';
  }

  const within = grantExpires(type)
    ? `, and usable within ${months(type.entitlementExpiryMonths ?? 0)} of it`
    : '';

  return (
    `Granted per occasion rather than as a yearly allowance${within}, so there is nothing ` +
    `standing to your name until an occasion arises.`
  );
}

function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

function months(count: number): string {
  return `${count} ${count === 1 ? 'month' : 'months'}`;
}

function sentenceCase(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
