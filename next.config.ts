import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/sql-wasm.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
      // Safari can aggressively cache favicons/touch icons.
      // These headers nudge it to revalidate instead of sticking to stale assets.
      {
        source:
          "/:icon(favicon\\.ico|favicon-16x16\\.png|favicon-32x32\\.png|apple-touch-icon\\.png|apple-touch-icon-precomposed\\.png|logo\\.ico|logo\\.png|logo-180\\.png|logo-192\\.png|logo-512\\.png)",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
