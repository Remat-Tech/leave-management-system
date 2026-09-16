import { useCallback, useEffect, useState } from 'react';
import {
  type EveryonesEntry,
  type EveryonesLeave,
  everyonesLeave,
  isNotSignedIn,
  type RequestStatus,
  reverseDecision,
} from '../../api';
import { inDays, period, statusLabel } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Trail } from '../requests/RequestsPage';

/** The statuses worth filtering by, in the order a person looks for them. */
const STATUSES: { value: RequestStatus; label: string }[] = [
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REFUSED', label: 'Refused' },
  { value: 'SUBMITTED', label: 'Waiting' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'UNROUTABLE', label: 'Stuck' },
];

interface Filter {
  leaveYearId?: string;
  status?: RequestStatus;
  employeeId?: string;
}

/** Everybody's leave, and reversing a decision once every desk has made it. The Chief Executive's. */
export function AllLeavePage({ onSignedOut }: { onSignedOut: () => void }) {
  const [leave, setLeave] = useState<EveryonesLeave | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (next: Filter) => {
      setLoading(true);
      setFilter(next);

      everyonesLeave(next)
        .then((found) => {
          setLeave(found);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          setProblem(problemFrom(error));
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [onSignedOut],
  );

  useEffect(() => {
    load({});
  }, [load]);

  if (leave === undefined) {
    return (
      <div className="page">
        {problem === undefined ? null : (
          <Notice
            problem={problem}
            retrying={loading}
            onRetry={() => {
              load(filter);
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
          {leave.entries.length} {leave.entries.length === 1 ? 'request' : 'requests'}
          {leave.year === null ? '' : ` in ${leave.year.label}`}
        </p>

        <div className="controls">
          <label>
            Leave year
            <select
              value={filter.leaveYearId ?? ''}
              disabled={loading}
              onChange={(event) => {
                load({ ...filter, leaveYearId: event.target.value || undefined });
              }}
            >
              <option value="">All years</option>
              {leave.years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Status
            <select
              value={filter.status ?? ''}
              disabled={loading}
              onChange={(event) => {
                load({
                  ...filter,
                  status: (event.target.value || undefined) as RequestStatus | undefined,
                });
              }}
            >
              <option value="">Any</option>
              {STATUSES.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Person
            <select
              value={filter.employeeId ?? ''}
              disabled={loading}
              onChange={(event) => {
                load({ ...filter, employeeId: event.target.value || undefined });
              }}
            >
              <option value="">Everybody</option>
              {leave.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {problem === undefined ? null : <Notice problem={problem} />}

      {leave.entries.length === 0 ? (
        <p className="notice plain">No leave matches these filters.</p>
      ) : (
        <ol className="requests">
          {leave.entries.map((entry) => (
            <LeaveCard
              key={entry.requestId}
              entry={entry}
              onSignedOut={onSignedOut}
              onReversed={() => {
                load(filter);
              }}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function LeaveCard({
  entry,
  onSignedOut,
  onReversed,
}: {
  entry: EveryonesEntry;
  onSignedOut: () => void;
  onReversed: () => void;
}) {
  return (
    <li className={`card request is-${entry.status.toLowerCase()}`}>
      <div className="asked-and-answered">
        <div className="asked-for">
          <div className="card-head">
            <span className="chip">
              <Icon name={iconForLeaveType(entry.typeName)} />
            </span>

            <h3>{entry.employeeName}</h3>

            <div className="tags">
              <span className={`tag status is-${entry.status.toLowerCase()}`}>
                {statusLabel(entry.status, entry.statusInWords)}
              </span>
              {entry.reversed ? <span className="tag">Reversed</span> : null}
            </div>
          </div>

          <p className="request-what">
            <strong>{period(entry.from, entry.to)}</strong>
            {' · '}
            {entry.typeName}
            {' · '}
            {inDays(entry.days)}
          </p>

          {entry.reason === null ? null : <blockquote className="said">{entry.reason}</blockquote>}

          <Reverse entry={entry} onSignedOut={onSignedOut} onReversed={onReversed} />
        </div>

        <Trail steps={entry.trail} />
      </div>
    </li>
  );
}

/** Today, as the server's calendar dates are written. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** What would stop a reversal, said before the button rather than after it. */
function whyNot(entry: EveryonesEntry): string | null {
  if (entry.reversed) {
    return 'This decision has already been reversed, and that is final.';
  }

  if (entry.status === 'APPROVED' && entry.from <= today()) {
    return 'This leave has started, so the approval can no longer be reversed.';
  }

  if (entry.withdrawalAsked) {
    return 'They have asked HR to cancel this. HR answers that first.';
  }

  return null;
}

function Reverse({
  entry,
  onSignedOut,
  onReversed,
}: {
  entry: EveryonesEntry;
  onSignedOut: () => void;
  onReversed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  if (entry.status !== 'APPROVED' && entry.status !== 'REFUSED') {
    return null;
  }

  const blocked = whyNot(entry);

  if (blocked !== null) {
    return <p className="muted">{blocked}</p>;
  }

  const approving = entry.status === 'REFUSED';

  const reverse = () => {
    setBusy(true);
    setProblem(undefined);

    reverseDecision(entry.requestId, reason.trim())
      .then(onReversed)
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
          className={approving ? 'primary' : 'danger'}
          onClick={() => {
            setOpen(true);
          }}
        >
          {approving ? 'Reverse: approve this leave' : 'Reverse: refuse this leave'}
        </button>
      </div>
    );
  }

  return (
    <div className="withdraw">
      {problem === undefined ? null : <Notice problem={problem} />}

      <label className="withdraw-reason">
        Why are you reversing this decision?
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
        {approving
          ? `The leave will be approved and ${inDays(entry.days)} come off their balance.`
          : `The leave will be refused and ${inDays(entry.days)} go back into their balance.`}{' '}
        They, their manager and HR are told, with your reason. This cannot be reversed again.
      </p>

      <div className="withdraw-buttons">
        <button
          type="button"
          className={approving ? 'primary' : 'danger'}
          disabled={busy || reason.trim() === ''}
          onClick={reverse}
        >
          {busy ? 'Reversing…' : 'Reverse the decision'}
        </button>
        <button
          type="button"
          className="linkish"
          disabled={busy}
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
