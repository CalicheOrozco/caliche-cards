import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/sql-wasm.wasm",
        headers: [{ key: "Content-Type", value: "application/wasm" }],
      },
    ];
  },
};

export default nextConfig;
