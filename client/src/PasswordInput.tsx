import { useState } from 'react';
import { Icon } from './Icon';

/**
 * A password box that can show what is being typed.
 *
 * One component rather than a toggle written five times, because every place a password is
 * typed should behave the same, and a sixth added later gets it for free.
 *
 * **Hidden until asked**, and back to hidden on nothing but a second press: a password shown
 * by default is a password on the screen of whoever is standing behind the person typing.
 * The button is a real button, labelled for a screen reader, and outside the form's submit —
 * `type="button"` is what stops a press from signing somebody in. NFR USA 03.
 */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  required = true,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  required?: boolean;
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);

  return (
    <span className="password-input">
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        autoComplete={autoComplete}
        /* Nothing a phone should second-guess while it is visible. */
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required={required}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => {
          setShown((was) => !was);
        }}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} />
      </button>
    </span>
  );
}
