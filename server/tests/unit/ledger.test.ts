import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUCKETS,
  correctionFor,
  ENTRY_SIGNS,
  inOrderWritten,
  InvalidLedgerEntry,
  isACorrection,
  isARequestMovement,
  LARGEST_MOVEMENT,
  LEDGER_ENTRY_TYPES,
  type LedgerEntry,
  LedgerEntryIsFinal,
  type LedgerEntryType,
  type NewLedgerEntry,
  REQUEST_MOVEMENTS,
  runningTotal,
  validateNewLedgerEntry,
} from '../../src/domain/ledger.js';

/**
 * The balance ledger. FR 27, §5.7, design principle 1. LMS 210.
 *
 * The rules are pure functions, so this file is where the story is proved. There
 * is an integration suite beside it — ../integration/ledger.test.ts — and what it
 * proves is narrower on purpose: that the same rules hold against a writer that
 * never came through the domain, and that no connection can change or remove a row.
 *
 * The property nearly every test below is really about: **an entry, once written,
 * is the account.** Not a draft of it. So the interesting assertions are not that
 * a bad entry is refused — every table in this system refuses bad rows — but that
 * there is no shape of correct-looking call that changes an existing one, and that
 * the only thing offered instead is exact.
 *
 * Two distinctions get the most attention, because both look like tidiness and are
 * not:
 *
 *   A correction is an ADJUSTMENT, always. It is the only type free in its sign,
 *   and every other type keeps a fixed one because of it.
 *
 *   A run of signed days is not a balance. {@link runningTotal} says what the rows
 *   did; available is five buckets and is LMS 211, and the gap between those two
 *   sentences is where a wrong figure would live.
 */

/** The fields every entry has to name, so a test can vary only what it is about. */
const SOUND: NewLedgerEntry = {
  employeeId: '1',
  leaveTypeId: '2',
  leaveYearId: '3',
  entryType: 'GRANT',
  days: 20,
  reason: 'Annual entitlement for 2026',
};

/**
 * SOUND, plus the request id LMS 301 requires of the four request-shaped kinds.
 *
 * The rule itself is asserted once, in its own block below. Everywhere else a
 * RESERVATION is a convenient example of something else — a sign, a size, a zero — and
 * this keeps those cases about what they are about.
 */
function soundFor(entryType: LedgerEntryType): NewLedgerEntry {
  return {
    ...SOUND,
    entryType,
    ...((REQUEST_MOVEMENTS as readonly string[]).includes(entryType)
      ? { leaveRequestId: '77' }
      : {}),
  };
}

/**
 * A written entry, built from the same validation a real one goes through.
 *
 * Since LMS 301 the four request-shaped kinds have to name the request that caused
 * them, so one is supplied here for any test that asks about one. That keeps the rule
 * asserted in the one place below that is about it, rather than repeated in every case
 * that merely happens to use a RESERVATION to say something else.
 */
function stored(
  overrides: Partial<NewLedgerEntry> & { id?: string; at?: string } = {},
): LedgerEntry {
  const { id = '1', at = '2026-01-01T00:00:00Z', ...input } = overrides;
  const entryType = input.entryType ?? SOUND.entryType;

  return {
    id,
    ...validateNewLedgerEntry({
      ...SOUND,
      ...((REQUEST_MOVEMENTS as readonly string[]).includes(entryType)
        ? { leaveRequestId: '77' }
        : {}),
      ...input,
    }),
    createdBy: 'Ama in HR',
    createdByEmployeeId: '9',
    createdAt: new Date(at),
  };
}

/** The field a refusal blamed, which is what a form puts the message next to. */
function refusedField(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidLedgerEntry);
    return (error as InvalidLedgerEntry).field;
  }

  throw new Error('That was accepted, and should not have been.');
}

/* -------------------------------------------------------- the nine, and signs */

