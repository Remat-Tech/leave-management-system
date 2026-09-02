import { useCallback, useEffect, useState } from 'react';
import { type BalanceLine, isNotSignedIn, myBalances, type Statement, type Year } from '../../api';
import { days, sentenceCase, signed } from '../../format';

/** My balances. FR 53, LMS 401, FR 32g. */
export function BalancesPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [statement, setStatement] = useState<Statement | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);

      myBalances(leaveYearId)
        .then((next) => {
          setStatement(next);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /** The server's own sentence, verbatim. NFR USA 03. */
          setProblem(error instanceof Error ? error.message : 'Something went wrong.');
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [onSignedOut],
  );

  useEffect(() => {
    load();
  }, [load]);

  if (statement === undefined) {
    return (
      <div className="page">{loading ? <Skeletons /> : <p className="notice">{problem}</p>}</div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <h2>Your leave in {statement.year.label}</h2>
          <p>
            {statement.year.startDate} to {statement.year.endDate}
            {statement.year.isClosed ? ' · this year has been closed' : ''}
          </p>
        </div>

        <YearPicker years={statement.years} showing={statement.year} busy={loading} onPick={load} />
      </div>

      {}
      {problem === undefined ? null : <p className="notice">{problem}</p>}

      <ul className="cards">
        {statement.lines.map((line) => (
          <BalanceCard key={line.leaveTypeId} line={line} />
        ))}
      </ul>

      <p className="muted" style={{ marginTop: '1.5rem' }}>
        Pending days are subtracted too, because days spoken for are not days you can book twice.
        They come back if a request is turned down or you take it back.
      </p>
    </div>
  );
}

/** One leave type. */
function BalanceCard({ line }: { line: BalanceLine }) {
  const awaitingAnOccasion = line.entitlementBasis === 'EVENT' && !line.hasMoved;
  const overdrawn = line.available < 0;

  return (
    <li className={`card${awaitingAnOccasion || !line.stillOffered ? ' dormant' : ''}`}>
      <div className="card-head">
        <h3>{line.name}</h3>

        <div className="tags">
          {line.isPaid ? null : <span className="tag">Unpaid</span>}
          {line.stillOffered ? null : <span className="tag">No longer offered</span>}
        </div>
      </div>

      {awaitingAnOccasion ? (
        <p className="headline-note">{sentenceCase(line.allowanceInWords)}</p>
      ) : (
        <>
          <div className={`headline${overdrawn ? ' overdrawn' : ''}`}>
            <span className="figure">{days(line.available)}</span>
            <span className="of">
              {line.available === 1 ? 'day' : 'days'} available
              {line.owed > 0 ? ` of ${days(line.owed)}` : ''}
            </span>
          </div>

          {overdrawn ? (
            <p className="headline-note overdrawn">
              Overdrawn by {days(Math.abs(line.available))}. This type allows it — going past the
              allowance asks for a certificate rather than refusing the leave.
            </p>
          ) : null}

          <Meter line={line} />
        </>
      )}

      <details className="breakdown">
        <summary>How this adds up</summary>

        <dl>
          <dt>Entitled</dt>
          <dd>{days(line.entitled)}</dd>

          <dt>Carried over</dt>
          <dd>{days(line.carriedOver)}</dd>

          <dt>Adjustments</dt>
          <dd>{signed(line.adjustment)}</dd>

          <dt>Taken</dt>
          <dd>−{days(line.taken)}</dd>

          <dt>Pending</dt>
          <dd>−{days(line.pending)}</dd>

          <dt className="sum">Available</dt>
          <dd className="sum">{days(line.available)}</dd>
        </dl>
      </details>

      {/* The story's third criterion, in the two words the server chose. The full
          explanation of what a basis means belongs on the request quote, where somebody is
          about to commit to a fortnight; here it is a label, because six of them repeated
          under six cards is noise that crowds out the figures. */}
      <p className="rules">{line.countingBasisLabel}</p>
    </li>
  );
}

/**
 * Where the year has gone, as a bar.
 *
 * The widths are the only arithmetic in this file and they are pixels rather than days —
 * see the module note for why that is a different act from computing a balance. Nothing
 * derived from them is printed: the legend beside it shows the server's own figures.
 *
 * `role="img"` with a written label, because a bar chart is a picture and a screen reader
 * should be given the sentence rather than three empty `<span>`s. And the legend has words
 * as well as colours, because colour alone is not information.
 */
function Meter({ line }: { line: BalanceLine }) {
  /* Against what was actually given, not against what is left, so two cards with the same
     allowance are the same shape. A balance that is overdrawn or has nothing granted has
     no meaningful denominator, and the bar is simply not drawn. */
  const total = line.owed;

  if (total <= 0 || line.available < 0) {
    return null;
  }

  const share = (figure: number): string => `${String(Math.max(0, (figure / total) * 100))}%`;

  return (
    <>
      <div
        className="meter"
        role="img"
        aria-label={`${days(line.taken)} taken, ${days(line.pending)} pending, ${days(
          line.available,
        )} available, of ${days(total)}.`}
      >
        <span className="is-taken" style={{ width: share(line.taken) }} />
        <span className="is-pending" style={{ width: share(line.pending) }} />
      </div>

      <div className="legend" aria-hidden="true">
        <span>
          <i className="swatch is-taken" /> {days(line.taken)} taken
        </span>
        <span>
          <i className="swatch is-pending" /> {days(line.pending)} pending
        </span>
        <span>
          <i className="swatch is-left" /> {days(line.available)} left
        </span>
      </div>
    </>
  );
}

/**
 * The year picker. The story's second criterion.
 *
 * A plain `<select>` of the years the server said are this person's. There is no rule here
 * about which years those are — a joiner does not get the year before they arrived and a
 * leaver does not get the year after they went — because that is decided in
 * `server/src/domain/balance-statement.ts` against employment dates this client has never
 * seen.
 *
 * Labelled rather than placeholder-ed, because a placeholder disappears once a value is
 * chosen and a screen reader user then has an unlabelled control.
 */
function YearPicker({
  years,
  showing,
  busy,
  onPick,
}: {
  years: Year[];
  showing: Year;
  busy: boolean;
  onPick: (leaveYearId: string) => void;
}) {
  return (
    <label>
      Leave year
      <select
        value={showing.id}
        disabled={busy || years.length < 2}
        onChange={(event) => {
          onPick(event.target.value);
        }}
      >
        {years.map((year) => (
          <option key={year.id} value={year.id}>
            {year.label}
            {year.isClosed ? ' (closed)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/* The shape of the answer while it is on its way, rather than a spinner that says nothing
   about what is coming. Six, because six is what most people here will get. */
function Skeletons() {
  return (
    <>
      <div className="pagehead">
        <h2>Your leave</h2>
      </div>

      <ul className="cards">
        {[0, 1, 2, 3, 4, 5].map((one) => (
          <li key={one} className="skeleton" />
        ))}
      </ul>
    </>
  );
}

/* `days`, `signed` and `sentenceCase` moved to `client/src/format.ts` in LMS 402, when the
   history screen became their second caller. None of them is a rule about leave — they decide
   decimal places and capital letters — and the module note there says where that line is. */
