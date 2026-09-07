import { useCallback, useEffect, useState } from 'react';
import {
  type BalanceLine,
  isNotSignedIn,
  myTeam,
  type Team,
  type TeamBooking,
  type TeamCalendar,
  type TeamDay,
  type TeamMember,
  type Year,
} from '../../api';
import { days, inDays } from '../../format';

/** My direct reports, what they have left and who is already away. FR 55, FR 56, LMS 405. */
export function TeamPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [team, setTeam] = useState<Team | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string) => {
      setLoading(true);

      myTeam(leaveYearId)
        .then((next) => {
          setTeam(next);
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

  /* Usually a refusal rather than a fault: the tab is offered to everybody, so somebody who
     manages nobody lands on the server's own sentence saying what the screen is for. */
  if (team === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : (
          <>
            <div className="pagehead">
              <h2>Your team</h2>
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
          <h2>Your team in {team.year.label}</h2>
          <p>{team.inWords}</p>
        </div>

        <YearPicker years={team.years} showing={team.year} busy={loading} onPick={load} />
      </div>

      {problem === undefined ? null : <p className="notice">{problem}</p>}

      <Calendar calendar={team.calendar} />

      <ol className="requests">
        {team.members.map((member) => (
          <MemberCard key={member.employeeId} member={member} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Who is away when. FR 56, and the "so that" of the story.
 *
 * Only the days somebody is off are listed, because that is what the server sends: a year is
 * three hundred and sixty-five rows of which a handful matter. The ones that matter are marked
 * — a clash is the day a manager is deciding around — and the mark is never the only thing
 * saying so, because the row names everybody on it.
 */
function Calendar({ calendar }: { calendar: TeamCalendar }) {
  return (
    <section className="calendar">
      <div className="calendar-head">
        <h3>Who is away</h3>
        <p>{calendar.inWords}</p>
      </div>

      {calendar.days.length === 0 ? null : (
        <ol className="months">
          {monthsOf(calendar.days).map((month) => (
            <li key={month.key}>
              <h4>{month.label}</h4>

              <ul className="awaydays">
                {month.days.map((day) => (
                  <AwayDay key={day.date} day={day} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AwayDay({ day }: { day: TeamDay }) {
  return (
    <li className={day.isClash ? 'is-clash' : undefined}>
      <span className="when">{dayOfMonth(day.date)}</span>

      <span className="who">
        {day.away.map((one) => (
          <span
            key={one.requestId}
            className={`tag${one.status === 'APPROVED' ? ' is-agreed' : ''}`}
          >
            {one.name}
            {one.status === 'APPROVED' ? '' : ' (asked for)'}
          </span>
        ))}
      </span>

      {/* Colour is not what says this, and neither is the border. */}
      {day.isClash ? (
        <span className="clash">
          {day.isEverybody ? 'the whole team' : `${String(day.away.length)} away`}
        </span>
      ) : null}
    </li>
  );
}

/** One direct report: what they have left, and what they have booked. FR 55, FR 56. */
function MemberCard({ member }: { member: TeamMember }) {
  const left = member.employmentStatus === 'TERMINATED';

  return (
    <li className={`card request queued${left ? ' is-held' : ''}`}>
      <div className="card-head">
        <h3>{member.name}</h3>

        <div className="tags">
          {member.awayToday ? <span className="tag flag">Away today</span> : null}
          {left ? <span className="tag">Has left</span> : null}
        </div>
      </div>

      <p className="request-what">
        {member.jobTitle === null ? 'No job title on the record' : member.jobTitle}
        {' · '}
        {inDays(member.daysBooked)} booked
        {' · '}
        {member.booked.length === 1 ? '1 request' : `${String(member.booked.length)} requests`}
      </p>

      <p className="muted">{member.inWords}</p>

      <Figures lines={member.balances} />

      <details className="breakdown">
        <summary>Balances in full</summary>

        <table className="figures-table">
          <thead>
            <tr>
              <th scope="col">Leave</th>
              <th scope="col">Entitled</th>
              <th scope="col">Carried</th>
              <th scope="col">Adjusted</th>
              <th scope="col">Taken</th>
              <th scope="col">Pending</th>
              <th scope="col">Available</th>
            </tr>
          </thead>
          <tbody>
            {member.balances.map((line) => (
              <tr key={line.leaveTypeId}>
                <th scope="row">
                  {line.name}
                  <small>{line.allowanceInWords}</small>
                </th>
                <td>{days(line.entitled)}</td>
                <td>{days(line.carriedOver)}</td>
                <td>{days(line.adjustment)}</td>
                <td>{days(line.taken)}</td>
                <td>{days(line.pending)}</td>
                <td className={line.available < 0 ? 'overdrawn' : undefined}>
                  {days(line.available)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {member.booked.length === 0 ? null : (
        <ul className="away">
          {member.booked.map((booking) => (
            <Booking key={booking.requestId} booking={booking} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * What each kind of leave has left, as a figure each.
 *
 * Nothing is added up across the row: twenty annual days and three sick days are not
 * twenty-three of anything. A type that arrives with an occasion and has had none reads as a
 * dash rather than as nought, because a nought there means "not yet" and not "none left" —
 * the sentence in the table below says which.
 */
function Figures({ lines }: { lines: BalanceLine[] }) {
  return (
    <ul className="figures">
      {lines.map((line) => {
        const awaitingAnOccasion = line.entitlementBasis === 'EVENT' && !line.hasMoved;

        return (
          <li key={line.leaveTypeId}>
            <span className="what">{line.name}</span>
            <span className={`figure${line.available < 0 ? ' overdrawn' : ''}`}>
              {awaitingAnOccasion ? '—' : days(line.available)}
            </span>
            <span className="of">{awaitingAnOccasion ? 'per occasion' : 'left'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One piece of live leave, in the server's own sentence. FR 56. */
function Booking({ booking }: { booking: TeamBooking }) {
  return (
    <li>
      <strong>
        {booking.from} to {booking.to}
      </strong>
      {` · ${inDays(booking.days)}`}
      {/* FR 24. Said only where the two differ, because "5 days, 5 days off" is noise. */}
      {booking.calendarDays === booking.days
        ? ''
        : ` charged, ${inDays(booking.calendarDays)} away`}
      {` · ${booking.typeName} · `}
      <span className={`tag status is-${booking.status.toLowerCase()}`}>
        {booking.agreed ? 'agreed' : 'waiting to be decided'}
      </span>
    </li>
  );
}

/**
 * The year picker.
 *
 * The years the server said there are, in its own order. Labelled rather than placeholder-ed,
 * because a placeholder disappears once a value is chosen and a screen reader user then has an
 * unlabelled control.
 */
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
 * Sliced out of the ten characters rather than parsed. `api.ts` is emphatic that a calendar
 * date is never handed to `new Date()` — a leave year runs to a day rather than to an instant,
 * and converting one here is how the first of November becomes the thirty-first of October for
 * anybody west of Greenwich. Grouping is a presentation decision and not arithmetic on a date.
 */
function monthsOf(awayDays: TeamDay[]): { key: string; label: string; days: TeamDay[] }[] {
  const grouped: { key: string; label: string; days: TeamDay[] }[] = [];

  for (const day of awayDays) {
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
        <h2>Your team</h2>
      </div>

      <ol className="requests">
        {[0, 1, 2].map((one) => (
          <li key={one} className="skeleton is-tall" />
        ))}
      </ol>
    </>
  );
}
