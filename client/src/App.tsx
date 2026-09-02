import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { currentSession, type Me, signOut } from './api';
import { BalancesPage } from './features/balances/BalancesPage';
import { NewRequestPage } from './features/requests/NewRequestPage';
import { RequestsPage } from './features/requests/RequestsPage';
import { SignIn } from './features/session/SignIn';

/** The application, and the three places there are to go. LMS 401, LMS 402, LMS 403. */

/**
 * The places there are to go, and the labels on them.
 *
 * In the order somebody uses them rather than the order they were built: what you have, then
 * asking for some, then what became of what you asked for.
 */
const SCREENS = [
  { id: 'balances', label: 'My balances' },
  { id: 'ask', label: 'Ask for leave' },
  { id: 'requests', label: 'My requests' },
] as const;

type Screen = (typeof SCREENS)[number]['id'];

const DEFAULT_SCREEN: Screen = 'balances';

export function App() {
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [asked, setAsked] = useState(false);

  const screen = useScreen();

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

          {/* Anchors rather than buttons, which is the whole of what the router buys: a tab
              can be middle clicked, copied, bookmarked and gone back from, and none of that
              is behaviour this file has to write. */}
          <nav className="screens" aria-label="Sections">
            {SCREENS.map((one) => (
              <a
                key={one.id}
                href={`#/${one.id}`}
                className="screen-tab"
                aria-current={screen === one.id ? 'page' : undefined}
              >
                {one.label}
              </a>
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

      {screen === 'balances' ? <BalancesPage onSignedOut={forget} /> : null}
      {screen === 'ask' ? <NewRequestPage onSignedOut={forget} /> : null}
      {screen === 'requests' ? <RequestsPage onSignedOut={forget} /> : null}
    </>
  );
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
