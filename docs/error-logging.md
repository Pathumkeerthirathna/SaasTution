# Error logging

SLClassroom records unexpected errors in local JSON Lines files on the server. Nothing is sent to an external service or stored in the database, and no emails are sent.

## What is captured, and where

| Source | Caught by | Log file |
|---|---|---|
| Browser: uncaught exceptions | `GlobalErrorListener` (`window` `error` event), mounted in `app/layout.tsx` | `client-errors.jsonl` |
| Browser: unhandled promise rejections | `GlobalErrorListener` (`unhandledrejection`) | `client-errors.jsonl` |
| React rendering errors (client and server components) | `app/error.tsx`, `app/session/join/error.tsx`, `app/global-error.tsx` | `client-errors.jsonl` (`source: "react"`) |
| API routes: unexpected exceptions | `handleRouteError(error, { request })` in `lib/error-handler.ts` (used by most routes), `reportRouteError` (routes with their own catch block), or `withApiErrorHandling` | `api-errors.jsonl` |
| Server process: unhandled rejections, uncaught exceptions | the process monitor in `lib/error-logging/server-logger.ts` | `server-errors.jsonl` |

Browsers never write files. They send a small report to `POST /api/client-errors`, and the server writes it.

Expected errors are not logged:

- `AppError` (validation, permissions, "not found"…) and invalid JSON keep their usual 4xx responses.
- Next.js control flow (`redirect()`, `notFound()`, dynamic-rendering bailouts during `next build`) is ignored.

## Code

```
lib/error-logging/
  sanitize.ts        redaction, length limits, route sanitizing, error normalizing (browser + server)
  types.ts           log entry shape, channels
  file-sink.ts       JSON Lines files: directory, queue, rotation (server only)
  server-logger.ts   builds and writes entries; installs the process monitor (server only)
  client-reporter.ts browser side: dedupes, caps, sends the report (sendBeacon / fetch)
  client-report.ts   the report schema the endpoint accepts (zod)
  rate-limit.ts      in-memory rate limiter for the endpoint
  constants.ts       endpoint path, body size limit
app/api/client-errors/route.ts      browser report endpoint
components/error-reporting/         GlobalErrorListener, useErrorReport (boundaries)
app/error.tsx, app/global-error.tsx, app/session/join/error.tsx
```

### Using it in API routes

Every API route passes its own incoming request to the handler. The context is required: TypeScript rejects a call without it.

```ts
export async function GET(request: Request) {
  try {
    // ...
  } catch (error) {
    return handleRouteError(error, { request });
  }
}
```

- **Where the details come from:** the route path, HTTP method and User-Agent in the log come only from that `Request`. No Next.js internals (`staticGenerationAsyncStorage`) or `next/headers` are used, so the logger does not depend on the Next.js version.
- **Passing the request has no cost on success:** the request is read only after an unexpected error, and never during `next build`. Adding the parameter did not change any route's static/dynamic classification: `health` is static before and after, and `teacher/master/*` is dynamic in both the baseline and the updated build.
- **Responses from `handleRouteError`:**

  | Error | Response | Logged |
  |---|---|---|
  | `AppError` | its message, status, code and details, unchanged | no |
  | `SyntaxError` (invalid JSON body) | 400 `INVALID_JSON`, "Invalid JSON payload.", unchanged | no |
  | anything else | 500 `INTERNAL_SERVER_ERROR` | yes, with status 500 |

  In production, the 500's message is always "An unexpected error occurred. Please try again.", never the raw exception message, stack or file path. In development (and when `NODE_ENV` is unset) it keeps the raw message for diagnosis. The response's shape is the same either way. The full, sanitized error is in the log.
- **Routes with their own catch block** call `reportRouteError(error, { request, statusCode })`, passing the status their response actually uses (default 500), so the log records it. It logs unexpected errors only (not `AppError`) and never changes the response. For values that must not reach clients in production, such as a raw error or its message, use `developmentOnly(value)`: it returns the value in development and `undefined` in production, where JSON leaves the field out.
- **New routes:** wrap the handler instead of writing try/catch:

```ts
import { withApiErrorHandling } from "@/lib/error-handler";

export const POST = withApiErrorHandling(async (request) => {
  // ...
  return apiSuccess(data);
});
```

## Log format

There is one JSON object per line. Every string is already sanitized.

```json
{"id":"0b9c…","timestamp":"2026-11-02T03:14:00.000Z","source":"api","kind":"unhandled-route-error","environment":"production","name":"Error","message":"…","stack":"Error: …\n    at …","route":"/api/lectures/3f1c…","method":"POST","statusCode":500,"browser":"Mobile Safari 17.5","os":"iOS 17.5","deviceType":"mobile"}
```

