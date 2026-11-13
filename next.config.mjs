/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ESLint is enforced separately via `npm run lint`. The production build only
  // needs it to not fail on pre-existing lint debt (unused vars, `any`, etc.)
  // across the codebase; type-checking below stays enabled and is still gating.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // instrumentation.ts: starts the teacher-departure sweeper once per
  // long-running server process (Next.js 14.2 needs this flag for the hook).
  experimental: {
    instrumentationHook: true,
  },
  // Password-reset pages only (Student Profile SP-7E): a reset address must
  // never leave in a Referer header. Other routes are unaffected.
  async headers() {
    return ["/reset-password", "/reset-password/:path*"].map((source) => ({
      source,
      headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
    }));
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default nextConfig;
