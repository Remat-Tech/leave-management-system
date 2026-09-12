import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentSession, type Me, signOut, type Year } from './api';
import { ApprovalsPage } from './features/approvals/ApprovalsPage';
import { AuditLogPage } from './features/audit/AuditLogPage';
import { BalancesPage } from './features/balances/BalancesPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { ApprovalChainsPage } from './features/config/ApprovalChainsPage';
import { BalanceAdjustmentsPage } from './features/config/BalanceAdjustmentsPage';
import { EmailWordingPage } from './features/config/EmailWordingPage';
import { EntitlementRulesPage } from './features/config/EntitlementRulesPage';
import { HolidaysPage } from './features/config/HolidaysPage';
import { LeaversPage } from './features/config/LeaversPage';
import { LeaveTypesPage } from './features/config/LeaveTypesPage';
import { PolicySettingsPage } from './features/config/PolicySettingsPage';
import { NewRequestPage } from './features/requests/NewRequestPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { SignIn } from './features/session/SignIn';
import { Icon } from './Icon';

/** The application, and the places there are to go. LMS 401 to LMS 406, LMS 409. */

/**
 * The places there are to go, and the labels on them.
 *
 * In the order somebody uses them rather than the order they were built: what you have, then
 * asking for some, then what became of what you asked for, then what is waiting on you.
 *
 * **"Waiting on me" is offered to everybody**, which looks like an omission and is not.
 * Whether somebody staffs an approver desk turns on a reporting line, an HR role and FR 04's
 * seat, and `integration/balances-api.test.ts` pins the fields of `/api/me` so that no
 * `canApprove` ever appears there — "a screen that knew its own roles would start deciding
 * what to draw from them, and the day the two disagree the server is right and the page has
 * been lying". So the tab is a link like the others, and somebody who approves nothing gets
 * the server's own sentence saying what an approver is. FR 40, NFR USA 03.
 *
 * **"My team" is not a tab any more.** LMS 409. It drew the same calendar as "Who is away"
 * over different people. What was only on it, FR 55 and FR 56, is on "Who is away" now.
 */
const SCREENS = [
  { id: 'balances', label: 'My balances', icon: 'balances' },
  { id: 'ask', label: 'Ask for leave', icon: 'ask' },
  { id: 'requests', label: 'My requests', icon: 'requests' },
  /** FR 55, FR 56, FR 57, LMS 406, LMS 409. Everybody's, scoped to a department. */
  { id: 'calendar', label: 'Who is away', icon: 'calendar' },
  { id: 'approvals', label: 'Waiting on me', icon: 'approvals' },
  /**
   * FR 31, FR 32, LMS 501. Setting the kinds of leave up.
   *
   * Offered to everybody, for the reason "Waiting on me" is: reading a leave type is open to
   * anybody signed in, and every button on the screen is refused for anybody but an HR
   * Administrator with the server's own sentence. A tab hidden on this page's idea of
   * somebody's roles would be a second answer to a question the server owns.
   */
  { id: 'leave-types', label: 'Leave types', icon: 'settings' },
  /**
   * FR 31, LMS 502. What each of those types is worth, and from when.
   *
   * Its own screen rather than a panel on the one above, because it is a different kind of
   * record: a leave type is edited in place, and an entitlement figure is never edited at
   * all — it is superseded by a rule from a later date, and both stay.
   *
   * Offered to everybody for the reason the tab above is, though this one's *reading* is HR's:
   * the rules include personal arrangements, and somebody without the standing gets the
   * server's own sentence rather than a tab that quietly is not there.
   */
  { id: 'entitlements', label: 'Entitlements', icon: 'balances' },
  /**
   * FR 38a, LMS 503. Who approves each of those types, and in what order.
   *
   * Its own screen rather than a fieldset on "Leave types": a chain is read across types, and
   * that was answerable only by opening each form in turn.
   */
  { id: 'approval-chains', label: 'Approval chains', icon: 'stage' },
  /**
   * FR 22, LMS 504. The days the office is closed, which nobody is charged leave for.
   *
   * Last of the configuration tabs and not beside "Who is away", though both draw dates:
   * that screen is a reading of what people asked for, and this is a record HR keeps. Its
   * *reading* is everybody's — a holiday is what a leave quote is priced against — and the
   * writes are HR's, refused with the server's own sentence.
   */
  { id: 'holidays', label: 'Holidays', icon: 'holiday' },
  /**
   * FR 44, FR 48c, NFR SEC 06, LMS 505. What the system does for everybody.
   *
   * Last of the configuration tabs: these are set once and revisited when the policy changes,
   * where the four above are kept.
   */
  { id: 'policy', label: 'Policy', icon: 'settings' },
  /**
   * FR 37, FR 27, LMS 506. Putting one person's figures right.
   *
   * Last, and not beside "Entitlements" though both are about what somebody is owed: the five
   * above are rules that apply to everybody, and this is one correction to one balance. It is
   * the only configuration screen that writes a movement rather than a setting.
   *
   * Offered to everybody for the reason the others are. Its reading is HR's and a manager's and
   * the person's own; the button is an HR Administrator's, refused with the server's sentence.
   */
  { id: 'adjustments', label: 'Adjustments', icon: 'pencil' },
  /**
   * FR 37a, §8.6d, §8.7, LMS 509. What somebody who has left is owed.
   *
   * Beside "Adjustments" rather than beside "My balances": both are about one person's
   * figures rather than about a rule, and this is the one a final payment is checked against.
   * Its reading is the balance's — theirs, their manager's and HR's — and it writes nothing.
   */
  { id: 'leavers', label: 'Leavers', icon: 'people' },
  /** FR 63, LMS 510. HR's reports on leave across the company. */
  { id: 'reports', label: 'Reports', icon: 'report' },
  /** FR 61, LMS 512. The words the system's emails go out in. */
  { id: 'email-wording', label: 'Email wording', icon: 'send' },
  /** NFR AUD 01, LMS 513. Who changed what. HR Administrators and System Administrators. */
  { id: 'audit', label: 'Audit log', icon: 'history' },
] as const;

type Screen = (typeof SCREENS)[number]['id'];

/** The screens a leave year decides the contents of, and so the ones the picker appears on. */
const YEAR_SCOPED = new Set<Screen>(['balances', 'calendar']);

const DEFAULT_SCREEN: Screen = 'balances';

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
      .then((who) => {
        setMe(who);
        setEnded(undefined);
      })
      .catch(() => {
        setMe(undefined);
      })
      .finally(() => {
        setAsked(true);
      });
  }, []);

  useEffect(ask, [ask]);

  /** Signing out on purpose. Nothing went wrong, so nothing is said. */
  const forget = useCallback(() => {
    setMe(undefined);
    setEnded(undefined);
  }, []);

  /** LMS 410. What every screen calls on a 401. Not the same act as signing out. */
  const ranOut = useCallback(() => {
    setMe(undefined);
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

  const here = SCREENS.find((one) => one.id === screen) ?? SCREENS[0];

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
          {SCREENS.map((one) => (
            <a
              key={one.id}
              href={`#/${one.id}`}
              className="screen-tab"
              aria-current={screen === one.id ? 'page' : undefined}
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
            <h1>{here.label}</h1>

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
 */
function screenInTheAddress(): Screen {
  const named = window.location.hash.replace(/^#\/?/, '');

  return SCREENS.some((one) => one.id === named) ? (named as Screen) : DEFAULT_SCREEN;
}
