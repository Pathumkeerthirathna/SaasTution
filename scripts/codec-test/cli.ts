/*
 * Codec test scripts: strict command-line parsing. Unknown options,
 * repeated options, a missing value or a value that is really the next
 * option ("--teacher --student x") are refused instead of guessed.
 * Error messages name the option, never echo the values given.
 */

export type OptionSpec = Record<string, "value" | "flag">;

export class UsageError extends Error {}

export function parseArgs(argv: string[], spec: OptionSpec): Record<string, string | true> {
  const result: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      throw new UsageError(`Unexpected argument at position ${index + 1} (options start with "--").`);
    }

    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const kind = spec[name];

    if (!kind) {
      throw new UsageError(`Unknown option "${name}". Known: ${Object.keys(spec).join(", ")}.`);
    }

    if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new UsageError(`"${name}" was given more than once.`);
    }

    if (kind === "flag") {
      if (equals >= 0) {
        throw new UsageError(`"${name}" takes no value.`);
      }

      result[name] = true;
      continue;
    }

    let value: string | undefined;

    if (equals >= 0) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }

    if (value === undefined || value.trim() === "" || value.startsWith("--")) {
      throw new UsageError(`"${name}" needs a value.`);
    }

    result[name] = value;
  }

  return result;
}

export function optionalValue(args: Record<string, string | true>, name: string): string | undefined {
  const value = args[name];

  return typeof value === "string" ? value : undefined;
}
