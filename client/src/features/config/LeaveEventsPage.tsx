import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type EventChoices,
  type EventGranted,
  type EventOnRecord,
  eventChoices,
  eventsFor,
  isNotSignedIn,
  recordEvent,
} from '../../api';
import { day, inDays } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Recording a birth, a bereavement and the like, which grants that leave. FR 32g, LMS 218.
 *
 * The days come from the entitlement rule in force on the date it happened, and land in that
 * date's leave year. The server decides all of it; this page only sends the facts.
 */
export function LeaveEventsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [choices, setChoices] = useState<EventChoices | undefined>(undefined);
  const [chosen, setChosen] = useState('');
  const [events, setEvents] = useState<EventOnRecord[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState<EventGranted | undefined>(undefined);

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

  const loadChoices = useCallback(() => {
    setLoading(true);

    eventChoices()
      .then((next) => {
        setChoices(next);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(loadChoices, [loadChoices]);

  const loadEvents = useCallback(
    (employeeId: string) => {
      if (employeeId === '') {
        setEvents(undefined);
        return;
      }

      setLoading(true);

      eventsFor(employeeId)
        .then((next) => {
          setEvents(next.events);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          setEvents(undefined);
          answer(error);
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [answer],
  );

  if (choices === undefined) {
    return (
      <div className="page">
        {loading ? null : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={loadChoices} />
        )}
      </div>
    );
  }

  const person = choices.employees.find((one) => one.id === chosen);

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          Maternity, paternity, compassionate and other leave that is granted when something
          happens. Record what happened and when; the days come from the entitlement rule on that
          date.
        </p>

        <div className="controls">
          <label className="filter">
            <span className="visually-hidden">Whose event</span>
            <select
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value);
                setDone(undefined);
                loadEvents(event.target.value);
              }}
            >
              <option value="">Select</option>
              {choices.employees.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name} · {one.employeeNumber}
                  {one.hasLeft ? ' (left)' : ''}
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
            loadEvents(chosen);
          }}
        />
      )}

      {person === undefined || events === undefined ? (
        <p className="muted">Select the person the event happened to.</p>
      ) : (
        <>
          <EventForm
            employeeId={person.id}
            choices={choices}
            onSignedOut={onSignedOut}
            onRecorded={(granted) => {
              setDone(granted);
              loadEvents(chosen);
            }}
          />

          {done === undefined ? null : (
            <p className="notice done" role="status">
              {inDays(done.days)} granted
              {done.event.expiresOn === null ? '' : `, usable up to ${day(done.event.expiresOn)}`}.
              That balance now stands at {inDays(done.available)}.
            </p>
          )}

          <section className="ruleset">
            <h2>
              <span className="chip">
                <Icon name="history" />
              </span>
              Recorded for {person.name}
            </h2>

            {events.length === 0 ? (
              <p className="muted">Nothing recorded for this person yet.</p>
            ) : (
              <ul className="cards">
                {events.map((one) => (
                  <li key={one.id} className="card">
                    <div className="card-head">
                      <span className="chip">
                        <Icon name={iconForLeaveType(one.typeName)} />
                      </span>
                      <h3>{one.typeName}</h3>
                      <div className="tags">
                        {one.hasLapsed ? <span className="tag">Lapsed</span> : null}
                      </div>
                    </div>

                    <dl className="settings">
                      <div>
                        <dt>Happened on</dt>
                        <dd>{day(one.occurredOn)}</dd>
                      </div>
                      <div>
                        <dt>Usable until</dt>
                        <dd>{one.expiresOn === null ? 'No limit' : day(one.expiresOn)}</dd>
                      </div>
                    </dl>

                    {one.note === null ? null : <p className="muted">{one.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const REFUSAL_ID = 'leave-event-refusal';

function EventForm({
  employeeId,
  choices,
  onRecorded,
  onSignedOut,
}: {
  employeeId: string;
  choices: EventChoices;
  onRecorded: (granted: EventGranted) => void;
  onSignedOut: () => void;
}) {
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [occurredOn, setOccurredOn] = useState('');
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function save(event: FormEvent): void {
    event.preventDefault();

    setSaving(true);
    setRefusal(undefined);

    recordEvent({
      employeeId,
      leaveTypeId,
      occurredOn,
      note: note.trim() === '' ? null : note.trim(),
    })
      .then((granted) => {
        setLeaveTypeId('');
        setOccurredOn('');
        setNote('');
        onRecorded(granted);
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

  const marks = (field: string) =>
    refusal?.field !== field ? {} : { 'aria-invalid': true, 'aria-describedby': REFUSAL_ID };

  const type = choices.types.find((one) => one.id === leaveTypeId);

  return (
    <form className="panel" onSubmit={save}>
      <h2 className="panel-title">Record an event</h2>

      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <fieldset className="fields">
        <legend>What happened</legend>

        <label>
          Leave it grants
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
            {choices.types.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
          {type?.entitlementExpiryMonths == null ? null : (
            <small className="muted">
              Days must be used within {String(type.entitlementExpiryMonths)} months of the event.
            </small>
          )}
        </label>

        <label>
          Date it happened
          <input
            type="date"
            required
            value={occurredOn}
            max={new Date().toISOString().slice(0, 10)}
            disabled={saving}
            {...marks('occurredOn')}
            onChange={(event) => {
              setOccurredOn(event.target.value);
            }}
          />
          <small className="muted">
            The day of the birth, death and so on, not today. It decides which leave year the days
            go into.
          </small>
        </label>

        <label>
          Note (optional)
          <textarea
            rows={2}
            value={note}
            disabled={saving}
            {...marks('note')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </label>
      </fieldset>

      <p className="rules">
        <Icon name="info" />
        This cannot be undone. A mistake is put right with an adjustment.
      </p>

      <div className="card-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Recording…' : 'Record and grant days'}
        </button>
      </div>
    </form>
  );
}
