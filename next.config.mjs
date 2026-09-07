/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ESLint is enforced separately via `npm run lint`. The production build only
  // needs it to not fail on pre-existing lint debt (unused vars, `any`, etc.)
  // across the codebase; type-checking below stays enabled and is still gating.
  eslint: {
    ignoreDuringBuilds: true,
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
