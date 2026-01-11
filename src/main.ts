import { buildCli } from "./cli/index.js";

export async function main(argv: string[]): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}

// Allow `node dist/src/main.js` direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv);
}
