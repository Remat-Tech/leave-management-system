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
import { Modal } from '../../Modal';
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

  const changing = settings.types.find((one) => one.id === editing);

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
            onEdit={() => {
              setEditing(type.id);
            }}
          />
        ))}
      </ul>

      {/* The editor is a dialog rather than a panel that opens inside the card. A grid row
          is as tall as its tallest tile, so growing one card pushed every card beside it
          down with it. Nothing on the page moves now. Looked up fresh, so a save that
          reloads the list cannot leave a stale copy on screen. */}
      {changing === undefined ? null : (
        <Modal
          title={`Who approves ${changing.name}`}
          onClose={() => {
            setEditing(undefined);
          }}
        >
          <ChainForm
            type={changing}
            choices={settings.choices.approvers}
            onSaved={() => {
              setEditing(undefined);
              load();
            }}
            onCancel={() => {
              setEditing(undefined);
            }}
            onSignedOut={onSignedOut}
          />
        </Modal>
      )}
    </div>
  );
}

/** One kind of leave and its chain. Read only: changing it happens in the dialog. */
function ChainCard({
  type,
  choices,
  onEdit,
}: {
  type: ConfiguredLeaveType;
  choices: DeskChoices;
  onEdit: () => void;
}) {
  return (
    <li className={`card chain-card${type.isActive ? '' : ' dormant'}`}>
      <div className="card-head">
        <span className="chip">
          <Icon name={iconForLeaveType(type.name)} />
        </span>

        <h3>{type.name}</h3>

        {/* No code pill. This screen is about who signs a request, the name is what
            identifies the type on it, and the code was taking the width a long name
            needed. Leave types is where a code is the point. */}
        <div className="tags">
          {type.isActive ? null : <span className="tag">Retired</span>}
          {type.approvalChain.length === 0 ? (
            <span className="tag is-nobody">Nobody approves it</span>
          ) : null}
        </div>
      </div>

      <ChainInOrder chain={type.approvalChain} choices={choices} />

      {/* The chain as a sentence, with the pencil on the end of it: that sentence is what
          the button changes, so it sits beside it rather than under a rule of its own. The
          label is the button's accessible name, because a control with no words still has
          to say what it does and which chain it does it to. NFR USA 03. */}
      <p className="rules">
        <Icon name="stage" />
        {type.approvedByLabel}

        <button type="button" className="iconic trailing" onClick={onEdit}>
          <Icon name="pencil" />
          <span className="visually-hidden">Change who approves {type.name}</span>
        </button>
      </p>
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

      <div className="modal-actions">
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
