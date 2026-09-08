import { useCallback, useEffect, useState } from 'react';
import {
  type Absence,
  type AwayOn,
  type Colleague,
  type DepartmentOnTheCalendar,
  EVERY_DEPARTMENT,
  isNotSignedIn,
  myCalendar,
  myTeam,
  type Team,
  type TeamAwayCalendar,
  type TeamMember,
  type Year,
} from '../../api';
import { inDays, period } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Reports } from '../team/Reports';
import { Month, nameOf, step } from './Month';

/**
 * Who is away, in a department. FR 55, FR 56, FR 57, LMS 406, LMS 409.
 *
 * Dates and names for everybody; a report's balances and bookings for their own manager, out
 * of `/api/me/team`, which is the only call that may name a leave type.
 */
export function CalendarPage({
  onSignedOut,
  yearId,
  onYears,
}: {
  onSignedOut: () => void;
  /** LMS 409. The year the picker in the bar is showing. */
  yearId: string | undefined;
  onYears: (years: Year[], showing: string) => void;
}) {
  const [calendar, setCalendar] = useState<TeamAwayCalendar | undefined>(undefined);
  const [team, setTeam] = useState<Team | undefined>(undefined);
  const [month, setMonth] = useState<string | undefined>(undefined);

  /** LMS 409. Held here rather than read back off the answer, so changing the year in the bar
      does not quietly reset an HR reader's department back to their own. */
  const [departmentId, setDepartmentId] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (leaveYearId?: string, departmentId?: string) => {
      setLoading(true);

      myCalendar(leaveYearId, departmentId)
        .then((next) => {
          setCalendar(next);
          setMonth(openingMonth(next));
          onYears(next.years, next.year.id);
          setProblem(undefined);
        })
        .catch((error: unknown) => {
          if (isNotSignedIn(error)) {
            onSignedOut();
            return;
          }

          /** The server's own sentence, verbatim. NFR USA 03, LMS 410. */
          setProblem(problemFrom(error));
        })
        .finally(() => {
          setLoading(false);
        });

      /* FR 55. Refused for anybody who manages nobody, which is not a fault: the extra the
         cards carry is simply not there for them. */
      myTeam(leaveYearId)
        .then(setTeam)
        .catch(() => {
          setTeam(undefined);
        });
    },
    [onSignedOut, onYears],
  );

  useEffect(() => {
    load(yearId, departmentId);
  }, [load, yearId, departmentId]);

  const again = () => {
    load(yearId, departmentId);
  };

  if (calendar === undefined) {
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

  const reports = new Map(team?.members.map((one) => [one.employeeId, one]) ?? []);
  const showing = month ?? openingMonth(calendar);

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">{whoseCalendar(calendar)}</p>

        <div className="controls">
          {/* LMS 409. HR only — everybody else gets their own department and no picker. */}
          {calendar.canChooseDepartment ? (
            <DepartmentPicker
              departments={calendar.departments}
              showing={calendar.department}
              busy={loading}
              onPick={setDepartmentId}
            />
          ) : null}
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={again} />
      )}

      <Today away={calendar.awayToday} size={calendar.size} />

      <section className="calendar">
        <div className="calendar-head">
          <h3>{calendar.department?.name ?? 'Every department'}</h3>

          <div className="month-steps">
            <Step
              to={step(showing, -1, calendar.from, calendar.to)}
              label="Previous month"
              mark="‹"
              onPick={setMonth}
            />
            <span className="month-name">{nameOf(showing)}</span>
            <Step
              to={step(showing, 1, calendar.from, calendar.to)}
              label="Next month"
              mark="›"
              onPick={setMonth}
            />
          </div>

          <p>{summaryOf(calendar)}</p>
        </div>

        <Month
          month={showing}
          days={calendar.days}
          colleagues={calendar.colleagues}
          today={todayInWholeDays()}
        />
      </section>

      {/* FR 57. What this screen deliberately does not say, said. */}
      <p className="footnote">
        <Icon name="info" />
        Only the dates are shown. Leave type and reason are not on this screen at all — just who is
        away and when.
      </p>

      <ol className="requests">
        {calendar.colleagues.map((colleague) => (
          <ColleagueCard
            key={colleague.employeeId}
            colleague={colleague}
            report={reports.get(colleague.employeeId)}
            named={calendar.department === null}
          />
        ))}
      </ol>
    </div>
  );
}

