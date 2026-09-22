import { useCallback, useEffect, useState } from 'react';
import {
  askToCancel,
  type Desk,
  type History,
  isNotSignedIn,
  myRequests,
  myRequestsExportPath,
  type RequestEntry,
  type TrailStep,
  withdrawRequest,
  type Year,
} from '../../api';
import { ExportButtons } from '../../ExportButtons';
import { inDays, moment, period, sentenceCase, statusLabel } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { AttachedFiles } from './Attachments';

/** My request history. FR 54, FR 41, FR 39. */
export function RequestsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [history, setHistory] = useState<History | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  /** What "try again" would ask for, which is the year that failed and not the first. */
  const [showing, setShowing] = useState<string | undefined>(undefined);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);
      setShowing(leaveYearId);

      myRequests(leaveYearId)
        .then((next) => {
          setHistory(next);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /** The server's own sentence, verbatim. NFR USA 03. */
          setProblem(problemFrom(error));
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

  const again = () => {
    load(showing);
  };

  if (history === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={again} />
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">{counted(history)}</p>

        <div className="controls">
          <YearFilter
            years={history.years}
            showing={history.year}
            busy={loading}
            onPick={(leaveYearId) => {
              load(leaveYearId);
            }}
          />

          {/* FR 64. */}
          <ExportButtons
            path={myRequestsExportPath(history.year?.id)}
            onSignedOut={onSignedOut}
            onProblem={setProblem}
          />
        </div>
      </div>

      {/* A history is already on screen, so a failure to load a *different* year is a notice
          above it rather than a blank page — what they were reading is still true. */}
      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={again} />
      )}

      {history.entries.length === 0 ? (
        <Nothing year={history.year} />
      ) : (
        <ol className="requests">
          {history.entries.map((entry) => (
            <RequestCard
              key={entry.requestId}
              entry={entry}
              onSignedOut={onSignedOut}
              onWithdrawn={again}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One request.
 *
 * The status is a tag rather than a headline figure, because the question somebody arrives
 * with here is "what happened to the fortnight in December" — the dates identify the request
 * and the status answers it, and neither is a number worth setting at 2rem.
 *
 * `is-<status>` on the card is what carries the colour. It is never the only thing carrying
 * the meaning: the same tag says the word, for the reason the stylesheet gives about one man
 * in twelve.
 */
function RequestCard({
  entry,
  onSignedOut,
  onWithdrawn,
}: {
  entry: RequestEntry;
  onSignedOut: () => void;
  onWithdrawn: () => void;
}) {
  return (
    <li className={`card request is-${entry.status.toLowerCase()}`}>
      {/* What was asked for on the left, how it got where it is on the right — so
          the account of a decision sits beside the thing decided rather than under it. */}
      <div className="asked-and-answered">
        <div className="asked-for">
          <div className="card-head">
            <span className="chip">
              <Icon name={iconForLeaveType(entry.typeName)} />
            </span>

            <h3>{period(entry.from, entry.to)}</h3>

            <div className="tags">
              <span className={`tag status is-${entry.status.toLowerCase()}`}>
                {statusLabel(entry.status, entry.statusInWords)}
              </span>
            </div>
          </div>

          <p className="request-what">
            <strong>{entry.typeName}</strong>
            {' · '}
            {inDays(entry.days)}
            {/* FR 24. The two figures differ whenever a weekend or a public holiday falls
                inside the period, and the difference is the single thing people query about a
                day count. Said only when it is true, because "7 days, 7 days off" is noise. */}
            {entry.calendarDays === entry.days
              ? ''
              : ` charged, ${inDays(entry.calendarDays)} away`}
            {' · '}
            {entry.countingBasisLabel.toLowerCase()}
          </p>

          {/* What they said when they asked. Quoted, because it is somebody's own words and an
              approver decided on them — the same reason the comments are quoted. Nothing at
              all where the type asked for none. FR 10. */}
          {entry.reason === null ? null : <blockquote className="said">{entry.reason}</blockquote>}

          {/* FR 38a. The desk it is with now, which is what somebody chasing it needs. Said
              only while it is still with somebody: once it is settled `awaiting` is null, and
              the status tag and the trail are what say where it ended. */}
          {entry.awaiting === null ? null : (
            <p className="nowwith">
              Now with: <strong>{deskLabel(entry.awaiting)}</strong>
            </p>
          )}

          {/* FR 12, NFR SEC 04. Shut, and asked for only when it is opened: a list of
              filenames is itself information about somebody's health. */}
          <AttachedFiles requestId={entry.requestId} onSignedOut={onSignedOut} />

          {/* Normally empty. A chain that has gained a desk since a request was approved is a
              real and legitimate state — `stagesMissing` — and saying so is better
              than a screen that quietly implies somebody signed who never did. */}
          {entry.agreed && entry.stagesMissing.length > 0 ? (
            <p className="muted">Agreed under an earlier approval policy.</p>
          ) : null}

          {/* FR 26. Only while the last desk has still to decide: a manager may already
              have answered, but it is not settled until it leaves SUBMITTED. */}
          {entry.status === 'SUBMITTED' ? (
            <Withdraw
              requestId={entry.requestId}
              onSignedOut={onSignedOut}
              onWithdrawn={onWithdrawn}
            />
          ) : null}

          {/* FR 47. Approved leave is not taken back but asked about: the days are spent,
              so HR answers. One open ask at a time, which the server holds as well. */}
          {entry.status === 'APPROVED' ? (
            entry.withdrawalAsked ? (
              <p className="notice plain">
                You have asked HR to cancel this. They have not answered yet.
              </p>
            ) : (
              <AskToCancel
                requestId={entry.requestId}
                onSignedOut={onSignedOut}
                onAsked={onWithdrawn}
              />
            )
          ) : null}
        </div>

        <Trail steps={entry.trail} />
      </div>
    </li>
  );
}

/**
 * What a trail step is, in two or three words.
 *
 * The server writes each step as a sentence — "You asked for this leave.", "Waiting with your
 * manager now." — which reads well in a paragraph and badly in a column of five. This is the
 * same fact as a label: the desk it belongs to, or what happened where there is no desk.
 *
 * The sentence is not lost. `inWords` is still on the wire and still the thing to reach for
 * anywhere there is room to read rather than scan.
 */
function stepLabel(step: TrailStep): string {
  if (step.desk !== null) {
    return deskLabel(step.desk);
  }

  switch (step.kind) {
    case 'ASKED':
      return 'Submitted';
    case 'WITHDRAWAL':
      return 'Withdrawal';
    case 'REVERSED':
      return 'Chief Executive';
    case 'ENDED':
      return 'Closed';
    default:
      return sentenceCase(step.inWords);
  }
}

/**
 * Where that step got to, as one word beside the label.
 *
 * `agreed` rather than a reading of the sentence: the server sends the fact. A step with no
 * time on it has not happened, which is the only thing "Pending" means here.
 */
function stepState(step: TrailStep): string | null {
  if (step.at === null) {
    return 'Pending';
  }

  if (step.agreed === null) {
    return null;
  }

  /* FR 44. An overturn is still a yes or a no; which one is what `agreed` carries. */
  return step.agreed ? 'Approved' : 'Refused';
}

/** A desk, in the words somebody says. FR 38a. */
function deskLabel(desk: Desk): string {
  switch (desk) {
    case 'MANAGER':
      return 'Manager';
    case 'HR':
      return 'HR';
    default:
      return 'Chief Executive';
  }
}

/**
 * Taking a request back before it is settled. FR 26.
 *
 * Two presses, because it cannot be undone: the request ends and its days go back, and asking
 * again is a new request that starts at the first desk. The server decides whether it is still
 * withdrawable — if HR settled it while this page was open, its sentence says so.
 */
function Withdraw({
  requestId,
  onSignedOut,
  onWithdrawn,
}: {
  requestId: string;
  onSignedOut: () => void;
  onWithdrawn: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const withdraw = () => {
    setBusy(true);
    setProblem(undefined);

    withdrawRequest(requestId)
      .then(onWithdrawn)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
        setConfirming(false);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="withdraw">
      {problem === undefined ? null : <Notice problem={problem} />}

      {confirming ? (
        <>
          <p className="muted">
            Withdraw this request? The days go back to your balance, and it can’t be undone.
          </p>
          <div className="withdraw-buttons">
            <button type="button" className="danger" disabled={busy} onClick={withdraw}>
              {busy ? 'Withdrawing…' : 'Yes, withdraw it'}
            </button>
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep it
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="danger"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Withdraw request
        </button>
      )}
    </div>
  );
}

/**
 * Asking HR to cancel leave that has already been approved. FR 47.
 *
 * A reason, because HR is answering somebody rather than pressing a button: the days are
 * already spent, and putting them back is a correction HR has to be able to account for.
 */
function AskToCancel({
  requestId,
  onSignedOut,
  onAsked,
}: {
  requestId: string;
  onSignedOut: () => void;
  onAsked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const ask = () => {
    setBusy(true);
    setProblem(undefined);

    askToCancel(requestId, reason.trim())
      .then(onAsked)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (!open) {
    return (
      <div className="withdraw">
        <button
          type="button"
          className="danger"
          onClick={() => {
            setOpen(true);
          }}
        >
          Ask to cancel
        </button>
      </div>
    );
  }

  return (
    <div className="withdraw">
      {problem === undefined ? null : <Notice problem={problem} />}

      <label className="withdraw-reason">
        Why do you want to cancel this leave?
        <textarea
          rows={3}
          value={reason}
          disabled={busy}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>

      <p className="muted">
        HR will answer. If the leave has already started, only the days you have not used yet come
        back.
      </p>

      <div className="withdraw-buttons">
        <button
          type="button"
          className="danger"
          disabled={busy || reason.trim() === ''}
          onClick={ask}
        >
          {busy ? 'Sending…' : 'Send to HR'}
        </button>
        <button
          type="button"
          className="linkish"
          disabled={busy}
          onClick={() => {
            setOpen(false);
          }}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * How a request got where it is. The story's second criterion.
 *
 * An ordered list, because it is one: the steps are in the order they happened and the last
 * one is where the request stands. `<ol>` rather than styled `<div>`s so that a screen reader
 * announces "3 of 4" without this file having to say it.
 *
 * A step that has not happened is told by `at === null` rather than by its kind — see the
 * module note — and it is the only kind rendered without a time, because inventing one is the
 * whole thing `server/src/domain/request-history.ts` refuses to do for a withdrawal.
 */
export function Trail({ steps }: { steps: TrailStep[] }) {
  return (
    <ol className="trail">
      {steps.map((step, index) => (
        <li
          /* The index is the key because a trail has no ids and is never reordered,
             filtered or added to in place: it arrives whole from the server and is replaced
             whole on the next load. */
          key={index}
          className={`step is-${step.kind.toLowerCase()}${step.at === null ? ' is-waiting' : ''}`}
        >
          <p className="step-what">
            {stepLabel(step)}
            {stepState(step) === null ? null : (
              <span className={`step-state is-${stepState(step)?.toLowerCase() ?? ''}`}>
                {stepState(step)}
              </span>
            )}
          </p>

          {step.by === null && step.at === null ? null : (
            <p className="step-who">
              {[step.by, step.at === null ? undefined : moment(step.at)]
                .filter((part) => part !== undefined && part !== '')
                .join(' · ')}
            </p>
          )}

          {/* FR 39. In full, and quoted so that it reads as somebody's words rather than as
              the system's. */}
          {step.comment === null ? null : <blockquote className="said">{step.comment}</blockquote>}
        </li>
      ))}
    </ol>
  );
}

/**
 * The year filter. Every year, or one of them.
 *
 * "All years" is a real option rather than a way of clearing the control, and it is the
 * default — the story asks for *all* past requests, and a screen that opened on this year
 * would be answering a narrower question than the one somebody came with.
 *
 * Hidden entirely where there is nothing to choose between. A disabled `<select>` offering one
 * year is furniture that says the screen has a feature it does not.
 */
function YearFilter({
  years,
  showing,
  busy,
  onPick,
}: {
  years: Year[];
  showing: Year | null;
  busy: boolean;
  onPick: (leaveYearId?: string) => void;
}) {
  if (years.length < 2) {
    return null;
  }

  return (
    <label>
      Leave year
      <select
        value={showing?.id ?? ''}
        disabled={busy}
        onChange={(event) => {
          onPick(event.target.value === '' ? undefined : event.target.value);
        }}
      >
        <option value="">All years</option>
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
 * Nothing to show, said two ways because they are two different pieces of news.
 *
 * A filtered year with nothing in it is a true answer — `server/src/domain/request-history.ts`
 * argues why it is not a refusal — and it needs a way back out, because somebody who has
 * forgotten they set a filter is looking at an empty screen that is not empty.
 *
 * Somebody who has never asked for leave gets the other sentence, and it does not apologise:
 * it is a perfectly ordinary state and it is the first thing a new joiner sees.
 */
function Nothing({ year }: { year: Year | null }) {
  return (
    /* `plain`, because nothing is wrong. The warning stripe on a notice is for a refusal the
       server sent, and an empty history is an answer. */
    <p className="notice plain">
      {year === null
        ? 'You have not asked for any leave yet. When you do, every request will be here with ' +
          'what each approver said about it.'
        : `You asked for no leave in ${year.label}. Choose "All years" above to see everything.`}
    </p>
  );
}

/* The shape of the answer while it is on its way, rather than a spinner that says nothing
   about what is coming. Three, because a card here is tall and three fill the fold. */
function Skeletons() {
  return (
    <>
      <ol className="requests">
        {[0, 1, 2].map((one) => (
          <li key={one} className="skeleton is-tall" />
        ))}
      </ol>
    </>
  );
}

/**
 * How many, and of what.
 *
 * A count of rows rather than a total of days — twenty annual days and three sick days are
 * not twenty-three of anything, which is the sentence `domain/balance-statement.ts` makes
 * about its own column and is just as true here.
 */
function counted(history: History): string {
  const many = history.entries.length;
  const what = `${String(many)} ${many === 1 ? 'request' : 'requests'}`;

  return history.year === null ? what : `${what} in ${history.year.label}`;
}
