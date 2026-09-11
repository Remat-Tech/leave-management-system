import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type Adjustable,
  type Adjusted,
  adjustBalance,
  type AdjustmentView,
  type BalanceLine,
  balanceToAdjust,
  isNotSignedIn,
  type Movement,
  whoCanBeAdjusted,
} from '../../api';
import { days, inDays, moment, period, sentenceCase, signed } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Correcting a balance by hand, with a reason that stays on it. FR 37, FR 27, LMS 506.
 *
 * The screen exists because a balance that is wrong is wrong until somebody can say so. The
 * movement it writes can never be removed afterwards, only compensated, so the ledger is
 * beside the form rather than behind a second click: the figures being corrected and the
 * correction are read in one place.
 *
 * Offered to everybody, as the other configuration screens are. Reading a ledger is the
 * person's own, their manager's and HR's; posting an adjustment is an HR Administrator's, and
 * anybody else meets the server's own sentence naming the desk that can.
 */
export function BalanceAdjustmentsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [people, setPeople] = useState<Adjustable[] | undefined>(undefined);
  const [chosen, setChosen] = useState('');
  const [yearId, setYearId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<AdjustmentView | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /** The last thing written, kept on screen so the figure it produced can be read. */
  const [done, setDone] = useState<Adjusted | undefined>(undefined);

  const answer = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }

      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  const loadPeople = useCallback(() => {
    setLoading(true);

    whoCanBeAdjusted()
      .then((next) => {
        setPeople(next.employees);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(loadPeople, [loadPeople]);

  const loadBalance = useCallback(
    (employeeId: string, leaveYearId?: string) => {
      if (employeeId === '') {
        setView(undefined);
        return;
      }

      setLoading(true);

      balanceToAdjust(employeeId, leaveYearId)
        .then((next) => {
          setView(next);
          setYearId(next.year.id);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          setView(undefined);
          answer(error);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [answer],
  );

  if (people === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={loadPeople} />
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          A correction to somebody&rsquo;s figures, with a written reason. Nothing here edits the
          past: the adjustment is a movement of its own, and it stays in their ledger beside the
          reason for it.
        </p>

        <div className="controls">
          <label className="filter">
            <span className="visually-hidden">Whose balance</span>
            <select
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
                setDone(undefined);
                loadBalance(event.target.value);
              }}
            >
              <option value="">Select</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} · {person.employeeNumber}
                  {person.hasLeft ? ' (left)' : ''}
                </option>
              ))}
            </select>
          </label>

          {view === undefined ? null : (
            <label className="filter">
              <span className="visually-hidden">Leave year</span>
              <select
                value={yearId ?? view.year.id}
                disabled={view.years.length < 2}
                onChange={(event) => {
                  setYearId(event.target.value);
                  setDone(undefined);
                  loadBalance(chosen, event.target.value);
                }}
              >
                {view.years.map((year) => (
                  <option key={year.id} value={year.id}>
                    {year.label}
                    {year.isClosed ? ' (closed)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice
          problem={problem}
          retrying={loading}
          onRetry={() => {
            loadBalance(chosen, yearId);
          }}
        />
      )}

      {view === undefined ? (
        <p className="muted">
          Select whose balance needs correcting. Their figures and every movement behind them are
          shown here, so the correction can be read against what it is correcting.
        </p>
      ) : (
        <>
          <section className="ruleset">
            <h2>
              <span className="chip">
                <Icon name="people" />
              </span>
              {view.employee.name}
              <span className="muted">
                {view.employee.jobTitle ?? view.employee.employeeNumber} · {view.year.label} ·{' '}
                {period(view.year.startDate, view.year.endDate)}
              </span>
            </h2>

            {/* FR 06. A leaver's final figure is exactly what FR 37a leaves HR to put right,
                so the screen says who they are rather than refusing them. */}
            {view.employee.hasLeft ? (
              <p className="rules">
                <Icon name="info" />
                {view.employee.name} has left the company. Their record and their figures stay, and
                a final correction is still posted here.
              </p>
            ) : null}

            {/* §8.9. An adjustment is the one entry a settled year accepts, and the only way to
                put a settled figure right. Said here, because a closed year reads as locked. */}
            {view.year.isClosed ? (
              <p className="rules">
                <Icon name="info" />
                {view.year.label} has been closed. An adjustment is the one kind of movement a
                settled year still accepts, so a figure in it can be put right.
              </p>
            ) : null}

            <Figures lines={view.lines} />
          </section>

          <AdjustmentForm
            view={view}
            onSignedOut={onSignedOut}
            onPosted={(posted) => {
              setDone(posted);
              loadBalance(chosen, yearId);
            }}
          />

          {/* The server's figure, never this page's arithmetic. */}
          {done === undefined ? null : (
            <p className="notice done" role="status">
              {signed(done.entry.days)} {Math.abs(done.entry.days) === 1 ? 'day' : 'days'} posted.
              That balance now stands at {inDays(done.balance.available)}.
            </p>
          )}

          <section className="ruleset">
            <h2>
              <span className="chip">
                <Icon name="requests" />
              </span>
              Every movement in {view.year.label}
              <span className="muted">{countOf(view.ledger.length)}</span>
            </h2>

            <Ledger movements={view.ledger} people={people} />
          </section>
        </>
      )}
    </div>
  );
}

/** What each kind of leave stands at. Every figure the server's. */
function Figures({ lines }: { lines: BalanceLine[] }) {
  return (
    <div className="balance-figures">
      <table className="figures-table">
        <thead>
          <tr>
            <th scope="col">Leave type</th>
            <th scope="col">Granted</th>
            <th scope="col">Carried</th>
            <th scope="col">Adjusted</th>
            <th scope="col">Taken</th>
            <th scope="col">Held</th>
            <th scope="col">Left</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.leaveTypeId} className={line.stillOffered ? undefined : 'dormant'}>
              <th scope="row">
                {line.name}
                {line.stillOffered ? null : <span className="tag">No longer offered</span>}
              </th>
              <td>{days(line.entitled)}</td>
              <td>{days(line.carriedOver)}</td>
              {/* FR 37. The column this screen writes to, and the only one free in its sign. */}
              <td className={line.adjustment === 0 ? undefined : 'is-adjusted'}>
                {line.adjustment === 0 ? '—' : signed(line.adjustment)}
              </td>
              <td>{days(line.taken)}</td>
              <td>{days(line.pending)}</td>
              <td className={line.available < 0 ? 'overdrawn' : undefined}>
                <b>{days(line.available)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** FR 27. The movements behind those figures, oldest first, as the server ordered them. */
function Ledger({ movements, people }: { movements: Movement[]; people: Adjustable[] }) {
  /* The writer, by name where one of them is a person. `createdBy` reads "employee 2", which
     is the right thing for an audit column and the wrong thing beside somebody's leave. */
  const names = new Map(people.map((person) => [person.id, person.name]));

  if (movements.length === 0) {
    return (
      <p className="muted">
        Nothing has moved this person&rsquo;s balances in this year. A correction posted here would
        be the first movement on them.
      </p>
    );
  }

  return (
    <ul className="movements">
      {movements.map((movement) => (
        <li
          key={movement.id}
          className={`movement${movement.entryType === 'ADJUSTMENT' ? ' is-adjustment' : ''}`}
        >
          <p className="movement-days">
            <b className={movement.days < 0 ? 'overdrawn' : undefined}>{signed(movement.days)}</b>
            <span className="muted">left {days(movement.after)}</span>
          </p>

          <div className="movement-what">
            <h3>
              {movement.typeName}
              <span className="tag">{sentenceCase(movement.inWords)}</span>
              {/* FR 27. A correction names the row it puts right, which is what makes a
                  reversed entry readable as one rather than as a second mistake. */}
              {movement.correctsId === null ? null : (
                <span className="tag">Puts an earlier movement right</span>
              )}
            </h3>

            {/* The whole point of the story. Never truncated: a reason nobody can read is a
                reason nobody wrote. */}
            <p className="movement-reason">{movement.reason}</p>

            <p className="muted">
              {(movement.createdByEmployeeId === null
                ? undefined
                : names.get(movement.createdByEmployeeId)) ?? movement.createdBy}{' '}
              · {moment(movement.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** So an input a refusal named can point at the sentence. NFR USA 03. */
const REFUSAL_ID = 'adjustment-refusal';

/** The largest movement the column holds. Held again by the server, which is what refuses one. */
const LARGEST = 9999.99;

/**
 * The correction itself. FR 37's two halves: a signed figure and a mandatory reason.
 *
 * **The direction is two buttons rather than a minus sign.** FR 37 asks for "positive or
 * negative" and a single signed box is one keystroke away from giving three days where two
 * were meant to go. The form states the direction in words and composes the sign from it, so
 * the figure typed is always the size of the correction.
 *
 * **Nothing is previewed.** What the balance becomes is the server's answer to the write, not
 * this page's addition — a browser that totalled it would be a second implementation of a
 * figure nothing here could check.
 */
function AdjustmentForm({
  view,
  onPosted,
  onSignedOut,
}: {
  view: AdjustmentView;
  onPosted: (posted: Adjusted) => void;
  onSignedOut: () => void;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [direction, setDirection] = useState<'ADD' | 'TAKE'>('ADD');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const size = Number(amount);
  const usable = amount !== '' && Number.isFinite(size) && size > 0 && size <= LARGEST;

  function post(event: FormEvent): void {
    event.preventDefault();

    setSaving(true);
    setRefusal(undefined);

    adjustBalance({
      employeeId: view.employee.id,
      leaveTypeId,
      leaveYearId: view.year.id,
      days: direction === 'ADD' ? size : -size,
      reason: reason.trim(),
    })
      .then((posted) => {
        setAmount('');
        setReason('');
        onPosted(posted);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setRefusal(problemFrom(error));
      })
      .finally(() => {
        setSaving(false);
      });
  }

  /** The input the refusal is about, where the server named one. NFR USA 03. */
  const marks = (field: string) =>
    refusal?.field !== field ? {} : { 'aria-invalid': true, 'aria-describedby': REFUSAL_ID };

  const line = view.lines.find((one) => one.leaveTypeId === leaveTypeId);

  return (
    <form className="panel" onSubmit={post}>
      <h2 className="panel-title">Post a correction</h2>

      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <fieldset className="fields">
        <legend>What is being corrected</legend>

        <label>
          Leave type
          <select
            required
            value={leaveTypeId}
            disabled={saving}
            {...marks('leaveTypeId')}
            onChange={(event) => {
              setLeaveTypeId(event.target.value);
            }}
          >
            <option value="">Select</option>
            {view.lines.map((one) => (
              <option key={one.leaveTypeId} value={one.leaveTypeId}>
                {one.name}
                {one.stillOffered ? '' : ' (no longer offered)'}
              </option>
            ))}
          </select>
          {line === undefined ? null : (
            <small className="muted">
              Stands at {inDays(line.available)}, of {inDays(line.owed)} granted.
            </small>
          )}
        </label>

        {/* FR 37. The direction, said rather than signed. */}
        <fieldset className="choice">
          <legend>Which way</legend>

          <label className="radio">
            <input
              type="radio"
              name="direction"
              value="ADD"
              checked={direction === 'ADD'}
              disabled={saving}
              onChange={() => {
                setDirection('ADD');
              }}
            />
            Give days back
          </label>

          <label className="radio">
            <input
              type="radio"
              name="direction"
              value="TAKE"
              checked={direction === 'TAKE'}
              disabled={saving}
              onChange={() => {
                setDirection('TAKE');
              }}
            />
            Take days away
          </label>
        </fieldset>

        <label className="day-count">
          How many days
          <input
            type="number"
            required
            min={0.01}
            max={LARGEST}
            step={0.01}
            value={amount}
            disabled={saving}
            {...marks('days')}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
        </label>

        {/* A balance below nought is legitimate where HR means it, so this is said rather than
            refused — the server does not refuse it either. §8.6b. */}
        {line !== undefined && direction === 'TAKE' && usable && size > line.available ? (
          <p className="notice warning" role="status">
            That is more than the {inDays(line.available)} left, so the balance would go below
            nought. It is allowed, and it is worth meaning to.
          </p>
        ) : null}

        <label>
          Why
          <textarea
            required
            rows={3}
            maxLength={500}
            value={reason}
            disabled={saving}
            {...marks('reason')}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <small className="muted">
            What went wrong, in a sentence somebody reading their own balance in two years would
            understand. This cannot be edited afterwards, and it is the only part of the movement
            nothing else in the system can work out.
          </small>
        </label>
      </fieldset>

      <div className="card-actions">
        <button
          type="submit"
          className="primary"
          disabled={saving || !usable || leaveTypeId === '' || reason.trim() === ''}
        >
          {saving ? 'Posting…' : 'Post correction'}
        </button>

        <p className="muted">
          Posted movements stay. A correction to a correction is another movement, not an edit.
        </p>
      </div>
    </form>
  );
}

function countOf(movements: number): string {
  return `${String(movements)} ${movements === 1 ? 'movement' : 'movements'}`;
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2].map((one) => (
        <li key={one} className="skeleton is-short" />
      ))}
    </ul>
  );
}
