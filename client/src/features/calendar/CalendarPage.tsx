import { useCallback, useEffect, useState } from 'react';
import {
  type Absence,
  type AwayDay,
  type AwayOn,
  type Colleague,
  isNotSignedIn,
  myCalendar,
  type TeamAwayCalendar,
  type Year,
} from '../../api';
import { inDays } from '../../format';

/**
 * Who is away and when, on the team I am on. FR 57, LMS 406.
 *
 * Dates and names, and nothing else. There is no leave type on this screen and no reason,
 * because neither is on the wire — `api.ts` says why.
 */
export function CalendarPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [calendar, setCalendar] = useState<TeamAwayCalendar | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);

      myCalendar(leaveYearId)
        .then((next) => {
          setCalendar(next);
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
    },
    [onSignedOut],
  );

  useEffect(() => {
    load();
  }, [load]);

  /* Usually a refusal rather than a fault: the tab is offered to everybody, and the one
     employee who reports to nobody lands on the server's sentence saying so. */
  if (calendar === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : (
          <>
            <div className="pagehead">
              <h2>Who is away</h2>
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
          <h2>Who is away in {calendar.year.label}</h2>
          <p>{calendar.inWords}</p>
        </div>

        <YearPicker years={calendar.years} showing={calendar.year} busy={loading} onPick={load} />
      </div>

      {problem === undefined ? null : <p className="notice">{problem}</p>}

      <Today away={calendar.awayToday} size={calendar.size} />

      <section className="calendar">
        <div className="calendar-head">
          <h3>The days somebody is off</h3>
          <p>
            {calendar.days.length === 0
              ? `Nothing is booked between ${calendar.from} and ${calendar.to}.`
              : `${String(calendar.days.length)} days, and at most ${String(calendar.busiest)} of you away at once.`}
          </p>
        </div>

        {calendar.days.length === 0 ? null : (
          <ol className="months">
            {monthsOf(calendar.days).map((month) => (
              <li key={month.key}>
                <h4>{month.label}</h4>

                <ul className="awaydays">
                  {month.days.map((day) => (
                    <Day key={day.date} day={day} />
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ol className="requests">
        {calendar.colleagues.map((colleague) => (
          <ColleagueCard key={colleague.employeeId} colleague={colleague} />
        ))}
      </ol>
    </div>
  );
}

/** Out right now, which is the question somebody arrives with. */
function Today({ away, size }: { away: AwayOn[]; size: number }) {
  return (
    <section className="today">
      <h3>Away today</h3>

      {away.length === 0 ? (
        <p className="muted">All {String(size)} of you are in.</p>
      ) : (
        <ul className="who">
          {away.map((one) => (
            <li key={one.employeeId}>
              <span className={`tag${one.agreed ? ' is-agreed' : ''}`}>
                {one.name}
                {one.isMe ? ' (you)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Day({ day }: { day: AwayDay }) {
  return (
    <li className={day.away.length > 1 ? 'is-clash' : undefined}>
      <span className="when">{dayOfMonth(day.date)}</span>

      <span className="who">
        {day.away.map((one) => (
          <span
            key={one.employeeId}
            className={`tag${one.agreed ? ' is-agreed' : ''}${one.isMe ? ' is-me' : ''}`}
          >
            {one.isMe ? 'You' : one.name}
            {one.agreed ? '' : ' (asked for)'}
          </span>
        ))}
      </span>

      {/* Colour is not what says this, and neither is the border. */}
      {day.away.length > 1 ? (
        <span className="clash">
          {day.isEverybody ? 'everybody' : `${String(day.away.length)} away`}
        </span>
      ) : null}
    </li>
  );
}

/** One person on the calendar, and the dates they are off. FR 57. */
function ColleagueCard({ colleague }: { colleague: Colleague }) {
  const left = colleague.employmentStatus === 'TERMINATED';

  return (
    <li className={`card request queued${left ? ' is-held' : ''}`}>
      <div className="card-head">
        <h3>
          {colleague.name}
          {colleague.isMe ? ' (you)' : ''}
        </h3>

        <div className="tags">
          {colleague.isTheManager ? <span className="tag">Your line manager</span> : null}
          {colleague.awayToday ? <span className="tag flag">Away today</span> : null}
          {left ? <span className="tag">Has left</span> : null}
        </div>
      </div>

      <p className="request-what">
        {colleague.jobTitle === null ? 'No job title on the record' : colleague.jobTitle}
      </p>

      <p className="muted">{colleague.inWords}</p>

      {colleague.absences.length === 0 ? null : (
        <ul className="away">
          {colleague.absences.map((absence) => (
            <AbsenceRow key={`${absence.from}-${absence.to}`} absence={absence} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One absence. Dates, how long, and whether it stands — the whole of what a peer may read. */
function AbsenceRow({ absence }: { absence: Absence }) {
  return (
    <li>
      <strong>
        {absence.from} to {absence.to}
      </strong>
      {` · ${inDays(absence.calendarDays)} · `}
      <span className={`tag status is-${absence.agreed ? 'approved' : 'submitted'}`}>
        {absence.agreed ? 'agreed' : 'waiting to be decided'}
      </span>
    </li>
  );
}

/** The year picker, as the team screen's. */
function YearPicker({
  years,
  showing,
  busy,
  onPick,
}: {
  years: Year[];
  showing: Year;
  busy: boolean;
  onPick: (leaveYearId: string) => void;
}) {
  return (
    <label>
      Leave year
      <select
        value={showing.id}
        disabled={busy || years.length < 2}
        onChange={(event) => {
          onPick(event.target.value);
        }}
      >
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

/* ------------------------------------------------------------------------- the calendar */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * The away days grouped under the month they fall in.
 *
 * Sliced out of the ten characters rather than parsed, for the reason `api.ts` gives: a
 * calendar date is never handed to `new Date()`.
 */
function monthsOf(days: AwayDay[]): { key: string; label: string; days: AwayDay[] }[] {
  const grouped: { key: string; label: string; days: AwayDay[] }[] = [];

  for (const day of days) {
    const key = day.date.slice(0, 7);
    const last = grouped.at(-1);

    if (last?.key === key) {
      last.days.push(day);
    } else {
      grouped.push({
        key,
        label: `${MONTHS[Number(day.date.slice(5, 7)) - 1] ?? key} ${day.date.slice(0, 4)}`,
        days: [day],
      });
    }
  }

  return grouped;
}

/** The day of the month, off the same ten characters and for the same reason. */
function dayOfMonth(date: string): string {
  return String(Number(date.slice(8, 10)));
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <>
      <div className="pagehead">
        <h2>Who is away</h2>
      </div>

      <ol className="requests">
        {[0, 1, 2].map((one) => (
          <li key={one} className="skeleton is-tall" />
        ))}
      </ol>
    </>
  );
}
