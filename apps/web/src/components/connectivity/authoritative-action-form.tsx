"use client";

import { useEffect, useRef, useState, type FormEvent, type FormHTMLAttributes, type ReactNode } from "react";

import {
  beginAttempt,
  clearAttemptFamily,
  isDeviceOnline,
  loadAttempt,
  resumeNotice,
  sanitizeSafeDraft,
  saveAttempt,
  type SafeDraftFields,
  type StorageLike,
} from "../../lib/authoritative-action";

/** Pre-rendered, localized copy so this client component never bundles translation catalogs. */
export interface AuthoritativeActionMessages {
  readonly offlineBlocked: string;
  readonly unknownOutcome: string;
  readonly draftRestored: string;
}

export interface AuthoritativeActionFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "method" | "onSubmit" | "children"> {
  readonly action: string;
  /** Groups the actions one server outcome settles, such as every job control of one booking. */
  readonly family: string;
  /** Identifies this action within its family; must start with `${family}:`. */
  readonly actionId: string;
  /** Rendered as the hidden `idempotencyKey` field. Omit for version-guarded actions. */
  readonly idempotencyKey?: string;
  /** Visible, non-sensitive field names that are kept as a safe draft. */
  readonly draftFields?: readonly string[];
  /** True when this page already reports the server outcome for this family. */
  readonly outcomeReported?: boolean;
  readonly messages: AuthoritativeActionMessages;
  readonly children: ReactNode;
}

type Notice = "NONE" | "OFFLINE" | "UNKNOWN" | "RESTORED";

const tabStorage = (): StorageLike | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

const fieldElement = (form: HTMLFormElement, name: string) => {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element
    : undefined;
};

function readDraftFields(form: HTMLFormElement, names: readonly string[]): SafeDraftFields {
  const values: Record<string, string | boolean> = {};
  for (const name of names) {
    const element = fieldElement(form, name);
    if (!element || (element instanceof HTMLInputElement && (element.type === "hidden" || element.type === "password"))) continue;
    values[name] = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked : element.value;
  }
  return sanitizeSafeDraft(values, names);
}

function restoreDraftFields(form: HTMLFormElement | null, fields: SafeDraftFields): void {
  if (!form) return;
  for (const [name, value] of Object.entries(fields)) {
    const element = fieldElement(form, name);
    if (!element || (element instanceof HTMLInputElement && element.type === "hidden")) continue;
    if (element instanceof HTMLInputElement && element.type === "checkbox") element.checked = value === true;
    else if (typeof value === "string") element.value = value;
  }
}

/**
 * A native form for one Authoritative Action. It never queues: an offline press sends nothing and
 * keeps the entries and idempotency key for the user's next explicit press. If a sent request's
 * outcome never reached the page (for example the connection dropped mid-request), the next visit
 * restores the same key so the explicit retry cannot record the action twice.
 */
export function AuthoritativeActionForm({
  action,
  actionId,
  children,
  draftFields = [],
  family,
  idempotencyKey,
  messages,
  outcomeReported = false,
  ...formProps
}: AuthoritativeActionFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState(idempotencyKey);
  const [notice, setNotice] = useState<Notice>("NONE");
  const draftFieldList = draftFields.join("\u0000");

  useEffect(() => {
    setKey(idempotencyKey);
    const storage = tabStorage();
    const resume = () => {
      if (outcomeReported) {
        clearAttemptFamily(storage, family);
        return;
      }
      const attempt = loadAttempt(storage, actionId, Date.now());
      const next = resumeNotice(attempt, false);
      if (attempt === undefined || next === "NONE") return;
      if (attempt.idempotencyKey !== undefined) setKey(attempt.idempotencyKey);
      restoreDraftFields(formRef.current, attempt.fields);
      setNotice(next === "UNKNOWN" ? "UNKNOWN" : "RESTORED");
    };
    resume();
    // A page restored from the back-forward cache after a failed navigation keeps its old state.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resume();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [actionId, family, idempotencyKey, outcomeReported]);

  useEffect(() => {
    if (notice === "OFFLINE") noticeRef.current?.focus();
  }, [notice]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const storage = tabStorage();
    const now = Date.now();
    const names = draftFieldList ? draftFieldList.split("\u0000") : [];
    const { attempt, decision } = beginAttempt({
      actionId,
      existing: loadAttempt(storage, actionId, now),
      ...(key === undefined ? {} : { renderedKey: key }),
      online: isDeviceOnline(window),
      fields: readDraftFields(form, names),
      now,
    });
    saveAttempt(storage, attempt);
    if (attempt.idempotencyKey !== undefined && attempt.idempotencyKey !== key) {
      const hidden = form.elements.namedItem("idempotencyKey");
      if (hidden instanceof HTMLInputElement) hidden.value = attempt.idempotencyKey;
      setKey(attempt.idempotencyKey);
    }
    if (decision === "BLOCK_OFFLINE") {
      event.preventDefault();
      setNotice("OFFLINE");
      return;
    }
    setNotice("NONE");
  };

  const noticeText = notice === "OFFLINE" ? messages.offlineBlocked
    : notice === "UNKNOWN" ? messages.unknownOutcome
      : notice === "RESTORED" ? messages.draftRestored : undefined;

  return (
    <form action={action} method="post" onSubmit={onSubmit} ref={formRef} {...formProps}>
      {noticeText ? (
        <div
          className={`kt-action-notice kt-action-notice--${notice === "RESTORED" ? "info" : "warning"}`}
          ref={noticeRef}
          role={notice === "RESTORED" ? "status" : "alert"}
          tabIndex={-1}
        >
          <p>{noticeText}</p>
        </div>
      ) : null}
      {key !== undefined ? <input name="idempotencyKey" type="hidden" value={key} /> : null}
      {children}
    </form>
  );
}
