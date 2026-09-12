import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type AuditChange,
  type AuditLog,
  type AuditLogEntry,
  type AuditSearch,
  isNotSignedIn,
  searchAuditLog,
} from '../../api';
import { moment } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/** Who changed what, searched by record and date. Read only. NFR AUD 01, NFR AUD 02, LMS 513. */

const ACTIONS: Record<AuditLogEntry['action'], string> = {
  CREATE: 'Created',
  UPDATE: 'Changed',
  DELETE: 'Removed',
};

export function AuditLogPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [searched, setSearched] = useState<AuditSearch>({});
  const [log, setLog] = useState<AuditLog | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);

    searchAuditLog(searched)
      .then((found) => {
        setLog(found);
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
  }, [searched, onSignedOut]);

  useEffect(load, [load]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearched({ entity, entityId: entity === '' ? '' : entityId, from, to });
  };

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          Every change to a record, newest first. Nothing here can be changed, by anybody.
        </p>

        <form className="controls" onSubmit={submit}>
          <label className="filter">
            <span className="muted">Record</span>
            <select
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value);
              }}
            >
              <option value="">Every kind</option>
              {log?.entities.map((one) => (
                <option key={one.name} value={one.name}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>

          <label className="filter">
            <span className="muted">Record id</span>
            <input
              type="text"
              inputMode="numeric"
              value={entityId}
              disabled={entity === ''}
              aria-invalid={problem?.field === 'entityId' ? true : undefined}
              onChange={(event) => {
                setEntityId(event.target.value);
              }}
            />
          </label>

          <label className="filter">
            <span className="muted">From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
          </label>

          <label className="filter">
            <span className="muted">To</span>
            <input
              type="date"
              value={to}
              aria-invalid={problem?.field === 'to' ? true : undefined}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </label>

          <button type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>
      </div>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      {log === undefined ? null : <Entries log={log} />}
    </div>
  );
}

function Entries({ log }: { log: AuditLog }) {
  if (log.entries.length === 0) {
    return <p className="muted">Nothing in the log matches that search.</p>;
  }

  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="history" />
        </span>
        Changes
        <span className="muted">
          {log.moreThanShown
            ? `the newest ${String(log.longestSearch)}. Narrow the search to see older ones`
            : `${String(log.entries.length)} found`}
        </span>
      </h2>

      <div className="report-table">
        <table className="figures-table audit-table">
          <thead>
            <tr>
              <th scope="col" className="is-text">
                When
              </th>
              <th scope="col" className="is-text">
                Who
              </th>
              <th scope="col" className="is-text">
                Record
              </th>
              <th scope="col" className="is-text">
                What
              </th>
            </tr>
          </thead>
          <tbody>
            {log.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="is-text">{moment(entry.occurredAt)}</td>
                <td className="is-text">{entry.actor}</td>
                <td className="is-text">
                  {entry.entityLabel}
                  <small>
                    {ACTIONS[entry.action]}, id {entry.entityId}
                  </small>
                </td>
                <td className="is-text">
                  <Changes changes={entry.changes} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Changes({ changes }: { changes: AuditChange[] }) {
  if (changes.length === 0) {
    return <span className="muted">No field moved.</span>;
  }

  return (
    <ul className="audit-changes">
      {changes.map((change) => (
        <li key={change.field}>
          <code>{change.field}</code> <span className="was">{shown(change.from)}</span> →{' '}
          <span>{shown(change.to)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A stored value, as text. */
function shown(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}
