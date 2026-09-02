import { useCallback, useEffect, useState } from 'react';
import { currentSession, type Me, signOut } from './api';
import { BalancesPage } from './features/balances/BalancesPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { SignIn } from './features/session/SignIn';

/**
 * The application. LMS 401, LMS 402.
 *
 * Two screens now, with the sign in in front of them: what somebody has left, and what became
 * of what they asked for.
 *
 * ## Still no router, and this is the point at which that becomes a decision
 *
 * LMS 401 said there was none "deliberately: LMS 402 onwards add history, the team calendar
 * and the request form, and how this application navigates is a decision worth making when
 * there is more than one place to go rather than now, on the strength of one."
 *
 * There are now two places to go and it is still not that decision, because two is not where
 * the argument turns. What a router buys is **addresses** — a link to a colleague, a bookmark
 * on a screen somebody checks weekly, and the browser's own back button — and every one of
 * those is worth having. What it costs is a dependency and a URL scheme chosen before the team
 * calendar and the request form have said what they need to be able to link to. A request form
 * that opens on a leave type, or a history that deep links to one request, would both want to
 * be in that scheme, and neither exists.
 *
 * So {@link Screen} is a `useState` and the cost is named rather than hidden: **you cannot
 * link to either screen, and the back button leaves the application.** The story that adds a
 * third screen brings the router, and this state is the two lines it replaces.
 *
 * ## Whether somebody is signed in is a question, not a stored fact
 *
 * {@link currentSession} on load, and nothing in `localStorage`. The session is an `HttpOnly`
 * cookie, which this code cannot read by design, so the only honest way to know whether it is
 * still good is to ask — and the answer accounts for everything a stored flag could not: a
 * cookie that has expired, an account that has been closed, somebody whose employment ended
 * this morning. `server/src/routes/identify.ts` re-reads all three on every request, which is
 * what makes asking worth anything.
 *
 * A flag would be a client that believes it is signed in and gets a 401 on every request,
 * which is the state where a person sees an error rather than a sign in form.
 *
 * ## And a 401 anywhere sends you back here
 *
 * Both screens report one rather than rendering it as a refusal, because a session that ran
 * out while somebody was reading is not an error about balances or about history — it is the
 * ordinary end of a working day, and the answer to it is the sign in form.
 */

/**
 * The places there are to go, and the labels on them.
 *
 * A list rather than two buttons written out, so that the nav below is a `map` and the third
 * screen is a line here. The order is the order they are offered in.
 */
const SCREENS = [
  { id: 'balances', label: 'My balances' },
  { id: 'requests', label: 'My requests' },
] as const;

type Screen = (typeof SCREENS)[number]['id'];

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [asked, setAsked] = useState(false);
  const [screen, setScreen] = useState<Screen>('balances');

  const ask = useCallback(() => {
    currentSession()
      .then(setMe)
      /* Not signed in, which is the ordinary state of a browser rather than a failure.
         Anything else — the server down, a proxy misbehaving — lands in the same place,
         and the sign in form is the right screen for both: one of them is fixed by
         signing in, and the other says so as soon as they try. */
      .catch(() => {
        setMe(undefined);
      })
      .finally(() => {
        setAsked(true);
      });
  }, []);

  useEffect(ask, [ask]);

  const forget = useCallback(() => {
    setMe(undefined);
  }, []);

  /* Nothing at all until the first answer, rather than the sign in form. Showing it and
     replacing it a moment later makes a signed-in person flash past a screen telling them
     they are not. */
  if (!asked) {
    return null;
  }

  if (me === undefined) {
    return <SignIn onSignedIn={ask} />;
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <h1>My leave</h1>
            <small>
              {me.firstName} {me.lastName}
            </small>
          </div>

          {/* `<nav>` with `aria-current`, rather than two buttons that only look different.
              Which screen you are on is information, and a screen reader is told it the same
              way a sighted reader is — by the control saying so, not by its colour. */}
          <nav className="screens" aria-label="Sections">
            {SCREENS.map((one) => (
              <button
                key={one.id}
                type="button"
                className="screen-tab"
                aria-current={screen === one.id ? 'page' : undefined}
                onClick={() => {
                  setScreen(one.id);
                }}
              >
                {one.label}
              </button>
            ))}
          </nav>

          <button
            type="button"
            className="linkish"
            onClick={() => {
              /* Cleared here whatever the server said. A sign out that failed and left
                 somebody looking at their own balances is worse than one that cleared the
                 screen and left a cookie to expire on its own. */
              void signOut().finally(forget);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {screen === 'balances' ? (
        <BalancesPage onSignedOut={forget} />
      ) : (
        <RequestsPage onSignedOut={forget} />
      )}
    </>
  );
}
