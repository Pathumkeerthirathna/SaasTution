/*
 * PM2 definition of the Jibri stop worker (scripts/jibri-stop-worker.ts),
 * a SEPARATE app next to the existing Next.js app (which keeps running with
 * `npm start` under its own PM2 entry, unchanged).
 *
 * NO SECRETS HERE. Every setting the worker needs comes from a dedicated
 * environment file OUTSIDE the repository, read by Node itself
 * (--env-file, Node >= 20.6; production runs Node 22). The project's .env is
 * never used by the worker (it refuses to start unless its own environment
 * has JIBRI_SERVER_STOP=on, the Jitsi JWT settings and DATABASE_URL).
 *
 *   JIBRI_WORKER_ENV_FILE=/etc/slclassroom/jibri-worker.env \
 *     pm2 start deploy/jibri-worker/ecosystem.config.cjs
 *
 * Execution: `node --env-file=<file> --import tsx scripts/jibri-stop-worker.ts`
 * (tsx registers TypeScript and the "@/..." paths). Requires tsx in
 * node_modules (a devDependency: the install must include devDependencies,
 * which the Next.js build needs anyway). Check with
 * deploy/jibri-worker/preflight.sh before starting. See README.md here.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS PM2 file
const path = require("node:path");

const appDir = path.resolve(__dirname, "..", "..");
const envFile = process.env.JIBRI_WORKER_ENV_FILE || "/etc/slclassroom/jibri-worker.env";

module.exports = {
  apps: [
    {
      name: "slclassroom-jibri-worker",
      cwd: appDir,
      script: "scripts/jibri-stop-worker.ts",
      interpreter: "node",
      interpreter_args: `--env-file=${envFile} --import tsx`,

      // One process (more are safe: every attempt is serialized by database
      // locks, but they add nothing).
      instances: 1,
      exec_mode: "fork",

      // Restart policy: always restarted; a crash loop backs off instead of
      // hammering Jitsi or the database; stopped after 10 quick failures
      // (then its liveness goes stale and the app reports it).
      autorestart: true,
      min_uptime: "60s",
      max_restarts: 10,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "300M",

      // SIGINT/SIGTERM: the worker finishes the attempt in flight (its lock
      // budget is 40 s) before exiting.
      kill_timeout: 45000,

      // Logs: outcome codes only (never tokens, names or student JIDs).
      // Rotation: pm2-logrotate (see README.md), not here.
      time: true,
      merge_logs: true,
      out_file: path.join(process.env.HOME || "/root", ".pm2", "logs", "slclassroom-jibri-worker-out.log"),
      error_file: path.join(process.env.HOME || "/root", ".pm2", "logs", "slclassroom-jibri-worker-error.log"),

      // Non-secret only.
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
