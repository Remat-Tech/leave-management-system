import { useCallback, useEffect, useState } from 'react';
import {
  isNotSignedIn,
  type Leaver,
  leaverFigure,
  type LeaverSettlement,
  type SettlementLine,
  type SettlementStep,
  whoHasLeft,
} from '../../api';
import { day, days, inDays, period, signed } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * What somebody who has left is owed, with its working. FR 37a, §8.6d, §8.7, LMS 509.
 *
 * The screen exists so a final payment can be checked rather than taken on trust, which is
 * the story's "so that". So every step of the sum is a row of its own, in the order it is
 * performed, with the sentence the server wrote beside it — a single total nobody can take
 * apart is the thing this replaces.
 *
 * **Only annual leave.** The server decides which kinds of leave those are, off the column
 * that says a type accrues over the year. Nothing here knows what annual leave is called.
 *
 * **Nothing is added up here.** Every figure on the page is a field on the wire, including
 * the answer, for the reason the balance screen gives: a figure computed in a browser is a
 * second implementation of a rule, running where no test can reach it.
 */
export function LeaversPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [leavers, setLeavers] = useState<Leaver[] | undefined>(undefined);
  const [chosen, setChosen] = useState('');
  const [settlement, setSettlement] = useState<LeaverSettlement | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

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

  const loadLeavers = useCallback(() => {
    setLoading(true);

    whoHasLeft()
      .then((next) => {
        setLeavers(next.leavers);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(loadLeavers, [loadLeavers]);

  const loadFigure = useCallback(
    (employeeId: string) => {
      if (employeeId === '') {
        setSettlement(undefined);
        setProblem(undefined);
        return;
      }

      setLoading(true);

      leaverFigure(employeeId)
        .then((next) => {
          setSettlement(next);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          setSettlement(undefined);
          answer(error);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [answer],
  );

  if (leavers === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={loadLeavers} />
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          What somebody who has left is owed, worked out to their last day. Annual leave only: the
          other kinds are an allowance for being here rather than something that accrues.
        </p>

        <div className="controls">
          <label className="filter">
            <span className="visually-hidden">Who left</span>
            <select
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
                loadFigure(event.target.value);
              }}
            >
              <option value="">Select</option>
              {leavers.map((leaver) => (
                <option key={leaver.id} value={leaver.id}>
                  {leaver.name} · left {leaver.exitDate ?? 'on a date nobody recorded'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice
          problem={problem}
          retrying={loading}
          onRetry={() => {
            loadFigure(chosen);
          }}
        />
      )}

      {leavers.length === 0 ? (
        <p className="muted">Nobody has left. A figure appears here once somebody has.</p>
      ) : settlement === undefined ? (
        <p className="muted">
          Select who has left. Their figure is shown with every step of the sum behind it, so the
          final payment can be checked rather than taken on trust.
        </p>
      ) : (
        <Settlement settlement={settlement} />
      )}
    </div>
  );
}

/** One leaver's figure: who they were, then a card for each kind of leave settled. */
function Settlement({ settlement }: { settlement: LeaverSettlement }) {
  return (
    <>
      <section className="ruleset">
        <h2>
          <span className="chip">
            <Icon name="people" />
          </span>
          {settlement.name}
          <span className="muted">
            {settlement.jobTitle ?? settlement.employeeNumber} · left {day(settlement.exitDate)}
          </span>
        </h2>

        <p className="rules">
          <Icon name="info" />
          Employed {period(settlement.startDate, settlement.exitDate)}, and settled against{' '}
          {settlement.year.label} — the leave year the exit date falls in.{' '}
          {period(settlement.portion.from, settlement.portion.to)} of it was worked.
        </p>

        {/* FR 46, §8.7. Said whether or not anything was cancelled: the reader is checking a
            figure, and "nothing was left pending" is part of what makes it checkable. */}
        <p className="rules">
          <Icon name="info" />
          Requests nobody had decided were cancelled when the exit was recorded, so no days are
          still being held. Leave already approved stands and is counted as taken.
        </p>
      </section>

      {settlement.lines.length === 0 ? (
        <p className="muted">
          No kind of leave accrues over the year for this person, so there is nothing to settle.
          That is an entitlement figure nobody has set rather than a figure of nought — ask an HR
          Administrator.
        </p>
      ) : (
        settlement.lines.map((line) => <Line key={line.leaveTypeId} line={line} />)
      )}
    </>
  );
}

/** One kind of leave: the answer, then the working that reaches it. */
function Line({ line }: { line: SettlementLine }) {
  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="balances" />
        </span>
        {line.name}
        <span className="muted">{line.countingBasisLabel}</span>
      </h2>

      <p className="leaver-figure">
        <b className={line.owed < 0 ? 'overdrawn' : undefined}>{days(line.owed)}</b>
        <span>{line.owed === 1 ? 'day owed' : 'days owed'}</span>
      </p>

      <Working steps={line.working} />

      {/* The question somebody asks first: why this is not the number on the balance screen. */}
      <p className="rules">
        <Icon name="info" />
        The balance screen shows {inDays(line.availableOnTheBalance)} left. That figure is what
        could still have been booked against a whole year&rsquo;s grant; this one is what the part
        year actually worked is worth.
      </p>
    </section>
  );
}

/** The working, in the order the sum is performed. FR 37a's second criterion. */
function Working({ steps }: { steps: SettlementStep[] }) {
  return (
    <ol className="working">
      {steps.map((step) => (
        <li key={step.label} className={`working-step is-${step.part.toLowerCase()}`}>
          {/* Signed where it enters the sum, plain where it only explains one. */}
          <p className="working-days">
            <b>{step.part === 'EXPLAINS' ? days(step.days) : signed(step.days)}</b>
          </p>

          <div className="working-what">
            <h3>{step.label}</h3>
            <p className="muted">{step.says}</p>
          </div>
        </li>
      ))}
    </ol>
  );
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