/** One step through the year. Absent at either end rather than disabled and unexplained. */
function Step({
  to,
  label,
  mark,
  onPick,
}: {
  to: string | undefined;
  label: string;
  mark: string;
  onPick: (month: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={to === undefined}
      onClick={() => {
        if (to !== undefined) {
          onPick(to);
        }
      }}
    >
      <span aria-hidden="true">{mark}</span>
    </button>
  );
}

/** Out right now, which is the question somebody arrives with. */
function Today({ away, size }: { away: AwayOn[]; size: number }) {
  return (
    <section className="today">
      <span className="chip">
        <Icon name="people" />
      </span>

      <div className="today-said">
        <h3>Away today</h3>
        <p className="muted">
          {away.length === 0
            ? `All ${String(size)} of you are in.`
            : `${String(away.length)} ${away.length === 1 ? 'person is' : 'people are'} off today`}
        </p>
      </div>

      {away.length === 0 ? null : (
        <ul className="who">
          {away.map((one) => (
            <li key={one.employeeId}>
              <span className={`tag${one.agreed ? ' is-agreed' : ''}`}>
                {/* No photograph on the record, so initials. */}
                <i className="initials" aria-hidden="true">
                  {initialsOf(one.name)}
                </i>
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

/** Two letters, standing in for a photograph the record does not hold. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);

  return `${parts[0]?.charAt(0) ?? ''}${parts.length > 1 ? parts[parts.length - 1].charAt(0) : ''}`.toUpperCase();
}

/**
 * One person on the calendar. FR 57, and FR 55 and FR 56 where they report to the reader.
 *
 * `report` is the manager's own answer from `/api/me/team`; without one the card is dates and
 * names, which is the whole of what a peer may read.
 */
function ColleagueCard({
  colleague,
  report,
  named,
}: {
  colleague: Colleague;
  report: TeamMember | undefined;
  /** LMS 409. Whether the department is worth saying, which it is across all of them. */
  named: boolean;
}) {
  const left = colleague.employmentStatus === 'TERMINATED';

  return (
    <li className={`card request queued${left ? ' is-held' : ''}`}>
      <div className="card-head">
        <h3>
          {colleague.name}
          {colleague.isMe ? ' (you)' : ''}
        </h3>

        <div className="tags">
          {colleague.isTheManager ? <span className="tag">Your manager</span> : null}
          {report === undefined ? null : <span className="tag">Reports to you</span>}
          {colleague.awayToday ? <span className="tag flag">Away today</span> : null}
          {left ? <span className="tag">Has left</span> : null}
        </div>
      </div>

      <p className="request-what">
        {colleague.jobTitle === null ? 'No job title on the record' : colleague.jobTitle}
        {named && colleague.department !== null ? ` · ${colleague.department.name}` : ''}
      </p>

      <p className="muted">{bookedInShort(colleague)}</p>

      {report === undefined ? (
        colleague.absences.length === 0 ? null : (
          <ul className="away">
            {colleague.absences.map((absence) => (
              <AbsenceRow key={`${absence.from}-${absence.to}`} absence={absence} />
            ))}
          </ul>
        )
      ) : (
        <Reports member={report} />
      )}
    </li>
  );
}

/** One absence. Dates, how long, and whether it stands — the whole of what a peer may read. */
function AbsenceRow({ absence }: { absence: Absence }) {
  return (
    <li>
      <strong>{period(absence.from, absence.to)}</strong>
      {` · ${inDays(absence.calendarDays)} · `}
      <span className={`tag status is-${absence.agreed ? 'approved' : 'submitted'}`}>
        {absence.agreed ? 'agreed' : 'waiting to be decided'}
      </span>
    </li>
  );
}

/** LMS 409. HR's filter. Labelled rather than placeholder-ed, as the year picker is. */
function DepartmentPicker({
  departments,
  showing,
  busy,
  onPick,
}: {
  departments: DepartmentOnTheCalendar[];
  showing: DepartmentOnTheCalendar | null;
  busy: boolean;
  onPick: (departmentId: string) => void;
}) {
  return (
    <label>
      Department
      <select
        value={showing?.id ?? EVERY_DEPARTMENT}
        disabled={busy}
        onChange={(event) => {
          onPick(event.target.value);
        }}
      >
        <option value={EVERY_DEPARTMENT}>Every department</option>
        {departments.map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------------- the calendar */

/** The month covering today, or the first of the year where today is outside it. */
function openingMonth(calendar: TeamAwayCalendar): string {
  const today = todayInWholeDays();

  return today >= calendar.from && today <= calendar.to
    ? today.slice(0, 7)
    : calendar.from.slice(0, 7);
}

/**
 * Today, ten characters, in the reader's own zone.
 *
 * The only date this file makes rather than receives, and it is deliberately local: "today"
 * on a wall calendar is the reader's Tuesday, not UTC's.
 */
function todayInWholeDays(): string {
  const now = new Date();

  return (
    `${String(now.getFullYear()).padStart(4, '0')}-` +
    `${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}`
  );
}

function summaryOf(calendar: TeamAwayCalendar): string {
  return calendar.days.length === 0
    ? 'Nothing booked this year.'
    : `${String(calendar.days.length)} days away · up to ${String(calendar.busiest)} at once`;
}

/**
 * What one person has booked, as a count. LMS 409.
 *
 * The server's sentence — "Akosua Darko has 1 absence booked in 2026, over 3 days" — repeated
 * the name at the top of the card and the dates listed underneath it.
 */
function bookedInShort(colleague: Colleague): string {
  const left = colleague.employmentStatus === 'TERMINATED' ? 'Has left · ' : '';

  if (colleague.absences.length === 0) {
    return `${left}nothing booked`;
  }

  const total = colleague.absences.reduce((sum, one) => sum + one.calendarDays, 0);

  return `${left}${String(colleague.absences.length)} ${colleague.absences.length === 1 ? 'absence' : 'absences'} · ${inDays(total)}`;
}

/** Whose calendar this is, as a caption. LMS 409. */
function whoseCalendar(calendar: TeamAwayCalendar): string {
  const where = calendar.department === null ? 'the company' : calendar.department.name;

  return `${String(calendar.size)} ${calendar.size === 1 ? 'person' : 'people'} in ${where}`;
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ol className="requests">
      {[0, 1, 2].map((one) => (
        <li key={one} className="skeleton is-tall" />
      ))}
    </ol>
  );
}