| Field | Meaning |
|---|---|
| `source` | `client`, `react`, `api` or `server` |
| `kind` | What caught it, e.g. `window-error`, `unhandled-rejection`, `error-boundary:classroom`, `unhandled-route-error`, `uncaught-exception` |
| `digest` | The Next.js error digest. For a server-rendering error it links the browser's report to the server console line with the same digest. |
| `clientEventId` | The "Reference" shown to the user on an error screen. Search for it when someone reports a problem. |
| `route` | The path only; query strings are never stored |

## Privacy

Never written:

- request bodies, query strings, headers, cookies or IP addresses;
- local storage, and the browser's form data.

Not guaranteed to be absent:

- **Names and other free text.** A name (or an address, or other personal text) inside an error message or stack is not currently redacted: only the patterns listed below are.
- **Record IDs.** The route keeps the actual path, so record UUIDs in it stay, for example `/api/student/Profile/<StudentId>`. A UUID can identify a user to anyone with database access.

Treat the log files as personal data: restrict who can read them.

Before writing, every text field (message, stack, route) is cut to its length limit and then scrubbed:

- JWTs, `Bearer`/`Basic` credentials, and opaque tokens of 32+ characters that mix letters and digits;
- `password=…`, `token: …`, `secret`, `apiKey`, `invite`, `otp`… values, and "password is …";
- `Cookie:` / `Set-Cookie:` headers, through the end of the line;
- email addresses;
- Sri Lankan NIC numbers (9 digits + V/X, or 12 digits), mobile and landline numbers, and `+` international numbers;
- query strings after URLs and after paths (`GET /api/x?studentId=…` becomes `GET /api/x?[query]`);
- terminal control characters and Unicode direction overrides (so a hostile report cannot rewrite the screen of someone reading the log).

Record IDs (UUIDs), digests and timestamps stay readable. Path segments that look like tokens or emails become `:redacted`.

**Prisma errors** are reduced to the error name, the code (`P2002`…), the operation (`prisma.student.create()`), model and field names, and the message's last line (for example "Unknown argument `nic`."). A `PrismaClientValidationError` prints the whole query, with the student's name, NIC, address and so on, so its message and the stack's copy of it are never kept.

The sanitizing patterns all run in linear time on input already cut to the field limit, so a hostile report cannot make the server slow.

**Console lines (PM2 log).** For an unexpected API error, the console shows one sanitized line instead of the raw error, for example `Unhandled route error: Error: … (error log <id>)`. Find the full, sanitized details in the log by that ID.

These lines are rate-limited to 30 per minute per process, so an error burst cannot flood the PM2 log. Lines over the limit are counted, not printed, and the next printed line ends with `[N earlier route error line(s) not printed: console limit; all are in the error log]`. File logging is independent of this limit: every error is still written to `api-errors.jsonl`, subject only to the file's own byte budget and queue limit. Next.js's own console output (for example server-rendering errors) is not under the application's control and is not sanitized.

Users never see technical details. Error screens show a friendly message, safe actions and a reference.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ERROR_LOG_DIR` | `./logs/errors` (relative to the app's working directory) | Where the files are written. Production: `/var/log/slclassroom/errors` |
| `ERROR_LOG_MAX_BYTES` | `5242880` (5 MiB) | A file larger than this is rotated (min 64 KiB) |
| `ERROR_LOG_MAX_FILES` | `5` | Rotated files kept per log (`.1` newest … `.5` oldest; min 1, max 50) |
| `ERROR_LOG_BYTES_PER_MINUTE` | `1048576` (1 MiB) | Per log file per minute; entries beyond it are dropped and counted (min 16 KiB) |
| `ERROR_LOG_DISABLED` | unset | `1` turns file logging off |
| `NEXT_PUBLIC_APP_URL` / `APP_URL` | unset | The public address (e.g. `https://slclassroom.live`). Browser reports from this origin are accepted even when a reverse proxy changes the `Host` header. |
| `TRUSTED_PROXY_COUNT` | `0` | Number of reverse proxies you control between the internet and the app. It must match the real proxy chain: each proxy must append to `X-Forwarded-For`. Only then are `X-Forwarded-For` (client address for rate limiting) and `X-Forwarded-Host` used. |

- **Rotation:** with the defaults, each log uses at most about 30 MiB (current file plus 5 rotated), so about 90 MiB for all three.
- **Budget and queue:** at most 1 MiB per log per minute, and at most 1,000 entries waiting per log. What is dropped is counted, and a `log-entries-dropped` line saying how many is written before the next entry.
- **Folder creation:** the directory is created on the first entry if permissions allow.

