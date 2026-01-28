/*
Purpose: render user-facing errors for CLI output with optional color.
Assumptions: stderr is the default stream; non-TTY output should disable color.
Usage: console.error(renderCliError(err, { debug: isDebugEnabled }));
*/

import {
  createAnsiFormatter,
  formatErrorLines,
  resolveColorEnabled,
  type AnsiFormatter,
  type ErrorFormatLine,
  type ErrorFormatMode,
} from "../core/error-format.js";

// =============================================================================
// TYPES
// =============================================================================

export type CliErrorFormatOptions = {
  debug?: boolean;
  useColor?: boolean;
  stream?: { isTTY?: boolean };
};

// =============================================================================
// OUTPUT
// =============================================================================

export function renderCliError(error: unknown, options: CliErrorFormatOptions = {}): string {
  const mode: ErrorFormatMode = options.debug ? "debug" : "short";
  const lines = formatErrorLines(error, { mode });

  const stream = options.stream ?? process.stderr;
  const useColor = resolveColorEnabled({ stream, useColor: options.useColor });
  const format = createAnsiFormatter(useColor);

  return lines.map((line) => renderLine(line, format)).join("\n");
}

// =============================================================================
// INTERNALS
// =============================================================================

function renderLine(line: ErrorFormatLine, format: AnsiFormatter): string {
  switch (line.kind) {
    case "title":
      return `${format("Error:", ["red", "bold"])} ${format(line.text, ["bold"])}`;
    case "message":
      return line.text;
    case "hint":
      return `${format("Hint:", ["yellow"])} ${line.text}`;
    case "next":
      return `${format("Next:", ["cyan"])} ${line.text}`;
    case "code":
      return `${format("Code:", ["dim"])} ${format(line.text, ["dim"])}`;
    case "name":
      return `${format("Name:", ["dim"])} ${format(line.text, ["dim"])}`;
    case "cause":
      return `${format("Cause:", ["dim"])} ${format(line.text, ["dim"])}`;
    case "stack":
      return `${format("Stack:", ["dim"])}\n${format(indentMultiline(line.text, 2), ["dim"])}`;
    default:
      return line.text;
  }
}

function indentMultiline(value: string, spaces: number): string {
  const prefix = " ".repeat(Math.max(0, spaces));
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
