import { useState } from 'react';
import { changeMyPassword, isNotSignedIn } from '../../api';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Replacing a password somebody else set. NFR SEC 01.
 *
 * Shown instead of the application rather than beside it, because until this is done the
 * server refuses every other route: a rail whose tabs all answer 403 would be a worse way of
 * saying the same thing.
 *
 * The current password is asked for even though they have just typed it at the sign in box.
 * A session left open on an unlocked laptop is not authority to take the account over, and it
 * costs nothing to somebody who is actually them.
 */
export function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const mismatched = again.length > 0 && newPassword !== again;

  return (
    <main className="centred">
      <div className="panel">
        <h1>Choose a new password</h1>

        <p className="muted">
          Your password was set for you, so somebody else knows it. Pick one only you know before
          you carry on.
        </p>

        {problem === undefined ? null : <Notice problem={problem} />}

        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (mismatched) {
              return;
            }

            setSaving(true);
            setProblem(undefined);

            changeMyPassword(currentPassword, newPassword)
              .then(onChanged)
              .catch((error: unknown) => {
                // Signed out mid-change: the sign in box says so, and nothing here can.
                setProblem(isNotSignedIn(error) ? undefined : problemFrom(error));
              })
              .finally(() => {
                setSaving(false);
              });
          }}
        >
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
              required
            />
          </label>

          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
              required
            />
          </label>

          <label>
            New password again
            <input
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(event) => {
                setAgain(event.target.value);
              }}
              required
            />
          </label>

          {/* Said here rather than as a refusal from the server, which never sees the second box. */}
          {mismatched ? <p className="muted">The two do not match.</p> : null}

          <p className="muted">
            At least 12 characters. Length is what makes a password hard to guess, so a phrase you
            will remember beats a short word with a symbol in it.
          </p>

          <button type="submit" className="primary" disabled={saving || mismatched}>
            {saving ? 'Saving…' : 'Change my password'}
          </button>
        </form>
      </div>
    </main>
  );
}
