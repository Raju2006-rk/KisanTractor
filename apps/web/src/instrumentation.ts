/**
 * Next.js server start hook. Subscribes server-rendered translation misses
 * (Requirement 13.3) to web telemetry. Only the Node.js runtime loads the
 * Node-based telemetry package.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ subscribeToTranslationMisses }, { createTranslationMissRecorder }, { webTelemetry }] = await Promise.all([
    import("@kisantractor/i18n"),
    import("@kisantractor/observability"),
    import("./lib/telemetry"),
  ]);
  subscribeToTranslationMisses(createTranslationMissRecorder(webTelemetry(), "WEB"));
}
