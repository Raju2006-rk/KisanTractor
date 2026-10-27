"use client";

import { useEffect, useState } from "react";

import { isDeviceOnline } from "../../lib/authoritative-action";

export interface ConnectivityStatusProps {
  readonly offlineMessage: string;
  readonly reconnectedMessage: string;
}

type Connectivity = "ONLINE" | "OFFLINE" | "RECONNECTED";

/**
 * Announces connectivity changes. It only displays state: reconnecting never sends, retries, or
 * refetches anything on the user's behalf.
 */
export function ConnectivityStatus({ offlineMessage, reconnectedMessage }: ConnectivityStatusProps) {
  const [state, setState] = useState<Connectivity>("ONLINE");

  useEffect(() => {
    const sync = () => setState((previous) => (isDeviceOnline(window)
      ? previous === "OFFLINE" ? "RECONNECTED" : previous
      : "OFFLINE"));
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return (
    <div aria-live="polite" className={`kt-connectivity kt-connectivity--${state.toLowerCase()}`} role="status">
      {state === "OFFLINE" ? <p>{offlineMessage}</p> : null}
      {state === "RECONNECTED" ? <p>{reconnectedMessage}</p> : null}
    </div>
  );
}
