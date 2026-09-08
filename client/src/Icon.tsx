/** The marks in the rail, on the cards and in the buttons. LMS 409. */

/**
 * One glyph per name, inline rather than an icon package.
 *
 * `aria-hidden` always — each sits beside its own label. NFR USA 03.
 */
export type IconName =
  /* The rail. */
  | 'balances'
  | 'ask'
  | 'requests'
  | 'calendar'
  | 'approvals'
  /* Kinds of leave, matched on the name by `iconForLeaveType`. */
  | 'annual'
  | 'sick'
  | 'compassionate'
  | 'maternity'
  | 'paternity'
  | 'study'
  | 'unpaid'
  /* On the cards and in the controls. */
  | 'info'
  | 'people'
  | 'stage'
  | 'tick'
  | 'cross'
  | 'send'
  | 'clip'
  | 'upload';

const PATHS: Record<IconName, string> = {
  /** What you have: a calendar with days counted on it. */
  balances: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  /** Asking: something sent. */
  ask: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z',
  /** What you asked for: a page with lines on it. */
  requests: 'M6 3h12v18H6zM9.5 8h5M9.5 12h5M9.5 16h3',
  /** Who is away: people. */
  calendar:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M17 4.5a3.5 3.5 0 0 1 0 7M18 20a6.5 6.5 0 0 0-2-4.7',
  /** Waiting on you: a clock, because what it is about is how long it has been sitting there. */
  approvals: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',

  annual: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  sick: 'M12 6.5h5M14.5 4v5M4.5 4.5h4v5.5a3 3 0 0 0 6 0M8.5 10v3a5 5 0 0 0 10 0v-1',
  compassionate: 'M12 20s-7-4.4-7-9.2A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.8C19 15.6 12 20 12 20z',
  maternity:
    'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 9c-2.5 0-4 2-4 4.5S9 21 12 21s4-4 4-7.5S14.5 9 12 9zM12 13v4',
  paternity:
    'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 21v-5H7.5V12a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v4H15v5z',
  study: 'M12 4 2.5 8.5 12 13l9.5-4.5zM6.5 11v5c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-5',
  unpaid: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8',

  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.75v.5',
  people:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M17 4.5a3.5 3.5 0 0 1 0 7M18 20a6.5 6.5 0 0 0-2-4.7',
  /** The chain a request walks up. FR 38a. */
  stage:
    'M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 8v3M12 11H7a2 2 0 0 0-2 2v2M12 11h5a2 2 0 0 1 2 2v2M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  tick: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  cross: 'M6 6l12 12M18 6 6 18',
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z',
  clip: 'M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 5 5L10 17.5a1.8 1.8 0 0 1-2.5-2.5l8-8',
  upload: 'M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d={PATHS[name]}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Which glyph a kind of leave gets.
 *
 * Matched on the name the server sent rather than on a list of codes this file keeps: HR
 * creates leave types, so an unrecognised one is the ordinary case and gets the calendar.
 */
export function iconForLeaveType(name: string): IconName {
  const said = name.toLowerCase();

  if (said.includes('sick')) return 'sick';
  if (said.includes('compassionate') || said.includes('bereave')) return 'compassionate';
  if (said.includes('matern')) return 'maternity';
  if (said.includes('patern')) return 'paternity';
  if (said.includes('study') || said.includes('exam')) return 'study';
  if (said.includes('unpaid')) return 'unpaid';

  return 'annual';
}
