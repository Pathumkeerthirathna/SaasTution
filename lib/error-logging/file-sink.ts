/*
 * Error logs on the local filesystem, as JSON Lines (one entry per line).
 * Server only (Node `fs`).
 *
 *   Directory: ERROR_LOG_DIR, else ./logs/errors (relative to the working
 *              directory). Production: ERROR_LOG_DIR=/var/log/slclassroom/errors
 *   Files:     client-errors.jsonl, api-errors.jsonl, server-errors.jsonl
 *   Rotation:  a file over ERROR_LOG_MAX_BYTES (default 5 MiB) is renamed to
 *              <name>.1 (older ones shift up, at most ERROR_LOG_MAX_FILES
 *              rotated files are kept, default 5; the oldest is deleted).
 *   Budget:    at most ERROR_LOG_BYTES_PER_MINUTE (default 1 MiB) per file per
 *              minute, so an error storm or a flood of reports cannot rotate
 *              away the history within minutes.
 *   Queue:     at most 1,000 entries waiting per file (a stalled disk cannot
 *              grow memory without limit).
 *
 * Entries over the budget or the queue limit are dropped and counted; the
 * next entry written is preceded by a summary line ("log-entries-dropped").
 * Writes for one file go through a queue, one appendFile call per entry (the
 * file is opened in append mode, so each line lands whole even with another
 * process appending). Logging never throws: a write failure is reported on
 * stderr (at most once a minute) and the entry is dropped.
 */

import { appendFileSync, constants as fsConstants, mkdirSync, promises as fs } from "node:fs";
import path from "node:path";

import type { ErrorLogChannel, ErrorLogEntry } from "./types";

const FILE_NAMES: Record<ErrorLogChannel, string> = {
  client: "client-errors.jsonl",
  api: "api-errors.jsonl",
  server: "server-errors.jsonl",
};

const CHANNELS: ErrorLogChannel[] = ["client", "api", "server"];
const SOURCE_FOR_CHANNEL: Record<ErrorLogChannel, ErrorLogEntry["source"]> = {
  client: "client",
  api: "api",
  server: "server",
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_BYTES_PER_MINUTE = 1024 * 1024;
export const DEFAULT_MAX_PENDING = 1000;
/** A single line never exceeds this (the stack is dropped first, then the message is cut). */
export const MAX_LINE_BYTES = 16 * 1024;

const FILE_MODE = 0o640;
const DIR_MODE = 0o750;
const BUDGET_WINDOW_MS = 60_000;

export type FileSinkOptions = {
  dir: string;
  maxBytes: number;
  maxFiles: number;
  /** Bytes per file per minute; entries beyond it are dropped and counted. */
  bytesPerMinute?: number;
  /** Entries waiting per file; beyond it they are dropped and counted. */
  maxPending?: number;
  /** False: entries are dropped (ERROR_LOG_DISABLED, or a test run without ERROR_LOG_DIR). */
  enabled?: boolean;
  /** Tests only. */
  now?: () => number;
};

function readInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function resolveFileSinkOptions(env: NodeJS.ProcessEnv = process.env): FileSinkOptions {
  const configured = env.ERROR_LOG_DIR?.trim();
  // The test runner (node --test sets NODE_TEST_CONTEXT) exercises error
  // paths on purpose: it writes only where a test points ERROR_LOG_DIR.
  const testRun = Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === "test";

  return {
    dir: configured ? path.resolve(configured) : path.join(process.cwd(), "logs", "errors"),
    maxBytes: readInt(env.ERROR_LOG_MAX_BYTES, DEFAULT_MAX_BYTES, 64 * 1024, 1024 * 1024 * 1024),
    maxFiles: readInt(env.ERROR_LOG_MAX_FILES, DEFAULT_MAX_FILES, 1, 50),
    bytesPerMinute: readInt(env.ERROR_LOG_BYTES_PER_MINUTE, DEFAULT_BYTES_PER_MINUTE, 16 * 1024, 100 * 1024 * 1024),
    maxPending: DEFAULT_MAX_PENDING,
    enabled: env.ERROR_LOG_DISABLED !== "1" && (Boolean(configured) || !testRun),
  };
}

/** The entry as one JSON line, within MAX_LINE_BYTES. */
export function serializeEntry(entry: ErrorLogEntry): string {
  let line = JSON.stringify(entry);

  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    line = JSON.stringify({ ...entry, stack: undefined });
  }

  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    line = JSON.stringify({ ...entry, stack: undefined, message: entry.message.slice(0, 500) });
  }

  return `${line}\n`;
}

