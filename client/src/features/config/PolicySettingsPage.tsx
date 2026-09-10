import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  changePolicySettings,
  editLeaveType,
  isNotSignedIn,
  type LeaveWindow,
  nameChiefExecutive,
  type Nameable,
  type PolicySettings,
  type PolicySettingsPage as Page,
  policySettings,
} from '../../api';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * The settings that are about the company rather than a type, a year or a person.
 * FR 44, FR 48c, NFR SEC 06, LMS 505.
 *
 * The override rule, the `CEO` desk, the notice and back-dating windows, and how long a
 * certificate is kept. One screen because they are read together: "does any type ask for
 * notice" was answerable only by opening seven forms in turn.
 *
 * Drawn for everybody; every write is refused for anybody but an HR Administrator, with the
 * server's own sentence.
 */
export function PolicySettingsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [page, setPage] = useState<Page | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const answer = useCallback(
    (error: unknown) => {
      if (isNotSignedIn(error)) {
        onSignedOut();
        return;
      }

      setProblem(problemFrom(error));
    },
    [onSignedOut],
  );

  const load = useCallback(() => {
    setLoading(true);

    policySettings()
      .then((next) => {
        setPage(next);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(load, [load]);

  if (page === undefined) {
    return (
      <div className="page">
        {loading ? (
          <Skeletons />
        ) : problem === undefined ? null : (
          <Notice problem={problem} retrying={loading} onRetry={load} />
        )}
      </div>
    );
  }

  /** Each panel writes through its own door, so each keeps its own answer. */
  const settingsChanged = (settings: PolicySettings) => {
    setPage({ ...page, settings });
  };

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          What the system does for everybody, rather than for one kind of leave. Changing any of it
          takes effect on the next request; nothing already decided is reopened.
        </p>
      </div>

      {/* FR 48c. The one setting that has to be answered before go live. */}
      {page.settings.isReadyForGoLive ? null : (
        <p className="notice warning" role="status">
          Nobody is named as the Chief Executive. Unpaid leave and the unpaid maternity extension
          are decided by HR and the Chief Executive, so until somebody is named that stage falls to
          HR and the skip is recorded on every such request.
        </p>
      )}

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      <OverridePanel settings={page.settings} onSaved={settingsChanged} onSignedOut={onSignedOut} />

      <ChiefExecutivePanel
        settings={page.settings}
        employees={page.employees}
        onSaved={settingsChanged}
        onSignedOut={onSignedOut}
      />

      <WindowsPanel windows={page.windows} onSaved={load} onSignedOut={onSignedOut} />

      <RetentionPanel
        settings={page.settings}
        longestMonths={page.longestRetentionMonths}
        onSaved={settingsChanged}
        onSignedOut={onSignedOut}
      />
    </div>
  );
}

/** FR 44. Whether HR may overturn a line manager. */
function OverridePanel({
  settings,
  onSaved,
  onSignedOut,
}: {
  settings: PolicySettings;
  onSaved: (settings: PolicySettings) => void;
  onSignedOut: () => void;
}) {
  const [allowed, setAllowed] = useState(settings.overridesAreAllowed);
  const saving = useSaving(onSignedOut);

  const dirty = allowed !== settings.overridesAreAllowed;

  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="stage" />
        </span>
        Overturning a manager
      </h2>

      <form
        className="policy"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          saving.run(changePolicySettings({ overridesAreAllowed: allowed }), onSaved);
        }}
      >
        {saving.refusal === undefined ? null : <Notice problem={saving.refusal} />}

        <label className="tick">
          <input
            type="checkbox"
            checked={allowed}
            disabled={saving.busy}
            onChange={(event) => {
              setAllowed(event.target.checked);
            }}
          />
          <span>
            <strong>HR may overturn a line manager’s decision</strong>
          </span>
        </label>

        {/* The sentence is the server's for what is saved, and this screen's for what is
            about to be. NFR USA 03. */}
        <p className="rules">
          <Icon name="info" />
          {dirty ? sayTheOverrideRule(allowed) : settings.overrideRuleInWords}
        </p>

        {/* Said before the press: turning it off leaves nothing to do with a request the
            manager already turned down, which is not obvious from the tick. */}
        {dirty && !allowed ? (
          <p className="notice warning" role="status">
            With this off, HR can neither approve leave a manager turned down nor turn down leave a
            manager agreed to. Requests already sitting at HR after a rejection stay there and can
            only be refused in the manager’s direction.
          </p>
        ) : null}

        <div className="card-actions">
          <button type="submit" className="primary" disabled={saving.busy || !dirty}>
            {saving.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** FR 48c. Who the `CEO` desk resolves to. */
function ChiefExecutivePanel({
  settings,
  employees,
  onSaved,
  onSignedOut,
}: {
  settings: PolicySettings;
  employees: Nameable[];
  onSaved: (settings: PolicySettings) => void;
  onSignedOut: () => void;
}) {
  const [chosen, setChosen] = useState(settings.chiefExecutiveId ?? '');
  const saving = useSaving(onSignedOut);

  const dirty = chosen !== (settings.chiefExecutiveId ?? '');
  const leaver = employees.find((one) => one.id === chosen)?.hasLeft ?? false;

  /* Empty for anybody who cannot name one: the server sends the picker only to somebody who
     may use it, so the name is read out rather than drawn as a select with nothing in it. */
  if (employees.length === 0) {
    return (
      <section className="ruleset">
        <h2>
          <span className="chip">
            <Icon name="people" />
          </span>
          The Chief Executive
        </h2>

        <div className="policy">
          <dl className="settings">
            <div>
              <dt>Named</dt>
              <dd>{settings.chiefExecutiveName ?? 'Nobody'}</dd>
            </div>
            <div>
              <dt>Job title</dt>
              <dd>{settings.chiefExecutiveJobTitle ?? 'Not recorded'}</dd>
            </div>
          </dl>

          <p className="rules">
            <Icon name="info" />
            Unpaid leave and the unpaid maternity extension are decided by HR and the Chief
            Executive. Naming somebody else is an HR Administrator’s.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="people" />
        </span>
        The Chief Executive
      </h2>

      <form
        className="policy"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          saving.run(nameChiefExecutive(chosen), onSaved);
        }}
      >
        {saving.refusal === undefined ? null : <Notice problem={saving.refusal} />}

        <label>
          Named by their employee record
          <select
            value={chosen}
            disabled={saving.busy}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            <option value="">Nobody named</option>
            {employees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.jobTitle === null ? '' : `, ${person.jobTitle}`}
                {person.hasLeft ? ' (has left)' : ''}
              </option>
            ))}
          </select>
          <small className="muted">
            A person, not a job title. Retitling the post moves nothing; changing this moves the
            desk for every unpaid request standing at it.
          </small>
        </label>

        {/* FR 06. Said before the press. The server refuses it, and this saves the trip. */}
        {leaver ? (
          <p className="notice warning" role="status">
            They have left the company and cannot sign in to decide anything. Name whoever holds the
            post now.
          </p>
        ) : null}

        {/* The seat is changed, never emptied. */}
        {dirty && chosen === '' ? (
          <p className="notice warning" role="status">
            The setting is changed, never cleared. Unpaid leave is decided by HR and the Chief
            Executive, so an empty seat is a stage no request can be sent to.
          </p>
        ) : null}

        <div className="card-actions">
          <button type="submit" className="primary" disabled={saving.busy || !dirty}>
            {saving.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** FR 17, FR 18. The two windows of every type in use, read down rather than one form at a time. */
function WindowsPanel({
  windows,
  onSaved,
  onSignedOut,
}: {
  windows: LeaveWindow[];
  onSaved: () => void;
  onSignedOut: () => void;
}) {
  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="calendar" />
        </span>
        Notice and back dating
        <span className="muted">{windows.length} types</span>
      </h2>

      <p className="rules">
        <Icon name="info" />
        Short notice warns and is allowed through; the approvers see that it was short. Back dating
        refuses: past the window only HR may enter the leave, with a reason.
      </p>

      <div className="windows">
        <table className="figures-table">
          <thead>
            <tr>
              <th scope="col">Kind of leave</th>
              <th scope="col">Notice expected</th>
              <th scope="col">May be entered late by</th>
              <th scope="col">
                <span className="visually-hidden">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {windows.map((one) => (
              <WindowRow key={one.id} window={one} onSaved={onSaved} onSignedOut={onSignedOut} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One type's two windows, written through the leave type door rather than a second one. */
function WindowRow({
  window: type,
  onSaved,
  onSignedOut,
}: {
  window: LeaveWindow;
  onSaved: () => void;
  onSignedOut: () => void;
}) {
  const [notice, setNotice] = useState(String(type.minNoticeCalendarDays));
  const [backdate, setBackdate] = useState(String(type.maxBackdateCalendarDays));
  const saving = useSaving(onSignedOut);

  const dirty =
    notice !== String(type.minNoticeCalendarDays) ||
    backdate !== String(type.maxBackdateCalendarDays);

  return (
    <>
      <tr>
        <th scope="row">
          {type.name}
          <small>{type.code}</small>
        </th>
        <td>
          <label className="days">
            <span className="visually-hidden">{type.name} notice expected, in calendar days</span>
            <input
              type="number"
              min={0}
              max={365}
              value={notice}
              disabled={saving.busy}
              onChange={(event) => {
                setNotice(event.target.value);
              }}
            />
            days
          </label>
        </td>
        <td>
          <label className="days">
            <span className="visually-hidden">
              {type.name} back dating window, in calendar days
            </span>
            <input
              type="number"
              min={0}
              max={3650}
              value={backdate}
              disabled={saving.busy}
              onChange={(event) => {
                setBackdate(event.target.value);
              }}
            />
            days
          </label>
        </td>
        <td>
          {dirty ? (
            <button
              type="button"
              className="primary"
              disabled={saving.busy}
              onClick={() => {
                saving.run(
                  editLeaveType(type.id, {
                    minNoticeCalendarDays: Number(notice),
                    maxBackdateCalendarDays: Number(backdate),
                  }),
                  onSaved,
                );
              }}
            >
              {saving.busy ? 'Saving…' : 'Save'}
            </button>
          ) : null}
        </td>
      </tr>

      {saving.refusal === undefined ? null : (
        <tr>
          <td colSpan={4}>
            <Notice problem={saving.refusal} />
          </td>
        </tr>
      )}
    </>
  );
}

/** NFR SEC 06. How long a certificate is kept. */
function RetentionPanel({
  settings,
  longestMonths,
  onSaved,
  onSignedOut,
}: {
  settings: PolicySettings;
  longestMonths: number;
  onSaved: (settings: PolicySettings) => void;
  onSignedOut: () => void;
}) {
  const [months, setMonths] = useState(
    settings.attachmentRetentionMonths === null ? '' : String(settings.attachmentRetentionMonths),
  );
  const saving = useSaving(onSignedOut);

  const dirty =
    months !==
    (settings.attachmentRetentionMonths === null ? '' : String(settings.attachmentRetentionMonths));

  return (
    <section className="ruleset">
      <h2>
        <span className="chip">
          <Icon name="clip" />
        </span>
        Keeping certificates
      </h2>

      <form
        className="policy"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          saving.run(
            changePolicySettings({
              attachmentRetentionMonths: months === '' ? null : Number(months),
            }),
            onSaved,
          );
        }}
      >
        {saving.refusal === undefined ? null : <Notice problem={saving.refusal} />}

        <label>
          Kept for
          <select
            value={months}
            disabled={saving.busy}
            onChange={(event) => {
              setMonths(event.target.value);
            }}
          >
            <option value="">Indefinitely</option>
            {retentionChoices(longestMonths).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <small className="muted">
            Counted from the day the request the file is attached to ends. Who opened a certificate
            is logged separately, and that log is kept whatever this says.
          </small>
        </label>

        <p className="rules">
          <Icon name="info" />
          {settings.retentionInWords}
        </p>

        <div className="card-actions">
          <button type="submit" className="primary" disabled={saving.busy || !dirty}>
            {saving.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The windows offered, up to the longest the server accepts. */
const RETENTION_CHOICES: [number, string][] = [
  [6, '6 months'],
  [12, '1 year'],
  [24, '2 years'],
  [36, '3 years'],
  [60, '5 years'],
  [84, '7 years'],
  [120, '10 years'],
];

function retentionChoices(longestMonths: number): [number, string][] {
  return RETENTION_CHOICES.filter(([months]) => months <= longestMonths);
}

/** What this screen says a rule about to be saved will mean. The saved one is the server's. */
function sayTheOverrideRule(allowed: boolean): string {
  return allowed
    ? 'HR will see every request a manager turned down and be able to overturn it, in writing.'
    : 'A line manager’s decision will be the final one. HR can still agree with it.';
}

/** One panel's save: busy while it is in flight, and its own refusal when it comes back. */
function useSaving(onSignedOut: () => void) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);

  function run<T>(saving: Promise<T>, onSaved: (saved: T) => void): void {
    setBusy(true);
    setRefusal(undefined);

    saving
      .then(onSaved)
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

  return { busy, refusal, run };
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2, 3].map((one) => (
        <li key={one} className="skeleton is-tall" />
      ))}
    </ul>
  );
}
