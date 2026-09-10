/** The ordered approver roles of one leave type. FR 38a, LMS 503. */

import type { Choice, Desk } from '../../api';
import { Icon } from '../../Icon';

/** The desks, and what each is called. The server's words, never this file's. */
export type DeskChoices = Choice<Desk>[];

/** The chain as it stands, numbered. The position is the policy, so it is shown. */
export function ChainInOrder({ chain, choices }: { chain: Desk[]; choices: DeskChoices }) {
  if (chain.length === 0) {
    return <p className="muted">{NOBODY}</p>;
  }

  return (
    <ol className="chain">
      {chain.map((desk, at) => (
        <li key={desk}>
          <span className="chain-at">{at + 1}</span>
          <span className="chain-desk">{nameOf(desk, choices)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The chain, in order. A list rather than ticks: "HR then the CEO" is not the reverse. */
export function ChainEditor({
  chain,
  choices,
  disabled,
  onChange,
}: {
  chain: Desk[];
  choices: DeskChoices;
  disabled: boolean;
  onChange: (chain: Desk[]) => void;
}) {
  const unused = choices.filter((one) => !chain.includes(one.value));

  const move = (at: number, by: number): void => {
    const moved = [...chain];
    const [desk] = moved.splice(at, 1);
    moved.splice(at + by, 0, desk);
    onChange(moved);
  };

  return (
    <>
      <ol className="chain-edit">
        {chain.map((desk, at) => (
          <li key={desk}>
            <span className="chain-at">{at + 1}</span>
            <span className="chain-desk">{nameOf(desk, choices)}</span>

            <button
              type="button"
              className="linkish"
              disabled={disabled || at === 0}
              onClick={() => {
                move(at, -1);
              }}
            >
              Earlier
            </button>

            <button
              type="button"
              className="linkish"
              disabled={disabled || at === chain.length - 1}
              onClick={() => {
                move(at, 1);
              }}
            >
              Later
            </button>

            <button
              type="button"
              className="linkish"
              disabled={disabled}
              onClick={() => {
                onChange(chain.filter((one) => one !== desk));
              }}
            >
              <Icon name="cross" />
              <span className="visually-hidden">Remove {nameOf(desk, choices)}</span>
            </button>
          </li>
        ))}
      </ol>

      {/* Said here as well as at the request, because this is where it can be fixed. */}
      {chain.length > 0 ? null : <p className="muted">{NOBODY}</p>}

      {unused.length === 0 ? null : (
        <p className="chain-add">
          Add:{' '}
          {unused.map((one) => (
            <button
              key={one.value}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange([...chain, one.value]);
              }}
            >
              <Icon name="plus" />
              {one.label}
            </button>
          ))}
        </p>
      )}
    </>
  );
}

/** Two chains, step for step. */
export function sameChain(one: Desk[], other: Desk[]): boolean {
  return one.length === other.length && one.every((desk, at) => desk === other[at]);
}

const NOBODY = 'Nobody. A request for this type would sit in no queue at all. Add an approver.';

/** The label the server gave the desk, or the token where it named none. */
function nameOf(desk: Desk, choices: DeskChoices): string {
  return choices.find((one) => one.value === desk)?.label ?? desk;
}