describe('the nine kinds of movement, §5.7', () => {
  it('are the nine the stories name', () => {
    expect([...LEDGER_ENTRY_TYPES].sort()).toEqual(
      [
        'ADJUSTMENT',
        'CARRY_FORWARD',
        'DEDUCTION',
        'EXPIRY',
        'GRANT',
        'LAPSE',
        'RECALCULATION',
        'RELEASE',
        'RESERVATION',
      ].sort(),
    );
  });

  /**
   * The database holds the same list.
   *
   * A type this file knows and the column refuses is a write that fails at the last
   * moment; one the column allows and this file does not is days moving for a reason
   * no screen can render. Read out of the SQL rather than restated, so the assertion
   * is that the two agree rather than that both match a third copy written here.
   *
   * **The *last* migration to define the constraint is the one that counts**, and
   * this searches for it rather than naming a file. LMS 218 added a ninth type by
   * dropping and recreating the CHECK, which is what a migration has to do — the file
   * that first declared it is never edited once merged — so a test pinned to that
   * file would have gone on asserting against a constraint the database no longer
   * has, and would have passed while doing it.
   */
  it('are the same nine the migrations leave behind', () => {
    const declarations = readdirSync(join(process.cwd(), 'server', 'migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .flatMap((file) => {
        /* The Up section alone. Every migration that changes a constraint restores
           the previous one below `-- Down Migration`, and reading that would be
           asserting against the state this schema has been rolled back out of. */
        const up = readFileSync(join(process.cwd(), 'server', 'migrations', file), 'utf8').split(
          '-- Down Migration',
        )[0];

        return [
          ...up.matchAll(/leave_ledger_entry_type_known CHECK \(\s*entry_type IN \(([^)]*)\)/g),
        ].map((held) => held[1]);
      });

    expect(declarations.length, 'the constraint moved or was renamed').toBeGreaterThan(0);

    const inForce = declarations.at(-1)!;

    expect(
      [...(inForce.match(/'([A-Z_]+)'/g) ?? [])].map((code) => code.replace(/'/g, '')).sort(),
    ).toEqual([...LEDGER_ENTRY_TYPES].sort());
  });

  it('each has a sign rule, and only an adjustment is free', () => {
    for (const type of LEDGER_ENTRY_TYPES) {
      expect(ENTRY_SIGNS[type], type).toBeDefined();
    }

    expect(LEDGER_ENTRY_TYPES.filter((type) => ENTRY_SIGNS[type] === 'EITHER')).toEqual([
      'ADJUSTMENT',
    ]);
  });

  /* §5.7's own table, restated as the assertion that the code matches it. LAPSE is
     not in that table — it is FR 32e's, added by LMS 218 — and goes the way its
     neighbour EXPIRY does, because both are days running out. */
  it('go the way the Technical Design Document says they go', () => {
    expect(ENTRY_SIGNS).toEqual({
      GRANT: 'ADDS',
      CARRY_FORWARD: 'ADDS',
      RELEASE: 'ADDS',
      RECALCULATION: 'ADDS',
      RESERVATION: 'CONSUMES',
      DEDUCTION: 'CONSUMES',
      EXPIRY: 'CONSUMES',
      LAPSE: 'CONSUMES',
      ADJUSTMENT: 'EITHER',
    });
  });

  /**
   * And the two that run a clock out are two, on purpose.
   *
   * `EXPIRY` is FR 36a — carried days lapsing in the month HR named — and takes days
   * back out of `carriedOver` where the carry put them. `LAPSE` is FR 32e — an event
   * grant unused before its deadline — and takes days out of `entitled` where the
   * grant put them. ../../src/domain/leave-type.ts named the collision before either
   * existed: "two clocks with similar names".
   *
   * Using one for the other would leave a paternity balance reading
   * `carriedOver: -14` on a type that cannot carry a single day. Available would come
   * out right and the column would be false, which is the failure design principle 1
   * exists to prevent, and it is why LMS 218 spent a migration on a ninth type rather
   * than reusing the eighth.
   */
  it('and the two clocks put their days back where each came from', () => {
    expect(BUCKETS.EXPIRY).toEqual(BUCKETS.CARRY_FORWARD);
    expect(BUCKETS.LAPSE).toEqual(BUCKETS.GRANT);
    expect(BUCKETS.EXPIRY).not.toEqual(BUCKETS.LAPSE);
  });

  it('divide into the four a request causes and the four it does not', () => {
    expect([...REQUEST_MOVEMENTS].sort()).toEqual([
      'DEDUCTION',
      'RECALCULATION',
      'RELEASE',
      'RESERVATION',
    ]);

    expect(isARequestMovement('RESERVATION')).toBe(true);
    expect(isARequestMovement('GRANT')).toBe(false);
  });

  it.each(LEDGER_ENTRY_TYPES)('%s says which balance column it moves', (type) => {
    expect(BUCKETS[type].length).toBeGreaterThan(0);
  });

  /**
   * The one that moves two, and the reason nothing here sums signed days into a
   * balance.
   *
   * Approval does not consume days a second time — the reservation already did —
   * it moves them from held to taken. A projection that added the pair would show
   * ten days gone where five were.
   */
  it('and DEDUCTION is the one that moves days between two of them', () => {
    expect(LEDGER_ENTRY_TYPES.filter((type) => BUCKETS[type].length > 1)).toEqual(['DEDUCTION']);

    expect(BUCKETS.DEDUCTION).toEqual(['pending', 'taken']);
  });
});

/* --------------------------------------------------------------- the amount */

describe('how many days moved', () => {
  it('is refused the wrong way round for its type', () => {
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, days: -20 }))).toBe('days');
    expect(
      refusedField(() => validateNewLedgerEntry({ ...soundFor('RESERVATION'), days: 5 })),
    ).toBe('days');
    expect(
      refusedField(() => validateNewLedgerEntry({ ...SOUND, entryType: 'EXPIRY', days: 3 })),
    ).toBe('days');
  });

  it('goes either way for an adjustment, which is the only one that does', () => {
    expect(validateNewLedgerEntry({ ...SOUND, entryType: 'ADJUSTMENT', days: 3 }).days).toBe(3);
    expect(validateNewLedgerEntry({ ...SOUND, entryType: 'ADJUSTMENT', days: -3 }).days).toBe(-3);
  });

  /* A movement of no days is not a movement. It would be a line in somebody's
     history that explains nothing and has to be skipped by every reader of it. */
  it('is never nothing', () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      expect(refusedField(() => validateNewLedgerEntry({ ...soundFor(entryType), days: 0 }))).toBe(
        'days',
      );
    }
  });

  it('is a number, and a finite one', () => {
    for (const days of [NaN, Infinity, -Infinity, '20' as unknown as number, null, undefined]) {
      expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, days: days as number }))).toBe(
        'days',
      );
    }
  });

  it('is refused past the size the column holds', () => {
    expect(validateNewLedgerEntry({ ...SOUND, days: LARGEST_MOVEMENT }).days).toBe(
      LARGEST_MOVEMENT,
    );
    expect(
      refusedField(() => validateNewLedgerEntry({ ...SOUND, days: LARGEST_MOVEMENT + 1 })),
    ).toBe('days');
  });
});

