import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type AllowanceUnit,
  type ConfiguredLeaveType,
  type CountingBasis,
  createLeaveType,
  type Desk,
  type DocumentationRule,
  type EntitlementBasis,
  editLeaveType,
  type GenderRestriction,
  isNotSignedIn,
  type LeaveTypeFields,
  type LeaveTypeSettings,
  leaveTypes,
  reinstateLeaveType,
  retireLeaveType,
} from '../../api';
import { ChainEditor, ChainInOrder } from './ChainEditor';
import { Icon, iconForLeaveType } from '../../Icon';
import { Modal } from '../../Modal';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Setting up the kinds of leave. FR 31, FR 32, LMS 501.
 *
 * Reading is open to anybody, so this screen draws for everybody; every button on it is
 * refused for anybody but an HR Administrator, with the server's own sentence. There is
 * deliberately no flag on `/api/me` to hide it in advance — the same argument "Waiting on
 * me" makes: a page that decided what to draw from its own idea of somebody's roles is a
 * second answer to a question the server owns.
 *
 * Nothing here computes a rule. The counting basis, the documentation rule and the chain are
 * tokens the server named and labelled, and what a person reads beside each control is the
 * server's wording rather than this file's.
 *
 * **The list is names and nothing else.** A leave type has eighteen settings on it, and a
 * grid of cards carrying all of them was a wall of text nobody could find a type in — the
 * one question the list is for, "which kinds of leave are there", was the hardest to answer
 * from it. So a card is the name, the icon and the code, and everything else is a press away.
 */
export function LeaveTypesPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [settings, setSettings] = useState<LeaveTypeSettings | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /**
   * Which type the dialog is open on, and whether it is reading or editing.
   *
   * Held as an **id** rather than as the record, because the list is reloaded underneath it:
   * retiring a type from inside the dialog fetches every type again, and a copy captured when
   * the dialog opened would go on showing the state it was in before the press. A null id is
   * a type that does not exist yet, which is only ever the form.
   */
  const [open, setOpen] = useState<Open | undefined>(undefined);

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

    leaveTypes()
      .then((next) => {
        setSettings(next);
        setProblem(undefined);
      })
      .catch(answer)
      .finally(() => {
        setLoading(false);
      });
  }, [answer]);

  useEffect(load, [load]);

  if (settings === undefined) {
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

  /* Looked up fresh every render, so the dialog shows the record as it stands rather than as
     it was when it opened. A type is never deleted, so an id that finds nothing is one the
     list no longer carries and the dialog has nothing left to show. */
  const showing =
    open?.id == null ? null : (settings.types.find((one) => one.id === open.id) ?? null);

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          <span className="count">{String(settings.types.length)}</span>
          kinds of leave. Changing one changes what leave costs and who may take it for everybody,
          from the next request onwards.
        </p>

        <div className="controls">
          <button
            type="button"
            className="primary"
            onClick={() => {
              setOpen({ mode: 'form', id: null });
            }}
          >
            <Icon name="plus" />
            New leave type
          </button>
        </div>
      </div>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      <ul className="cards type-cards">
        {settings.types.map((type) => (
          <TypeCard
            key={type.id}
            type={type}
            onOpen={() => {
              setOpen({ mode: 'details', id: type.id });
            }}
          />
        ))}
      </ul>

      {open === undefined ? null : (
        <Modal
          title={
            open.mode === 'form'
              ? showing === null
                ? 'New Leave Type'
                : `Editing ${showing.name}`
              : (showing?.name ?? 'That kind of leave')
          }
          tags={
            open.mode === 'details' && showing !== null ? (
              <div className="tags">
                <span className="tag">{showing.code}</span>
                {showing.isActive ? null : <span className="tag">Retired</span>}
              </div>
            ) : undefined
          }
          onClose={() => {
            setOpen(undefined);
          }}
        >
          {open.mode === 'form' ? (
            <TypeForm
              settings={settings}
              type={showing}
              onSignedOut={onSignedOut}
              onSaved={() => {
                setOpen(undefined);
                load();
              }}
              /* Back to the details for a type that exists, because that is where the press
                 came from. A new one has nothing to go back to. */
              onCancel={() => {
                setOpen(showing === null ? undefined : { mode: 'details', id: showing.id });
              }}
            />
          ) : showing === null ? (
            <p className="muted">That kind of leave is no longer on the list.</p>
          ) : (
            <TypeDetails
              type={showing}
              settings={settings}
              onEdit={() => {
                setOpen({ mode: 'form', id: showing.id });
              }}
              onChanged={load}
              onProblem={answer}
            />
          )}
        </Modal>
      )}
    </div>
  );
}

