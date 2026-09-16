import { type FormEvent, useState } from 'react';
import { forgotPassword, resetPasswordWithCode } from '../../api';
import { PasswordInput } from '../../PasswordInput';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * A forgotten password, set again with a code. NFR SEC 01.
 *
 * Two steps on one screen: ask for the code, then type it with the new password. The second
 * step is shown as soon as the first is asked for, because the sentence the server answers
 * with is the same whether or not that address has a login — a screen that only moved on for
 * real addresses would say what the sentence is careful not to.
 *
 * Setting it signs them in. The code proved the mailbox and the password is the one they just
 * chose, which is everything a sign in asks for — sending them back to type it again would be
 * asking twice.
 */
export function ForgottenPassword({
  onSignedIn,
  onDone,
}: {
  onSignedIn: () => void;
  /** Back to the sign in box, without having set anything. */
  onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  function attempt(what: Promise<unknown>, then: (outcome: unknown) => void): void {
    setBusy(true);
    setProblem(undefined);

    what
      .then(then)
      /** The server's own sentence, verbatim. NFR USA 03. */
      .catch((error: unknown) => {
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function askForACode(event: FormEvent): void {
    event.preventDefault();

    attempt(forgotPassword(email), (outcome) => {
      setAsked((outcome as { message: string }).message);
    });
  }

  function setTheNewOne(event: FormEvent): void {
    event.preventDefault();

    attempt(resetPasswordWithCode(email, code, newPassword), onSignedIn);
  }

  return (
    <main className="centred">
      <div className="panel">
        <h1>Forgotten your password</h1>

        {problem === undefined ? null : <Notice problem={problem} />}

        {asked === undefined ? (
          <form onSubmit={askForACode}>
            <p className="muted">
              Type your work address and we will email you a code. It is the same mailbox the system
              already uses to reach you.
            </p>

            <label>
              Work email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                required
              />
            </label>

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form onSubmit={setTheNewOne}>
            <p className="muted">{asked}</p>

            <label>
              Code from the email
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                required
              />
            </label>

            <label>
              New password
              <PasswordInput
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
              />
            </label>

            <p className="muted">
              At least 12 characters. A phrase you will remember beats a short word with a symbol in
              it.
            </p>

            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Set my password'}
            </button>
          </form>
        )}

        <button type="button" className="linkish" onClick={onDone}>
          Back to sign in
        </button>
      </div>
    </main>
  );
}
