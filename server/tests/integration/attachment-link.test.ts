import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { signedInAs, theSystem } from '../../src/auth/actor.js';
import { Guard, NotAuthorised } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { AUDITED_ENTITIES } from '../../src/features/audit/audit.js';
import { calendarDateIn } from '../../src/shared/time.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';
import { AttachmentNotScanned } from '../../src/features/leave-request/attachment.js';
import {
  DOWNLOAD_LINK_SECONDS,
  DownloadLinkNotUsable,
  newDownloadToken,
} from '../../src/features/leave-request/attachment-link.js';
import { AttachmentRepository } from '../../src/features/leave-request/attachment.db.js';
import { AttachmentLinkRepository } from '../../src/features/leave-request/attachment-link.db.js';
import { AttachmentService } from '../../src/features/leave-request/attachment.service.js';
import { BalanceRepository } from '../../src/features/balance/balance.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { LeaveDecisionRepository } from '../../src/features/leave-request/leave-decision.db.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../../src/features/leave-request/routing.db.js';
import { WithdrawalRepository } from '../../src/features/leave-request/withdrawal.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { OrganisationRepository } from '../../src/features/organisation/organisation.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { Transactions } from '../../src/db/transaction.js';
import { BalanceService } from '../../src/features/balance/balance.service.js';
import { LeaveCalculatorService } from '../../src/features/leave-calculator/leave-calculator.service.js';
import { LeaveRequestService } from '../../src/features/leave-request/leave-request.service.js';
import { LeaveYearService } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { SignatureScanner } from '../../src/scanning/signature-scanner.js';
import { UnavailableScanner } from '../../src/scanning/unavailable-scanner.js';
import { InMemoryStorage } from '../support/in-memory-storage.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { delegationService } from '../support/delegations.js';

/**
 * Fetching a certificate through a link that expires. NFR SEC 04, NFR SEC 06. LMS 407.
 *
 * ../unit/attachment-link.test.ts proves what is pure: what a token is, what is kept of it,
 * and the four reasons a link opens nothing. What needs a database and a store —
 *
 *   **There is no other address.** The bytes are reached by minting a link and spending it,
 *   and by nothing else.
 *
 *   **A link is spent once, and lasts as long as the schema says.** Both are the database's,
 *   not this application's.
 *
 *   **The standing is asked twice.** A link that outlived the standing behind it opens
 *   nothing, which is the half a signed URL on its own cannot do.
 *
 *   **Every reach is written down, refusals included** — and the account survives the file
 *   being taken off the request.
 */

const testDatabaseUrl = await databaseForThisFile();

const system = theSystem('attachment link integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let attachments: AttachmentService;
/** The same service with a scanner that answers nothing. NFR SEC 07. */
let unscanned: AttachmentService;
let storage: InMemoryStorage;
let requests: LeaveRequestService;
let balances: BalanceService;
let years: LeaveYearService;
let people: Record<string, string>;

let y2026: LeaveYear;
let annualId: string;

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  const employees = new EmployeeRepository(db);
  const types = new LeaveTypeRepository(db);
  const yearRepository = new LeaveYearRepository(db);
  const requestRepository = new LeaveRequestRepository(db);
  const organisation = new OrganisationRepository(db);
  const attachmentRepository = new AttachmentRepository(db);
  const linkRepository = new AttachmentLinkRepository(db);

  balances = new BalanceService(new BalanceRepository(db), guard, employees, new Transactions(db));
  years = new LeaveYearService(yearRepository, guard);

  requests = new LeaveRequestService(
    balances,
    guard,
    employees,
    types,
    yearRepository,
    requestRepository,
    new LeaveDecisionRepository(db),
    new LeaveRoutingRepository(db),
    new WithdrawalRepository(db),
    attachmentRepository,
    new RoleRepository(db),
    delegationService(db, guard),
    organisation,
    new LeaveCalculatorService(new WorkPatternRepository(db), new HolidayRepository(db), guard),
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
  );

  storage = new InMemoryStorage();

  attachments = new AttachmentService(
    guard,
    attachmentRepository,
    linkRepository,
    requestRepository,
    employees,
    types,
    organisation,
    delegationService(db, guard),
    storage,
    new SignatureScanner(),
  );

  unscanned = new AttachmentService(
    guard,
    attachmentRepository,
    linkRepository,
    requestRepository,
    employees,
    types,
    organisation,
    delegationService(db, guard),
    storage,
    new UnavailableScanner(),
  );
});

