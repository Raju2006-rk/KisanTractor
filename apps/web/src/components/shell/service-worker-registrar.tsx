"use client";
import { useEffect } from "react";
import { registerSafeServiceWorker, unregisterSafeServiceWorker } from "../../lib/pwa-registration";

export interface ServiceWorkerRegistrarProps {
  readonly enabled: boolean;
}

/** Registers the safe-cache worker after load. Renders nothing and never blocks the page. */
export function ServiceWorkerRegistrar({ enabled }: ServiceWorkerRegistrarProps) {
  useEffect(() => {
    const run = () => {
      void (enabled ? registerSafeServiceWorker(window) : unregisterSafeServiceWorker(window));
    };
    if (document.readyState === "complete") {
      run();
      return;
    }
    window.addEventListener("load", run, { once: true });
    return () => window.removeEventListener("load", run);
  }, [enabled]);
  return null;
}