/** Which type the dialog is open on, and whether it is reading or editing. */
interface Open {
  mode: 'details' | 'form';
  /** Null is a type that does not exist yet, which is only ever the form. */
  id: string | null;
}

/**
 * One type on the list: the name, the icon and the code, and nothing else.
 *
 * A button rather than a card with a button on it, so the whole tile is the target and the
 * keyboard reaches it in one tab stop. The code is the only pill — a second one reading
 * "Unpaid" beside a code of UNPAID was the same word twice, and what a type costs belongs
 * with the rest of its settings rather than on a tile meant to be scanned.
 */
function TypeCard({ type, onOpen }: { type: ConfiguredLeaveType; onOpen: () => void }) {
  return (
    <li className={`card type-card${type.isActive ? '' : ' dormant'}`}>
      <button type="button" onClick={onOpen}>
        <span className="chip">
          <Icon name={iconForLeaveType(type.name)} />
        </span>

        <h3>{type.name}</h3>

        <span className="tags">
          <span className="tag">{type.code}</span>
          {type.isActive ? null : <span className="tag">Retired</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * Everything a type says, once somebody has asked. FR 31, FR 32.
 *
 * Every label and every sentence here is the server's. The only thing this function decides
 * is the order they are read in: what it costs, what it asks of somebody, and who signs it.
 */
function TypeDetails({
  type,
  settings,
  onEdit,
  onChanged,
  onProblem,
}: {
  type: ConfiguredLeaveType;
  settings: LeaveTypeSettings;
  onEdit: () => void;
  onChanged: () => void;
  onProblem: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);

  const setOffered = (offered: boolean): void => {
    setBusy(true);

    (offered ? reinstateLeaveType(type.id) : retireLeaveType(type.id))
      .then(onChanged)
      .catch(onProblem)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      {type.description === null ? null : <p className="lede">{type.description}</p>}

      <section className="detail-group">
        <h3>
          <Icon name="balances" />
          What it costs
        </h3>

        <dl className="settings">
          <div>
            <dt>Counted in</dt>
            <dd>{type.countingBasisLabel}</dd>
          </div>
          <div>
            <dt>Entitlement</dt>
            <dd>{type.entitlementBasisLabel}</dd>
          </div>
          <div>
            <dt>Pay</dt>
            <dd>{type.isPaid ? 'Paid' : 'Unpaid'}</dd>
          </div>
          <div>
            <dt>Allowance said in</dt>
            <dd>{type.unitLabel}</dd>
          </div>
          <div>
            <dt>Days must be used within</dt>
            <dd>
              {type.entitlementExpiryMonths === null
                ? 'No time limit'
                : inMonths(type.entitlementExpiryMonths)}
            </dd>
          </div>
          <div>
            <dt>Separate spells</dt>
            <dd>{type.mayBeSplit ? 'May be split' : 'One unbroken spell'}</dd>
          </div>
        </dl>
      </section>

      <section className="detail-group">
        <h3>
          <Icon name="clip" />
          What it asks of somebody
        </h3>

        <dl className="settings">
          <div>
            <dt>Documentation</dt>
            <dd>
              {type.documentation === 'AFTER_DAYS' && type.documentationAfterDays !== null
                ? `${type.documentationLabel}, over ${String(type.documentationAfterDays)}`
                : type.documentationLabel}
            </dd>
          </div>
          <div>
            <dt>Notice expected</dt>
            <dd>{inDays(type.minNoticeCalendarDays)}</dd>
          </div>
          <div>
            <dt>May be entered up to</dt>
            <dd>{inDays(type.maxBackdateCalendarDays)} late</dd>
          </div>
          <div>
            <dt>Open to</dt>
            <dd>{type.genderRestrictionLabel}</dd>
          </div>
          <div>
            <dt>A reason</dt>
            <dd>{type.reasonRequired ? 'Has to be given' : 'Optional'}</dd>
          </div>
          <div>
            <dt>Past the allowance</dt>
            <dd>{type.exceedableWithDocument ? 'Asks for evidence' : 'Refused'}</dd>
          </div>
        </dl>
      </section>

      {/* FR 38a. Where a request of this kind goes, in order. The chain says it; the
          sentence underneath said the same thing again in the requester's voice. */}
      <section className="detail-group">
        <h3>
          <Icon name="stage" />
          Who approves it
        </h3>

        <ChainInOrder chain={type.approvalChain} choices={settings.choices.approvers} />
      </section>

      <div className="modal-actions">
        <button type="button" className="primary" onClick={onEdit}>
          Edit
        </button>

        {/* Never a delete: the type heads every report it ever headed. */}
        <button
          type="button"
          className={type.isActive ? 'linkish' : undefined}
          disabled={busy}
          onClick={() => {
            setOffered(!type.isActive);
          }}
        >
          {type.isActive ? 'Retire' : 'Offer again'}
        </button>

        <span className="muted">Display order {String(type.displayOrder)}</span>
      </div>
    </>
  );
}

/** What the form holds while it is being filled in. Counts are strings; an input gives one. */
interface Draft {
  code: string;
  name: string;
  description: string;
  countingBasis: CountingBasis;
  entitlementBasis: EntitlementBasis;
  isPaid: boolean;
  unit: AllowanceUnit;
  documentation: DocumentationRule;
  documentationAfterDays: string;
  exceedableWithDocument: boolean;
  entitlementExpiryMonths: string;
  mayBeSplit: boolean;
  minNoticeCalendarDays: string;
  maxBackdateCalendarDays: string;
  genderRestriction: GenderRestriction;
  reasonRequired: boolean;
  displayOrder: string;
  approvalChain: Desk[];
}

/** So an input a refusal named can point at the sentence. NFR USA 03. */
const REFUSAL_ID = 'leave-type-refusal';

/**
 * Creating one, and editing one. FR 31, FR 32. Both criteria of the story.
 *
 * One form for both, because they are the same fields: what differs is only whether an id
 * exists to send them to. Editing sends **what changed and nothing else**, so two
 * administrators with the form open do not overwrite each other's untouched fields.
 */
function TypeForm({
  settings,
  type,
  onSaved,
  onCancel,
  onSignedOut,
}: {
  settings: LeaveTypeSettings;
  /** Null for a new one. */
  type: ConfiguredLeaveType | null;
  onSaved: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(type, settings));
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const change = (part: Partial<Draft>): void => {
    setDraft((was) => ({ ...was, ...part }));
    setRefusal(undefined);
  };

  function save(event: FormEvent): void {
    event.preventDefault();

    setSaving(true);
    setRefusal(undefined);

    (type === null ? createOne(draft) : saveChanges(type, draft))
      .then(onSaved)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        setRefusal(problemFrom(error));
      })
      .finally(() => {
        setSaving(false);
      });
  }

  /** The input the refusal is about, where the server named one. NFR USA 03. */
  const marks = (field: string) =>
    refusal?.field !== field ? {} : { 'aria-invalid': true, 'aria-describedby': REFUSAL_ID };

  const chosenBasis = settings.choices.countingBases.find(
    (one) => one.value === draft.countingBasis,
  );

  /* No heading of its own: the dialog carries the title, and a second one under it would be
     the same sentence twice. */
  return (
    <form className="modal-form" onSubmit={save}>
      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <fieldset className="fields">
        <legend>What it is called</legend>

        <label>
          Name
          <input
            value={draft.name}
            maxLength={80}
            required
            disabled={saving}
            {...marks('name')}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
        </label>

        <label>
          Code
          <input
            value={draft.code}
            maxLength={40}
            required
            disabled={saving}
            {...marks('code')}
            onChange={(event) => {
              change({ code: event.target.value.toUpperCase() });
            }}
          />
          <small className="muted">
            The handle reports and imports join on, like ANNUAL. Letters, digits and underscores.
            Renaming the type does not change it.
          </small>
        </label>

        <label>
          Description (optional)
          <textarea
            value={draft.description}
            rows={3}
            disabled={saving}
            {...marks('description')}
            onChange={(event) => {
              change({ description: event.target.value });
            }}
          />
          <small className="muted">What staff read on the request form beside the name.</small>
        </label>
      </fieldset>

      <fieldset className="fields">
        <legend>How it is counted</legend>

        <label>
          Counting basis
          <select
            value={draft.countingBasis}
            disabled={saving}
            {...marks('countingBasis')}
            onChange={(event) => {
              change({ countingBasis: event.target.value as CountingBasis });
            }}
          >
            {settings.choices.countingBases.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
          {/* FR 22. The server's sentence, because what a calendar day costs is not this
              file's to word. */}
          <small className="muted">{chosenBasis?.inWords}</small>
        </label>

        <label>
          Entitlement
          <select
            value={draft.entitlementBasis}
            disabled={saving}
            {...marks('entitlementBasis')}
            onChange={(event) => {
              change({ entitlementBasis: event.target.value as EntitlementBasis });
            }}
          >
            {settings.choices.entitlementBases.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Allowance said in
          <select
            value={draft.unit}
            disabled={saving}
            {...marks('unit')}
            onChange={(event) => {
              change({ unit: event.target.value as AllowanceUnit });
            }}
          >
            {settings.choices.units.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
          {/* FR 24. How it is said, never how it is counted. */}
          <small className="muted">
            Only how the allowance is worded. Leave is counted and recorded in whole days whatever
            this says.
          </small>
        </label>

        {/* FR 32e. Not carry over, which is a rule about a leave year rather than a grant. */}
        <label>
          Days must be used within (months, optional)
          <input
            type="number"
            min={1}
            step={1}
            value={draft.entitlementExpiryMonths}
            disabled={saving}
            {...marks('entitlementExpiryMonths')}
            onChange={(event) => {
              change({ entitlementExpiryMonths: event.target.value });
            }}
          />
          <small className="muted">
            How long days stay usable once they are granted. Maternity leave granted on the day a
            child is born and set to 6 here has to be taken within six months of the birth. Leave it
            empty where granted days keep. This is not carry over, which is about a leave year
            ending rather than about how long one grant lasts.
          </small>
        </label>

        <Tick
          label="Paid"
          checked={draft.isPaid}
          disabled={saving}
          onChange={(isPaid) => {
            change({ isPaid });
          }}
        />

        <Tick
          label="May be taken in separate spells"
          checked={draft.mayBeSplit}
          disabled={saving}
          onChange={(mayBeSplit) => {
            change({ mayBeSplit });
          }}
        />
      </fieldset>

      <fieldset className="fields">
        <legend>What it asks of somebody</legend>

        {/* FR 13. A rule about the length of one request. */}
        <label>
          Documentation
          <select
            value={draft.documentation}
            disabled={saving}
            {...marks('documentation')}
            onChange={(event) => {
              const documentation = event.target.value as DocumentationRule;

              /* A threshold is refused for any rule but AFTER_DAYS, and would never be read.
                 Cleared here so the refusal never has to be shown for it. */
              change({
                documentation,
                documentationAfterDays:
                  documentation === 'AFTER_DAYS' ? draft.documentationAfterDays : '',
              });
            }}
          >
            {settings.choices.documentationRules.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
        </label>

        {draft.documentation !== 'AFTER_DAYS' ? null : (
          <label>
            Required past
            <input
              type="number"
              min={1}
              step={1}
              required
              value={draft.documentationAfterDays}
              disabled={saving}
              {...marks('documentationAfterDays')}
              onChange={(event) => {
                change({ documentationAfterDays: event.target.value });
              }}
            />
            <small className="muted">
              Days. A request of exactly this many is fine; the next one is not.
            </small>
          </label>
        )}

        {/* FR 17. Warns; never refuses. */}
        <label>
          Notice expected (calendar days)
          <input
            type="number"
            min={0}
            step={1}
            required
            value={draft.minNoticeCalendarDays}
            disabled={saving}
            {...marks('minNoticeCalendarDays')}
            onChange={(event) => {
              change({ minNoticeCalendarDays: event.target.value });
            }}
          />
          <small className="muted">
            Short notice is warned about and acknowledged, then allowed through. Use 0 for a type
            with no window.
          </small>
        </label>

        {/* FR 18. Refuses. */}
        <label>
          May be entered up to (calendar days late)
          <input
            type="number"
            min={0}
            step={1}
            required
            value={draft.maxBackdateCalendarDays}
            disabled={saving}
            {...marks('maxBackdateCalendarDays')}
            onChange={(event) => {
              change({ maxBackdateCalendarDays: event.target.value });
            }}
          />
          <small className="muted">
            Past this the employee is refused and only HR may enter the record, with a reason.
          </small>
        </label>

        {/* FR 05. */}
        <label>
          Open to
          <select
            value={draft.genderRestriction ?? ''}
            disabled={saving}
            {...marks('genderRestriction')}
            onChange={(event) => {
              change({
                genderRestriction:
                  event.target.value === '' ? null : (event.target.value as 'MALE' | 'FEMALE'),
              });
            }}
          >
            {settings.choices.genderRestrictions.map((one) => (
              <option key={one.value ?? ''} value={one.value ?? ''}>
                {one.label}
              </option>
            ))}
          </select>
        </label>

        {/* §7.4. */}
        <label>
          Display order
          <input
            type="number"
            min={0}
            step={1}
            required
            value={draft.displayOrder}
            disabled={saving}
            {...marks('displayOrder')}
            onChange={(event) => {
              change({ displayOrder: event.target.value });
            }}
          />
          <small className="muted">
            Where it sits on the balance screen and the request form. Lower comes first.
          </small>
        </label>

        {/* FR 10. */}
        <Tick
          label="A request has to say why"
          checked={draft.reasonRequired}
          disabled={saving}
          onChange={(reasonRequired) => {
            change({ reasonRequired });
          }}
        />

        {/* FR 32a. The balance stops being a cap and becomes the point evidence is asked for. */}
        <Tick
          label="Going past the yearly allowance asks for evidence rather than refusing"
          checked={draft.exceedableWithDocument}
          disabled={saving}
          onChange={(exceedableWithDocument) => {
            change({ exceedableWithDocument });
          }}
        />
      </fieldset>

      {/* FR 38a. Set here only while the type does not exist yet — one nobody approves cannot
          be asked for at all. Changing it afterwards is LMS 503's screen. */}
      <fieldset className="fields">
        <legend>Who approves it</legend>

        {type === null ? (
          <ChainEditor
            chain={draft.approvalChain}
            choices={settings.choices.approvers}
            disabled={saving}
            onChange={(approvalChain) => {
              change({ approvalChain });
            }}
          />
        ) : (
          <>
            <ChainInOrder chain={type.approvalChain} choices={settings.choices.approvers} />
            <p className="muted">
              Who approves it is changed on <a href="#/approval-chains">Approval chains</a>, where
              every type's is in one place.
            </p>
          </>
        )}
      </fieldset>

      <div className="modal-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : type === null ? 'Create' : 'Save changes'}
        </button>

        <button type="button" className="linkish" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A checkbox with its label beside it rather than above, which is what `label` does here. */
function Tick({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="tick">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * What the form starts at.
 *
 * A new one starts at the server's own defaults, and at the *first* counting and entitlement
 * basis it offered — those two have no default and are refused when missing, so the control
 * shows a choice rather than this file inventing one.
 */
function draftOf(type: ConfiguredLeaveType | null, settings: LeaveTypeSettings): Draft {
  const { defaults, choices } = settings;

  if (type === null) {
    return {
      code: '',
      name: '',
      description: '',
      countingBasis: choices.countingBases[0].value,
      entitlementBasis: choices.entitlementBases[0].value,
      isPaid: defaults.isPaid,
      unit: defaults.unit,
      documentation: defaults.documentation,
      documentationAfterDays: asText(defaults.documentationAfterDays),
      exceedableWithDocument: defaults.exceedableWithDocument,
      entitlementExpiryMonths: asText(defaults.entitlementExpiryMonths),
      mayBeSplit: defaults.mayBeSplit,
      minNoticeCalendarDays: String(defaults.minNoticeCalendarDays),
      maxBackdateCalendarDays: String(defaults.maxBackdateCalendarDays),
      genderRestriction: defaults.genderRestriction,
      reasonRequired: defaults.reasonRequired,
      displayOrder: String(defaults.displayOrder),
      approvalChain: [...defaults.approvalChain],
    };
  }

  return {
    code: type.code,
    name: type.name,
    description: type.description ?? '',
    countingBasis: type.countingBasis,
    entitlementBasis: type.entitlementBasis,
    isPaid: type.isPaid,
    unit: type.unit,
    documentation: type.documentation,
    documentationAfterDays: asText(type.documentationAfterDays),
    exceedableWithDocument: type.exceedableWithDocument,
    entitlementExpiryMonths: asText(type.entitlementExpiryMonths),
    mayBeSplit: type.mayBeSplit,
    minNoticeCalendarDays: String(type.minNoticeCalendarDays),
    maxBackdateCalendarDays: String(type.maxBackdateCalendarDays),
    genderRestriction: type.genderRestriction,
    reasonRequired: type.reasonRequired,
    displayOrder: String(type.displayOrder),
    approvalChain: [...type.approvalChain],
  };
}

/** Every field the draft holds, as the server takes them. */
function fieldsOf(draft: Draft): Required<Omit<LeaveTypeFields, 'approvalChain'>> {
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    /* Blank is null rather than an empty string, so "nobody wrote one" has one shape. */
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    countingBasis: draft.countingBasis,
    entitlementBasis: draft.entitlementBasis,
    isPaid: draft.isPaid,
    unit: draft.unit,
    documentation: draft.documentation,
    documentationAfterDays: asCount(draft.documentationAfterDays),
    exceedableWithDocument: draft.exceedableWithDocument,
    entitlementExpiryMonths: asCount(draft.entitlementExpiryMonths),
    mayBeSplit: draft.mayBeSplit,
    minNoticeCalendarDays: asWindow(draft.minNoticeCalendarDays),
    maxBackdateCalendarDays: asWindow(draft.maxBackdateCalendarDays),
    genderRestriction: draft.genderRestriction,
    reasonRequired: draft.reasonRequired,
    displayOrder: asWindow(draft.displayOrder),
  };
}

function createOne(draft: Draft): Promise<ConfiguredLeaveType> {
  return createLeaveType({ ...fieldsOf(draft), approvalChain: draft.approvalChain });
}

/**
 * What an edit sends, and only what it is.
 *
 * A PATCH carrying every field would revert whatever a colleague changed while this form was
 * open, so what goes is what differs.
 */
async function saveChanges(type: ConfiguredLeaveType, draft: Draft): Promise<ConfiguredLeaveType> {
  const changes = changedIn(fieldsOf(draft), type);

  return Object.keys(changes).length === 0 ? type : editLeaveType(type.id, changes);
}

/** The fields that differ from the record the form was drawn from. */
function changedIn(
  fields: Required<Omit<LeaveTypeFields, 'approvalChain'>>,
  type: ConfiguredLeaveType,
): LeaveTypeFields {
  const changes: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(fields)) {
    if (value !== (type as unknown as Record<string, unknown>)[field]) {
      changes[field] = value;
    }
  }

  return changes as LeaveTypeFields;
}

/** An optional count: empty is nothing at all, which is a different instruction from zero. */
function asCount(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

/**
 * A window, where zero is a real value and empty is not one.
 *
 * `NaN` for a blank rather than a nought: the inputs are `required`, so this is only reached
 * by a form that got past the browser, and the server's refusal names the field. Nought would
 * be a rule this file invented.
 */
function asWindow(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function asText(count: number | null): string {
  return count === null ? '' : String(count);
}

function inDays(count: number): string {
  return `${String(count)} ${count === 1 ? 'day' : 'days'}`;
}

function inMonths(count: number): string {
  return `${String(count)} ${count === 1 ? 'month' : 'months'}`;
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2, 3, 4, 5].map((one) => (
        <li key={one} className="skeleton" />
      ))}
    </ul>
  );
}
