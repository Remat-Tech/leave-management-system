import { type FormEvent, useState } from 'react';
import { type CodeSent, signIn, submitCode } from '../../api';

/**
 * Signing in. LMS 109 and LMS 110, as a screen.
 *
 * Two steps, and this component holds which one it is on. That is the only state it has,
 * and the shape of it is not this file's choice: `SignInOutcome` on the server is a union
 * for exactly this reason — "a caller that treats the second as the first has let somebody
 * past a factor" — so the branch here is the same branch, in the same shape, one layer up.
 *
 * ## Nothing about authentication is decided here
 *
 * Whether a code is needed is the server's, from the roles on the account. Whether the
 * address is a company one is the server's. Whether the password is right is obviously the
 * server's. This form collects two strings, posts them, and renders what comes back —
 * which is why there is no validation in it beyond the browser's own `type="email"` and
 * `required`.
 *
 * In particular there is no message here that distinguishes "no such account" from "wrong
 * password". The server sends one sentence for both on purpose, so that a sign in form is
 * not a directory of who works at this company, and this shows whatever it is sent.
 *
 * ## The password never goes anywhere but the request
 *
 * Not into `localStorage`, not into a URL, not into any state that outlives the submit.
 * It is cleared once the request has been made, so a browser extension or a devtools
 * snapshot taken a second later has nothing to find.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<CodeSent | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function attempt(what: Promise<unknown>, onDone: (outcome: unknown) => void): void {
    setBusy(true);
    setProblem(undefined);

    what
      .then(onDone)
      /* The server's own sentence, verbatim. NFR USA 03 — every refusal in this system was
         written to say what to do about it, and substituting a friendlier one loses that. */
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : 'Something went wrong.');
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function submitPassword(event: FormEvent): void {
    event.preventDefault();

    const attempted = password;
    /* Out of state as soon as it is in the request, and before the answer comes back. */
    setPassword('');

    attempt(signIn(email, attempted), (outcome) => {
      if ((outcome as CodeSent).status === 'CODE_SENT') {
        setSent(outcome as CodeSent);
        return;
      }

      onSignedIn();
    });
  }

  function submitTheCode(event: FormEvent): void {
    event.preventDefault();

    attempt(submitCode(email, code), () => {
      onSignedIn();
    });
  }

  if (sent !== undefined) {
    return (
      <main className="centred">
        <div className="panel">
          <h1>Check your email</h1>

          <p className="muted">
            A sign in code has gone to {sent.companyEmail}. It stops working at{' '}
            {new Date(sent.expiresAt).toLocaleTimeString()}.
          </p>

          {problem === undefined ? null : <p className="notice">{problem}</p>}

          <form onSubmit={submitTheCode}>
            <label>
              Sign in code
              <input
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                autoFocus
              />
            </label>

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="centred">
      <div className="panel">
        <h1>Sign in</h1>
        <p className="muted">Use your work email address.</p>

        {problem === undefined ? null : <p className="notice">{problem}</p>}

        <form onSubmit={submitPassword}>
          <label>
            Work email address
            <input
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              autoComplete="username"
              required
              autoFocus
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
              required
            />
          </label>

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
