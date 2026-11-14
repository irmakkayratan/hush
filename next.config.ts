import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  async headers() {
    return [{
      source: "/api/:feature(match-note|transcribe|notion-update|reminders)",
      headers: [{ key: "Cache-Control", value: "private, no-store" }],
    }, {
      source: "/hush-worker.js",
      headers: [
        { key: "Cache-Control", value: "no-cache" },
        { key: "Content-Security-Policy", value: "default-src 'self'" },
      ],
    }];
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
