import { useCallback, useEffect, useState } from 'react';
import {
  type ApproverQueue,
  isNotSignedIn,
  myApprovals,
  type QueueItem,
  type TeamContext,
} from '../../api';
import { inDays, sentenceCase } from '../../format';

/** Everything waiting on me. FR 20, FR 40, FR 17, FR 18, FR 48, LMS 404. */
export function ApprovalsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [queue, setQueue] = useState<ApproverQueue | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);

    myApprovals()
      .then((next) => {
        setQueue(next);
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
  }, [onSignedOut]);

  useEffect(load, [load]);

  /* The failure here is usually a refusal rather than a fault: this tab is offered to
     everybody, so somebody who staffs no desk lands on the server's own sentence saying what
     an approver is. It keeps its heading, because a bare paragraph reads as a broken page. */
  if (queue === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : (
          <>
            <div className="pagehead">
              <h2>Waiting on you</h2>
            </div>
            <p className="notice">{problem}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        <div>
          <h2>Waiting on you</h2>
          <p>{queue.inWords}</p>
        </div>
      </div>

      {problem === undefined ? null : <p className="notice">{problem}</p>}

      {queue.items.length === 0 ? (
        /* `plain`, because nothing is wrong. An empty queue is the state a manager wants to
           be in, and it is what the story's "so that" is aiming at. */
        <p className="notice plain">
          Nothing is waiting on you. When somebody on your team asks for leave, it will be here with
          what they have left and who else is away.
        </p>
      ) : (
        <ol className="requests">
          {queue.items.map((item) => (
            <QueueCard key={item.requestId} item={item} />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One request waiting on this approver.
 *
 * The person is the heading rather than the dates, which is the reverse of the history screen
 * and for the reason it is: somebody arrives at their own history asking "what happened to the
 * fortnight in December" and arrives here asking "who is asking me for what".
 *
 * `is-held` carries the colour for a request this approver may not decide. It is never the only
 * thing carrying that: the sentence beside it says so in words.
 */
function QueueCard({ item }: { item: QueueItem }) {
  return (
    <li className={`card request queued${item.actionable ? '' : ' is-held'}`}>
      <div className="card-head">
        <h3>{item.asker.name}</h3>

        <div className="tags">
          {/* FR 17, FR 18. The story's third criterion, and the first thing read on the card. */}
          {item.warnings.map((warning) => (
            <span key={warning.code} className={`tag flag is-${warning.code.toLowerCase()}`}>
              {warning.code === 'BACKDATED' ? 'Back dated' : 'Short notice'}
            </span>
          ))}
          <span className="tag desk">{deskLabel(item.desk)}</span>
        </div>
      </div>

      <p className="request-what">
        <strong>
          {item.from} to {item.to}
        </strong>
        {' · '}
        {inDays(item.days)}
        {/* FR 24. Said only where the two differ, because "7 days, 7 days off" is noise. */}
        {item.calendarDays === item.days ? '' : ` charged, ${inDays(item.calendarDays)} away`}
        {' · '}
        {item.typeName}
        {item.asker.jobTitle === null ? '' : ` · ${item.asker.jobTitle}`}
      </p>

      {/* What they said when they asked. FR 10 — quoted, because an approver decides on it.
          Absent where the type asks for none, and said rather than left blank: an empty
          quotation reads as somebody having written nothing when they were asked to. */}
      {item.reason === null ? (
        <p className="muted">This kind of leave does not ask for a reason.</p>
      ) : (
        <blockquote className="said">{item.reason}</blockquote>
      )}

      {/* FR 48, §8.6a. The story's second criterion, in the policy's own words. */}
      {item.notActionableBecause === null ? null : (
        <p className="notice warning">{item.notActionableBecause}</p>
      )}

      {item.warnings.map((warning) => (
        <p key={warning.code} className={`flagged is-${warning.code.toLowerCase()}`}>
          {warning.inWords}
        </p>
      ))}

      {/* `context` rather than `standing`: that one is a right-aligned column of figures, and
          these are sentences the server composed. The story's first criterion is the first two. */}
      <dl className="context">
        <dt>Balance</dt>
        <dd className={item.balance.available < 0 ? 'overdrawn' : undefined}>
          {sentenceCase(item.balance.inWords)}
        </dd>

        <dt>Team</dt>
        <dd>
          <TeamLine team={item.team} />
        </dd>

        {/* FR 41. Who has already signed, and who comes after this desk. */}
        <dt>Stage</dt>
        <dd>{item.stageInWords}</dd>
      </dl>
    </li>
  );
}

/**
 * Who else is away, as a sentence and then as a list.
 *
 * The sentence is the server's and says the count first, which is the figure the decision turns
 * on. The list repeats what the sentence already named because the dates are worth scanning
 * rather than reading, and it is left out entirely where no name may be shown — a list of
 * anonymous rows would be furniture where the count has already said everything true.
 */
function TeamLine({ team }: { team: TeamContext }) {
  const named = team.away.filter((one) => one.name !== null);

  return (
    <>
      {team.inWords}
      {named.length === 0 ? null : (
        <ul className="away">
          {named.map((one) => (
            <li key={`${one.employeeId}/${one.from}`}>
              <strong>{one.name}</strong>
              {` · ${one.from} to ${one.to} · ${inDays(one.days)} of ${one.typeName} · `}
              {one.status === 'APPROVED' ? 'agreed' : 'waiting to be decided'}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A desk, as a tag rather than as prose. The server's sentences name it in words. */
function deskLabel(desk: QueueItem['desk']): string {
  switch (desk) {
    case 'MANAGER':
      return 'Your team';
    case 'HR':
      return 'HR';
    default:
      return 'Chief Executive';
  }
}

/* The shape of the answer while it is on its way. Three, because a card here is tall. */
function Skeletons() {
  return (
    <>
      <div className="pagehead">
        <h2>Waiting on you</h2>
      </div>

      <ol className="requests">
        {[0, 1, 2].map((one) => (
          <li key={one} className="skeleton is-tall" />
        ))}
      </ol>
    </>
  );
}
