import { useCallback, useEffect, useState } from 'react';
import {
  type ConfiguredLeaveType,
  type Desk,
  isNotSignedIn,
  type LeaveTypeSettings,
  leaveTypes,
  setApprovalChain,
} from '../../api';
import { ChainEditor, ChainInOrder, type DeskChoices, sameChain } from './ChainEditor';
import { Icon, iconForLeaveType } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';

/**
 * Who approves each kind of leave, and in what order. FR 38a, LMS 503.
 *
 * Its own screen rather than a fieldset on the leave type form: a chain is read across types,
 * and that question was answerable only by opening each form in turn.
 *
 * Drawn for everybody, as the other config screens are. The writes are refused for anybody but
 * an HR Administrator, with the server's own sentence.
 */
export function ApprovalChainsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const [settings, setSettings] = useState<LeaveTypeSettings | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  /** The one type being changed, by id. */
  const [editing, setEditing] = useState<string | undefined>(undefined);

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

  return (
    <div className="page">
      <div className="pagehead">
        <p className="muted">
          <span className="count">{String(settings.types.length)}</span>
          kinds of leave, and the desks a request for each one goes to, in order.
        </p>
      </div>

      {/* What a change does to the requests already in the queues. LMS 316. */}
      <p className="rules">
        <Icon name="info" />A change takes effect at once, on requests already waiting as well as on
        new ones: each one travels the chain as it stands now and collects every signature in it. A
        desk that has already signed is not asked twice.
      </p>

      {problem === undefined ? null : (
        <Notice problem={problem} retrying={loading} onRetry={load} />
      )}

      <ul className="chains">
        {settings.types.map((type) => (
          <ChainCard
            key={type.id}
            type={type}
            choices={settings.choices.approvers}
            editing={editing === type.id}
            onEdit={() => {
              setEditing(type.id);
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
            onSaved={() => {
              setEditing(undefined);
              load();
            }}
            onSignedOut={onSignedOut}
          />
        ))}
      </ul>
    </div>
  );
}

/** One kind of leave and its chain, read or being changed. */
function ChainCard({
  type,
  choices,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onSignedOut,
}: {
  type: ConfiguredLeaveType;
  choices: DeskChoices;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onSignedOut: () => void;
}) {
  return (
    <li className={`card chain-card${type.isActive ? '' : ' dormant'}`}>
      <div className="card-head">
        <span className="chip">
          <Icon name={iconForLeaveType(type.name)} />
        </span>

        <h3>{type.name}</h3>

        <div className="tags">
          <span className="tag">{type.code}</span>
          {type.isActive ? null : <span className="tag">Retired</span>}
          {type.approvalChain.length === 0 ? (
            <span className="tag is-nobody">Nobody approves it</span>
          ) : null}
        </div>
      </div>

      {editing ? (
        /* Mounted only while it is being changed, so the draft starts at the saved chain. */
        <ChainForm
          type={type}
          choices={choices}
          onSaved={onSaved}
          onCancel={onCancel}
          onSignedOut={onSignedOut}
        />
      ) : (
        <>
          <ChainInOrder chain={type.approvalChain} choices={choices} />

          {/* The same chain in the requester's voice, which is what the request form says. */}
          <p className="rules">
            <Icon name="stage" />
            Staff are told: {type.approvedBy}
          </p>

          <div className="card-actions">
            <button type="button" onClick={onEdit}>
              Change who approves it
            </button>
          </div>
        </>
      )}
    </li>
  );
}

/** So an input a refusal named can point at the sentence. NFR USA 03. */
const REFUSAL_ID = 'approval-chain-refusal';

/** Changing one chain. Its own call and its own refusals, as the endpoint is. */
function ChainForm({
  type,
  choices,
  onSaved,
  onCancel,
  onSignedOut,
}: {
  type: ConfiguredLeaveType;
  choices: DeskChoices;
  onSaved: () => void;
  onCancel: () => void;
  onSignedOut: () => void;
}) {
  const [chain, setChain] = useState<Desk[]>(() => [...type.approvalChain]);
  const [refusal, setRefusal] = useState<Problem | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const unchanged = sameChain(chain, type.approvalChain);

  const save = (): void => {
    setSaving(true);
    setRefusal(undefined);

    setApprovalChain(type.id, chain)
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
  };

  return (
    <>
      {refusal === undefined ? null : <Notice problem={refusal} id={REFUSAL_ID} />}

      <ChainEditor
        chain={chain}
        choices={choices}
        disabled={saving}
        onChange={(next) => {
          setChain(next);
          setRefusal(undefined);
        }}
      />

      <div className="card-actions">
        <button type="button" className="primary" disabled={saving || unchanged} onClick={save}>
          {saving ? 'Saving…' : 'Save this chain'}
        </button>

        <button type="button" className="linkish" disabled={saving} onClick={onCancel}>
          Cancel
        </button>

        {unchanged ? <span className="muted">Nothing has moved yet.</span> : null}
      </div>
    </>
  );
}

/* The shape of the answer while it is on its way. */
function Skeletons() {
  return (
    <ul className="chains">
      {[0, 1, 2, 3, 4, 5].map((one) => (
        <li key={one} className="skeleton is-short" />
      ))}
    </ul>
  );
}
