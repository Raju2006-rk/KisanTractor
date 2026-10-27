import type { ReactNode } from "react";

import { Button } from "./primitives";

export interface EmptyStateProps {
  title: string;
  message: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, message, icon, action }: EmptyStateProps) {
  return (
    <section aria-label={title} className="kt-state kt-state--empty">
      {icon ? <div aria-hidden="true" className="kt-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{message}</p>
      {action ? <div className="kt-state__action">{action}</div> : null}
    </section>
  );
}

export interface ErrorStateProps {
  title: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  reference?: string;
}

export function ErrorState({ title, message, retryLabel, onRetry, reference }: ErrorStateProps) {
  return (
    <section aria-label={title} className="kt-state kt-state--error" role="alert">
      <div aria-hidden="true" className="kt-state__icon">!</div>
      <h2>{title}</h2>
      <p>{message}</p>
      {reference ? <p className="kt-state__reference">Reference: {reference}</p> : null}
      {retryLabel && onRetry ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
    </section>
  );
}
