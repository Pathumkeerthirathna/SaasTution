# Jibri stop worker: deployment runbook

The worker (`scripts/jibri-stop-worker.ts`) stops an orphaned classroom Jibri after a teacher's tab closes, and releases the teacher's shutdown fence only on evidence. It runs as a **separate PM2 app** next to the Next.js app. The Next.js app keeps running with `npm start` under its own PM2 entry, unchanged.

Nothing in this folder has been run against production. Every step below is for a person to perform.

## Files

| File | Purpose |
|---|---|
| `ecosystem.config.cjs` | PM2 app `slclassroom-jibri-worker`. No secrets. |
| `jibri-worker.env.example` | Variable names only. Copy it outside the repository and fill it in. |
| `preflight.sh` | Read-only checks before starting. It never connects to anything and never prints a value. |

## Package manager: confirm first

What the repository shows (as of 2026-10-31):

- `package-lock.json` (npm, lockfileVersion 3) at HEAD covers every HEAD dependency. It was last committed on 2026-09-20 and pins `tsx` 4.22.4 (dev).
- `pnpm-lock.yaml` at HEAD dates from 2026-05-05, the Netlify period (`netlify.toml`: `pnpm build`). It is missing 9 HEAD dependencies, so it has not been maintained since.
- The README documents `npm install`. There is no `packageManager` field.
- This development machine's `node_modules` was last installed with pnpm (`.modules.yaml`, 2026-10-31), over an earlier npm install (`.package-lock.json`, 2026-09-20).
- `@xmpp/client` (needed by the worker) is in the local `pnpm-lock.yaml` change, but **not** in `package-lock.json`.

The evidence points to npm on the VPS, but it does not prove it. Confirm on the VPS, read-only: is `node_modules/.package-lock.json` (npm) or `node_modules/.modules.yaml` (pnpm) present, and which install command does the deploy procedure run? Then regenerate **only that** lockfile with `@xmpp/client@0.14.0`, and review its diff. Neither lockfile has been changed for this.

## Execution strategy

**Chosen: TypeScript through tsx.** The PM2 config runs:

```
node --env-file=<worker env file> --import tsx scripts/jibri-stop-worker.ts
```

- Node 22 supports `--env-file` and `--import`. The VPS runs Node 22.23.2.
- tsx compiles TypeScript and resolves the `@/...` paths, exactly as the test suites do.
- `tsx` is a **devDependency**, so the production install must include devDependencies. A `next build` on the VPS needs them anyway. `preflight.sh` fails if tsx is missing.
- The worker reads **only** its own env file. If its environment lacks `JIBRI_SERVER_STOP=on`, the Jitsi JWT settings or `DATABASE_URL`, it exits before loading Prisma (Prisma would otherwise load the project's `.env`).

**Alternative: compiled JavaScript (not prepared).** Bundle with esbuild, which the npm lockfile already pins as a dev dependency. For example: `esbuild scripts/jibri-stop-worker.ts --bundle --platform=node --target=node22 --external:@prisma/client --external:.prisma --external:@xmpp/client --outfile=dist/jibri-stop-worker.cjs`. Run it with `node --env-file=<file> dist/jibri-stop-worker.cjs`. This removes the runtime need for tsx, but it adds a build step, and the bundle must be re-tested: the delayed loading of Prisma must survive bundling. Treat it as a later hardening.

## Environment

1. Copy `jibri-worker.env.example` to `/etc/slclassroom/jibri-worker.env`, outside the repository.
2. Give it to the PM2 user with mode `600`. Fill it from the same source as the app's environment.
3. **The Jitsi settings must equal the app's**: domain, WebSocket URL, MUC and recorder domains, focus JID, JWT issuer, JWT audience and JWT secret. The app compares them field by field (the secret only through a non-reversible fingerprint). Any difference makes the worker `unavailable`, and switching the mode to "on" is refused.
4. Set `JITSI_JWT_ISS` and `JITSI_JWT_AUD` explicitly, even when the app uses the defaults.
5. Never commit the real file.

## Preflight (read-only)

```
deploy/jibri-worker/preflight.sh /etc/slclassroom/jibri-worker.env [the app's env file]
```

It checks:
- the Node version;
- that tsx, `@xmpp/client` and `@prisma/client` are installed;
- that the generated Prisma client is current;
- the env file's location, permissions and required variable names;
- optionally, that the Jitsi settings equal the app's (reported as matches or differs only);
- that PM2 and pm2-logrotate are present.

Exit 1 means there is a blocker.

## Log rotation and restart policy

- **Rotation:** use pm2-logrotate, for example:
  ```
  pm2 install pm2-logrotate
  pm2 set pm2-logrotate:max_size 10M
  pm2 set pm2-logrotate:retain 14
  pm2 set pm2-logrotate:compress true
  ```
  The worker logs outcome codes only: never tokens, names or student JIDs.
- **Restarts:**
  - always restarted, with exponential back-off;
  - stops after 10 restarts that each fail within 60 s. Its liveness then goes stale, and the app reports the worker as unavailable;
  - `kill_timeout` is 45 s, longer than the 40 s attempt budget, so an attempt in flight finishes;
  - memory cap 300 MB.

## Activation order

1. Apply the migrations on the target database with `prisma migrate deploy`. The mode stays `off`.
2. Deploy the app code (`prisma generate`, build, restart the app).
3. Run `preflight.sh` and fix every FAIL.
4. Start the worker: `JIBRI_WORKER_ENV_FILE=/etc/slclassroom/jibri-worker.env pm2 start deploy/jibri-worker/ecosystem.config.cjs`, then `pm2 save`.
5. Check the admin page **Classroom stream shutdown**:
   - Worker shows "Not required (mode off)";
   - **Ready for mode on: Yes**: fresh liveness, every identity row "matches", a completed sweep, a recent login to the expected Jitsi server;
   - no connection error.
6. An administrator sets the mode to **on**, with a reason. The app refuses unless the worker is ready.

## Rollback order

1. Set **drain**: nothing new is armed and no STOP is sent; open fences are still verified.
2. Wait until no fence is open, or override the remaining ones after checking the Jibri server and YouTube. Overrides are audited.
3. Set **off**.
4. `pm2 stop slclassroom-jibri-worker`, then `pm2 delete slclassroom-jibri-worker`.

Never stop the worker while the mode is on or drain with fences open: those teachers' starts would get 503 until it returns. The audit tables (`JibriShutdownOverride`, `JibriShutdownModeChange`) are never dropped.