beforeEach(async () => {
  await clear();
  storage.reset();

  people = (await seed(admin)) as Record<string, string>;

  y2026 = (await years.byLabel(system, '2026'))!;
  annualId = (await admin.query("SELECT id FROM leave_type WHERE code = 'ANNUAL'")).rows[0].id;

  await admin.query('BEGIN');
  await admin.query('DELETE FROM leave_type_approval_step WHERE leave_type_id = $1', [annualId]);
  await admin.query('SELECT ensure_statutory_approval_chains()');
  await admin.query('COMMIT');

  await balances.grantTheYear(system, {
    employeeId: people.officer,
    leaveTypeId: annualId,
    leaveYearId: y2026.id,
    days: 20,
    reason: 'Annual entitlement for 2026',
  });
});

afterAll(async () => {
  await clear();

  await db?.destroy();
  await admin?.end();
});

async function clear(): Promise<void> {
  await admin.query('TRUNCATE leave_balance');
  await admin.query(
    'TRUNCATE notification, leave_entitlement_event, leave_ledger_entry, ' +
      'attachment_access, attachment_download_link, leave_request_attachment, ' +
      'leave_request_decision, leave_request_reassignment, leave_request_routing, ' +
      'leave_request_withdrawal, leave_request_draft, leave_request',
  );
}

/* --------------------------------------------------------------------- the fixtures */

function daysFromToday(offset: number): string {
  const day = new Date();

  day.setUTCDate(day.getUTCDate() + offset);

  return calendarDateIn(day, 'UTC');
}

function asTheEmployee() {
  return signedInAs(people.officer, { roles: ['EMPLOYEE'], isManager: false });
}

function asTheirManager() {
  return signedInAs(people.teamLead, { roles: ['EMPLOYEE'], isManager: true });
}

function asAStranger() {
  return signedInAs(people.engineer, { roles: ['EMPLOYEE'], isManager: false });
}

const A_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('a certificate')]);

function aFile(content = A_PDF, filename = 'certificate.pdf') {
  return { filename, content, claimedContentType: 'application/octet-stream' };
}

/** A submitted request of the employee's, sitting with their manager. */
async function aRequest() {
  const submitted = await requests.submit(asTheEmployee(), {
    employeeId: people.officer,
    leaveTypeId: annualId,
    from: daysFromToday(21),
    to: daysFromToday(25),
    reason: 'My sister is getting married',
    acknowledgesShortNotice: true,
  });

  return submitted.request;
}

/** A request with one clean file on it, which is the whole of every case below. */
async function aRequestWithACertificate() {
  const request = await aRequest();
  const attached = await attachments.attach(asTheEmployee(), request.id, aFile());

  return { request, attached };
}

