import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // The whole stylesheet is ~7 KB gzip. Inlining it saves the render-blocking CSS round trip
    // (562 ms of added latency per request on the slow-4G lab profile) before the first paint,
    // which is also the landing LCP. See ops/performance/initial-load-profile.md.
    inlineCss: true,
  },
  async headers() {
    return [
      {
        // Session, booking, document, and payment responses must never enter a shared cache.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store, max-age=0" }],
      },
    ];
  },
};
export default nextConfig;
