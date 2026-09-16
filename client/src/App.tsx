import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentSession, type Me, mySections, signOut, type Year } from './api';
import { ApprovalsPage } from './features/approvals/ApprovalsPage';
import { AuditLogPage } from './features/audit/AuditLogPage';
import { BalancesPage } from './features/balances/BalancesPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { ApprovalChainsPage } from './features/config/ApprovalChainsPage';
import { BalanceAdjustmentsPage } from './features/config/BalanceAdjustmentsPage';
import { EmailWordingPage } from './features/config/EmailWordingPage';
import { EntitlementRulesPage } from './features/config/EntitlementRulesPage';
import { HolidaysPage } from './features/config/HolidaysPage';
import {
  hasHrSection,
  HR_GROUPS,
  HrSettingsPage,
  type HrSectionId,
} from './features/config/HrSettingsPage';
import { LeaversPage } from './features/config/LeaversPage';
import { LeaveTypesPage } from './features/config/LeaveTypesPage';
import { PolicySettingsPage } from './features/config/PolicySettingsPage';
import { NewRequestPage } from './features/requests/NewRequestPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { ChangePassword } from './features/session/ChangePassword';
import { SignIn } from './features/session/SignIn';
import { Icon } from './Icon';

/** The application, and the places there are to go. LMS 401 to LMS 406, LMS 409. */

/**
 * The rail: what somebody does with their own leave, in the order they do it.
 *
 * **"Waiting on me" is drawn only for somebody who answers at a desk.** FR 40. That turns on a
 * reporting line, an HR role, FR 04's seat and any delegation running this morning — none of
 * which this page can work out, and it does not try: `/api/me/sections` asks
 * `leaveRequestPolicy.queue`, the screen's own decision. `/api/me` still carries no roles, so
 * the page holds nothing it could decide from, and the screen refuses on its own account for
 * anybody who reaches its address anyway.
 *
 * **"My team" is not a tab any more.** LMS 409. It drew the same calendar as "Who is away"
 * over different people. What was only on it, FR 55 and FR 56, is on "Who is away" now.
 */
const MAIN_SCREENS = [
  { id: 'balances', label: 'My balances', icon: 'balances' },
  { id: 'ask', label: 'Ask for leave', icon: 'ask' },
  { id: 'requests', label: 'My requests', icon: 'requests' },
  /** FR 55, FR 56, FR 57, LMS 406, LMS 409. Everybody's, scoped to a department. */
  { id: 'calendar', label: 'Who is away', icon: 'calendar' },
  { id: 'approvals', label: 'Waiting on me', icon: 'approvals' },
] as const;

/**
 * The way into the configuration screens, which used to be ten tabs of their own.
 *
 * Drawn only for somebody the server said has a section to reach, from `/api/me/sections`.
 * That is not the page deciding: it asks, and each section's own policy answers. Opening a
 * section's address directly still meets the refusal it always gave, so nothing here is a
 * second answer to a question the server owns.
 */
const HR_HUB = { id: 'hr', label: 'HR settings', icon: 'settings' } as const;

type MainScreen = (typeof MAIN_SCREENS)[number]['id'];
type Screen = MainScreen | typeof HR_HUB.id | HrSectionId;

const HR_SECTIONS = HR_GROUPS.flatMap((group) => group.sections);

/** Rail tabs that are drawn only where the server named them. */
const CONDITIONAL = new Set<string>(['approvals']);

/** Every address there is, and what the heading says on it. */
const LABELS = new Map<string, string>([
  ...MAIN_SCREENS.map((one) => [one.id, one.label] as const),
  [HR_HUB.id, HR_HUB.label],
  ...HR_SECTIONS.map((one) => [one.id, one.label] as const),
]);

/** The screens a leave year decides the contents of, and so the ones the picker appears on. */
const YEAR_SCOPED = new Set<Screen>(['balances', 'calendar']);

const DEFAULT_SCREEN: Screen = 'balances';

/** The hub stays lit while you are on one of its sections. */
function isHrSection(screen: Screen): boolean {
  return HR_SECTIONS.some((one) => one.id === screen);
}

/**
 * What somebody is told when the session ran out under them. NFR USA 03, LMS 410.
 *
 * Every screen answers a 401 by dropping back here, and used to do it in silence — a half
 * filled form replaced by a sign in box with no account of why. It does not promise what was
 * typed survived; it did not.
 */