/**
 * FR 24 and §8.6d, which say different things and are both right.
 *
 * A request is whole days; what somebody has accrued is divisible. The line between
 * the two runs exactly along {@link REQUEST_MOVEMENTS}, and it is the reason the
 * column is allowed a scale at all — see ./migrations.test.ts, which permits it by
 * name on this condition.
 */
/**
 * Which request a movement is about. LMS 301.
 *
 * The column the immutable-leave-ledger migration refused to add until there was a
 * table to put behind it, and the rule it named when it did: "the four request-shaped
 * entry types must carry one".
 *
 * **It is an equivalence rather than a requirement, and the second half is the half
 * that matters.** A reservation with no request is days held for nothing anybody can
 * find, which is the obvious failure. A *grant* with a request is a year's entitlement
 * filed under a fortnight in March — which is what a method copied from `reserve`
 * produces, looks entirely reasonable, and nothing downstream would question.
 */
describe('which request a movement is about', () => {
  it.each(REQUEST_MOVEMENTS)('%s has to name the request that caused it', (entryType) => {
    const days = ENTRY_SIGNS[entryType] === 'ADDS' ? 5 : -5;

    expect(validateNewLedgerEntry({ ...soundFor(entryType), days }).leaveRequestId).toBe('77');
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, entryType, days }))).toBe(
      'leaveRequestId',
    );
  });

  it.each(LEDGER_ENTRY_TYPES.filter((type) => !REQUEST_MOVEMENTS.includes(type)))(
    '%s moves what somebody is owed, so it cannot name one',
    (entryType) => {
      const days = ENTRY_SIGNS[entryType] === 'CONSUMES' ? -5 : 5;

      expect(validateNewLedgerEntry({ ...SOUND, entryType, days }).leaveRequestId).toBeNull();
      expect(
        refusedField(() =>
          validateNewLedgerEntry({ ...SOUND, entryType, days, leaveRequestId: '77' }),
        ),
      ).toBe('leaveRequestId');
    },
  );

  /* The line runs exactly along REQUEST_MOVEMENTS, which is the same list FR 24's whole
     days rule runs along — because they are the same distinction seen twice. A request
     is whole days and names a request; what somebody has accrued is divisible and names
     nothing. */
  it('and the line is the same one whole days are held to', () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      const needsARequest = (REQUEST_MOVEMENTS as readonly string[]).includes(entryType);

      expect(isARequestMovement(entryType), entryType).toBe(needsARequest);
    }
  });

  /* And a correction of a reservation is an ADJUSTMENT, so it names no request — which
     is right rather than an oversight: the adjustment is HR moving days by fiat, and
     what it puts right is an entry rather than a request. */
  it('and the correction of a request movement names no request', () => {
    const held = stored({ entryType: 'RESERVATION', days: -5 });

    expect(correctionFor(held, 'wrong person').leaveRequestId).toBeUndefined();
    expect(validateNewLedgerEntry(correctionFor(held, 'wrong person')).leaveRequestId).toBeNull();
  });
});

