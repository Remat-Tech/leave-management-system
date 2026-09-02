import { useCallback, useEffect, useState } from 'react';
import {
  type History,
  isNotSignedIn,
  myRequests,
  type RequestEntry,
  type TrailStep,
  type Year,
} from '../../api';
import { inDays, moment, sentenceCase } from '../../format';

/**
 * My request history. FR 54. LMS 402.
 *
 * The screen the story is about: every request somebody has made, with what became of it and
 * the account of how it got there — "so that I can check what happened without relying on
 * memory or email".
 *
 * ## It renders. It does not decide
 *
 * There is no leave arithmetic here and no judgement about state either. Whether a request is
 * agreed is `entry.agreed`, what its status is called is `entry.statusInWords`, and every
 * sentence on the trail arrives written. This file chooses type sizes and the order things sit
 * on a card.
 *
 * That is stricter than it sounds, and the temptation it is refusing is specific: it would be
 * one line to write `entry.status === 'APPROVED' ? 'Approved' : …` and never call the server
 * again. Then the day `progressOf` starts distinguishing "approved under the old chain", the
 * screen goes on saying the old thing, and the person reading it has no way to know which of
 * the two is current. `server/src/domain/request-history.ts` composes the words for that
 * reason.
 *
 * ## The trail shows what has not happened yet, and that is the point of it
 *
 * A list that stopped at the newest decision would read "approved by your line manager" under
 * a request nobody has agreed to, which is the exact misreading FR 41 exists to prevent. So a
 * step with no time on it renders as a step in waiting — dimmer, with no timestamp — rather
 * than being dropped, and the last thing on an undecided card is who has still to be asked.
 *
 * `step.at === null` is the whole test. The kinds are on the wire too, but a screen that
 * branched on `STILL_TO_ASK` would have to be told again the day a fifth kind arrives.
 *
 * ## The comment is shown in full
 *
 * FR 39, and the story's second criterion says "including comments" for a reason. A refusal's
 * reason is the only account of that decision anybody will have next year, and it is what the
 * person turned down has to act on. There is no truncation here, no "show more", and no line
 * clamp — a manager's two paragraphs about cover during month end are two paragraphs.
 */
export function RequestsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [history, setHistory] = useState<History | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);

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

          /* The server's own sentence, verbatim. NFR USA 03; see `BalancesPage` for why
             replacing one with "Something went wrong" throws away the useful half. */
          setProblem(error instanceof Error ? error.message : 'Something went wrong.');
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [onSignedOut],
  );

  /* The first load names no year, and here that means every request there is rather than a
     year the server picked. See `myRequests`. */
  useEffect(() => {
    load();
  }, [load]);

  if (history === undefined) {
    return (
      <div className="page">{loading ? <Skeletons /> : <p className="notice">{problem}</p>}</div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <h2>
            {history.year === null
              ? 'Everything you have asked for'
              : `Your leave requests in ${history.year.label}`}
          </h2>
          <p>{counted(history)}</p>
        </div>

        <YearFilter
          years={history.years}
          showing={history.year}
          busy={loading}
          onPick={(leaveYearId) => {
            load(leaveYearId);
          }}
        />
      </div>

      {/* A history is already on screen, so a failure to load a *different* year is a notice
          above it rather than a blank page — what they were reading is still true. */}
      {problem === undefined ? null : <p className="notice">{problem}</p>}

      {history.entries.length === 0 ? (
        <Nothing year={history.year} />
      ) : (
        <ol className="requests">
          {history.entries.map((entry) => (
            <RequestCard key={entry.requestId} entry={entry} />
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
function RequestCard({ entry }: { entry: RequestEntry }) {
  return (
    <li className={`card request is-${entry.status.toLowerCase()}`}>
      <div className="card-head">
        <h3>
          {entry.from} to {entry.to}
        </h3>

        <div className="tags">
          <span className={`tag status is-${entry.status.toLowerCase()}`}>
            {sentenceCase(entry.statusInWords)}
          </span>
        </div>
      </div>

      <p className="request-what">
        <strong>{entry.typeName}</strong>
        {' · '}
        {inDays(entry.days)}
        {/* FR 24. The two figures differ whenever a weekend or a public holiday falls inside
            the period, and the difference is the single thing people query about a day count.
            Said only when it is true, because "7 days, 7 days off" is noise. */}
        {entry.calendarDays === entry.days ? '' : ` charged, ${inDays(entry.calendarDays)} away`}
        {' · '}
        {entry.countingBasisLabel.toLowerCase()}
      </p>

      {/* What they said when they asked. Quoted, because it is somebody's own words and an
          approver decided on them — the same reason the comments below are quoted. */}
      <blockquote className="said">{entry.reason}</blockquote>

      {/* FR 41. The one sentence a person acts on, and it says what has happened before it
          says what has not. Server-composed; see the module note. */}
      <p className={`progress${entry.agreed ? ' is-agreed' : ''}`}>{entry.progressInWords}</p>

      <Trail steps={entry.trail} />

      {/* Normally empty. A chain that has gained a desk since a request was approved is a
          real and legitimate state — LMS 316's `stagesMissing` — and saying so is better than
          a screen that quietly implies somebody signed who never did. */}
      {entry.agreed && entry.stagesMissing.length > 0 ? (
        <p className="muted">
          This was agreed under an earlier approval policy. The chain for this kind of leave has
          changed since.
        </p>
      ) : null}
    </li>
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
function Trail({ steps }: { steps: TrailStep[] }) {
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
          <p className="step-what">{step.inWords}</p>

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
      <div className="pagehead">
        <h2>Your leave requests</h2>
      </div>

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

  return history.year === null
    ? `${what}, most recently asked for first.`
    : `${what} in ${history.year.label}, most recently asked for first.`;
}