const SESSION_ENDED =
  'You were signed out because your session ran out. Sign in again to carry on. Anything ' +
  'you had already submitted is safe, but a form you were part way through is not.';

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [asked, setAsked] = useState(false);
  /** LMS 410. Set only where the session ended on its own, never where somebody signed out. */
  const [ended, setEnded] = useState<string | undefined>(undefined);
  /** The server's answer, not this page's. Empty until it has answered. */
  const [sections, setSections] = useState<string[]>([]);

  /**
   * The leave year, held here rather than on each screen. LMS 409.
   *
   * The years come *up* from whichever year-scoped screen loaded last rather than being
   * fetched here: there is no endpoint that answers "which years are mine" on its own, and
   * inventing a request for one would be a second answer to a question the screens already
   * have. `yearId` going the other way is what makes the picker in the bar the same control
   * on both screens.
   */
  const [years, setYears] = useState<Year[]>([]);
  const [yearId, setYearId] = useState<string | undefined>(undefined);

  const yearsKnown = useCallback((offered: Year[], showing: string) => {
    setYears(offered);
    setYearId((was) => was ?? showing);
  }, []);

  const screen = useScreen();
  const screens = useRef<HTMLElement | null>(null);

  const ask = useCallback(() => {
    currentSession()
      .then(async (who) => {
        setMe(who);
        setEnded(undefined);
        // A rail without the hub is better than a rail that guesses at one.
        setSections(await mySections().catch(() => []));
      })
      .catch(() => {
        setMe(undefined);
        setSections([]);
      })
      .finally(() => {
        setAsked(true);
      });
  }, []);

  useEffect(ask, [ask]);

  /** Signing out on purpose. Nothing went wrong, so nothing is said. */
  const forget = useCallback(() => {
    setMe(undefined);
    setSections([]);
    setEnded(undefined);
  }, []);

  /** LMS 410. What every screen calls on a 401. Not the same act as signing out. */
  const ranOut = useCallback(() => {
    setMe(undefined);
    setSections([]);
    setEnded(SESSION_ENDED);
  }, []);

  /**
   * Bring the tab you are on into view. LMS 408.
   *
   * The tabs scroll sideways on a phone, so a link to "Waiting on me" would land on a strip
   * with nothing marked. Moves nothing where the strip is not scrolling. `block: 'nearest'`
   * never scrolls the page — the bar is sticky, so only the strip has anywhere to go. `me` is a
   * dependency because the bar exists only once there is somebody to draw it for.
   */
  useEffect(() => {
    screens.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [screen, me]);

  if (!asked) {
    return null;
  }

  if (me === undefined) {
    return <SignIn onSignedIn={ask} ended={ended} />;
  }

  /* NFR SEC 01. Instead of the application, not beside it: the server refuses every other
     route while this stands, so a rail drawn here would be tabs that all answer 403. */
  if (me.mustChangePassword) {
    return <ChangePassword onChanged={ask} />;
  }

  /* Every tab the server said this person may reach: the four everybody has, "Waiting on me"
     for whoever staffs a desk, and the hub for whoever has a card in it. */
  const tabs = [
    ...MAIN_SCREENS.filter((one) => !CONDITIONAL.has(one.id) || sections.includes(one.id)),
    ...(hasHrSection(sections) ? [HR_HUB] : []),
  ];

  return (
    <div className="shell">
      {/* LMS 409. The company rail: the wordmark, the screens, and the company line. */}
      <header className="sidebar">
        <a className="logo" href={`#/${DEFAULT_SCREEN}`}>
          <span className="logo-mark" aria-hidden="true">
            R
          </span>
          <span className="logo-word">
            <b>Remat</b>
            <i>Holdings</i>
          </span>
        </a>

        {/* Anchors rather than buttons, which is the whole of what the router buys: a tab
            can be middle clicked, copied, bookmarked and gone back from, and none of that
            is behaviour this file has to write. */}
        <nav className="screens" aria-label="Sections" ref={screens}>
          {tabs.map((one) => (
            <a
              key={one.id}
              href={`#/${one.id}`}
              className="screen-tab"
              aria-current={
                screen === one.id || (one.id === HR_HUB.id && isHrSection(screen))
                  ? 'page'
                  : undefined
              }
            >
              <Icon name={one.icon} />
              {one.label}
            </a>
          ))}
        </nav>
      </header>

      <div className="main">
        <div className="topbar">
          <div className="topbar-inner">
            {/* The screen you are on, as the page's heading. The rail says which tab is lit;
                this is the one `h1`, and it is what a screen reader lands on. */}
            {/* Back to the cards, from a section that no longer has a tab of its own. Before
                the heading, where a way back is looked for. */}
            {isHrSection(screen) ? (
              <a className="back" href={`#/${HR_HUB.id}`} aria-label={`Back to ${HR_HUB.label}`}>
                <Icon name="back" />
              </a>
            ) : null}

            <h1>{LABELS.get(screen) ?? LABELS.get(DEFAULT_SCREEN)}</h1>

            {/* LMS 409. Only on the screens it means something on: a picker over "Ask for
                leave" would be a control that changes nothing. */}
            {YEAR_SCOPED.has(screen) && years.length > 0 ? (
              <label className="year">
                <span className="visually-hidden">Leave year</span>
                <select
                  value={yearId ?? ''}
                  disabled={years.length < 2}
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

            <p className="whoami">
              <span className="avatar" aria-hidden="true">
                {initialsOf(me)}
              </span>
              <span className="whoami-name">
                {me.firstName} {me.lastName}
              </span>
            </p>

            <button
              type="button"
              className="linkish"
              onClick={() => {
                void signOut().finally(forget);
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* LMS 410. `ranOut` rather than `forget`: a screen reaches this on a 401, which is a
            session ending under somebody rather than a person leaving. */}
        {screen === 'balances' ? (
          <BalancesPage onSignedOut={ranOut} yearId={yearId} onYears={yearsKnown} />
        ) : null}
        {screen === 'ask' ? <NewRequestPage onSignedOut={ranOut} /> : null}
        {screen === 'requests' ? <RequestsPage onSignedOut={ranOut} /> : null}
        {screen === 'calendar' ? (
          <CalendarPage onSignedOut={ranOut} yearId={yearId} onYears={yearsKnown} />
        ) : null}
        {screen === 'approvals' ? <ApprovalsPage onSignedOut={ranOut} /> : null}
        {screen === 'hr' ? <HrSettingsPage sections={sections} /> : null}
        {screen === 'leave-types' ? <LeaveTypesPage onSignedOut={ranOut} /> : null}
        {screen === 'entitlements' ? <EntitlementRulesPage onSignedOut={ranOut} /> : null}
        {screen === 'approval-chains' ? <ApprovalChainsPage onSignedOut={ranOut} /> : null}
        {screen === 'holidays' ? <HolidaysPage onSignedOut={ranOut} /> : null}
        {screen === 'policy' ? <PolicySettingsPage onSignedOut={ranOut} /> : null}
        {screen === 'adjustments' ? <BalanceAdjustmentsPage onSignedOut={ranOut} /> : null}
        {screen === 'leavers' ? <LeaversPage onSignedOut={ranOut} /> : null}
        {screen === 'reports' ? <ReportsPage onSignedOut={ranOut} /> : null}
        {screen === 'email-wording' ? <EmailWordingPage onSignedOut={ranOut} /> : null}
        {screen === 'audit' ? <AuditLogPage onSignedOut={ranOut} /> : null}
      </div>
    </div>
  );
}

/** The two letters in the circle. LMS 409. `aria-hidden`; the name is beside it. */
function initialsOf(me: Me): string {
  return `${me.firstName.charAt(0)}${me.lastName.charAt(0)}`.toUpperCase();
}

/**
 * Which screen the address bar is asking for. LMS 403.
 *
 * LMS 401 left the router out — "worth making when there is more than one place to go" — and
 * LMS 402 named the moment it would be needed: *the story that adds a third screen brings the
 * router*. This is that story, so here it is, and it is deliberately not a dependency.
 *
 * What a router buys is **addresses**: a link somebody can send, a bookmark, and a back button
 * that moves between screens instead of leaving the application. Three static screens with no
 * parameters and no nesting need the address and nothing else a routing library sells — no
 * loaders, no outlets, no route objects — and `react-router` is fifteen kilobytes and a set of
 * conventions to buy a `hashchange` listener with.
 *
 * **The hash rather than a path**, because a path needs the server to answer every URL with
 * `index.html` and nothing in `server/src/http/app.ts` does: a reload on `/requests` today
 * would hit the API's 404 rather than the application. The hash never reaches the server. When
 * the deployment grows a static file server that falls back to `index.html`, this becomes the
 * History API and the rest of the file does not change.
 *
 * `useSyncExternalStore` rather than an effect and a `useState`, because the hash is exactly
 * what it is for: a value owned outside React that changes without React being told. An effect
 * would render one frame of the old screen after the back button.
 */
function useScreen(): Screen {
  return useSyncExternalStore(subscribeToTheAddress, screenInTheAddress, () => DEFAULT_SCREEN);
}

function subscribeToTheAddress(changed: () => void): () => void {
  window.addEventListener('hashchange', changed);

  return () => {
    window.removeEventListener('hashchange', changed);
  };
}

/**
 * The screen named in the address bar, or the default.
 *
 * An unknown hash falls back rather than showing nothing, because the addresses in it are
 * typed by people and pasted into chat windows. A stale link to a screen that has been renamed
 * should land somewhere useful, and a blank page with a good URL is the worst of both.
 *
 * A section's own address still works, which is what keeps every link sent before the rail
 * was grouped. Whether it answers anything is the screen's policy, not this.
 */
function screenInTheAddress(): Screen {
  const named = window.location.hash.replace(/^#\/?/, '');

  return LABELS.has(named) ? (named as Screen) : DEFAULT_SCREEN;
}
