import { useCallback, useEffect, useState } from 'react';
import {
  type BalanceLine,
  isNotSignedIn,
  myBalances,
  myBalancesExportPath,
  type Statement,
  type Year,
} from '../../api';
import { ExportButtons } from '../../ExportButtons';
import { days, period } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/** My balances. FR 53, LMS 401, FR 32g. */
export function BalancesPage({
  onSignedOut,
  yearId,
  onYears,
}: {
  onSignedOut: () => void;
  /** LMS 409. The year the picker in the bar is showing. */
  yearId: string | undefined;
  onYears: (years: Year[], showing: string) => void;
}) {
  const [statement, setStatement] = useState<Statement | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);

      myBalances(leaveYearId)
        .then((next) => {
          setStatement(next);
          onYears(next.years, next.year.id);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /** The server's own sentence, verbatim. NFR USA 03, LMS 410. */
          setProblem(problemFrom(error));
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [onSignedOut, onYears],
  );

  useEffect(() => {
    load(yearId);
  }, [load, yearId]);

  if (statement === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          /* LMS 410. Nothing is on screen, so the way out has to be on the notice. */
          <Notice
            problem={problem}
            retrying={loading}
            onRetry={() => {
              load(yearId);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          {statement.year.label} · {period(statement.year.startDate, statement.year.endDate)}
          {statement.year.isClosed ? ' · this year has been closed' : ''}
        </p>

        {/* FR 64, LMS 511. */}
        <div className="controls">
          <ExportButtons
            path={myBalancesExportPath(statement.year.id)}
            onSignedOut={onSignedOut}
            onProblem={setProblem}
          />
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice
          problem={problem}
          retrying={loading}
          onRetry={() => {
            load(yearId);
          }}
        />
      )}

      <ul className="cards">
        {statement.lines.map((line) => (
          <BalanceCard key={line.leaveTypeId} line={line} />
        ))}
      </ul>
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
        {/* LMS 409. The kind of leave, as a mark as well as a name. */}
        <span className="chip">
          <Icon name={iconForLeaveType(line.name)} />
        </span>

        <h3>{line.name}</h3>

        <div className="tags">
          {line.isPaid ? null : <span className="tag">Unpaid</span>}
          {line.stillOffered ? null : <span className="tag">No longer offered</span>}
          {awaitingAnOccasion ? <span className="tag">Dormant</span> : null}
        </div>
      </div>

      {/* Every card the same shape, whatever the type. FR 32g: a nought on a type granted per
          occasion means "not yet" rather than "none left", and the Dormant badge above and
          the sentence in the disclosure below are what say which. */}
      <div className={`headline${overdrawn ? ' overdrawn' : ''}`}>
        <span className="figure">{days(line.available)}</span>
        <span className="of">
          {line.owed > 0 ? `of ${days(line.owed)} ` : ''}
          {line.owed === 1 ? 'day' : 'days'}
        </span>
      </div>

      {overdrawn ? (
        <p className="headline-note overdrawn">Overdrawn by {days(Math.abs(line.available))}</p>
      ) : null}

      <Meter line={line} />

      {/* "How this adds up" — entitled, carried over, adjustments, taken, pending — was taken
          off in LMS 409. They are the workings of a figure already on the card, and six cards
          each carrying a sixth disclosure made the screen read as a form. Every one of them is
          still on the wire, and still in the team screen's "balances in full" table, which is
          where somebody checking an allowance rather than reading one goes. */}

      {/* The story's third criterion, in the two words the server chose. The full
          explanation of what a basis means belongs on the request quote, where somebody is
          about to commit to a fortnight; here it is a label, because six of them repeated
          under six cards is noise that crowds out the figures. */}
      <p className="rules">
        <Icon name="balances" />
        {line.countingBasisLabel}
      </p>
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

  /* Nought granted is a real state and not a missing one, so the track is still drawn: a card
     that dropped its bar was a hole in a row of cards that all had one. */
  const share = (figure: number): string =>
    total <= 0 ? '0%' : `${String(Math.min(100, Math.max(0, (figure / total) * 100)))}%`;

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
        {/* §8.6b. Below nought is legitimate on a type FR 32a lets go past its allowance, and
            the word beside the figure is what says so. */}
        <span className={line.available < 0 ? 'overdrawn' : undefined}>
          <i className={`swatch ${line.available < 0 ? 'is-over' : 'is-left'}`} />{' '}
          {days(line.available)} left
        </span>
      </div>
    </>
  );
}

/* The shape of the answer while it is on its way, rather than a spinner that says nothing
   about what is coming. Six, because six is what most people here will get. */
function Skeletons() {
  return (
    <>
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
