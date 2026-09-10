import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  addHoliday,
  editHoliday,
  type Holiday,
  type HolidayCalendar,
  type HolidayFields,
  holidayCalendar,
  isNotSignedIn,
  removeHoliday,
  type Year,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * The gazetted public holiday calendar. FR 22, LMS 504.
 *
 * The screen exists so a holiday declared this morning is on the calendar this morning,
 * rather than in the next deployment. Every day the office is closed is a day nobody is
 * charged leave for, so the calendar has to be right before the leave is taken.
 *
 * Its own screen rather than a panel on "Entitlements": a holiday is not a figure anybody is
 * owed, it is a fact about a date, and it is read by year rather than by leave type.
 *
 * Drawn for everybody, as the other config screens are — reading the calendar is open to
 * anybody signed in, because it is what a leave quote is priced against. The writes are
 * refused for anybody but HR, with the server's own sentence.
 */
export function HolidaysPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [calendar, setCalendar] = useState<HolidayCalendar | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /** Null is a new day; a record is that one being corrected; undefined is the list. */
  const [editing, setEditing] = useState<Holiday | null | undefined>(undefined);

  /** '' is every year. */
  const [showing, setShowing] = useState('');

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

  const load = useCallback(() => {
    setLoading(true);

    holidayCalendar()
      .then((next) => {
        setCalendar(next);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(load, [load]);

  if (calendar === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}
      </div>
    );
  }

  if (editing !== undefined) {
    return (
      <div className="page">
        <HolidayForm
          calendar={calendar}
          holiday={editing}
          onSignedOut={onSignedOut}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
          onCancel={() => {
            setEditing(undefined);
          }}
        />
      </div>
    );
  }

  const shown =
    showing === ''
      ? calendar.holidays
      : calendar.holidays.filter((one) => one.leaveYearId === showing);

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          <span className="count">{String(calendar.holidays.length)}</span>
          days the office is closed. Nobody is charged leave for one, so a day declared this morning
          belongs here this morning.
        </p>

        <div className="controls">
          <label className="filter">
            <span className="visually-hidden">Leave year</span>
            <select
              value={showing}
              onChange={(event) => {
                setShowing(event.target.value);
              }}
            >
              <option value="">Every leave year</option>
              {calendar.years.map((year) => (
                <option key={year.id} value={year.id}>
                  {year.label}
                  {year.isClosed ? ' (closed)' : ''}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="primary"
            onClick={() => {
              setEditing(null);
            }}
          >
            <Icon name="plus" />
            Add a holiday
          </button>
        </div>
      </div>

      {/* FR 22. A year nobody has entered a calendar for, said before December rather than in
          January. An empty year is a year nobody transcribed the gazette for, not a year with
          no holidays, and everybody in it is charged a day for Christmas until somebody does. */}
      {calendar.yearsAwaitingACalendar.length === 0 ? null : (
        <p className="notice warning" role="status">
          {sayTheYears(calendar.yearsAwaitingACalendar)} no holidays on the calendar at all. Until
          somebody enters them, every gazetted day in {theyOrIt(calendar.yearsAwaitingACalendar)}{' '}
          counts as an ordinary working day and is charged against leave.
        </p>
      )}

      {/* FR 22. Only where a closed year actually bars a day. With nothing closed the
          sentence announces a restriction that does not apply to anybody reading it. */}
      {calendar.earliestOpenDay === null ? null : (
        <p className="rules">
          <Icon name="info" />
          {calendar.closedYearsInWords}
        </p>
      )}

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      {shown.length === 0 ? (
        <p className="muted">
          No holidays here yet. Every day in this year counts as a working day until one is entered.
        </p>
      ) : (
        groupedByYear(shown, calendar.years).map(([label, group]) => (
          <section key={label} className="ruleset">
            <h2>
              <span className="chip">
                <Icon name="holiday" />
              </span>
              {label}
              <span className="muted">{countOf(group.length)}</span>
            </h2>

            <ul className="holidays">
              {group.map((holiday) => (
                <HolidayRow
                  key={holiday.id}
                  holiday={holiday}
                  today={calendar.today}
                  onEdit={() => {
                    setEditing(holiday);
                  }}
                  onChanged={load}
                  onProblem={answer}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** One day, as it stands. The date and the weekday are the server's, never recomputed here. */
function HolidayRow({
  holiday,
  today,
  onEdit,
  onChanged,
  onProblem,
}: {
  holiday: Holiday;
  today: string;
  onEdit: () => void;
  onChanged: () => void;
  onProblem: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const clear = (): void => {
    setBusy(true);

    removeHoliday(holiday.id)
      .then(onChanged)
      .catch(onProblem)
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };

  return (
    <li className={`holiday${holiday.mayBeChanged ? '' : ' is-fixed'}`}>
      <p className="holiday-day">
        <b>{holiday.inWords}</b>
        <span className="muted">{holiday.weekday}</span>
      </p>

      <h3>{holiday.name}</h3>

      <div className="tags">
        {holiday.date < today ? <span className="tag">Passed</span> : null}
        {/* A day the gazette declared for a stretch nobody has defined a leave year over.
            Worth saying: no request can be made over it, so nothing is priced against it. */}
        {holiday.leaveYearId === null ? (
          <span className="tag is-nobody">Outside every leave year</span>
        ) : null}
      </div>

      {holiday.mayBeChanged ? (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={onEdit}>
            Edit
          </button>

          {asking ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={clear}>
                Yes, it is a working day
              </button>
              <button
                type="button"
                className="linkish"
                disabled={busy}
                onClick={() => {
                  setAsking(false);
                }}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setAsking(true);
              }}
            >
              Remove
            </button>
          )}
        </div>
      ) : (
        /* Not a disabled button with a title on it: the reason is the point, so it is read
           out rather than hovered for. */
        <p className="muted fixed">
          <Icon name="info" />
          {holiday.fixedReason}
        </p>
      )}
    </li>
  );
}

/** So an input a refusal named can point at the sentence. NFR USA 03. */
const REFUSAL_ID = 'holiday-refusal';

/**
 * Adding a day, and correcting one. FR 22. Both halves of the story.
 *
 * One form for both, because they are the same two fields. What differs is only which of
 * them a refusal is likely to be about: a new day usually clashes on the date, and a
 * correction is usually a name the gazette spelled differently.
 */
function HolidayForm({
  calendar,
  holiday,
  onSaved,
  onCancel,
  onSignedOut,
}: {
  calendar: HolidayCalendar;
  /** Null for a new one. */
  holiday: Holiday | null;
  onSaved: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [name, setName] = useState(holiday?.name ?? '');
  const [date, setDate] = useState(holiday?.date ?? '');
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function save(event: FormEvent): void {
    event.preventDefault();

    setSaving(true);
    setRefusal(undefined);

    const fields: HolidayFields = { name: name.trim(), date };

    (holiday === null ? addHoliday(fields) : editHoliday(holiday.id, changedIn(fields, holiday)))
      .then(onSaved)
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

  /* The day already has a holiday on it. Said before the press rather than after, because
     the answer is usually to rename the row that is there rather than to add another. */
  const taken = calendar.holidays.find((one) => one.date === date && one.id !== holiday?.id);

  return (
    <form className="panel" onSubmit={save}>
      <h2 className="panel-title">
        {holiday === null ? 'A new public holiday' : `Editing ${holiday.name}`}
      </h2>

      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <fieldset className="fields">
        <legend>What the gazette says</legend>

        <label>
          Name
          <input
            type="text"
            required
            maxLength={80}
            value={name}
            disabled={saving}
            {...marks('name')}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <small className="muted">
            What the day is called on the calendar somebody reads it from: Christmas Day,
            Farmers&rsquo; Day. Two feasts on one day is one name holding both.
          </small>
        </label>

        <label>
          Date
          <input
            type="date"
            required
            value={date}
            min={calendar.earliestOpenDay ?? undefined}
            disabled={saving}
            {...marks('date')}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
          {calendar.earliestOpenDay === null ? null : (
            <small className="muted">{calendar.closedYearsInWords}</small>
          )}
        </label>

        {taken === undefined ? null : (
          <p className="notice warning" role="status">
            {taken.inWords} is already {taken.name}. A day is closed once however many things fall
            on it, and a second row for it would be counted as a second day off. Rename the one that
            is there instead.
          </p>
        )}
      </fieldset>

      <div className="card-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : holiday === null ? 'Add holiday' : 'Save changes'}
        </button>

        <button type="button" className="linkish" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The fields that differ from the record the form was drawn from. */
function changedIn(fields: HolidayFields, holiday: Holiday): HolidayFields {
  const changes: HolidayFields = {};

  if (fields.name !== holiday.name) changes.name = fields.name;
  if (fields.date !== holiday.date) changes.date = fields.date;

  return changes;
}

/**
 * The days of each leave year, under the year's own label.
 *
 * The days arrive in the order they fall, so the groups come out in that order too. Anything
 * outside every defined year is gathered last rather than dropped — a day nobody can request
 * leave over is still a day HR entered and may want to move.
 */
function groupedByYear(holidays: Holiday[], years: Year[]): [string, Holiday[]][] {
  const labels = new Map(years.map((year) => [year.id, year.label]));
  const groups = new Map<string, Holiday[]>();

  for (const holiday of holidays) {
    const label =
      holiday.leaveYearId === null
        ? 'Outside every leave year'
        : (labels.get(holiday.leaveYearId) ?? 'Outside every leave year');

    const group = groups.get(label);

    if (group === undefined) {
      groups.set(label, [holiday]);
    } else {
      group.push(holiday);
    }
  }

  return [...groups];
}

function countOf(days: number): string {
  return `${String(days)} ${days === 1 ? 'day' : 'days'}`;
}

/** The years with nothing on them, named. "2027 and 2028 have" rather than "some years have". */
function sayTheYears(years: Year[]): string {
  const labels = years.map((year) => year.label);
  const named =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

  return `${named} ${labels.length === 1 ? 'has' : 'have'}`;
}

function theyOrIt(years: Year[]): string {
  return years.length === 1 ? 'it' : 'them';
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2, 3].map((one) => (
        <li key={one} className="skeleton is-short" />
      ))}
    </ul>
  );
}
