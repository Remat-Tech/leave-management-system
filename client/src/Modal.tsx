/** A dialog over the page. LMS 501. */

import { type ReactNode, useEffect, useRef } from 'react';
import { Icon } from './Icon';

/**
 * The platform's own dialog, opened imperatively.
 *
 * `showModal()` rather than the `open` attribute, because only the method buys what a modal
 * has to do: the top layer, a focus trap, the rest of the page made inert, and Escape. Every
 * one of those is a thing this file would otherwise have to write and keep right.
 *
 * `onClose` is wired to the element's own `close` event rather than to each button, so
 * Escape, the close button and a click on the backdrop all leave by one door.
 */
export function Modal({
  title,
  tags,
  actions,
  onClose,
  children,
}: {
  title: string;
  /** Pills beside the heading — a code, a state. */
  tags?: ReactNode;
  /** The buttons at the foot. Left out where there is nothing to do but read. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const close = (): void => {
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      className="modal"
      onClose={onClose}
      /* The backdrop is the dialog's own box, so a press that lands on the element itself
         rather than on anything inside it is a press outside the panel. */
      onClick={(event) => {
        if (event.target === dialog.current) {
          close();
        }
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        {tags}

        <button type="button" className="modal-close" onClick={close}>
          <Icon name="cross" />
          <span className="visually-hidden">Close</span>
        </button>
      </div>

      <div className="modal-body">{children}</div>

      {actions === undefined ? null : <div className="modal-actions">{actions}</div>}
    </dialog>
  );
}
