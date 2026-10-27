import { buildServiceWorkerScript } from "../../lib/pwa-service-worker";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildServiceWorkerScript(), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Browsers must always revalidate the worker so policy changes roll out promptly.
      "cache-control": "no-cache, max-age=0, must-revalidate",
      "service-worker-allowed": "/",
      "x-content-type-options": "nosniff",
    },
  });
}
