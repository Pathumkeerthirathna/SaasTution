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
