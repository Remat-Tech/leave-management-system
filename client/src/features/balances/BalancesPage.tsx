import { useCallback, useEffect, useState } from 'react';
import { type BalanceLine, isNotSignedIn, myBalances, type Statement, type Year } from '../../api';

/**
 * My balances. FR 53. LMS 401.
 *
 * The screen the story is about: every leave type with what was granted, carried over,
 * taken and spoken for, and what is left — for a leave year the person picks.
 *
 * ## It renders. It does not calculate
 *
 * There is no leave arithmetic in this file. `available` and `owed` arrive as fields, the
 * counting basis arrives as a sentence, and what a nought on an event type means arrives
 * as another one. See `client/src/api.ts` for why that is a rule rather than a habit.
 *
 * The one exception is **geometry**, in {@link Meter}: the width of a bar is worked out
 * here from figures the server already sent. That is not the same act and the line is
 * worth stating exactly — a *day count* is a fact somebody plans around and must have one
 * implementation; a *percentage of a bar* is a picture of facts already on the wire, and
 * no number derived from it is ever shown. If this file ever prints a figure it computed,
 * that is the bug.
 *
 * ## A card, and the workings folded underneath it
 *
 * A table gave every one of the six figures the same weight, which is the wrong shape for
 * the question people actually arrive with — "can I book a fortnight in December". So the
 * headline is `available`, at the size of the thing being asked, with `of 20 days` beside
 * it and a bar showing where the year has gone.
 *
 * **The six figures are still all there**, in a `<details>` under each card. That is not a
 * compromise: a balance that cannot be added up by the person reading it is the thing
 * design principle 1 is against, and `adjustment` in particular — "somebody decided this"
 * — is the figure people query. Folded is not hidden; it is one click, on the card the
 * question is about, and it means the ordinary case is legible.
 *
 * ## And a nought is never shown on its own
 *
 * FR 32g divides leave types in two, and an event type at nought in January is not
 * somebody who has used it all — it is somebody nothing has happened to. Those cards drop
 * the big number entirely and say what they are instead, which is the strongest form of
 * the argument the server's `allowanceInWords` is making.
 */
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

          /* The server's own sentence, verbatim. Every refusal in this system is written
             to say what is wrong and what to do about it, and replacing one with
             "Something went wrong" throws away the only useful half. NFR USA 03. */
          setProblem(error instanceof Error ? error.message : 'Something went wrong.');
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [onSignedOut],
  );

  /* The first load names no year on purpose. Which year is "this" one depends on a clock
     and on which years this person was employed for, and both are the server's. */
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

      {/* A statement is already on screen, so a failure to load a *different* year is a
          notice above it rather than a blank page — the figures they were looking at are
          still true. */}
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

/**
 * One leave type.
 *
 * Two shapes, and which one it takes is a fact from the server rather than a judgement
 * made here: a type that has never been granted and never will be until something happens
 * — `entitlementBasis: 'EVENT'` with nothing moved — gets no headline figure, because a
 * large `0` on a compassionate leave card tells somebody the opposite of the truth on
 * what is by definition a bad week.
 */
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

/**
 * A number of days, as it is written down.
 *
 * **Not rounding, and not arithmetic.** The server sends figures already at the precision
 * its columns hold — two decimal places, because §8.6d pro rates a mid year joiner to
 * 10.08 days — and this only decides whether to print the decimals. A whole number shows
 * as `20`, because "20.00 days" reads like a bank statement; anything else shows both
 * places, because 10.08 and 10.8 are different figures and dropping a zero makes them look
 * alike.
 *
 * `toFixed(2)` on a value the server has already rounded cannot change it. If it ever
 * appears to, the bug is upstream and hiding it here would be the worst possible response.
 */
function days(figure: number): string {
  return Number.isInteger(figure) ? String(figure) : figure.toFixed(2);
}

/** An adjustment, with its sign kept. "+3" and "−2" are different news. */
function signed(figure: number): string {
  if (figure === 0) {
    return '0';
  }

  return figure > 0 ? `+${days(figure)}` : `−${days(Math.abs(figure))}`;
}

/** The server writes its sentences to sit mid-line; a card starts one. */
function sentenceCase(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