### Browser reports: who is accepted, and limits

- **Origin:** a report must carry an `Origin` header. Browsers send it on every POST, same-origin ones included, and the reporter only sends POSTs (`sendBeacon`, or `fetch` as a fallback). It is accepted when it is:
  - the configured app URL, compared as a whole origin (scheme, host and port: `http://slclassroom.live` does not match `https://slclassroom.live`); or
  - the host of the `Host` header the request arrived with; or
  - `X-Forwarded-Host`, only with `TRUSTED_PROXY_COUNT` set.
- **Sec-Fetch-Site:** the reporter posts to its own origin, so when the browser sends this header it must be `same-origin`. `same-site`, `cross-site` and `none` are refused. Older browsers (Safari before 16.4) do not send it; `Origin` still applies to them.
- **Refused with 403 and an empty body:** no `Origin` (for example `curl` or a script), an opaque or malformed `Origin` (`null`, `file:`), another site, or a cross-site `Sec-Fetch-Site`. These checks run before the rate limits, so refused requests use none of the reporting quota.
- **Rejected origins:** they produce at most one console warning every 10 minutes, with the count and the origin hosts only, for example `[error-log] rejected 3 browser error report(s) from untrusted origin(s): …`. If that host is your own site, set `APP_URL`.
- **Rate limits:**
  - 120 reports per minute in total;
  - 20 per minute per client, but only when a trusted proxy identifies the client: the address it appended to `X-Forwarded-For`, never the client-supplied first entry;
  - without a trusted proxy, only the total limit applies, so users are never pooled under one per-client limit;
  - `X-Real-IP` and other client-settable address headers are never used. If `X-Forwarded-For` has fewer entries than `TRUSTED_PROXY_COUNT`, the client is treated as unidentified.
- **Limitation: the headers are not authentication.** They stop other websites (a browser cannot forge `Origin` or `Sec-Fetch-Site`) and clients that send no browser headers. A script can copy the headers, though. Such a script is then held only by the rate limits:
  - behind a correctly configured trusted proxy, 20 reports a minute per client address;
  - without one, the 120-a-minute total, which it can use up, delaying genuine reports for that minute;
  - in both cases the client log's byte budget caps what it can write.

  It can write only to `client-errors.jsonl`, never to the API or server logs, and its text is sanitized like any other report. Treat browser reports as unverified input.
- **Disk:** the client log's byte budget caps what a flood can write.

### Persistent storage (production)

The application never creates `/var/log/...` or changes permissions. At start-up it checks the log directory and prints the result once:

- `[error-log] error logs: /var/log/slclassroom/errors`: ready.
- `[error-log] WARNING: ERROR_LOG_DIR is not set: …`: logs go to `./logs/errors` inside the app directory, where a deployment (`git clean`, a fresh release directory, `rsync --delete`) can delete them.
- `[error-log] WARNING: … is not writable by this user …` or `… does not exist and … is not writable …`: logs cannot be written.

Requirements:

- **Location:** outside the application directory, so deployments never touch it.
- **Ownership:** owned by the user PM2 runs the app as (`pm2 show <app>` → "username"). If PM2 ever ran as root, root-owned log files cannot be appended to later by a non-root process. Fix the ownership with `chown`.
- **Persistent disk:** a local disk. Serverless platforms (e.g. Netlify functions) have a read-only or temporary filesystem: file logs do not persist there.
- **Test runs:** `node --test` processes write nothing unless `ERROR_LOG_DIR` is set.

## Inspecting the logs

### Locally

Run the app (`npm run dev`) and trigger the problem. The files appear in `./logs/errors/`. `logs/` is git-ignored.

```bash
# Latest client errors, pretty-printed (needs jq; or open the file in VS Code)
tail -n 20 logs/errors/client-errors.jsonl | jq .

# Follow API errors as they happen
tail -f logs/errors/api-errors.jsonl | jq '{timestamp, route, method, message}'

# Find the entry a user's "Reference: 4026658a7bd22f58" belongs to
grep 4026658a7bd22f58 logs/errors/*.jsonl | jq .
```

The same in PowerShell:

```powershell
Get-Content logs\errors\client-errors.jsonl -Tail 20 | ForEach-Object { $_ | ConvertFrom-Json }
Get-Content logs\errors\api-errors.jsonl -Wait -Tail 5
Select-String -Path logs\errors\*.jsonl -Pattern 4026658a7bd22f58
```

### On the production VPS

One-time setup (done by an administrator; not done by the application):

