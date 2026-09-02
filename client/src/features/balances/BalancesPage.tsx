import { useCallback, useEffect, useState } from 'react';
import { type BalanceLine, isNotSignedIn, myBalances, type Statement, type Year } from '../../api';

/**
 * My balances. FR 53. LMS 401.
 *
 * The screen the story is about: every leave type with what was granted, what was carried
 * over, what has been taken, what is spoken for and what is left — for a leave year the
 * person picks.
 *
 * ## It renders. It does not calculate
 *
 * There is no arithmetic in this file. `available` and `owed` arrive as fields, the
 * counting basis arrives as a sentence, and what a nought on an event type means arrives
 * as another one. See `client/src/api.ts` for why that is a rule rather than a
 * convenience — briefly, a figure computed here is a second implementation of a rule that
 * no test in this repository can reach.
 *
 * The one thing this file decides is *presentation*: which figure is the loud one, which
 * are the workings, and what a nought is allowed to look like.
 *
 * ## The five figures are all shown, because the answer has to add up
 *
 * It would read better with two columns. It would also be a screen somebody cannot check,
 * and the whole design principle behind this system is that a figure explains itself
 * rather than being taken on trust. So the row carries entitled, carried over,
 * adjustment, taken and pending beside available, and the subtraction between them can be
 * done by the person reading it.
 *
 * `adjustment` is the one that earns its column. It is where "somebody decided this"
 * appears, and it is the figure people actually query.
 *
 * ## A nought is never shown on its own
 *
 * FR 32g divides leave types in two, and an event type at nought in January is not
 * somebody who has used it all — it is somebody nothing has happened to. The server sends
 * the sentence that says which; this shows it under the name rather than leaving a bare
 * digit to be misread.
 *
 * ## And a negative balance is shown as one
 *
 * §8.6b. Sick leave goes past its allowance on purpose, because FR 32a makes it a
 * documentation threshold rather than a cap. The figure is printed as it is, with a word
 * beside it — never a colour alone, which is not information to anybody who cannot see it.
 */
export function BalancesPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [statement, setStatement] = useState<Statement | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /**
   * Loads a year, or the one the server opens on when none is named.
   *
   * The first load passes nothing on purpose: which year is "this" one depends on a clock
   * and on which years this person was employed for, and both are the server's.
   */
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

  useEffect(() => {
    load();
  }, [load]);

  if (statement === undefined) {
    return (
      <main>{loading ? <p>Loading your balances…</p> : <p className="notice">{problem}</p>}</main>
    );
  }

  return (
    <main className="stack">
      <div className="row">
        <YearPicker years={statement.years} showing={statement.year} busy={loading} onPick={load} />
        <p className="quiet">
          {statement.year.startDate} to {statement.year.endDate}
          {statement.year.isClosed ? ' · closed' : ''}
        </p>
      </div>

      {problem === undefined ? null : <p className="notice">{problem}</p>}

      <BalancesTable lines={statement.lines} year={statement.year} />

      <p className="quiet">
        Days spoken for are days you cannot book twice, so both what you have taken and what is
        still being decided are subtracted from what is left.
      </p>
    </main>
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
 * Labelled rather than placeholder-ed, because a placeholder disappears when a value is
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

/**
 * The table.
 *
 * A real `<table>` with a `<caption>` and `<th scope>`, because it is tabular data and
 * that is what makes it navigable by anybody using a screen reader — a grid of `<div>`s
 * with the same borders reads as one long sentence.
 *
 * The column order is the order `server/src/domain/balance.ts` names the buckets in:
 * what somebody was given, then what they have spent, then what is left. Available last
 * and emphasised, because it is the figure the story is about and the rest are its
 * workings.
 */
function BalancesTable({ lines, year }: { lines: BalanceLine[]; year: Year }) {
  return (
    <table className="balances">
      <caption>
        <h2>Your leave in {year.label}</h2>
      </caption>

      <thead>
        <tr>
          <th scope="col">Leave type</th>
          <th scope="col" className="figure">
            Entitled
          </th>
          <th scope="col" className="figure">
            Carried over
          </th>
          <th scope="col" className="figure">
            Adjustments
          </th>
          <th scope="col" className="figure">
            Taken
          </th>
          <th scope="col" className="figure">
            Pending
          </th>
          <th scope="col" className="figure">
            Available
          </th>
        </tr>
      </thead>

      <tbody>
        {lines.map((line) => (
          <Row key={line.leaveTypeId} line={line} />
        ))}
      </tbody>
    </table>
  );
}

function Row({ line }: { line: BalanceLine }) {
  return (
    <tr>
      <th scope="row">
        <div className={line.stillOffered ? undefined : 'retired'}>
          {line.name}
          {line.stillOffered ? '' : ' — no longer offered'}
          {line.isPaid ? '' : ' — unpaid'}
        </div>

        {/* The story's third criterion, and the sentence that stops a nought lying. Both
            are the server's words; this file writes neither. */}
        <div className="quiet">Counted in {line.countingBasisInWords}</div>
        <div className="quiet">{line.allowanceInWords}</div>
      </th>

      <td className="figure">{days(line.entitled)}</td>
      <td className="figure">{days(line.carriedOver)}</td>
      <td className="figure">{days(line.adjustment)}</td>
      <td className="figure">{days(line.taken)}</td>
      <td className="figure">{days(line.pending)}</td>
      <td className={`figure available${line.available < 0 ? ' overdrawn' : ''}`}>
        {days(line.available)}
      </td>
    </tr>
  );
}

/**
 * A number of days, as it is written down.
 *
 * **Not rounding, and not arithmetic.** The server sends figures already at the precision
 * its columns hold — two decimal places, because §8.6d pro rates a mid year joiner to
 * 10.08 days — and this only decides whether to print the decimals. A whole number shows
 * as `20` because "20.00 days" reads like a bank statement; anything else shows both
 * places, because 10.08 and 10.8 are different figures and dropping a zero makes them look
 * alike.
 *
 * `toFixed(2)` on a value the server already rounded cannot change it. If it ever appears
 * to, the bug is upstream and hiding it here would be the worst possible response.
 */
function days(figure: number): string {
  return Number.isInteger(figure) ? String(figure) : figure.toFixed(2);
}