let lastFailureReport = 0;

function reportFailure(error: unknown) {
  const now = Date.now();

  if (now - lastFailureReport < 60_000) return;
  lastFailureReport = now;

  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";

  // Never the entry itself: only that writing failed and why.
  console.error(`[error-log] could not write the error log (${code}); entry dropped.`);
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export type DroppedCounts = { queueFull: number; budget: number };

export type FileSink = {
  write(channel: ErrorLogChannel, entry: ErrorLogEntry): Promise<void>;
  /** For a process that may exit next (uncaught exception): synchronous, no rotation. */
  writeSync(channel: ErrorLogChannel, entry: ErrorLogEntry): void;
  /** Resolves when every queued write has finished (tests, shutdown). */
  flush(): Promise<void>;
  /** Entries dropped since the last summary line, per file. */
  dropped(channel: ErrorLogChannel): DroppedCounts;
  readonly options: FileSinkOptions;
};

export function createFileSink(options: FileSinkOptions): FileSink {
  const now = options.now ?? Date.now;
  const bytesPerMinute = options.bytesPerMinute ?? DEFAULT_BYTES_PER_MINUTE;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;

  const queues = new Map<ErrorLogChannel, Promise<void>>();
  const state = new Map(
    CHANNELS.map((channel) => [
      channel,
      { pending: 0, windowStart: 0, windowBytes: 0, dropped: { queueFull: 0, budget: 0 } as DroppedCounts },
    ])
  );

  const filePath = (channel: ErrorLogChannel) => path.join(options.dir, FILE_NAMES[channel]);

  const rotate = async (file: string) => {
    await fs.rm(`${file}.${options.maxFiles}`, { force: true });

    for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
      await fs.rename(`${file}.${index}`, `${file}.${index + 1}`).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }

    await fs.rename(file, `${file}.1`).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  };

  const append = async (channel: ErrorLogChannel, line: string) => {
    const file = filePath(channel);
    const bytes = Buffer.byteLength(line);

    // Checked on every write (error logging is low volume): sees other
    // processes' appends too.
    const size = await fs.stat(file).then((stat) => stat.size, (error) => {
      if (isMissing(error)) return 0;
      throw error;
    });

    if (size > 0 && size + bytes > options.maxBytes) {
      await rotate(file);
    }

    try {
      await fs.appendFile(file, line, { encoding: "utf8", mode: FILE_MODE });
    } catch (error) {
      if (!isMissing(error)) throw error;

      // The directory does not exist yet (first entry, or it was removed).
      await fs.mkdir(options.dir, { recursive: true, mode: DIR_MODE });
      await fs.appendFile(file, line, { encoding: "utf8", mode: FILE_MODE });
    }
  };

  const droppedSummary = (channel: ErrorLogChannel, dropped: DroppedCounts): string =>
    serializeEntry({
      id: `dropped-${now().toString(36)}`,
      timestamp: new Date(now()).toISOString(),
      source: SOURCE_FOR_CHANNEL[channel],
      kind: "log-entries-dropped",
      environment: process.env.NODE_ENV ?? "unknown",
      name: "ErrorLogEntriesDropped",
      message: `${dropped.queueFull + dropped.budget} error log entries were dropped (write queue full: ${dropped.queueFull}, over the per-minute budget: ${dropped.budget}).`,
    });

  return {
    options,

    dropped(channel) {
      return { ...state.get(channel)!.dropped };
    },

    write(channel, entry) {
      if (options.enabled === false) return Promise.resolve();

      const channelState = state.get(channel)!;
      let line: string;

      try {
        line = serializeEntry(entry);
      } catch (error) {
        reportFailure(error);
        return Promise.resolve();
      }

      if (channelState.pending >= maxPending) {
        channelState.dropped.queueFull += 1;
        return Promise.resolve();
      }

      const time = now();

      if (time - channelState.windowStart >= BUDGET_WINDOW_MS) {
        channelState.windowStart = time;
        channelState.windowBytes = 0;
      }

      const bytes = Buffer.byteLength(line);

      if (channelState.windowBytes + bytes > bytesPerMinute) {
        channelState.dropped.budget += 1;
        return Promise.resolve();
      }

      channelState.windowBytes += bytes;

      // Entries were dropped since the last line: say so first.
      const dropped = channelState.dropped;

      if (dropped.queueFull + dropped.budget > 0) {
        line = droppedSummary(channel, dropped) + line;
        channelState.dropped = { queueFull: 0, budget: 0 };
      }

      channelState.pending += 1;

      const previous = queues.get(channel) ?? Promise.resolve();
      const next = previous
        .then(() => append(channel, line))
        .catch(reportFailure)
        .finally(() => {
          channelState.pending -= 1;
        });

      queues.set(channel, next);

      return next;
    },

    writeSync(channel, entry) {
      if (options.enabled === false) return;

      try {
        const line = serializeEntry(entry);

        mkdirSync(options.dir, { recursive: true, mode: DIR_MODE });
        appendFileSync(filePath(channel), line, { encoding: "utf8", mode: FILE_MODE });
      } catch (error) {
        reportFailure(error);
      }
    },

    async flush() {
      await Promise.all([...queues.values()]);
    },
  };
}