describe('whole days, and the one place a fraction belongs', () => {
  it.each(REQUEST_MOVEMENTS)('%s follows a request, so it moves whole days', (entryType) => {
    const whole = ENTRY_SIGNS[entryType] === 'ADDS' ? 5 : -5;
    const half = ENTRY_SIGNS[entryType] === 'ADDS' ? 5.5 : -5.5;

    expect(validateNewLedgerEntry({ ...soundFor(entryType), days: whole }).days).toBe(whole);
    expect(refusedField(() => validateNewLedgerEntry({ ...soundFor(entryType), days: half }))).toBe(
      'days',
    );
  });

  /* §8.6d: a joiner on 1 July is owed 20 × 184/365 = 10.08 days, and FR 24
     "governs how leave is requested, not how entitlement is held". */
  it('a pro rated entitlement keeps its hundredths', () => {
    expect(validateNewLedgerEntry({ ...SOUND, days: 10.08 }).days).toBe(10.08);
    expect(validateNewLedgerEntry({ ...SOUND, entryType: 'CARRY_FORWARD', days: 9.92 }).days).toBe(
      9.92,
    );
    expect(validateNewLedgerEntry({ ...SOUND, entryType: 'EXPIRY', days: -0.5 }).days).toBe(-0.5);
  });

  /**
   * And no finer, because Postgres would round it away silently.
   *
   * The column is NUMERIC(6,2). A third decimal place is a figure nobody typed
   * appearing in an account whose whole claim is that every figure can be
   * explained — refused rather than rounded, for the same reason LMS 209 refuses
   * rather than rounds.
   */
  it('and is refused past the hundredth of a day', () => {
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, days: 10.083 }))).toBe('days');
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, days: 1 / 3 }))).toBe('days');
  });
});

/* ---------------------------------------------------------------- the reason */

describe('the reason, FR 27', () => {
  it('is mandatory, and blank is not one', () => {
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, reason: '' }))).toBe('reason');
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, reason: '   ' }))).toBe('reason');
    expect(
      refusedField(() =>
        validateNewLedgerEntry({ ...SOUND, reason: undefined as unknown as string }),
      ),
    ).toBe('reason');
  });

  it('is trimmed rather than refused when it arrives padded', () => {
    expect(validateNewLedgerEntry({ ...SOUND, reason: '  opening balance  ' }).reason).toBe(
      'opening balance',
    );
  });

  /* Deliberately no rule about what it may say. A reason nobody can write freely is
     a reason everybody writes 'correction' in. */
  it('says whatever the writer needs it to say', () => {
    const wordy = 'Transferred from the previous system; see the migration note of 3 January.';

    expect(validateNewLedgerEntry({ ...SOUND, reason: wordy }).reason).toBe(wordy);
  });
});

