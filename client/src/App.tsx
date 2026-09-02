import { useCallback, useEffect, useState } from 'react';
import { currentSession, type Me, signOut } from './api';
import { BalancesPage } from './features/balances/BalancesPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { SignIn } from './features/session/SignIn';

/** The application. LMS 401, LMS 402. */

/** The places there are to go, and the labels on them. */
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

          {}
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
