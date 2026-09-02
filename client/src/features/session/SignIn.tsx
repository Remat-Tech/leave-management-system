import { type FormEvent, useState } from 'react';
import { type CodeSent, signIn, submitCode } from '../../api';

/** Signing in. LMS 109, LMS 110. */
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
      /** The server's own sentence, verbatim. NFR USA 03. */
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
