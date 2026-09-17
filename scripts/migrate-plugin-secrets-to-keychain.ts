import { isAbsolute, resolve } from "node:path";
import {
  listPluginSecretFiles,
  migratePluginSecretFilesToKeychain,
} from "../packages/secret-storage/src/index.js";

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function renderHelp(): string {
  return [
    "Usage:",
    "  pnpm exec tsx scripts/migrate-plugin-secrets-to-keychain.ts --data-dir ABSOLUTE_PATH",
    "  pnpm exec tsx scripts/migrate-plugin-secrets-to-keychain.ts --data-dir ABSOLUTE_PATH --apply --confirm ABSOLUTE_PATH",
    "",
    "The first form is a read-only inventory. The apply form writes each value to",
    "macOS Keychain, verifies it, and only then deletes that source file. Conflicts",
    "remain untouched. Stop every bb process using the profile before applying.",
    "",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderHelp());
    return;
  }
  const rawDataDir = optionValue(argv, "--data-dir");
  if (rawDataDir === undefined || !isAbsolute(rawDataDir)) {
    throw new Error("--data-dir must be an absolute path");
  }
  const dataDir = resolve(rawDataDir);
  const files = await listPluginSecretFiles(dataDir);
  if (!argv.includes("--apply")) {
    for (const file of files) {
      process.stdout.write(
        `inventory: ${JSON.stringify(`${file.pluginId}/${file.key}`)}\n`,
      );
    }
    process.stdout.write(
      `Found ${String(files.length)} plugin secret file(s) in the selected profile. No changes made.\n`,
    );
    return;
  }
  const confirmation = optionValue(argv, "--confirm");
  if (
    confirmation === undefined ||
    !isAbsolute(confirmation) ||
    confirmation !== rawDataDir
  ) {
    throw new Error("--confirm must exactly repeat the absolute --data-dir");
  }
  if (process.platform !== "darwin") {
    throw new Error("Keychain migration requires macOS");
  }
  const results = await migratePluginSecretFilesToKeychain({ dataDir });
  for (const result of results) {
    process.stdout.write(
      `${result.status}: ${JSON.stringify(`${result.pluginId}/${result.key}`)}\n`,
    );
  }
  const conflicts = results.filter((result) => result.status === "conflict");
  if (conflicts.length > 0) {
    process.stderr.write(
      `${String(conflicts.length)} conflict(s) retained their source files.\n`,
    );
    process.exitCode = 2;
  }
}

await main(process.argv.slice(2));
