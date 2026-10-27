import { buildOfflinePage } from "../../lib/pwa-offline-page";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(buildOfflinePage(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
    },
  });
}