let defaultSink: FileSink | null = null;

/** The process-wide sink, configured from the environment on first use. */
export function getDefaultFileSink(): FileSink {
  if (!defaultSink) {
    defaultSink = createFileSink(resolveFileSinkOptions());
  }

  return defaultSink;
}

export type StorageCheck = {
  dir: string;
  configured: boolean;
  /** "writable": ready; "missing": will be created on the first entry if the parent allows it. */
  status: "writable" | "missing" | "not-writable" | "not-a-directory" | "disabled";
  warnings: string[];
};

/**
 * Checks, without creating or changing anything, whether error logs can be
 * written. Production warnings: ERROR_LOG_DIR unset (logs would sit in the
 * app directory, where deployments may delete them), the directory missing
 * with a parent the app cannot write to, or the directory not writable by
 * the user the app runs as.
 */
export async function checkErrorLogStorage(env: NodeJS.ProcessEnv = process.env): Promise<StorageCheck> {
  const options = resolveFileSinkOptions(env);
  const configured = Boolean(env.ERROR_LOG_DIR?.trim());
  const production = env.NODE_ENV === "production";
  const warnings: string[] = [];

  if (options.enabled === false) {
    return { dir: options.dir, configured, status: "disabled", warnings };
  }

  if (production && !configured) {
    warnings.push(
      `ERROR_LOG_DIR is not set: error logs go to ${options.dir}, inside the application directory, where a deployment can delete them. Set ERROR_LOG_DIR (for example /var/log/slclassroom/errors).`
    );
  }

  let status: StorageCheck["status"];

  try {
    const stat = await fs.stat(options.dir);

    if (!stat.isDirectory()) {
      status = "not-a-directory";
      warnings.push(`${options.dir} exists but is not a directory: error logs cannot be written.`);
    } else {
      await fs.access(options.dir, fsConstants.W_OK);
      status = "writable";
    }
  } catch (error) {
    if (isMissing(error)) {
      status = "missing";

      // The app would create it on the first entry: possible only if the
      // nearest existing parent is a writable directory. Nothing is created here.
      let parent = path.dirname(options.dir);

      while (parent !== path.dirname(parent)) {
        try {
          await fs.access(parent, fsConstants.F_OK);
          break;
        } catch {
          parent = path.dirname(parent);
        }
      }

      try {
        if (!(await fs.stat(parent)).isDirectory()) {
          throw new Error("not a directory");
        }

        await fs.access(parent, fsConstants.W_OK);
      } catch {
        status = "not-writable";
        warnings.push(
          `${options.dir} does not exist and ${parent} is not writable by this user: error logs cannot be written. Create the directory and give it to the user the app runs as.`
        );
      }
    } else {
      status = "not-writable";
      warnings.push(`${options.dir} is not writable by this user (${(error as NodeJS.ErrnoException).code ?? "error"}): error logs cannot be written.`);
    }
  }

  return { dir: options.dir, configured, status, warnings };
}
