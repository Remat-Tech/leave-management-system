import { useCallback, useEffect, useState } from 'react';
import { currentSession, signOut } from './api';
import { BalancesPage } from './features/balances/BalancesPage';
import { SignIn } from './features/session/SignIn';

/**
 * The application. LMS 401.
 *
 * One screen, with the sign in in front of it, which is the whole of Phase 4's first
 * story. There is no router yet, deliberately: LMS 402 onwards add history, the team
 * calendar and the request form, and how this application navigates is a decision worth
 * making when there is more than one place to go rather than now, on the strength of one.
 *
 * ## Whether somebody is signed in is a question, not a stored fact
 *
 * {@link currentSession} on load, and nothing in `localStorage`. The session is an
 * `HttpOnly` cookie, which this code cannot read by design, so the only honest way to know
 * whether it is still good is to ask — and the answer accounts for everything a stored
 * flag could not: a cookie that has expired, an account that has been closed, somebody
 * whose employment ended this morning. `server/src/routes/identify.ts` re-reads all three
 * on every request, which is what makes asking worth anything.
 *
 * A flag would be a client that believes it is signed in and gets a 401 on every request,
 * which is the state where a person sees an error rather than a sign in form.
 *
 * ## And a 401 anywhere sends you back here
 *
 * {@link BalancesPage} reports one rather than rendering it as a refusal, because a session
 * that ran out while somebody was reading is not an error about balances — it is the
 * ordinary end of a working day, and the answer to it is the sign in form.
 */
export function App() {
  const [employeeId, setEmployeeId] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState(false);

  const ask = useCallback(() => {
    currentSession()
      .then((me) => {
        setEmployeeId(me.employeeId);
      })
      /* Not signed in, which is the ordinary state of a browser rather than a failure.
         Anything else — the server down, a proxy misbehaving — lands in the same place,
         and the sign in form is the right screen for both: one of them is fixed by
         signing in, and the other says so as soon as they try. */
      .catch(() => {
        setEmployeeId(undefined);
      })
      .finally(() => {
        setAsked(true);
      });
  }, []);

  useEffect(ask, [ask]);

  const forget = useCallback(() => {
    setEmployeeId(undefined);
  }, []);

  /* Nothing at all until the first answer, rather than the sign in form. Showing it and
     replacing it a moment later makes a signed-in person flash past a screen telling them
     they are not. */
  if (!asked) {
    return null;
  }

  if (employeeId === undefined) {
    return <SignIn onSignedIn={ask} />;
  }

  return (
    <>
      <header className="bar">
        <h1>My leave</h1>

        <button
          type="button"
          onClick={() => {
            /* Cleared here whatever the server said. A sign out that failed and left
               somebody looking at their own balances is worse than one that cleared the
               screen and left a cookie to expire on its own. */
            void signOut().finally(forget);
          }}
        >
          Sign out
        </button>
      </header>

      <BalancesPage onSignedOut={forget} />
    </>
  );
}