/** The token out of the path, which is the only thing a browser ever holds. */
function tokenIn(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

async function accessesFor(attachmentId: string) {
  const { rows } = await admin.query<{ outcome: string; because: string | null; by: string }>(
    'SELECT outcome, because, accessed_by_employee_id::text AS by FROM attachment_access ' +
      'WHERE attachment_id = $1 ORDER BY id',
    [attachmentId],
  );

  return rows;
}

/* ------------------------------------------------------------------- minting one */

describe('asking for a link', () => {
  it('gives an address that is not the file, and says when it stops working', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);

    expect(issued.url).toMatch(/^\/api\/attachments\/downloads\/[0-9a-f]{64}$/);
    /* NFR SEC 04. The handle is storage's, and an address derived from it would be one. */
    expect(issued.url).not.toContain(attached.storageKey);
    expect(issued.expiresInSeconds).toBeLessThanOrEqual(DOWNLOAD_LINK_SECONDS);
  });

  /* The two minutes are the schema's. A story that moved the constant and left the CHECK
     alone would fail here rather than on the afternoon somebody copied an address. */
  it('lasts exactly as long as the migration says, and the database decides that', async () => {
    const { request, attached } = await aRequestWithACertificate();

    await attachments.linkTo(asTheEmployee(), request.id, attached.id);

    const { rows } = await admin.query<{ seconds: string }>(
      'SELECT extract(epoch FROM expires_at - issued_at)::text AS seconds ' +
        'FROM attachment_download_link WHERE attachment_id = $1',
      [attached.id],
    );

    expect(Number(rows[0].seconds)).toBe(DOWNLOAD_LINK_SECONDS);
  });

  it('is minted for the approver who has to decide on it', async () => {
    const { request, attached } = await aRequestWithACertificate();

    await expect(
      attachments.linkTo(asTheirManager(), request.id, attached.id),
    ).resolves.toBeDefined();
  });

  it('and for nobody with no standing over the request', async () => {
    const { request, attached } = await aRequestWithACertificate();

    await expect(attachments.linkTo(asAStranger(), request.id, attached.id)).rejects.toThrow(
      NotAuthorised,
    );
  });

  /* NFR SEC 07. There is no address for a file nothing has cleared. */
  it('and never for a file the scanner has not answered for', async () => {
    const request = await aRequest();
    const attached = await unscanned.attach(asTheEmployee(), request.id, aFile());

    await expect(attachments.linkTo(asTheEmployee(), request.id, attached.id)).rejects.toThrow(
      AttachmentNotScanned,
    );
  });
});

/* ------------------------------------------------------------------ spending one */

describe('following a link', () => {
  it('gives the bytes back exactly as they went in', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);
    const { content } = await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));

    expect(content).toEqual(A_PDF);
  });

  /* The whole of "short lived": the same address a second time is not an address. */
  it('works once, and the same address a second time opens nothing', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);

    await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));

    await expect(attachments.downloadVia(asTheEmployee(), tokenIn(issued.url))).rejects.toThrow(
      DownloadLinkNotUsable,
    );
  });

  /* NFR SEC 04. A copied address is worthless rather than merely brief. */
  it('opens nothing for anybody but the person it was minted for', async () => {
    const { request, attached } = await aRequestWithACertificate();

    /* Minted for the manager, who may read it, and handed to a colleague who may not — and
       to HR, who may. Neither gets in. */
    const issued = await attachments.linkTo(asTheirManager(), request.id, attached.id);

    await expect(attachments.downloadVia(asAStranger(), tokenIn(issued.url))).rejects.toThrow(
      DownloadLinkNotUsable,
    );
    await expect(attachments.downloadVia(asTheEmployee(), tokenIn(issued.url))).rejects.toThrow(
      DownloadLinkNotUsable,
    );
  });

  it('and nothing at all for a token nobody issued', async () => {
    await expect(attachments.downloadVia(asTheEmployee(), newDownloadToken())).rejects.toThrow(
      DownloadLinkNotUsable,
    );
  });

  /**
   * The standing is asked again at the fetch. NFR SEC 04, LMS 407.
   *
   * The half a signed URL on its own cannot do: the manager was at the desk when the link
   * was minted and is not when it is presented, so it opens nothing — and the refusal is on
   * the record beside the minting.
   */
  it('opens nothing once the standing behind it has gone', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheirManager(), request.id, attached.id);

    await admin.query('UPDATE employee SET manager_id = $1 WHERE id = $2', [
      people.hrOfficer,
      people.officer,
    ]);

    await expect(attachments.downloadVia(asTheirManager(), tokenIn(issued.url))).rejects.toThrow(
      NotAuthorised,
    );

    expect(await accessesFor(attached.id)).toMatchObject([
      { outcome: 'ISSUED' },
      { outcome: 'REFUSED' },
    ]);
  });
});

/* -------------------------------------------------------------- the fourth criterion */

