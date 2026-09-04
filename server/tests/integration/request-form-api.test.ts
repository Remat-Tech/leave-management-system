import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { LeaveRequestDraftRepository } from '../../src/features/leave-request/draft.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { buildApp } from '../../src/http/app.js';
import { mintSession, SESSION_COOKIE } from '../../src/features/sign-in/session-cookie.routes.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * The request form over HTTP. FR 10, FR 11, FR 13, FR 32f. LMS 403.
 *
 * ../unit/request-form.test.ts proves the wording — which rules, in which order, marked as
 * asking or as explaining — against types it configures itself, and it is deliberately unable
 * to say anything about the seven types the business actually has. This suite is for the four
 * claims that need a real migrated database and a real socket:
 *
 *   **Compassionate leave says it is at the approvers' discretion.** The story's second
 *   criterion names one leave type, and the only place that claim can honestly be checked is
 *   against the row the migration wrote. A unit test asserting it would be asserting its own
 *   fixture. Nothing in the source branches on the code, so what this proves is that the
 *   *configuration* says what the requirement says it says — which is a different fact, and
 *   the one that would break if somebody edited the row.
 *
 *   **The documentation rule reaches the form before any dates.** Criterion three, and the
 *   whole of "not after". `GET /me/request-form` takes no period and is answerable the moment
 *   the screen opens.
 *
 *   **The day count is the server's, and moves when the dates move.** Criterion one, against
 *   a period containing a weekend and a gazetted public holiday, where a browser doing its
 *   own arithmetic would get a different answer.
 *
 *   **A rule that refuses arrives as a sentence rather than a five hundred.** The refusals a
 *   form provokes are the ones that carry the instruction — which dates to submit instead,
 *   how many days could be asked for — and losing them to a generic error is the failure this
 *   story is written against.
 *
 * `buildApp` is the same function ../../src/main.ts calls. There is no second assembly.
 */

const testDatabaseUrl = await databaseForThisFile();

/** Long enough for `sessionSecretFrom`, and nowhere near any real one. */
const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

const system = theSystem('request form api integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let server: Server;
let origin: string;
let balances: BalanceService;
let requests: LeaveRequestService;
let people: Record<string, string>;
let seededYears: Record<string, unknown>[];

let y2026: string;
let annualId: string;
let sickId: string;
let compassionateId: string;
/** FR 10. The one type in these tests that asks for a reason. */
let unpaidId = '';
let maternityId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);
  const roles = new RoleRepository(db);
  const types = new LeaveTypeRepository(db);
  const years = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const decisions = new LeaveDecisionRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    years,
    requestRepository,
    decisions,
    /** FR 48b, LMS 320. */
    new LeaveRoutingRepository(db),
    /** FR 47, LMS 324. */
    new WithdrawalRepository(db),
    new RoleRepository(db),
    new OrganisationRepository(db),
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  const app = buildApp({
    guard,
    signIn: new SignInService(accounts, employees, roles, recordingMailer(), guard, {
      domains: ['rematholdings.com'],
    }),
    balances: new BalanceRepository(db),
    employees,
    types,
    years,
    requests: requestRepository,
    leaveRequests: requests,
    decisions,
    /** FR 48b, LMS 320. */
    routing: new LeaveRoutingRepository(db),
    /** FR 47, LMS 324. */
    withdrawals: new WithdrawalRepository(db),
    /** FR 19, LMS 302. */
    drafts: new LeaveRequestDraftRepository(db),
    accounts,
    roles,
    organisation: new OrganisationRepository(db),
    secret: SECRET,
  });

  /* Port 0, so the operating system picks one nothing else is on. */
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => {
      resolve(listening);
    });
  });

  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  seededYears = (await admin.query('SELECT * FROM leave_year ORDER BY start_date')).rows;
});

beforeEach(async () => {
  /* FR 18, LMS 308. The fixture days are months behind today, so annual leave's seven day
     backdating window would refuse almost every request in this file. Widened rather than
     dated forward: the window is a column HR sets, and the rule it states is
     ./leave-request.test.ts's to prove. */
  await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 3650');

  await emptyTheLeaveTables();
  await restoreYears();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = await yearIdOf('2026');
  annualId = await typeIdOf('ANNUAL');
  sickId = await typeIdOf('SICK');
  compassionateId = await typeIdOf('COMPASSIONATE');
  maternityId = await typeIdOf('MATERNITY');
  unpaidId = await typeIdOf('UNPAID');

  /* Granted through the one door, the way the annual run grants it. */
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });

  /* FR 10. Unpaid leave is the type that asks for a reason, and it is a QUOTA type since
     LMS 326 — so there has to be an allowance behind it for the reason to be what fails. */
  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: unpaidId,
    leaveYearId: y2026,
    days: 10,
    reason: 'Unpaid allowance for 2026',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await emptyTheLeaveTables();
  await restoreYears();

  await db?.destroy();
  await admin?.end();
});

