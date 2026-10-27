"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "./primitives";

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  closeLabel: string;
  onClose: () => void;
  actions?: ReactNode;
  description?: string;
}

export function Dialog({
  open,
  title,
  children,
  closeLabel,
  onClose,
  actions,
  description,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const generatedId = useId();
  const titleId = `dialog-title-${generatedId.replace(/:/g, "")}`;
  const descriptionId = description ? `${titleId}-description` : undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="kt-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <div className="kt-dialog__header">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label={closeLabel} className="kt-dialog__close" onClick={onClose} variant="quiet">
          <span aria-hidden="true">×</span><span className="kt-visually-hidden">{closeLabel}</span>
        </Button>
      </div>
      {description ? <p className="kt-dialog__description" id={descriptionId}>{description}</p> : null}
      <div className="kt-dialog__content">{children}</div>
      {actions ? <div className="kt-dialog__actions">{actions}</div> : null}
    </dialog>
  );
}
