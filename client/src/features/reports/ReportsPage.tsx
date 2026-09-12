import { useCallback, useEffect, useState } from 'react';
import {
  type CarriedOverReport,
  carriedOverReport,
  type Desk,
  isNotSignedIn,
  type LeaveTakenReport,
  leaveTakenReport,
  type LeaveUsageReport,
  type LiabilityLine,
  type LiabilityReport,
  liabilityReport,
  type OverdueRequestsReport,
  overdueRequestsReport,
  type PersonLine,
  usageReport,
  type Year,
} from '../../api';
import { day, days, period } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/** HR's reports on leave across the company. FR 63, LMS 510. Every figure is the server's. */

const REPORTS = [
  { id: 'liability', label: 'Leave liability by department' },
  { id: 'taken', label: 'Leave taken by type and period' },
  { id: 'overdue', label: 'Requests past the turnaround' },
  { id: 'usage', label: 'Zero or excessive leave taken' },
  { id: 'carried', label: 'Carried over balances' },
] as const;

type ReportId = (typeof REPORTS)[number]['id'];

type Loaded =
  | { id: 'liability'; report: LiabilityReport }
  | { id: 'taken'; report: LeaveTakenReport }
  | { id: 'overdue'; report: OverdueRequestsReport }
  | { id: 'usage'; report: LeaveUsageReport }
  | { id: 'carried'; report: CarriedOverReport };

interface Asked {
  yearId?: string;
  from: string;
  to: string;
  turnaround: string;
}

const DESKS: Record<Desk, string> = { MANAGER: 'Line manager', HR: 'HR', CEO: 'Chief Executive' };