/* ------------------------------------------------------- what an entry names */

describe('the balance an entry is filed under', () => {
  it.each(['employeeId', 'leaveTypeId', 'leaveYearId'] as const)('names a %s', (field) => {
    expect(refusedField(() => validateNewLedgerEntry({ ...SOUND, [field]: '' }))).toBe(field);
    expect(
      refusedField(() =>
        validateNewLedgerEntry({ ...SOUND, [field]: undefined as unknown as string }),
      ),
    ).toBe(field);
  });

  it('refuses a kind of movement that is not one of the eight', () => {
    expect(
      refusedField(() =>
        validateNewLedgerEntry({ ...SOUND, entryType: 'WRITE_OFF' as LedgerEntryType }),
      ),
    ).toBe('entryType');
  });
});

/* ------------------------------------------------------------- corrections */

describe('a correction is a new entry, never an edit', () => {
  const grant = stored({ id: '41', days: 20, reason: 'Annual entitlement for 2026' });

  it('is the exact opposite of what it puts right', () => {
    const putRight = correctionFor(grant, 'Granted against the wrong leave year');

    expect(putRight).toMatchObject({
      employeeId: grant.employeeId,
      leaveTypeId: grant.leaveTypeId,
      leaveYearId: grant.leaveYearId,
      entryType: 'ADJUSTMENT',
      days: -20,
      correctsId: '41',
    });
  });

  /**
   * The amount is not the caller's to choose, and that is the rule rather than a
   * convenience.
   *
   * A correction somebody could size is a correction that can be the wrong size,
   * and "an adjustment of −18 correcting a grant of 20" is a row that looks
   * reconciled and leaves two days behind. Anybody who wants a different figure
   * wants an ordinary adjustment, which reads as one.
   */
  it('takes no amount from the caller at all', () => {
    expect(correctionFor(stored({ days: 10.08 }), 'wrong figure').days).toBe(-10.08);
    expect(
      correctionFor(stored({ entryType: 'RESERVATION', days: -5 }), 'never submitted').days,
    ).toBe(5);
  });

  it('still needs a reason, because that is the one thing it cannot work out', () => {
    expect(() => correctionFor(grant, '')).toThrow(InvalidLedgerEntry);
    expect(() => correctionFor(grant, '   ')).toThrow(InvalidLedgerEntry);
  });

  /* Every other type keeps a fixed sign precisely because corrections do not use
     them: putting right a grant of +20 means −20, which is not a grant. */
  it('is refused as any type but an adjustment', () => {
    for (const entryType of LEDGER_ENTRY_TYPES) {
      const build = () =>
        validateNewLedgerEntry({ ...SOUND, entryType, days: 1, correctsId: '41' });

      if (entryType === 'ADJUSTMENT') {
        expect(build().correctsId).toBe('41');
      } else {
        expect(refusedField(build)).toBe('entryType');
      }
    }
  });

  it('is legible as one afterwards', () => {
    expect(isACorrection(stored({ entryType: 'ADJUSTMENT', days: -20, correctsId: '41' }))).toBe(
      true,
    );
    expect(isACorrection(grant)).toBe(false);
  });

  /* A wrong reversal is a mistake like any other, and the honest fix is another
     row. Nothing here caps the chain. */
  it('may itself be corrected', () => {
    const wrongly = stored({ id: '42', entryType: 'ADJUSTMENT', days: -20, correctsId: '41' });

    expect(correctionFor(wrongly, 'that grant was right after all')).toMatchObject({
      days: 20,
      correctsId: '42',
    });
  });

  /**
   * And there is nothing anywhere that changes an entry.
   *
   * The assertion the story is really about, and it can only be made negatively:
   * the module offers no verb that takes an existing entry and returns a changed
   * one. {@link LedgerEntryIsFinal} exists to answer the database's refusal with a
   * sentence, and it is the closest thing here to an edit.
   */
  it('and nothing in this file offers a way to change one', () => {
    const source = readFileSync(join(process.cwd(), 'server', 'src', 'domain', 'ledger.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    expect(source).not.toMatch(/export function (edit|update|amend|void|reverse|delete|remove)/);

    expect(new LedgerEntryIsFinal('41', 'changed').message).toMatch(/compensating adjustment/);
  });
});

/* --------------------------------------------------------------- the reading */

describe('reading a run of entries', () => {
  /**
   * Oldest first, and the tie break is the point.
   *
   * A year rollover posts a CARRY_FORWARD and a GRANT in one transaction, so
   * `now()` is identical on both. Ordering on the timestamp alone would put them
   * in a different order on different reads, and an account that reorders itself
   * is one nobody can check twice.
   */
  it('is in the order they were written, ties broken by id', () => {
    const same = '2026-01-01T00:00:00Z';
    const shuffled = [
      stored({ id: '10', at: same, entryType: 'CARRY_FORWARD', days: 3 }),
      stored({ id: '2', at: '2026-03-01T00:00:00Z', entryType: 'RESERVATION', days: -5 }),
      stored({ id: '9', at: same, days: 20 }),
    ];

    expect(inOrderWritten(shuffled).map((entry) => entry.id)).toEqual(['9', '10', '2']);
  });

  it('compares ids as numbers rather than as text', () => {
    const same = '2026-01-01T00:00:00Z';
    const shuffled = [
      stored({ id: '100', at: same }),
      stored({ id: '9', at: same }),
      stored({ id: '11', at: same }),
    ];

    expect(inOrderWritten(shuffled).map((entry) => entry.id)).toEqual(['9', '11', '100']);
  });

  it('leaves the list it was given alone', () => {
    const entries = [stored({ id: '2', at: '2026-03-01T00:00:00Z' }), stored({ id: '1' })];

    inOrderWritten(entries);

    expect(entries.map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('shows the figure each movement left behind it', () => {
    const account = runningTotal([
      stored({ id: '1', days: 20, reason: 'Annual entitlement' }),
      stored({ id: '2', at: '2026-02-01T00:00:00Z', entryType: 'RESERVATION', days: -5 }),
      stored({ id: '3', at: '2026-03-01T00:00:00Z', entryType: 'RELEASE', days: 5 }),
    ]);

    expect(account.map((entry) => entry.after)).toEqual([20, 15, 20]);
  });

  /* Doubles cannot hold 10.08, so a run of accrued figures drifts —
     10.08 + 0.01 is 10.089999999999998 without this. A total shown to a person has
     to be one they can add up themselves. */
  it('adds accrued figures to the precision the column holds', () => {
    const account = runningTotal([
      stored({ id: '1', days: 10.08 }),
      stored({ id: '2', at: '2026-02-01T00:00:00Z', entryType: 'CARRY_FORWARD', days: 9.92 }),
      stored({ id: '3', at: '2026-03-01T00:00:00Z', entryType: 'ADJUSTMENT', days: 0.01 }),
    ]);

    expect(account.map((entry) => entry.after)).toEqual([10.08, 20, 20.01]);
  });

  /**
   * And the running figure is not the available balance, which is why it is called
   * `after`.
   *
   * A RESERVATION and the DEDUCTION that follows it on approval are five days gone
   * once, not ten: the second moves them from held to taken. This total shows ten,
   * correctly, because it answers "what did these rows do" — and the test is here
   * so that nobody later reads it as the other question. Available is five buckets
   * and is LMS 211.
   */
  it('and is deliberately not what the person may still book', () => {
    const account = runningTotal([
      stored({ id: '1', days: 20 }),
      stored({ id: '2', at: '2026-02-01T00:00:00Z', entryType: 'RESERVATION', days: -5 }),
      stored({ id: '3', at: '2026-03-01T00:00:00Z', entryType: 'DEDUCTION', days: -5 }),
    ]);

    expect(account.at(-1)!.after).toBe(10);

    /* The five days are gone once. Anything reading the figure above as a balance
       would be wrong by exactly the amount of the double count, which is why
       BUCKETS says DEDUCTION moves between two columns rather than out of one. */
    expect(BUCKETS.RESERVATION).toEqual(['pending']);
    expect(BUCKETS.DEDUCTION).toEqual(['pending', 'taken']);
  });

  it('is empty for a balance nothing has moved', () => {
    expect(runningTotal([])).toEqual([]);
    expect(inOrderWritten([])).toEqual([]);
  });
});
