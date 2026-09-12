import { useCallback, useEffect, useState } from 'react';
import {
  type Attachment,
  type Attachments,
  attachmentsOn,
  discardEvidence,
  type EvidenceWaiting,
  evidenceWaiting,
  fetchAttachment,
  holdEvidence,
  isNotSignedIn,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
  rescanEvidence,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Uploading a certificate, and reading one back. FR 12, FR 13, NFR SEC 04, NFR SEC 07. LMS 407.
 *
 * Two components, and they are the two halves of the story:
 *
 *   **{@link Evidence}** goes on the request form, because that is where somebody has the
 *   document in front of them. FR 13 is answered at submission, so the file is uploaded
 *   *before* the request exists and named as the request is asked for — the server puts the
 *   two together in one transaction.
 *
 *   **{@link AttachedFiles}** is the other end: an approver, or the person themselves,
 *   opening what is on a request. Every open goes through a link minted for that person and
 *   spent by the first fetch, so nothing here ever holds an address for a medical
 *   certificate — which is the whole of "never publicly addressable".
 *
 * Neither of them decides who may see anything. The server refuses, and what it says is what
 * is shown. NFR USA 03.
 */

/* ------------------------------------------------- reading what is on a request */

/**
 * What is attached to a request, and a way to open each file.
 *
 * Behind a disclosure rather than open on the card, and that is the story rather than
 * tidiness: a list of filenames is itself information about somebody's health, and a
 * colleague glancing at a screen should not read "oncology-referral.pdf" without anybody
 * having decided to open anything.
 */
export function AttachedFiles({
  requestId,
  onSignedOut,
}: {
  requestId: string;
  onSignedOut: () => void;
}) {
  const [held, setHeld] = useState<Attachments | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [opened, setOpened] = useState(false);

  const look = useCallback(() => {
    attachmentsOn(requestId)
      .then((next) => {
        setHeld(next);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setProblem(problemFrom(error));
      });
  }, [requestId, onSignedOut]);

  useEffect(() => {
    if (opened) {
      look();
    }
  }, [opened, look]);

  return (
    <details
      className="attachments"
      onToggle={(event) => {
        setOpened(event.currentTarget.open);
      }}
    >
      <summary>
        Attachments
        {held === undefined ? '' : ` (${String(held.attachments.length)})`}
      </summary>

      {problem === undefined ? null : <Notice problem={problem} onRetry={look} />}

      {held === undefined ? (
        problem === undefined ? (
          <p className="muted">Looking…</p>
        ) : null
      ) : (
        <>
          <p className="muted">{held.evidence.inWords}</p>

          <ul className="files">
            {held.attachments.map((attachment) => (
              <FileOnARequest
                key={attachment.attachmentId}
                requestId={requestId}
                attachment={attachment}
                onSignedOut={onSignedOut}
              />
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

/** One file on a request, with the two calls it takes to open it. NFR SEC 04, LMS 407. */
function FileOnARequest({
  requestId,
  attachment,
  onSignedOut,
}: {
  requestId: string;
  attachment: Attachment;
  onSignedOut: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);

  const open = useCallback(() => {
    setOpening(true);
    setRefusal(undefined);

    fetchAttachment(requestId, attachment.attachmentId)
      .then(save)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setRefusal(problemFrom(error));
      })
      .finally(() => {
        setOpening(false);
      });
  }, [requestId, attachment.attachmentId, onSignedOut]);

  return (
    <li className="file">
      <span className="file-name">{attachment.filename}</span>
      <span className="muted">{megabytes(attachment.sizeBytes)}</span>

      {attachment.downloadable ? (
        <button type="button" className="linkish" disabled={opening} onClick={open}>
          {opening ? 'Fetching…' : 'Download'}
        </button>
      ) : attachment.fileDeletedAt !== null ? (
        /* NFR SEC 06, LMS 514. The name stays; the file is gone. */
        <span className="tag">File deleted after the retention period</span>
      ) : (
        /* NFR SEC 07. Greyed off `downloadable`, which the server decides. A screen that
           worked out for itself whether a scan had passed would be a second copy of a rule
           that has to have one. */
        <span className="tag flag">Being checked for viruses</span>
      )}

      {/* NFR SEC 04, LMS 407. A link is meant to stop working, so the retry is the whole
          answer here: pressing Download again mints a new one. */}
      {refusal === undefined ? null : (
        <Notice problem={refusal} retrying={opening} onRetry={open} />
      )}
    </li>
  );
}

/* ------------------------------------------------ uploading before there is a request */

/**
 * Certificates uploaded ahead of the request they will go on. FR 13, LMS 311, LMS 407.
 *
 * The ids of the files that count are handed up as they change, and the form sends them with
 * the request. Nothing here decides whether one is *needed* — `DOCUMENTATION_REQUIRED` on
 * the quote says that, and the server refuses a request that arrives without one either way.
 */
export function Evidence({
  disabled,
  onChange,
  onSignedOut,
}: {
  disabled: boolean;
  /** Every file waiting, whether or not it has been scanned yet. */
  onChange: (attachmentIds: string[]) => void;
  onSignedOut: () => void;
}) {
  const [waiting, setWaiting] = useState<EvidenceWaiting | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  /** One place the answer lands, so the ids the form sends and the list drawn agree. */
  const took = useCallback(
    (next: EvidenceWaiting) => {
      setWaiting(next);
      setProblem(undefined);
      onChange(next.attachments.map((attachment) => attachment.attachmentId));
    },
    [onChange],
  );

  const failed = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }

      /** The server's own sentence, verbatim — it names the fix. NFR USA 03, LMS 410. */
      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  const read = useCallback(() => {
    evidenceWaiting().then(took).catch(failed);
  }, [took, failed]);

  useEffect(read, [read]);

  /** Uploads, then re-reads: what is waiting is the server's answer, not a list kept here. */
  const upload = useCallback(
    (file: File) => {
      setBusy(true);

      holdEvidence(file)
        .then(() => evidenceWaiting())
        .then(took)
        .catch(failed)
        .finally(() => {
          setBusy(false);
        });
    },
    [took, failed],
  );

  const act = useCallback(
    (work: Promise<unknown>) => {
      setBusy(true);

      work
        .then(() => evidenceWaiting())
        .then(took)
        .catch(failed)
        .finally(() => {
          setBusy(false);
        });
    },
    [took, failed],
  );

  const held = waiting?.attachments ?? [];

  return (
    <div className="evidence">
      {/* LMS 409. A drop zone rather than a bare button, and the input is the zone rather than
          something beside it: a file input already accepts a dropped file, so stretching one
          over the box buys real drag and drop without a drag handler to keep correct. */}
      <label className="dropzone">
        <input
          type="file"
          disabled={disabled || busy || held.length >= MAX_ATTACHMENTS_PER_REQUEST}
          accept=".pdf,.jpg,.jpeg,.png,.docx"
          onChange={(event) => {
            const file = event.target.files?.[0];

            /* Cleared so that the same file can be chosen again after a refusal — a file
               input fires nothing when the value has not changed. */
            event.target.value = '';

            if (file !== undefined) {
              upload(file);
            }
          }}
        />

        <span className="dropzone-mark" aria-hidden="true">
          <Icon name="upload" />
        </span>

        <span className="dropzone-said">
          <strong>{busy ? 'Uploading…' : 'Drop a file here, or click to choose one'}</strong>
          {/* FR 12. The caps, said before somebody picks a file rather than after. The server
              holds both, and `accept` narrows the picker and enforces nothing: what a file
              is, is read from the bytes. NFR SEC 07. */}
          <small>
            PDF, JPG, PNG or DOCX, up to {megabytes(MAX_ATTACHMENT_BYTES)} each and{' '}
            {MAX_ATTACHMENTS_PER_REQUEST} in all.
          </small>
        </span>
      </label>

      {/* LMS 410. Offered only while nothing has been read at all — after a failed upload the
          fix is the dropzone above, and a button re-reading a list would point at the wrong act. */}
      {problem === undefined ? null : (
        <Notice
          problem={problem}
          retrying={busy}
          onRetry={waiting === undefined ? read : undefined}
        />
      )}

      {held.length === 0 ? null : (
        <>
          <ul className="files">
            {held.map((attachment) => (
              <li key={attachment.attachmentId} className="file">
                <span className="file-name">{attachment.filename}</span>
                <span className="muted">{megabytes(attachment.sizeBytes)}</span>

                {/* NFR SEC 07. A file nothing has looked at satisfies no rule, so it says so
                    here rather than at the moment somebody presses submit. */}
                {attachment.scanStatus === 'PENDING' ? (
                  <button
                    type="button"
                    className="linkish"
                    disabled={busy}
                    onClick={() => {
                      act(rescanEvidence(attachment.attachmentId));
                    }}
                  >
                    Check again
                  </button>
                ) : null}

                <button
                  type="button"
                  className="linkish"
                  disabled={busy}
                  onClick={() => {
                    act(discardEvidence(attachment.attachmentId));
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {/* FR 13, NFR SEC 07. How much of it counts, in the server's words. */}
          <p className="muted">{waiting?.inWords}</p>
        </>
      )}
    </div>
  );
}

/**
 * Hands the bytes to the browser to save. NFR SEC 04.
 *
 * An object URL and a click, because the response was fetched rather than navigated to —
 * and revoked immediately, so the only copy of the file that outlives this function is the
 * one the person chose to keep.
 */
function save({ blob, filename }: { blob: Blob; filename: string }): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