describe('every access is written down', () => {
  it('records the asking and the fetching, and who did each', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheirManager(), request.id, attached.id);
    await attachments.downloadVia(asTheirManager(), tokenIn(issued.url));

    expect(await accessesFor(attached.id)).toEqual([
      { outcome: 'ISSUED', because: null, by: people.teamLead },
      { outcome: 'DOWNLOADED', because: null, by: people.teamLead },
    ]);
  });

  it('records a refusal, and says why in the log rather than in the message', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);

    await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));
    await expect(attachments.downloadVia(asTheEmployee(), tokenIn(issued.url))).rejects.toThrow(
      DownloadLinkNotUsable,
    );

    const log = await accessesFor(attached.id);

    expect(log.map((row) => row.outcome)).toEqual(['ISSUED', 'DOWNLOADED', 'ALREADY_USED']);
    expect(log[2].because).toContain('already been used');
  });

  /* A token that names no link is about no file, so there is nothing to file it under. */
  it('and writes nothing down for a token that names nothing', async () => {
    const { attached } = await aRequestWithACertificate();

    await expect(attachments.downloadVia(asTheEmployee(), newDownloadToken())).rejects.toThrow(
      DownloadLinkNotUsable,
    );

    expect(await accessesFor(attached.id)).toEqual([]);
  });

  /* NFR SEC 04. A log of who read a certificate that the reader can edit is not a log. */
  it('cannot be edited or removed, on any connection', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);
    await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));

    await expect(
      admin.query("UPDATE attachment_access SET outcome = 'ISSUED' WHERE attachment_id = $1", [
        attached.id,
      ]),
    ).rejects.toThrow(/never changed/);

    await expect(
      admin.query('DELETE FROM attachment_access WHERE attachment_id = $1', [attached.id]),
    ).rejects.toThrow(/never deleted/);
  });

  /**
   * The account outlives the file. NFR SEC 04, LMS 407.
   *
   * FR 12 lets the uploader take a file back off while it is being decided, and the links
   * for it go in the same statement — an unspent address for bytes nobody may reach is not
   * something to keep. Who read it while it was there is not the same kind of thing.
   */
  it('and survives the file being taken back off the request', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);
    await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));

    await attachments.remove(asTheEmployee(), request.id, attached.id);

    expect(await accessesFor(attached.id)).toHaveLength(2);
    expect(
      (
        await admin.query('SELECT 1 FROM attachment_download_link WHERE attachment_id = $1', [
          attached.id,
        ])
      ).rowCount,
    ).toBe(0);
  });

  /* NFR AUD 01. Neither table is audited: the link is frozen by its own trigger, and an
     audit of the access log would be a second copy of every read. */
  it('is its own record, and `AUDITED_ENTITIES` says so', () => {
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('attachment_access');
    expect(AUDITED_ENTITIES as readonly string[]).not.toContain('attachment_download_link');
  });
});

/* ------------------------------------------------------------------ the link itself */

describe('the link row', () => {
  it('keeps the digest of the token and never the token', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);

    const { rows } = await admin.query<{ token_digest: string }>(
      'SELECT token_digest FROM attachment_download_link WHERE attachment_id = $1',
      [attached.id],
    );

    expect(rows[0].token_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_digest).not.toBe(tokenIn(issued.url));
  });

  it('is spent once and edited never, on any connection', async () => {
    const { request, attached } = await aRequestWithACertificate();

    const issued = await attachments.linkTo(asTheEmployee(), request.id, attached.id);
    await attachments.downloadVia(asTheEmployee(), tokenIn(issued.url));

    await expect(
      admin.query(
        'UPDATE attachment_download_link SET redeemed_at = now() WHERE attachment_id = $1',
        [attached.id],
      ),
    ).rejects.toThrow(/already been used/);

    await expect(
      admin.query(
        "UPDATE attachment_download_link SET token_digest = repeat('a', 64) WHERE attachment_id = $1",
        [attached.id],
      ),
    ).rejects.toThrow(/already been used/);
  });
});