/* ------------------------------------------------------- nothing without a session */

describe('the line everything is mounted behind', () => {
  it('answers 401 for the form, the quote and the submission alike', async () => {
    /* Asserted rather than read off http/app.ts. A route added in front of `identify` would
       be a form that told an anonymous caller what leave the company offers, and a submission
       that had nobody to attribute. */
    for (const path of ['/api/me/request-form', '/api/me/requests/quote']) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
    }

    const posted = await fetch(`${origin}/api/me/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ leaveTypeId: annualId, from: '2026-03-02', to: '2026-03-06' }),
    });

    expect(posted.status).toBe(401);
  });
});

/* ------------------------------------------- the rules, before anything has been typed */

describe('what each kind of leave asks of me', () => {
  /**
   * The story's second criterion, against the row the seven-leave-types migration wrote.
   *
   * The migration's own comment is the requirement: "no list of qualifying relationships
   * anywhere in the system: that is the approvers' judgement on the reason given." What has
   * to reach the form is that judgement, said to the person before they ask.
   */
  it('says compassionate leave is the approvers to decide', async () => {
    const compassionate = await typeOnTheForm(people.officer, compassionateId);

    expect(said(compassionate, 'DESCRIPTION')).toContain(
      'whether it qualifies is for your manager and HR to decide',
    );
  });

  /**
   * And the structural half of the same fact, from `entitlement_basis` rather than from
   * anybody's prose — so it stays true if HR rewords the description.
   */
  it('and that there is nothing standing to your name until an occasion arises', async () => {
    const compassionate = await typeOnTheForm(people.officer, compassionateId);

    expect(said(compassionate, 'ENTITLEMENT')).toContain('per occasion');
    expect(said(compassionate, 'ENTITLEMENT')).toContain('nothing standing to your name');
  });

  /**
   * The story's third criterion, and the whole of "before submission": this route takes no
   * dates, so the answer is available the instant the screen opens.
   */
  it('says maternity leave needs documentation, with no dates having been chosen', async () => {
    const maternity = await typeOnTheForm(people.headOfHr, maternityId);

    expect(said(maternity, 'DOCUMENTATION')).toContain('needs supporting documentation');
    expect(said(maternity, 'DOCUMENTATION')).toContain('before you submit');
    expect(ruleOf(maternity, 'DOCUMENTATION')?.asks).toBe(true);
  });

  /**
   * FR 13 against FR 32a, on the shipped configuration. Sick leave is the type these two are
   * most often conflated on, and getting it wrong tells everybody who has been off for two
   * days that they need a certificate.
   */
  it('tells sick leave apart: no documentation for the request, only for going past the allowance', async () => {
    const sick = await typeOnTheForm(people.officer, sickId);

    expect(kindsOf(sick)).not.toContain('DOCUMENTATION');
    expect(said(sick, 'EVIDENCE_IF_EXCEEDED')).toContain('still granted');
  });

  /** FR 17, and annual leave is the one type carrying a notice window. */
  it('says annual leave expects a fortnight of notice and allows less anyway', async () => {
    const annual = await typeOnTheForm(people.officer, annualId);

    expect(said(annual, 'NOTICE')).toContain("14 days' notice is expected");
    expect(said(annual, 'NOTICE')).toContain('not refused');
  });

  /** FR 38a, off the chain rather than off the code. Unpaid leave is the one that differs. */
  it('names each chain as its own row says it', async () => {
    const annual = await typeOnTheForm(people.officer, annualId);
    const unpaid = await typeOnTheForm(people.officer, await typeIdOf('UNPAID'));

    expect(annual.approvedBy).toBe('your line manager then HR');
    expect(unpaid.approvedBy).toBe('HR then the Chief Executive');
  });

  /**
   * FR 05, over HTTP. Maternity leave is restricted to women, and the form is where somebody
   * finds out — by it not being offered — rather than after they have filled it in.
   */
  it('offers only what the person is eligible for', async () => {
    const hers = await formFor(people.headOfHr);
    const his = await formFor(people.teamLead);

    /* Both directions, because a filter that dropped everything restricted would pass an
       assertion made only one way round. Each is offered the one their record makes them
       eligible for and not the other. */
    expect(codesOn(hers)).toContain('MATERNITY');
    expect(codesOn(hers)).not.toContain('PATERNITY');

    expect(codesOn(his)).toContain('PATERNITY');
    expect(codesOn(his)).not.toContain('MATERNITY');
  });

  /** §7.4's `display_order`, which the unpaid-leave migration last had an opinion about. */
  it('puts them in the order the balance screen uses', async () => {
    expect(codesOn(await formFor(people.officer)).slice(0, 4)).toEqual([
      'ANNUAL',
      'SICK',
      'UNPAID',
      'COMPASSIONATE',
    ]);
  });

  /** `/me` means me, and there is no way to write down anybody else. FR 55, FR 56. */
  it('is the employee in the cookie, whatever the query string names', async () => {
    const form = await formFor(people.teamLead, `?employeeId=${people.headOfHr}`);

    expect(form.employeeId).toBe(people.teamLead);
    expect(codesOn(form)).not.toContain('MATERNITY');
  });
});

/* ------------------------------------------------------ the day count, as dates change */

describe('what the leave would cost', () => {
  /**
   * The story's first criterion. Two to ten March 2026 spans a weekend and Independence Day,
   * so the two figures differ by three — which is the difference a browser doing its own
   * arithmetic would get wrong and the whole reason the count is the server's.
   */
  it('counts working days, and says which days inside the period were free', async () => {
    const quote = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-10',
    });

    expect(quote.days).toBe(6);
    expect(quote.calendarDays).toBe(9);
    expect(quote.countingBasis).toBe('WORKING_DAYS');

    /* NFR USA 03. The explanation rather than only the figure, and the public holiday is
       named because "the sixth of March is Independence Day" is what stops the query. */
    expect(quote.free.map((day) => day.inWords).join(' | ')).toContain('Independence Day');
    expect(quote.free.some((day) => day.because === 'NOT_A_WORKING_DAY')).toBe(true);
  });

  /** The same question again with one date moved, which is what a live preview is. */
  it('answers again with a different figure when a date moves', async () => {
    const shorter = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-04',
    });

    const longer = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-13',
    });

    expect(shorter.days).toBe(3);
    expect(longer.days).toBe(9);
  });

  /**
   * FR 14. What the balance holds and what it would hold, which is the other half of a quote.
   *
   * A plain Monday to Friday with no holiday in it, so that the subtraction being asserted is
   * the balance's and not the calendar's — the week above deliberately contains Independence
   * Day and would make this two claims at once.
   */
  it('says what the balance holds now and what it would hold afterwards', async () => {
    const quote = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-09',
      to: '2026-03-13',
    });

    expect(quote.days).toBe(5);
    expect(quote.availableNow).toBe(20);
    expect(quote.availableAfter).toBe(15);
  });

  /**
   * FR 13, the same rule the form already stated, now about this request.
   *
   * Said twice on purpose and in two voices: the form says *this kind of leave needs a
   * certificate*, and the quote says *these nine days need one*. Neither replaces the other.
   */
  it('warns about documentation again once there is a period to warn about', async () => {
    const quote = await quoteFor(people.headOfHr, {
      leaveTypeId: maternityId,
      from: '2026-03-02',
      to: '2026-03-10',
    });

    expect(codesOfWarnings(quote)).toContain('DOCUMENTATION_REQUIRED');
  });

  /** FR 17. A warning rather than a refusal — the quote comes back 200 with the sentence on it. */
  it('warns about short notice without refusing it', async () => {
    const soon = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
    });

    expect(codesOfWarnings(soon)).toContain('SHORT_NOTICE');
  });

  /** It writes nothing, which is what makes it safe to call on every keystroke. */
  it('leaves no request and no ledger entry behind', async () => {
    await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
    });

    const { rows } = await admin.query<{ count: string }>(
      'SELECT (SELECT count(*) FROM leave_request) + (SELECT count(*) FROM leave_ledger_entry) ' +
        'AS count',
    );

    /* Two entries: the GRANTs the fixture posted, annual and unpaid. Nothing the quote did. */
    expect(rows[0].count).toBe('2');
  });

  /** NFR DAT 03. Ten characters in, ten characters out, and no `Date` in between. */
  it('sends the dates back as calendar dates', async () => {
    const quote = await quoteFor(people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
    });

    expect(quote.from).toBe('2026-03-02');
    expect(quote.to).toBe('2026-03-06');
  });
});

/* ------------------------------------- a rule that refuses, arriving as a sentence */

describe('when a rule says no', () => {
  /**
   * The claim this whole section exists for. Every refusal below already carries the sentence
   * that says what to do instead, and before LMS 403 each of them reached a browser as
   * "Something went wrong. It has been logged." — which sends a developer to the logs instead
   * of the person who can fix it.
   */
  it('says a period that costs nothing costs nothing, and why', async () => {
    /* FR 16a. A Saturday and a Sunday of annual leave. 400, because the dates are the fix. */
    const response = await get(
      `/api/me/requests/quote?leaveTypeId=${annualId}&from=2026-03-07&to=2026-03-08`,
      people.officer,
    );

    expect(response.status).toBe(400);

    const problem = (await response.json()) as { error: string; message: string };

    expect(problem.error).toBe('LeaveCountsNoDays');
    expect(problem.message).toContain('costs no Annual Leave at all');
  });

  /** FR 16. 400, and the message names both dates to submit instead. */
  it('names the two requests to submit where a period crosses a year end', async () => {
    const response = await get(
      `/api/me/requests/quote?leaveTypeId=${annualId}&from=2026-12-28&to=2027-01-05`,
      people.officer,
    );

    expect(response.status).toBe(400);

    const problem = (await response.json()) as { error: string; message: string };

    expect(problem.error).toBe('LeaveCrossesAYearEnd');
    expect(problem.message).toContain('31 December 2026');
    expect(problem.message).toContain('1 January 2027');
  });

  /** FR 15. 409, because nothing retyped fixes it — the leave is already booked. */
  it('names the leave already in the way', async () => {
    await requests.submit(asOfficer(), {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: 'My sister is getting married',
      /** FR 17, LMS 307. Every period in this file is behind today, so all of it is short. */
      acknowledgesShortNotice: true,
    });

    const response = await get(
      `/api/me/requests/quote?leaveTypeId=${annualId}&from=2026-03-04&to=2026-03-11`,
      people.officer,
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: 'LeaveOverlapsAnother',
    });
  });

  /** FR 14. 409, and the message says how many days could be asked for instead. */
  it('says how many days there are, where there are not enough', async () => {
    const response = await post('/api/me/requests', people.officer, {
      leaveTypeId: annualId,
      from: '2026-06-01',
      to: '2026-08-31',
      reason: 'A long break',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(409);

    const problem = (await response.json()) as { error: string; message: string };

    expect(problem.error).toBe('NotEnoughDays');
    expect(problem.message).toContain('Ask for');
  });

  /**
   * The validators keep their own family and their field, so a form can place the message.
   *
   * FR 10. Unpaid leave, which is one of the two types that asks for a reason — annual
   * leave takes the same body and answers 201, which the case below pins.
   */
  it('names the field for a request with no reason on it', async () => {
    const response = await post('/api/me/requests', people.officer, {
      leaveTypeId: unpaidId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: '   ',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { field: string }).toMatchObject({
      error: 'InvalidLeaveRequest',
      field: 'reason',
    });
  });

  /* FR 10. And the same body against a type that asks for none is written, with nothing
     stored rather than the spaces. */
  it('but takes the same request for a type that asks for none', async () => {
    const response = await post('/api/me/requests', people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: '   ',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(201);
    expect((await response.json()) as { reason: string | null }).toMatchObject({ reason: null });
  });

  /**
   * FR 17, LMS 307. Short notice is answered rather than refused, and the wire says which.
   *
   * A 400, because what has to change is part of what was sent rather than the state of the
   * world — the dates are fine and the days are there. The same body with the flag on it is a
   * 201, which is the whole of "never blocks" said over HTTP.
   */
  it('asks for the short notice acknowledgement, and takes the same request once it has it', async () => {
    const body = {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: 'My sister is getting married',
    };

    const refused = await post('/api/me/requests', people.officer, body);

    expect(refused.status).toBe(400);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('ShortNoticeNotAcknowledged');
    expect(problem.message).toContain('14 days');
    expect(problem.message).toMatch(/dates do not have to move/);

    const asked = await post('/api/me/requests', people.officer, {
      ...body,
      acknowledgesShortNotice: true,
    });

    expect(asked.status).toBe(201);
  });

  /**
   * FR 18, LMS 308. And the other window, which refuses rather than asking.
   *
   * A 409 for the person whose leave it is, because nothing they retype fixes it — the state
   * of the world is that the days are further back than the type allows, and the fix is a
   * different person. A 400 for HR, because what is missing is part of what they sent.
   */
  it('refuses leave from further back than the window, and answers HR differently', async () => {
    await admin.query('UPDATE leave_type SET max_backdate_calendar_days = 7 WHERE id = $1', [
      annualId,
    ]);

    const body = {
      employeeId: people.officer,
      leaveTypeId: annualId,
      from: daysFromToday(-24),
      to: daysFromToday(-20),
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
    };

    const refused = await post('/api/me/requests', people.officer, body);

    expect(refused.status).toBe(409);

    const problem = (await refused.json()) as { error: string; message: string };

    expect(problem.error).toBe('TooLateToRecord');
    expect(problem.message).toMatch(/Ask HR/);

    /* FR 18. HR's door, which is the only one that can name somebody else. */
    const asked = await post('/api/requests', people.hrOfficer, body);

    expect(asked.status).toBe(400);
    expect((await asked.json()) as { error: string }).toMatchObject({
      error: 'LateEntryNeedsAReason',
    });

    const entered = await post('/api/requests', people.hrOfficer, {
      ...body,
      lateEntryReason: 'She was in hospital that week and is only back today',
    });

    expect(entered.status).toBe(201);
  });

  /* Only `true` is somebody saying yes. A client sending the string, or the box's own
     `"on"`, has not acknowledged anything. */
  it('and takes nothing but true for one', async () => {
    for (const sent of ['true', 'on', 1, {}]) {
      const response = await post('/api/me/requests', people.officer, {
        leaveTypeId: annualId,
        from: '2026-03-02',
        to: '2026-03-06',
        reason: 'My sister is getting married',
        acknowledgesShortNotice: sent,
      });

      expect(response.status, `${JSON.stringify(sent)} was taken for an acknowledgement`).toBe(400);
    }
  });
});

/* --------------------------------------------------------------- asking for the leave */

describe('asking for the leave', () => {
  it('writes the request, holds the days and says what is left', async () => {
    const response = await post('/api/me/requests', people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-10',
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(201);

    const submitted = (await response.json()) as JsonSubmitted;

    /* FR 11. Counted again on the way in, and it is this figure that was stored — not one
       the browser sent. */
    expect(submitted.days).toBe(6);
    expect(submitted.calendarDays).toBe(9);
    expect(submitted.countingBasis).toBe('WORKING_DAYS');

    /* FR 38a, LMS 314. Sitting at the first desk of annual leave's chain. */
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.awaitingApprovalFrom).toBe('MANAGER');

    /* The days are held. §8. */
    expect(submitted.availableAfter).toBe(14);
  });

  /**
   * The day count is never an input, and this is the assertion that says so over the wire: a
   * body carrying its own figures is answered with the figures the server counted.
   */
  it('ignores a day count somebody put in the body', async () => {
    const response = await post('/api/me/requests', people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-10',
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
      days: 1,
      calendarDays: 1,
      status: 'APPROVED',
    });

    expect(response.status).toBe(201);

    const submitted = (await response.json()) as JsonSubmitted;

    expect(submitted.days).toBe(6);
    expect(submitted.status).toBe('SUBMITTED');
  });

  /** `/me` means me here too: the request is filed against the cookie's employee. */
  it('files it against the employee in the cookie, whatever the body says', async () => {
    const response = await post('/api/me/requests', people.officer, {
      employeeId: people.headOfHr,
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
    });

    expect(response.status).toBe(201);

    const { rows } = await admin.query<{ employee_id: string }>(
      'SELECT employee_id FROM leave_request',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(people.officer);
  });

  /**
   * And it turns up on the history screen, which is the next thing somebody looks at.
   *
   * The two screens are joined here rather than assumed: LMS 402 reads what LMS 403 wrote,
   * and the day count on the history is the one the submission counted rather than a second
   * opinion. Four days, because 6 March 2026 is Independence Day.
   */
  it('and appears on my request history', async () => {
    await post('/api/me/requests', people.officer, {
      leaveTypeId: annualId,
      from: '2026-03-02',
      to: '2026-03-06',
      reason: 'My sister is getting married',
      acknowledgesShortNotice: true,
    });

    const response = await get('/api/me/requests', people.officer);
    const history = (await response.json()) as { entries: { from: string; days: number }[] };

    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ from: '2026-03-02', days: 4 });
  });
});

/* --------------------------------------------------------------------------- helpers */

interface JsonRule {
  kind: string;
  inWords: string;
  asks: boolean;
}

interface JsonLeaveType {
  leaveTypeId: string;
  code: string;
  name: string;
  documentation: string;
  documentationAfterDays: number | null;
  exceedableWithDocument: boolean;
  minNoticeCalendarDays: number;
  maxBackdateCalendarDays: number;
  approvedBy: string;
  rules: JsonRule[];
}

interface JsonForm {
  employeeId: string;
  types: JsonLeaveType[];
}

interface JsonQuote {
  from: string;
  to: string;
  days: number;
  calendarDays: number;
  countingBasis: string;
  free: { date: string; because: string; name: string | null; inWords: string }[];
  availableNow: number;
  availableAfter: number;
  approvedBy: string;
  warnings: { code: string; message: string }[];
}

interface JsonSubmitted {
  requestId: string;
  days: number;
  calendarDays: number;
  countingBasis: string;
  status: string;
  awaitingApprovalFrom: string | null;
  availableAfter: number;
}

/** A calendar date this many days either side of today, in UTC. FR 18, LMS 308. */
function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return day.toISOString().slice(0, 10);
}

function get(path: string, employeeId: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}` },
  });
}