export function ReportsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [chosen, setChosen] = useState<ReportId>('liability');
  const [years, setYears] = useState<Year[]>([]);
  const [yearId, setYearId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [turnaround, setTurnaround] = useState('');
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);

    reportFor(chosen, { yearId, from, to, turnaround })
      .then((next) => {
        setLoaded(next);
        setProblem(undefined);

        if ('years' in next.report) {
          setYears(next.report.years);
          setYearId((was) => was ?? (next.report as { year: Year }).year.id);
        }
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
  }, [chosen, yearId, from, to, turnaround, onSignedOut]);

  useEffect(load, [load]);

  const showing = loaded?.id === chosen ? loaded : undefined;
  const overAYear = chosen === 'liability' || chosen === 'usage' || chosen === 'carried';

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          Leave across the company, for HR. People who have left are not counted in the balance
          reports; their figure is on the Leavers screen.
        </p>

        <div className="controls">
          <label className="filter">
            <span className="visually-hidden">Report</span>
            <select
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value as ReportId);
              }}
            >
              {REPORTS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>

          {overAYear && years.length > 0 ? (
            <label className="filter">
              <span className="visually-hidden">Leave year</span>
              <select
                value={yearId ?? ''}
                onChange={(event) => {
                  setYearId(event.target.value);
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
          ) : null}

          {chosen === 'taken' ? (
            <>
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
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              </label>
            </>
          ) : null}

          {chosen === 'overdue' ? (
            <label className="filter">
              <span className="muted">Turnaround, in days</span>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                placeholder={showing?.id === 'overdue' ? String(showing.report.turnaroundDays) : ''}
                value={turnaround}
                onChange={(event) => {
                  setTurnaround(event.target.value);
                }}
              />
            </label>
          ) : null}
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      {showing === undefined ? loading ? <Skeletons /> : null : <Report loaded={showing} />}
    </div>
  );
}

function Report({ loaded }: { loaded: Loaded }) {
  switch (loaded.id) {
    case 'liability':
      return <Liability report={loaded.report} />;
    case 'taken':
      return <LeaveTaken report={loaded.report} />;
    case 'overdue':
      return <Overdue report={loaded.report} />;
    case 'usage':
      return <Usage report={loaded.report} />;
    case 'carried':
      return <CarriedOver report={loaded.report} />;
  }
}

/* ------------------------------------------------------------------ liability */

function Liability({ report }: { report: LiabilityReport }) {
  return (
    <>
      <Section title={`The company, ${report.year.label}`}>
        <LiabilityTable lines={report.company} />
      </Section>

      {report.departments.map((department) => (
        <Section
          key={department.departmentId}
          title={department.name}
          aside={`${String(department.headcount)} ${department.headcount === 1 ? 'person' : 'people'}`}
        >
          <LiabilityTable lines={department.lines} />
        </Section>
      ))}
    </>
  );
}

function LiabilityTable({ lines }: { lines: LiabilityLine[] }) {
  return (
    <Table
      head={['Leave type', 'People', 'Granted', 'Carried', 'Adjusted', 'Taken', 'Held', 'Unused']}
    >
      {lines.map((line) => (
        <tr key={line.leaveTypeId}>
          <TypeCell name={line.name} basis={line.countingBasisLabel} />
          <td>{line.people}</td>
          <td>{days(line.entitled)}</td>
          <td>{days(line.carriedOver)}</td>
          <td>{days(line.adjustment)}</td>
          <td>{days(line.taken)}</td>
          <td>{days(line.pending)}</td>
          <td className={line.unused < 0 ? 'overdrawn' : undefined}>
            <b>{days(line.unused)}</b>
          </td>
        </tr>
      ))}
    </Table>
  );
}

/* ----------------------------------------------------------------- leave taken */

function LeaveTaken({ report }: { report: LeaveTakenReport }) {
  return (
    <Section
      title="Approved leave"
      aside={`${period(report.from, report.to)}, counted in the month it starts`}
    >
      <Table head={['Leave type', ...report.months.map(monthLabel), 'Days', 'Requests']}>
        {report.lines.map((line) => (
          <tr key={line.leaveTypeId}>
            <TypeCell name={line.name} basis={line.countingBasisLabel} />
            {line.byMonth.map((figure, index) => (
              <td key={report.months[index]}>{days(figure)}</td>
            ))}
            <td>
              <b>{days(line.days)}</b>
            </td>
            <td>{line.requests}</td>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

/* --------------------------------------------------------------------- overdue */

function Overdue({ report }: { report: OverdueRequestsReport }) {
  return (
    <Section
      title="Waiting for a decision"
      aside={`longer than ${String(report.turnaroundDays)} days, as at ${day(report.asAt)}`}
    >
      {report.requests.length === 0 ? (
        <p className="muted">Nothing has waited longer than the turnaround.</p>
      ) : (
        <Table
          head={[
            'Who',
            'Department',
            'Leave',
            'Dates',
            'Days',
            'Asked on',
            'Waiting',
            'Waiting on',
          ]}
        >
          {report.requests.map((one) => (
            <tr key={one.requestId}>
              <th scope="row">{one.name}</th>
              <td className="is-text">{one.department}</td>
              <td className="is-text">{one.typeName}</td>
              <td className="is-text">{period(one.from, one.to)}</td>
              <td>{days(one.days)}</td>
              <td className="is-text">{day(one.submittedOn)}</td>
              <td>
                <b>{one.daysWaiting}</b>
              </td>
              <td className="is-text">
                {one.awaiting === null ? 'Nobody to approve' : DESKS[one.awaiting]}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

/* ----------------------------------------------------------------------- usage */

function Usage({ report }: { report: LeaveUsageReport }) {
  const [typeId, setTypeId] = useState(report.types[0]?.leaveTypeId ?? '');

  const ofType = (lines: PersonLine[]) => lines.filter((line) => line.leaveTypeId === typeId);

  return (
    <>
      <div className="controls">
        <label className="filter">
          <span className="visually-hidden">Leave type</span>
          <select
            value={typeId}
            onChange={(event) => {
              setTypeId(event.target.value);
            }}
          >
            {report.types.map((type) => (
              <option key={type.leaveTypeId} value={type.leaveTypeId}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Section title="Took none" aside={`given days in ${report.year.label} and took none of them`}>
        <People lines={ofType(report.zero)} empty="Everybody given days has taken some." />
      </Section>

      <Section
        title="Took more than given"
        aside="taken is more than granted, carried and adjusted"
      >
        <People lines={ofType(report.excessive)} empty="Nobody took more than they were given." />
      </Section>
    </>
  );
}

/* --------------------------------------------------------------------- carried */

function CarriedOver({ report }: { report: CarriedOverReport }) {
  return (
    <>
      <p className="rules">
        <Icon name="info" />
        Carry over is uncapped, so these figures can be any size. FR 36a.
      </p>

      <Section title={`Carried into ${report.year.label}`}>
        {report.totals.length === 0 ? (
          <p className="muted">Nothing was carried into this year.</p>
        ) : (
          <Table head={['Leave type', 'People', 'Carried']}>
            {report.totals.map((total) => (
              <tr key={total.leaveTypeId}>
                <TypeCell name={total.name} basis={total.countingBasisLabel} />
                <td>{total.people}</td>
                <td>
                  <b>{days(total.carriedOver)}</b>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {report.balances.length === 0 ? null : (
        <Section title="Balances">
          <People lines={report.balances} empty="" withType />
        </Section>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- shared */

function People({
  lines,
  empty,
  withType = false,
}: {
  lines: PersonLine[];
  empty: string;
  withType?: boolean;
}) {
  if (lines.length === 0) {
    return <p className="muted">{empty}</p>;
  }

  return (
    <Table
      head={[
        'Who',
        'Department',
        ...(withType ? ['Leave'] : []),
        'Given',
        'Carried',
        'Taken',
        'Held',
        'Left',
      ]}
    >
      {lines.map((line) => (
        <tr key={`${line.employeeId}-${line.leaveTypeId}`}>
          <th scope="row">{line.name}</th>
          <td className="is-text">{line.department}</td>
          {withType ? <td className="is-text">{line.typeName}</td> : null}
          <td>{days(line.given)}</td>
          <td>{days(line.carriedOver)}</td>
          <td>{days(line.taken)}</td>
          <td>{days(line.pending)}</td>
          <td className={line.available < 0 ? 'overdrawn' : undefined}>{days(line.available)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="report" />
        </span>
        {title}
        {aside === undefined ? null : <span className="muted">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="report-table">
      <table className="figures-table">
        <thead>
          <tr>
            {head.map((label, index) => (
              <th key={label} scope="col" className={index === 0 ? 'is-text' : undefined}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function TypeCell({ name, basis }: { name: string; basis: string }) {
  return (
    <th scope="row">
      {name}
      <small>{basis}</small>
    </th>
  );
}

/** "Mar 2026" from `2026-03`. */
function monthLabel(month: string): string {
  const written = day(`${month}-01`);

  return written.slice(written.indexOf(' ') + 1);
}

async function reportFor(id: ReportId, asked: Asked): Promise<Loaded> {
  switch (id) {
    case 'liability':
      return { id, report: await liabilityReport(asked.yearId) };
    case 'taken':
      return { id, report: await leaveTakenReport(asked.from, asked.to) };
    case 'overdue':
      return { id, report: await overdueRequestsReport(asked.turnaround) };
    case 'usage':
      return { id, report: await usageReport(asked.yearId) };
    case 'carried':
      return { id, report: await carriedOverReport(asked.yearId) };
  }
}

function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2].map((one) => (
        <li key={one} className="skeleton is-short" />
      ))}
    </ul>
  );
}
