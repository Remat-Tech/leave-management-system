import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  addEntitlementRule,
  editEntitlementRule,
  type EntitlementRule,
  type EntitlementRuleFields,
  type EntitlementRuleSettings,
  entitlementRules,
  isNotSignedIn,
  type RuleScope,
  withdrawEntitlementRule,
} from '../../api';
import { day, inDays } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * What each kind of leave is worth, and from when. FR 31, LMS 502.
 *
 * The screen exists to make one thing hard: rewriting last year. A figure is never edited
 * into a new figure — it is superseded by a rule from a later date, and both stay on the
 * record. Only a rule that has not started yet carries Edit and Withdraw, and the sentence
 * saying why the others do not is the server's.
 *
 * Reading the list is refused for anybody who does not read every record, because the rules
 * include personal arrangements. The tab is offered to everybody all the same, for the reason
 * "Waiting on me" is: a page deciding what to draw from its own idea of somebody's roles is a
 * second answer to a question the server owns.
 */
export function EntitlementRulesPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [settings, setSettings] = useState<EntitlementRuleSettings | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /** Null is a new rule; a record is that one being corrected; undefined is the list. */
  const [editing, setEditing] = useState<EntitlementRule | null | undefined>(undefined);

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

    entitlementRules()
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

  if (editing !== undefined) {
    return (
      <div className="page">
        <RuleForm
          settings={settings}
          rule={editing}
          onSignedOut={onSignedOut}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
          onCancel={() => {
            setEditing(undefined);
          }}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="pagehead">
        {/* Why a rule is never edited belongs on the rule whose buttons are greyed, where
            there is something in front of somebody to be about, rather than in the abstract
            up here. `fixedReason` says it there. */}
        <p className="muted">
          <span className="count">{String(settings.rules.length)}</span>
          entitlement rules. Each one says what a kind of leave is worth, who it is for, and from
          when.
        </p>

        <div className="controls">
          <button
            type="button"
            className="primary"
            onClick={() => {
              setEditing(null);
            }}
          >
            <Icon name="plus" />
            New rule
          </button>
        </div>
      </div>

      {/* FR 31. Only where a closed year actually bars a date. With nothing closed the
          sentence announces a restriction that does not apply to anybody reading it. */}
      {settings.earliestOpenDay === null ? null : (
        <p className="rules">
          <Icon name="info" />
          {settings.closedYearsInWords}
        </p>
      )}

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      {settings.rules.length === 0 ? (
        <p className="muted">
          No rules here yet. Until one is added, this kind of leave has no figure at all, which is
          not the same as a figure of nought.
        </p>
      ) : (
        /* One grid rather than a section per leave type. Most types carry a single rule, so
           a heading and a lone card each left three quarters of every row empty. The type is
           on the card instead, and the sort keeps a type's rules next to each other. */
        <ul className="cards">
          {byTypeThenDate(settings.rules).map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onEdit={() => {
                setEditing(rule);
              }}
              onChanged={load}
              onProblem={answer}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One rule, as it stands. Every figure on it is a column, and every sentence is the server's. */
function RuleCard({
  rule,
  onEdit,
  onChanged,
  onProblem,
}: {
  rule: EntitlementRule;
  onEdit: () => void;
  onChanged: () => void;
  onProblem: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const withdraw = (): void => {
    setBusy(true);

    withdrawEntitlementRule(rule.id)
      .then(onChanged)
      .catch(onProblem)
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };

  return (
    <li className={`card${rule.mayBeChanged ? ' draft' : ''}`}>
      <div className="card-head">
        <span className="chip">
          <Icon name={iconForLeaveType(rule.leaveTypeName)} />
        </span>

        <h3>{rule.leaveTypeName}</h3>

        {/* `scopeLabel` is not among these: it reads "Everybody" beside a `who` of
            "Everybody", and where the two differ the named one is the better half. */}
        <div className="tags">
          {rule.inForce ? <span className="tag is-agreed">In force</span> : null}
          {rule.mayBeChanged ? <span className="tag">Not started</span> : null}
        </div>
      </div>

      <p className="headline compact">
        <span className="figure">{inDays(rule.entitlementDays)}</span>
      </p>

      <dl className="settings">
        <div>
          <dt>Who</dt>
          <dd>{rule.who}</dd>
        </div>
        <div>
          <dt>Effective from</dt>
          <dd>{day(rule.effectiveFrom)}</dd>
        </div>
        <div>
          <dt>Until</dt>
          <dd>{rule.effectiveTo === null ? 'A later rule' : day(rule.effectiveTo)}</dd>
        </div>
      </dl>

      {/* FR 31. Carry over, in the server's words rather than reassembled here. Set smaller
          than the card's other footnotes: the sentence runs to ten words in a third-width
          card, and the alternative to shrinking it was wrapping to three lines. */}
      <p className="rules small">
        <Icon name="again" />
        {rule.carryoverInWords}
      </p>

      {/* The note is not drawn. It is written for the record rather than for this list, and
          what the migration seeded reads as provenance for a developer. It is still on the
          rule and still sent, so a screen that wants it has it. */}

      {/* Nothing at all under the carry over line for a rule that has already started: the
          "In force" tag says which those are, and `fixedReason` said the rest at length on
          every card. The server still refuses the write with the whole sentence. */}
      {rule.mayBeChanged ? (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={onEdit}>
            Edit
          </button>

          {asking ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={withdraw}>
                Yes, withdraw it
              </button>
              <button
                type="button"
                className="linkish"
                disabled={busy}
                onClick={() => {
                  setAsking(false);
                }}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => {
                setAsking(true);
              }}
            >
              Withdraw
            </button>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** What the form holds while it is being filled in. Counts are strings; an input gives one. */
interface Draft {
  leaveTypeId: string;
  scope: RuleScope;
  employeeId: string;
  departmentId: string;
  entitlementDays: string;
  prorateOnJoin: boolean;
  carriesOver: boolean;
  carryoverMaxDays: string;
  carryoverExpiryMonth: string;
  effectiveFrom: string;
  effectiveTo: string;
  note: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** So an input a refusal named can point at the sentence. NFR USA 03. */
const REFUSAL_ID = 'entitlement-rule-refusal';

/**
 * Adding a rule, and correcting one that has not started. FR 31. Both criteria of the story.
 *
 * One form for both, because they are the same fields. What differs is the date: a new rule
 * may start on any open day, and a correction is only ever offered on a rule whose day has
 * not come.
 */
function RuleForm({
  settings,
  rule,
  onSaved,
  onCancel,
  onSignedOut,
}: {
  settings: EntitlementRuleSettings;
  /** Null for a new one. */
  rule: EntitlementRule | null;
  onSaved: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule, settings));
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

    const fields = fieldsOf(draft);

    (rule === null
      ? addEntitlementRule(fields)
      : editEntitlementRule(rule.id, changedIn(fields, rule))
    )
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

  /* A rule starting today is in force today, so it is a rule nobody may edit afterwards. */
  const startsInForce = draft.effectiveFrom !== '' && draft.effectiveFrom <= settings.today;

  return (
    <form className="panel wide" onSubmit={save}>
      <h2 className="panel-title">
        {rule === null ? 'A new entitlement rule' : `Editing the rule for ${rule.who}`}
      </h2>

      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <fieldset className="fields">
        <legend>What it is worth</legend>

        <label>
          Kind of leave
          <select
            value={draft.leaveTypeId}
            disabled={saving}
            {...marks('leaveTypeId')}
            onChange={(event) => {
              change({ leaveTypeId: event.target.value });
            }}
          >
            {settings.leaveTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
                {type.isActive ? '' : ' (retired)'}
              </option>
            ))}
          </select>
        </label>

        {/* FR 24. Whole days, and nought is a decision rather than a blank. */}
        <label>
          Days a year
          <input
            type="number"
            min={0}
            step={1}
            required
            value={draft.entitlementDays}
            disabled={saving}
            {...marks('entitlementDays')}
            onChange={(event) => {
              change({ entitlementDays: event.target.value });
            }}
          />
          <small className="muted">
            Whole days. Nought is a real figure. It says this leave is worth nothing to these
            people, which reads differently from having no rule at all.
          </small>
        </label>

        <Tick
          label="Pro rata in the year somebody joins"
          checked={draft.prorateOnJoin}
          disabled={saving}
          onChange={(prorateOnJoin) => {
            change({ prorateOnJoin });
          }}
        />
      </fieldset>

      <fieldset className="fields">
        <legend>Who it is for</legend>

        <label>
          Aimed at
          <select
            value={draft.scope}
            disabled={saving}
            onChange={(event) => {
              /* The other rung's id is cleared, because a rule names an employee or a
                 department and never both. */
              const scope = event.target.value as RuleScope;

              change({
                scope,
                employeeId: scope === 'EMPLOYEE' ? draft.employeeId : '',
                departmentId: scope === 'DEPARTMENT' ? draft.departmentId : '',
              });
            }}
          >
            {settings.scopes.map((one) => (
              <option key={one.value} value={one.value}>
                {one.label}
              </option>
            ))}
          </select>
          <small className="muted">
            The narrowest rule wins: a person's own beats their department's, which beats
            everybody's.
          </small>
        </label>

        {draft.scope === 'DEPARTMENT' ? (
          <label>
            Department
            <select
              value={draft.departmentId}
              required
              disabled={saving}
              {...marks('departmentId')}
              onChange={(event) => {
                change({ departmentId: event.target.value });
              }}
            >
              <option value="">Choose a department</option>
              {settings.departments.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
            <small className="muted">
              Everybody in it today, rather than whoever was in it when the rule was written.
            </small>
          </label>
        ) : null}

        {draft.scope === 'EMPLOYEE' ? (
          <label>
            Person
            <select
              value={draft.employeeId}
              required
              disabled={saving}
              {...marks('employeeId')}
              onChange={(event) => {
                change({ employeeId: event.target.value });
              }}
            >
              <option value="">Choose a person</option>
              {settings.employees.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </fieldset>

      {/* FR 31. The half of the form the story is actually about. */}
      <fieldset className="fields">
        <legend>From when</legend>

        <label>
          Effective from
          <input
            type="date"
            required
            value={draft.effectiveFrom}
            min={settings.earliestOpenDay ?? undefined}
            disabled={saving}
            {...marks('effectiveFrom')}
            onChange={(event) => {
              change({ effectiveFrom: event.target.value });
            }}
          />
          {settings.earliestOpenDay === null ? null : (
            <small className="muted">{settings.closedYearsInWords}</small>
          )}
        </label>

        <label>
          Until (optional)
          <input
            type="date"
            value={draft.effectiveTo}
            min={draft.effectiveFrom === '' ? undefined : draft.effectiveFrom}
            disabled={saving}
            {...marks('effectiveTo')}
            onChange={(event) => {
              change({ effectiveTo: event.target.value });
            }}
          />
          <small className="muted">Leave empty for a rule that stands until a later one.</small>
        </label>

        {startsInForce ? (
          <p className="notice warning" role="status">
            This rule is in force from the day it is saved, so it cannot be edited or withdrawn
            afterwards. Give it a later date if it is meant to be a draft.
          </p>
        ) : null}

        <label>
          Note (optional)
          <textarea
            value={draft.note}
            rows={2}
            disabled={saving}
            {...marks('note')}
            onChange={(event) => {
              change({ note: event.target.value });
            }}
          />
          <small className="muted">
            Why the figure changed: the board minute, the policy, the arrangement. It stays on the
            record beside the rule.
          </small>
        </label>
      </fieldset>

      <fieldset className="fields">
        <legend>Carry over</legend>

        <Tick
          label="Unused days carry into the next leave year"
          checked={draft.carriesOver}
          disabled={saving}
          onChange={(carriesOver) => {
            /* A cap or an expiry month means nothing where nothing carries over, and the
               server refuses the pair. Cleared here so that refusal never has to be shown. */
            change({
              carriesOver,
              carryoverMaxDays: carriesOver ? draft.carryoverMaxDays : '',
              carryoverExpiryMonth: carriesOver ? draft.carryoverExpiryMonth : '',
            });
          }}
        />

        {draft.carriesOver ? (
          <>
            <label>
              At most (days, optional)
              <input
                type="number"
                min={1}
                step={1}
                value={draft.carryoverMaxDays}
                disabled={saving}
                {...marks('carryoverMaxDays')}
                onChange={(event) => {
                  change({ carryoverMaxDays: event.target.value });
                }}
              />
              <small className="muted">Leave empty to carry the whole unused balance.</small>
            </label>

            <label>
              Carried days expire at the end of
              <select
                value={draft.carryoverExpiryMonth}
                disabled={saving}
                {...marks('carryoverExpiryMonth')}
                onChange={(event) => {
                  change({ carryoverExpiryMonth: event.target.value });
                }}
              >
                <option value="">They never expire</option>
                {MONTHS.map((name, at) => (
                  <option key={name} value={String(at + 1)}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </fieldset>

      <div className="card-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : rule === null ? 'Add rule' : 'Save changes'}
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
 * A type's rules together, latest first within each.
 *
 * What the grouping headings used to do, without spending a row on each: the grid reads
 * left to right, so rules of one kind sit beside each other rather than under a heading.
 */
function byTypeThenDate(rules: EntitlementRule[]): EntitlementRule[] {
  return [...rules].sort(
    (left, right) =>
      left.leaveTypeName.localeCompare(right.leaveTypeName) ||
      right.effectiveFrom.localeCompare(left.effectiveFrom),
  );
}

/**
 * What the form starts at.
 *
 * A new one starts at the server's defaults and at the first day it would accept — never
 * today, because a rule dated today is in force the moment it is saved.
 */
function draftOf(rule: EntitlementRule | null, settings: EntitlementRuleSettings): Draft {
  if (rule === null) {
    const { defaults } = settings;

    return {
      leaveTypeId: settings.leaveTypes[0]?.id ?? '',
      scope: 'EVERYBODY',
      employeeId: '',
      departmentId: '',
      entitlementDays: String(defaults.entitlementDays),
      prorateOnJoin: defaults.prorateOnJoin,
      carriesOver: defaults.carriesOver,
      carryoverMaxDays: asText(defaults.carryoverMaxDays),
      carryoverExpiryMonth: asText(defaults.carryoverExpiryMonth),
      effectiveFrom: '',
      effectiveTo: defaults.effectiveTo ?? '',
      note: defaults.note ?? '',
    };
  }

  return {
    leaveTypeId: rule.leaveTypeId,
    scope: rule.scope,
    employeeId: rule.employeeId ?? '',
    departmentId: rule.departmentId ?? '',
    entitlementDays: String(rule.entitlementDays),
    prorateOnJoin: rule.prorateOnJoin,
    carriesOver: rule.carriesOver,
    carryoverMaxDays: asText(rule.carryoverMaxDays),
    carryoverExpiryMonth: asText(rule.carryoverExpiryMonth),
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo ?? '',
    note: rule.note ?? '',
  };
}

/** Every field the draft holds, as the server takes them. */
function fieldsOf(draft: Draft): Required<EntitlementRuleFields> {
  return {
    leaveTypeId: draft.leaveTypeId,
    /* Both rungs sent, and the unused one as null: a scope somebody moved off has to arrive
       as cleared rather than as left alone. */
    employeeId: draft.scope === 'EMPLOYEE' ? draft.employeeId : null,
    departmentId: draft.scope === 'DEPARTMENT' ? draft.departmentId : null,
    entitlementDays: asFigure(draft.entitlementDays),
    prorateOnJoin: draft.prorateOnJoin,
    carriesOver: draft.carriesOver,
    carryoverMaxDays: asCount(draft.carryoverMaxDays),
    carryoverExpiryMonth: asCount(draft.carryoverExpiryMonth),
    effectiveFrom: draft.effectiveFrom,
    effectiveTo: draft.effectiveTo === '' ? null : draft.effectiveTo,
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  };
}

/** The fields that differ from the record the form was drawn from. */
function changedIn(
  fields: Required<EntitlementRuleFields>,
  rule: EntitlementRule,
): EntitlementRuleFields {
  const changes: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(fields)) {
    if (value !== (rule as unknown as Record<string, unknown>)[field]) {
      changes[field] = value;
    }
  }

  return changes as EntitlementRuleFields;
}

/** An optional count: empty is nothing at all, which differs from zero. */
function asCount(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

/**
 * A figure, where zero is real and empty is not.
 *
 * `NaN` for a blank rather than a nought: the input is `required`, so this is only reached by
 * a form that got past the browser, and the server's refusal names the field.
 */
function asFigure(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function asText(count: number | null): string {
  return count === null ? '' : String(count);
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="cards">
      {[0, 1, 2, 3].map((one) => (
        <li key={one} className="skeleton" />
      ))}
    </ul>
  );
}