function post(path: string, employeeId: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${mintSession(employeeId, SECRET)}`,
    },
    body: JSON.stringify(body),
  });
}

async function formFor(employeeId: string, query = ''): Promise<JsonForm> {
  const response = await get(`/api/me/request-form${query}`, employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonForm;
}

async function typeOnTheForm(employeeId: string, leaveTypeId: string): Promise<JsonLeaveType> {
  const form = await formFor(employeeId);
  const type = form.types.find((one) => one.leaveTypeId === leaveTypeId);

  if (type === undefined) {
    throw new Error(`The form offered ${codesOn(form).join()} and not the type asked for.`);
  }

  return type;
}

async function quoteFor(
  employeeId: string,
  input: { leaveTypeId: string; from: string; to: string },
): Promise<JsonQuote> {
  const query = new URLSearchParams(input);
  const response = await get(`/api/me/requests/quote?${query.toString()}`, employeeId);

  expect(response.status).toBe(200);

  return (await response.json()) as JsonQuote;
}

function ruleOf(type: JsonLeaveType, kind: string): JsonRule | undefined {
  return type.rules.find((rule) => rule.kind === kind);
}

function said(type: JsonLeaveType, kind: string): string {
  return ruleOf(type, kind)?.inWords ?? '';
}

function kindsOf(type: JsonLeaveType): string[] {
  return type.rules.map((rule) => rule.kind);
}

function codesOn(form: JsonForm): string[] {
  return form.types.map((type) => type.code);
}

function codesOfWarnings(quote: JsonQuote): string[] {
  return quote.warnings.map((warning) => warning.code);
}

/** Adwoa Frimpong, the operations officer, as the domain sees her. */
function asOfficer() {
  return { ...system, employeeId: people.officer };
}

async function typeIdOf(code: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_type WHERE code = $1', [
    code,
  ]);

  return rows[0].id;
}

async function yearIdOf(label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>('SELECT id FROM leave_year WHERE label = $1', [
    label,
  ]);

  return rows[0].id;
}

function emptyTheLeaveTables(): Promise<unknown> {
  return admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'leave_request_decision, leave_request_routing, leave_request_withdrawal, leave_request, leave_balance',
  );
}

async function restoreYears(): Promise<void> {
  const columns = Object.keys(seededYears[0]).filter((column) => column !== 'updated_at');
  const placeholders = columns.map((_column, index) => `$${String(index + 1)}`).join(', ');

  await admin.query('TRUNCATE leave_year CASCADE');

  for (const row of seededYears) {
    await admin.query(
      `INSERT INTO leave_year (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  }

  await admin.query(`SELECT setval('leave_year_id_seq', (SELECT max(id) FROM leave_year))`);
}
