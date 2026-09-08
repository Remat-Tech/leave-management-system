import type { AwayDay, Colleague } from '../../api';

/** A month of away days, one stripe per person. FR 57, LMS 409. */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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

/** How many colours `styles.css` defines. Assignment wraps; the legend still names them. */
const HUES = 10;

/** A person's lane, held across the whole month so a stretch of leave reads as one line. */
interface Lane {
  colleague: Colleague;
  hue: number;
}

export function Month({
  month,
  days,
  colleagues,
  today,
}: {
  /** Seven characters, `YYYY-MM`. */
  month: string;
  /** Every away day the calendar holds, not only this month's. */
  days: AwayDay[];
  colleagues: Colleague[];
  /** Ten characters. */
  today: string;
}) {
  const inThisMonth = days.filter((day) => day.date.startsWith(month));
  const lanes = lanesIn(inThisMonth, colleagues);
  const byDate = new Map(inThisMonth.map((day) => [day.date, day]));

  return (
    <>
      <div className="month-grid" role="grid" aria-label={nameOf(month)}>
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="weekday" role="columnheader">
            {weekday}
          </div>
        ))}

        {weeksOf(month).map((week, index, weeks) =>
          week.map((date) => (
            <Day
              key={date}
              date={date}
              inMonth={date.startsWith(month)}
              lastWeek={index === weeks.length - 1}
              today={date === today}
              away={byDate.get(date)}
              lanes={lanes}
            />
          )),
        )}
      </div>

      {/* NFR USA 03. What actually says whose stripe is whose. */}
      {lanes.length === 0 ? (
        <p className="month-empty">Nobody is away in {nameOf(month)}.</p>
      ) : (
        <ul className="who-legend">
          {lanes.map(({ colleague, hue }) => (
            <li key={colleague.employeeId} className={colleague.isMe ? 'is-me' : undefined}>
              <span className="who-swatch" style={hueOf(hue)} />
              {colleague.isMe ? `${colleague.name} (you)` : colleague.name}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One cell: the day, and a lane per person on the legend — the empty ones included. */
function Day({
  date,
  inMonth,
  lastWeek,
  today,
  away,
  lanes,
}: {
  date: string;
  inMonth: boolean;
  lastWeek: boolean;
  today: boolean;
  away: AwayDay | undefined;
  lanes: Lane[];
}) {
  /** FR 41. Which of the two, rather than only whether. */
  const standing = new Map(
    (away?.away ?? []).map((one) => [one.employeeId, one.agreed ? 'agreed' : 'asked'] as const),
  );

  const names = (away?.away ?? []).map(
    (one) => `${one.isMe ? 'You' : one.name}${one.agreed ? '' : ', asked for'}`,
  );

  return (
    <div
      role="gridcell"
      className={
        'day' +
        (inMonth ? '' : ' is-outside') +
        (lastWeek ? ' is-last-week' : '') +
        (today ? ' is-today' : '') +
        (isWeekend(date) ? ' is-weekend' : '')
      }
      /* NFR USA 03. The cell in words, for anybody the stripes do not reach. */
      aria-label={names.length === 0 ? undefined : `${readably(date)}: ${names.join('; ')} away.`}
    >
      <span className="day-number">{Number(date.slice(8, 10))}</span>

      <span className="lanes">
        {lanes.map(({ colleague, hue }) => {
          const mine = standing.get(colleague.employeeId);

          return (
            <span
              key={colleague.employeeId}
              className={`lane${mine === undefined ? '' : mine === 'agreed' ? ' is-away' : ' is-asked'}`}
              style={mine === undefined ? undefined : hueOf(hue)}
            />
          );
        })}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- the shapes */

/** Everybody with a stripe this month, in the order the server listed them. */
function lanesIn(days: AwayDay[], colleagues: Colleague[]): Lane[] {
  const away = new Set(days.flatMap((day) => day.away.map((one) => one.employeeId)));

  return colleagues
    .filter((colleague) => away.has(colleague.employeeId))
    .map((colleague, index) => ({ colleague, hue: index % HUES }));
}

/** The custom property `styles.css` paints a stripe and a swatch from. */
function hueOf(hue: number): React.CSSProperties {
  return { '--who': `var(--who-${String(hue)})` } as React.CSSProperties;
}

/**
 * The weeks the month is drawn over, Monday first, whole at both ends.
 *
 * `Date.UTC` from three numbers, never `new Date('2026-11-01')`: `api.ts` says why.
 */
function weeksOf(month: string): string[][] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;

  /** Sunday is 0 in JavaScript and last in a week that starts on Monday. */
  const before = (new Date(Date.UTC(year, index, 1)).getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, index, 1 - before));

  const length = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();

  return Array.from({ length: Math.ceil((before + length) / 7) }, (_week, row) =>
    Array.from({ length: 7 }, (_day, column) =>
      formatted(new Date(start.getTime() + (row * 7 + column) * 86_400_000)),
    ),
  );
}

/** Ten characters, out of the UTC fields. NFR DAT 03. */
function formatted(at: Date): string {
  return (
    `${String(at.getUTCFullYear()).padStart(4, '0')}-` +
    `${String(at.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(at.getUTCDate()).padStart(2, '0')}`
  );
}

/** The shape of the week, and no claim about whose working days these are. FR 23. */
function isWeekend(date: string): boolean {
  const day = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  ).getUTCDay();

  return day === 0 || day === 6;
}

/** "May 2026", off the seven characters. */
export function nameOf(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/** "12 May 2026", for a label rather than for a column. */
function readably(date: string): string {
  return `${Number(date.slice(8, 10))} ${nameOf(date.slice(0, 7))}`;
}

/** The month either side, or nothing where that leaves the year the calendar covers. */
export function step(month: string, by: -1 | 1, from: string, to: string): string | undefined {
  const asked = formatted(
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1)),
  ).slice(0, 7);

  return asked < from.slice(0, 7) || asked > to.slice(0, 7) ? undefined : asked;
}
