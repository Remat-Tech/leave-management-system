import { type FormEvent, useState } from 'react';
import { type CodeSent, signIn, submitCode } from '../../api';
import { Notice, type Problem, problemFrom } from '../../problem';

/** Signing in. LMS 109, LMS 110. */
export function SignIn({
  onSignedIn,
  ended,
}: {
  onSignedIn: () => void;
  /** LMS 410. Why this screen is showing, where nobody asked for it. Undefined on a sign out. */
  ended?: string;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<CodeSent | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function attempt(what: Promise<unknown>, onDone: (outcome: unknown) => void): void {
    setBusy(true);
    setProblem(undefined);

    what
      .then(onDone)
      /** The server's own sentence, verbatim. NFR USA 03, LMS 410. */
      .catch((error: unknown) => {
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function submitPassword(event: FormEvent): void {
    event.preventDefault();

    const attempted = password;
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

          {problem === undefined ? null : <Notice problem={problem} />}

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

        {/* LMS 410. Above the refusal rather than instead of it — a session that ended and a
            password that was wrong are two pieces of news and can both be true. */}
        {ended === undefined ? null : <p className="notice plain">{ended}</p>}

        {problem === undefined ? null : <Notice problem={problem} />}

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
