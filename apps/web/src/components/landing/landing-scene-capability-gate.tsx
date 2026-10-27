"use client";

import { useEffect } from "react";

import type { Landing3dOutcome } from "@kisantractor/observability/landing-3d";

import {
  applyLandingSceneDecision,
  assessLandingSceneCapability,
  detectGpuConfidence,
  heroSceneSlot,
  landingSceneEvents,
  type GraphicsCanvasLike,
  type LandingEnhancementSignals,
} from "./landing-enhancement";
import { landing3dOutcomeForFallback, reportLanding3dOutcome } from "./landing-3d-telemetry";

interface NavigatorWithCapabilityHints extends Navigator {
  readonly connection?: EventTarget & { readonly saveData?: boolean };
  readonly deviceMemory?: number;
}

interface SceneFailureDetail {
  readonly outcome?: "FAILED" | "TIMED_OUT";
}

/** Maximum wait after eligibility before the poster becomes the measured timeout fallback. */
export const landingSceneLoadTimeoutMs = 8_000;

function matchesMedia(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function browserSignals(serverDataSaver: boolean, sceneLoadFailed: boolean): LandingEnhancementSignals {
  const hints = navigator as NavigatorWithCapabilityHints;
  const canvas = document.createElement("canvas") as unknown as GraphicsCanvasLike;
  return {
    scriptsAvailable: true,
    prefersReducedMotion: matchesMedia("(prefers-reduced-motion: reduce)"),
    dataSaver: serverDataSaver || hints.connection?.saveData === true || matchesMedia("(prefers-reduced-data: reduce)"),
    deviceMemoryGb: hints.deviceMemory,
    gpuConfidence: detectGpuConfidence(canvas),
    sceneLoadFailed,
  };
}

export interface LandingSceneCapabilityGateProps {
  /** Carries the HTTP Save-Data decision into the client capability check. */
  readonly serverDataSaver?: boolean;
}

/**
 * Evaluates browser-only signals after hydration. It only annotates the media
 * slot and emits eligibility; the complete server-rendered landing page stays
 * present for disabled scripting and every fallback outcome. One terminal,
 * bounded outcome is sent to first-party production telemetry per page view.
 */
export function LandingSceneCapabilityGate({ serverDataSaver = false }: LandingSceneCapabilityGateProps) {
  useEffect(() => {
    const slot = document.querySelector<HTMLElement>(`[data-enhancement-slot="${heroSceneSlot}"]`);
    if (!slot) return;

    const motion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const reducedData = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-data: reduce)") : null;
    const connection = (navigator as NavigatorWithCapabilityHints).connection;
    let sceneLoadFailed = false;
    let sceneLoaded = false;
    let eligibilityAnnounced = false;
    let loadTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearLoadTimeout = () => {
      if (loadTimeout !== undefined) clearTimeout(loadTimeout);
      loadTimeout = undefined;
    };
    const reportOnce = (outcome: Landing3dOutcome) => {
      if (slot.hasAttribute("data-scene-telemetry-reported")) return;
      slot.setAttribute("data-scene-telemetry-reported", outcome);
      reportLanding3dOutcome(outcome);
    };
    const fail = (outcome: "FAILED" | "TIMED_OUT") => {
      if (sceneLoaded || sceneLoadFailed) return;
      sceneLoadFailed = true;
      clearLoadTimeout();
      evaluate();
      reportOnce(outcome);
    };
    const evaluate = () => {
      const decision = assessLandingSceneCapability(browserSignals(serverDataSaver, sceneLoadFailed));
      applyLandingSceneDecision(slot, decision);
      if (!decision.enhance) {
        clearLoadTimeout();
        if (!sceneLoadFailed) reportOnce(landing3dOutcomeForFallback(decision.reason));
        return;
      }

      slot.setAttribute("data-scene-state", sceneLoaded ? "loaded" : "eligible");
      if (sceneLoaded) {
        clearLoadTimeout();
        reportOnce("LOADED");
      } else if (!eligibilityAnnounced) {
        eligibilityAnnounced = true;
        loadTimeout = setTimeout(() => fail("TIMED_OUT"), landingSceneLoadTimeoutMs);
        window.dispatchEvent(new CustomEvent(landingSceneEvents.eligible));
      }
    };
    const onLoaded = () => {
      sceneLoaded = true;
      sceneLoadFailed = false;
      evaluate();
    };
    const onLoadFailed = (event: Event) => {
      const detail = (event as CustomEvent<SceneFailureDetail>).detail;
      fail(detail?.outcome === "TIMED_OUT" ? "TIMED_OUT" : "FAILED");
    };

    window.addEventListener(landingSceneEvents.loaded, onLoaded);
    window.addEventListener(landingSceneEvents.loadFailed, onLoadFailed);
    motion?.addEventListener("change", evaluate);
    reducedData?.addEventListener("change", evaluate);
    connection?.addEventListener("change", evaluate);
    evaluate();

    return () => {
      clearLoadTimeout();
      window.removeEventListener(landingSceneEvents.loaded, onLoaded);
      window.removeEventListener(landingSceneEvents.loadFailed, onLoadFailed);
      motion?.removeEventListener("change", evaluate);
      reducedData?.removeEventListener("change", evaluate);
      connection?.removeEventListener("change", evaluate);
    };
  }, [serverDataSaver]);

  return null;
}
