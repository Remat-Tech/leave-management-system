import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  type EmailWording,
  emailWording,
  type EmailWordingPage as Page,
  isNotSignedIn,
  previewEmail,
  putBackEmailWording,
  rewordEmail,
  type Wording,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/** The wording of every email the system sends, kept by HR. FR 61, LMS 512. */
export function EmailWordingPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [page, setPage] = useState<Page | undefined>(undefined);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);

    emailWording()
      .then((next) => {
        setPage(next);
        setChosen((was) => was ?? next.emails[0]?.name);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [onSignedOut]);

  useEffect(load, [load]);

  if (page === undefined) {
    return (
      <div className="page">
        {problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}
      </div>
    );
  }

  const email = page.emails.find((one) => one.name === chosen) ?? page.emails[0];

  const saved = (next: EmailWording) => {
    setPage({
      ...page,
      emails: page.emails.map((one) => (one.name === next.name ? next : one)),
    });
  };

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          The words each email goes out in. A change applies to the next email sent; emails already
          sent keep their words.
        </p>
      </div>

      <label className="pick-email">
        Email
        <select
          value={email?.name ?? ''}
          onChange={(event) => {
            setChosen(event.target.value);
          }}
        >
          {page.emails.map((one) => (
            <option key={one.name} value={one.name}>
              {one.label}, to {one.readBy}
              {one.isReworded ? ' (reworded)' : ''}
            </option>
          ))}
        </select>
      </label>

      {email === undefined ? null : (
        <WordingForm
          key={`${email.name} ${email.updatedAt ?? 'original'}`}
          email={email}
          longestSubject={page.longestSubject}
          longestBody={page.longestBody}
          onSaved={saved}
          onSignedOut={onSignedOut}
        />
      )}
    </div>
  );
}

/** One email's subject and message, its placeholders, and a preview. */
function WordingForm({
  email,
  longestSubject,
  longestBody,
  onSaved,
  onSignedOut,
}: {
  email: EmailWording;
  longestSubject: number;
  longestBody: number;
  onSaved: (email: EmailWording) => void;
  onSignedOut: () => void;
}) {
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body);
  const [preview, setPreview] = useState<Wording | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);

  const subjectBox = useRef<HTMLInputElement | null>(null);
  const bodyBox = useRef<HTMLTextAreaElement | null>(null);
  /** Where a placeholder goes: the box last typed in. */
  const lastFocused = useRef<'subject' | 'body'>('body');

  const dirty = subject !== email.subject || body !== email.body;

  function run<T>(call: Promise<T>, done: (answer: T) => void): void {
    setBusy(true);
    setRefusal(undefined);

    call
      .then(done)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setRefusal(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function insert(placeholder: string): void {
    const text = `{{${placeholder}}}`;
    const inSubject = lastFocused.current === 'subject';
    const box = inSubject ? subjectBox.current : bodyBox.current;
    const value = inSubject ? subject : body;
    const start = box?.selectionStart ?? value.length;
    const end = box?.selectionEnd ?? start;
    const next = value.slice(0, start) + text + value.slice(end);

    if (inSubject) {
      setSubject(next);
    } else {
      setBody(next);
    }

    requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="send" />
        </span>
        {email.label}
        <span className="muted">to {email.readBy}</span>
      </h2>

      <form
        className="policy wording"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          run(rewordEmail(email.name, { subject, body }), onSaved);
        }}
      >
        {refusal === undefined ? null : <Notice problem={refusal} />}

        <label>
          Subject line
          <input
            ref={subjectBox}
            value={subject}
            maxLength={longestSubject}
            disabled={busy}
            aria-invalid={refusal?.field === 'subject'}
            onFocus={() => {
              lastFocused.current = 'subject';
            }}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </label>

        <label>
          Message
          <textarea
            ref={bodyBox}
            value={body}
            rows={16}
            maxLength={longestBody}
            disabled={busy}
            aria-invalid={refusal?.field === 'body'}
            onFocus={() => {
              lastFocused.current = 'body';
            }}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <small className="muted">
            A blank line starts a new paragraph. A paragraph that fills in to nothing is left out.
          </small>
        </label>

        <div>
          <p className="rules">
            <Icon name="info" />
            Press one to put it where you were typing. Start it with a capital, as in
            {' {{DecidedBy}}'}, to capitalise what it fills in.
          </p>
          <ul className="placeholders">
            {email.placeholders.map((one) => (
              <li key={one.name}>
                <button
                  type="button"
                  disabled={busy}
                  title={one.meaning}
                  onClick={() => {
                    insert(one.name);
                  }}
                >
                  {`{{${one.name}}}`}
                </button>
                <span className="muted">{one.meaning}</span>
              </li>
            ))}
          </ul>
        </div>

        {preview === undefined ? null : (
          <div className="email-preview" aria-live="polite">
            <p>
              <strong>{preview.subject}</strong>
            </p>
            <pre>{preview.body}</pre>
          </div>
        )}

        <div className="card-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              run(previewEmail(email.name, { subject, body }), setPreview);
            }}
          >
            Preview
          </button>

          {email.isReworded ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                run(putBackEmailWording(email.name), onSaved);
              }}
            >
              Put back the original wording
            </button>
          ) : null}

          <button type="submit" className="primary" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}