```bash
sudo mkdir -p /var/log/slclassroom/errors
sudo chown <app-user>:<app-user> /var/log/slclassroom/errors   # the user PM2 runs the app as
sudo chmod 750 /var/log/slclassroom/errors
```

Then set these in the app's environment (for example the PM2 ecosystem file's `env`, or the server's `.env`) and restart the app:

```bash
ERROR_LOG_DIR=/var/log/slclassroom/errors
APP_URL=https://slclassroom.live      # or NEXT_PUBLIC_APP_URL, already used by the app
TRUSTED_PROXY_COUNT=1                 # example only: must equal the number of proxies you control in front of the app (0 if reached directly)
```

Check the PM2 log after the restart for `[error-log] error logs: /var/log/slclassroom/errors`, and no `[error-log] WARNING` lines.

Set `TRUSTED_PROXY_COUNT` from the real chain, not by assumption. For example, nginx alone in front of the app is `1`; a CDN or load balancer in front of nginx adds one more each, if they append to `X-Forwarded-For`. Too high a value lets clients choose their own address; too low makes an outer proxy's address the client, pooling all users under one 20-a-minute limit. Each proxy should pass the client address (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Forwarding the host (`proxy_set_header Host $host;`) is fine but not required once `APP_URL` is set.

To inspect:

```bash
cd /var/log/slclassroom/errors
ls -lh                                     # files and sizes (rotation keeps them bounded)
tail -n 50 client-errors.jsonl | jq .     # recent browser errors
tail -f api-errors.jsonl server-errors.jsonl
jq -r 'select(.os | test("iOS")) | [.timestamp, .route, .message] | @tsv' client-errors.jsonl   # e.g. iPhone-only errors
grep '"digest":"2210434325"' *.jsonl      # a server-rendering error by digest; its stack is in the PM2 log
pm2 logs <app-name> --lines 200            # the server console (Next.js's own error output)
```

## Limitations

- **Server-rendering errors of pages:** Next.js 14.2 has no hook to intercept them on the server. The browser's boundary reports them, with the digest only in production. The full server stack stays in the server console (PM2 log); find it by the digest.
- **Routes without central logging:** 37 of the 240 routes still write nothing to the file logs. Their unexpected errors produce their usual response and console output only.
  - **Added:** 16 routes that keep their own catch block now call `reportRouteError(error, { request })`, with their statuses unchanged. They are `Grade`, `students/[id]/resetpassword`, `students/import`, `teacher/profile/check-slug`, `teacher/master/*` and `student/Profile/[StudentId]/*`. `teacher/master/*` responds 400 and records `statusCode: 400`.
  - **Production changes to three of them:** `Grade` no longer sends the raw error object, and `teacher/master/mediums` and `subjects` no longer send the raw error message. They send their fixed message instead ("Failed to load mediums" / "Failed to load subjects"). Development still includes them.
  - **Separate approval (lifecycle):** the YouTube routes and `classes/[id]/notify-absent`.
  - **Separate approval (plain `Error`s for expected cases):** routes whose services throw plain `Error`s for expected cases (`students/[id]/confirm`, `decline`, `confirm-all`, most `teacher/profile/*`). Logging them would record validation failures as errors until those services use `AppError`.
  - **Separate approval (no try/catch):** routes without a try/catch (`students/check-*`, `student/next-registration-number`, `student/devices/[deviceId]/request-again`, `teacher/profile/header`, `teacher/profile/photo`, the logout routes). Wrapping them would change their 500 response.
- **Route path in the API log:** the actual request path (for example `/api/lectures/3f1c…`), not the route pattern (`/api/lectures/[id]`). Server-process errors in `server-errors.jsonl` (unhandled rejections, uncaught exceptions) have no request, so they have no route or method.
- **Generic 500 message in production:** some services throw plain `Error`s for expected cases (for example "Teacher not found." or "This profile is private." in `teacher-profile-service.ts`). Through `handleRouteError`, these are still 500s, and in production users now see the generic message instead of that text. Converting them to `AppError` would restore the specific message with a 4xx status; that is a separate change.
- **Console limit:** the limit is per process, and a count of skipped lines is printed only when a later line is printed.
- **Development duplicates:** in development a React rendering error can appear twice (as `window-error` and as `error-boundary:*`). React's development build re-throws caught errors; production does not.
- **Before the page is interactive:** browser errors before hydration are not reported, and neither is a page whose own scripts failed to load. Reports are best effort (`sendBeacon`, no retries, at most 20 per page load).
- **Rate limiting:** in-memory and per process. With several app processes, each has its own limits.
- **Multiple processes:** several processes appending to the same file is safe, since each entry is one append. Their rotations can race, losing at most a few entries during a rotation.
