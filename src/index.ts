import { CommanderError, type Command } from "commander";

import { renderCliError } from "./cli/error-format.js";
import { buildCli } from "./cli/index.js";

// =============================================================================
// ERROR HANDLING
// =============================================================================

function configureCliErrorHandling(program: Command): void {
  program.configureOutput({
    outputError: (_message: string, _write: (chunk: string) => void) => undefined,
  });

  program.exitOverride();
}

function isHelpOrVersionExit(error: unknown): boolean {
  if (!(error instanceof CommanderError)) {
    return false;
  }

  return (
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version" ||
    error.code === "commander.help"
  );
}

function resolveDebugEnabled(argv: string[], program: Command): boolean {
  const argvDebug = resolveDebugFlagFromArgv(argv);
  if (argvDebug !== undefined) {
    return argvDebug;
  }

  const options = program.opts() as { debug?: boolean };
  return Boolean(options.debug);
}

function resolveDebugFlagFromArgv(argv: string[]): boolean | undefined {
  let debugFlag: boolean | undefined;

  for (const arg of argv) {
    if (arg === "--") {
      break;
    }

    if (arg === "--debug") {
      debugFlag = true;
    }

    if (arg === "--no-debug") {
      debugFlag = false;
    }
  }

  return debugFlag;
}

function resolveExitCode(error: unknown): number {
  if (error && typeof error === "object" && "exitCode" in error) {
    const exitCode = (error as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
      return exitCode;
    }
  }

  return 1;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildCli();
  configureCliErrorHandling(program);

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isHelpOrVersionExit(error)) {
      process.exitCode = resolveExitCode(error);
      return;
    }

    const debug = resolveDebugEnabled(argv, program);
    console.error(renderCliError(error, { debug }));
    const exitCode = resolveExitCode(error);
    process.exitCode = exitCode === 0 ? 1 : exitCode;
  }
}

// =============================================================================
// DIRECT EXECUTION
// =============================================================================

// Allow `node dist/src/index.js` direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv);
}
