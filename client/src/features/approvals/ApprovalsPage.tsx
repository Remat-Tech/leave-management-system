import { useCallback, useEffect, useState } from 'react';
import {
  type ApproverQueue,
  decideMany,
  type Desk,
  isNotSignedIn,
  myApprovals,
  type QueueItem,
  type TeamContext,
} from '../../api';
import { inDays, sentenceCase } from '../../format';
import { Icon } from '../../Icon';
import { AttachedFiles } from '../requests/Attachments';

/** Everything waiting on me, and answering it. FR 20, FR 40, FR 17, FR 18, FR 48, FR 51. */
export function ApprovalsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [queue, setQueue] = useState<ApproverQueue | undefined>(undefined);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);

  /** FR 51. What a batch could not answer, kept beside the row it belongs to. LMS 328. */
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());

  const load = useCallback(() => {
    setLoading(true);

    myApprovals()
      .then((next) => {
        setQueue(next);
        setChosen(new Set());
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

  /**
   * Answers some requests. FR 39, FR 51, LMS 326, LMS 328.
   *
   * One press and a whole selection go through the same door, because the server decides each
   * row at its own desk either way — a batch is not a second rule, it is one call. The versions
   * are the ones these rows carried, so a row somebody else has answered since is refused on
   * its own rather than taking the rest down with it.
   */
  const decide = useCallback(
    (action: 'APPROVE' | 'REFUSE', requestIds: readonly string[], comment: string) => {
      if (queue === undefined || requestIds.length === 0) {
        return;
      }

      const rows = queue.items
        .filter((item) => requestIds.includes(item.requestId))
        .map((item) => ({ requestId: item.requestId, version: item.version }));

      setDeciding(true);
      setRefused(new Map());

      decideMany({ action, requests: rows, comment: comment === '' ? undefined : comment })
        .then((outcome) => {
          setRefused(new Map(outcome.undecided.map((one) => [one.requestId, one.message])));
          load();
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          setProblem(error instanceof Error ? error.message : 'Something went wrong.');
        })
        .finally(() => {
          setDeciding(false);
        });
    },
    [queue, load, onSignedOut],
  );

  /* The failure here is usually a refusal rather than a fault: this tab is offered to
     everybody, so somebody who staffs no desk lands on the server's own sentence saying what
     an approver is. */
  if (queue === undefined) {
    return (
      <div className="page">{loading ? <Skeletons /> : <p className="notice">{problem}</p>}</div>
    );
  }

  /** FR 48. Only a row this approver may actually decide can be picked. */
  const pickable = queue.items.filter((item) => item.actionable);
  const picked = pickable.filter((item) => chosen.has(item.requestId));

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          {queue.items.length > 0 ? <span className="count">{queue.items.length}</span> : null}
          {queue.inWords}
        </p>
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
        <>
          {/* FR 51, LMS 328. Clearing the queue in one press, each row decided as if it had
              been clicked on its own. Refusing is not offered here: FR 39 wants a reason, and
              one reason spread across a selection is not the account of any of them. */}
          {pickable.length === 0 ? null : (
            <div className="bulkbar">
              <label className="pick">
                <input
                  type="checkbox"
                  checked={picked.length === pickable.length}
                  ref={(box) => {
                    if (box !== null) {
                      box.indeterminate = picked.length > 0 && picked.length < pickable.length;
                    }
                  }}
                  onChange={(event) => {
                    setChosen(
                      event.target.checked
                        ? new Set(pickable.map((item) => item.requestId))
                        : new Set(),
                    );
                  }}
                />
                Select all ({String(pickable.length)})
              </label>

              <button
                type="button"
                className="primary"
                disabled={deciding || picked.length === 0}
                onClick={() => {
                  decide(
                    'APPROVE',
                    picked.map((item) => item.requestId),
                    '',
                  );
                }}
              >
                <Icon name="tick" />
                {deciding ? 'Approving…' : `Approve selected (${String(picked.length)})`}
              </button>
            </div>
          )}

          <ol className="requests">
            {queue.items.map((item) => (
              <QueueCard
                key={item.requestId}
                item={item}
                chosen={chosen.has(item.requestId)}
                busy={deciding}
                refused={refused.get(item.requestId)}
                onChoose={(wanted) => {
                  setChosen((was) => {
                    const next = new Set(was);
                    if (wanted) next.add(item.requestId);
                    else next.delete(item.requestId);
                    return next;
                  });
                }}
                onDecide={(action, comment) => {
                  decide(action, [item.requestId], comment);
                }}
                onSignedOut={onSignedOut}
              />
            ))}
          </ol>
        </>
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
function QueueCard({
  item,
  chosen,
  busy,
  refused,
  onChoose,
  onDecide,
  onSignedOut,
}: {
  item: QueueItem;
  chosen: boolean;
  busy: boolean;
  /** FR 51. Why a batch could not answer this one. LMS 328. */
  refused: string | undefined;
  onChoose: (wanted: boolean) => void;
  onDecide: (action: 'APPROVE' | 'REFUSE', comment: string) => void;
  onSignedOut: () => void;
}) {
  const [comment, setComment] = useState('');

  /** FR 39. A refusal has to say why; an approval need not. */
  const canRefuse = comment.trim() !== '';

  return (
    <li className={`card request queued${item.actionable ? '' : ' is-held'}`}>
      {/* Who is asking on the left, what they are asking for on the right. */}
      <div className="asking-head">
        <div className="asking-who">
          {item.actionable ? (
            <input
              type="checkbox"
              className="pickbox"
              checked={chosen}
              disabled={busy}
              aria-label={`Select ${item.asker.name}'s request`}
              onChange={(event) => {
                onChoose(event.target.checked);
              }}
            />
          ) : null}

          <div className="asking-name">
            <h3>
              {item.asker.name}
              {item.asker.jobTitle === null ? null : <small>{item.asker.jobTitle}</small>}
            </h3>

            <div className="tags">
              {/* FR 17, FR 18. The story's third criterion, and the first thing read. */}
              {item.warnings.map((warning) => (
                <span key={warning.code} className={`tag flag is-${warning.code.toLowerCase()}`}>
                  {warning.code !== 'BACKDATED'
                    ? 'Short notice'
                    : /* FR 18, LMS 308. Two different pieces of news under one flag: recorded
                         on the way back in, or entered past the window as HR's exception. */
                      item.lateEntryReason === null
                      ? 'Back dated'
                      : 'Entered by HR'}
                </span>
              ))}
              <span className="tag desk">{deskLabel(item.desk)}</span>
            </div>
          </div>
        </div>

        <div className="asking-what">
          <p className="when">
            <Icon name="balances" />
            {item.from} to {item.to}
          </p>
          <p className="muted">
            {inDays(item.days)}
            {/* FR 24. Said only where the two differ, because "7 days, 7 days" is noise. */}
            {item.calendarDays === item.days ? '' : ` charged, ${inDays(item.calendarDays)} away`}
            {` · ${item.typeName}`}
          </p>
        </div>
      </div>

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
        <div className="held">
          <h4>
            <Icon name="info" />
            Held
          </h4>
          <p>{item.notActionableBecause}</p>
        </div>
      )}

      {item.warnings.map((warning) => (
        <p key={warning.code} className={`flagged is-${warning.code.toLowerCase()}`}>
          {warning.inWords}
        </p>
      ))}

      {/* LMS 409. The three things the decision turns on, side by side rather than stacked,
          and the fourth column is the decision itself. */}
      <div className="deciding">
        <section className="fact">
          <h4>
            <Icon name="balances" />
            Balance
          </h4>
          {/* §8.6b. Below nought is legitimate on a type FR 32a lets go past its allowance,
              and the sentence under the figure is what says so. */}
          <p className={`figure${item.balance.available < 0 ? ' overdrawn' : ''}`}>
            {inDays(item.balance.available)}
            <small>remaining</small>
          </p>
          <p className="small">{sentenceCase(item.balance.inWords)}</p>
        </section>

        <section className="fact">
          <h4>
            <Icon name="people" />
            Team
          </h4>
          <TeamLine team={item.team} />
        </section>

        <section className="fact">
          <h4>
            <Icon name="stage" />
            Stage
          </h4>
          <p>{item.stageInWords}</p>
          <Chain item={item} />
        </section>

        {item.actionable ? (
          <section className="decide">
            <div className="decide-buttons">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => {
                  onDecide('APPROVE', comment.trim());
                }}
              >
                <Icon name="tick" />
                Approve
              </button>

              <button
                type="button"
                className="danger"
                disabled={busy || !canRefuse}
                title={canRefuse ? undefined : 'A refusal has to say why. FR 39.'}
                onClick={() => {
                  onDecide('REFUSE', comment.trim());
                }}
              >
                <Icon name="cross" />
                Refuse
              </button>
            </div>

            {/* FR 39. Optional on an approval and required on a refusal, which is why the
                Refuse button is the one that waits for it rather than this being two boxes. */}
            <label className="comment">
              <span className="visually-hidden">Comment on this decision</span>
              <input
                value={comment}
                placeholder="Add a comment…"
                disabled={busy}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              <Icon name="send" />
            </label>

            <p className="muted">A refusal has to say why. FR 39.</p>
          </section>
        ) : null}
      </div>

      {/* FR 51. What a batch could not answer here, in the server's own sentence. LMS 328. */}
      {refused === undefined ? null : <p className="notice">{refused}</p>}

      {/* FR 12, NFR SEC 04, LMS 407. The desk this is sitting on may open the certificate —
          `readAttachment` is `read` widened by exactly that — and every open is recorded
          against the approver's name. Shut until somebody decides to look. */}
      <AttachedFiles requestId={item.requestId} onSignedOut={onSignedOut} />
    </li>
  );
}

/** FR 38a. Who has signed, who is being asked, and who comes after. */
function Chain({ item }: { item: QueueItem }) {
  return (
    <ol className="chain">
      {item.chain.map((desk) => {
        const done = item.approvedBy.includes(desk);
        const here = desk === item.desk;

        return (
          <li key={desk} className={done ? 'is-done' : here ? 'is-here' : 'is-waiting'}>
            {deskLabel(desk)}
            <small>{done ? 'approved' : here ? 'you, now' : 'after'}</small>
          </li>
        );
      })}
    </ol>
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
      <p>{team.inWords}</p>
      {named.length === 0 ? null : (
        <ul className="away">
          {named.map((one) => (
            <li key={`${one.employeeId}/${one.from}`}>
              <strong>{one.name}</strong>
              {` · ${one.from} to ${one.to}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A desk, as a tag rather than as prose. The server's sentences name it in words. */
function deskLabel(desk: Desk): string {
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
    <ol className="requests">
      {[0, 1, 2].map((one) => (
        <li key={one} className="skeleton is-tall" />
      ))}
    </ol>
  );
}
