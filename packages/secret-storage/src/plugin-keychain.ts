import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AsyncEntry, findCredentialsAsync } from "@napi-rs/keyring";

const MAX_PLUGIN_DELETE_ITEMS = 10_000;

export type PluginSecretBackendStatus =
  | "configured"
  | "not-configured"
  | "unavailable";

export interface PluginSecretStatus {
  backend: "keychain";
  set: boolean;
  status: PluginSecretBackendStatus;
}

export interface PluginSecretFileEntry {
  key: string;
  path: string;
  pluginId: string;
}

export interface PluginSecretMigrationEntry {
  key: string;
  pluginId: string;
  status: "conflict" | "migrated" | "resumed";
}

export interface PluginKeychainEntry {
  deleteCredential(): Promise<boolean>;
  getSecret(): Promise<Uint8Array | number[] | null | undefined>;
  setSecret(secret: Uint8Array): Promise<void>;
}

export interface PluginKeychain {
  entry(service: string, account: string): PluginKeychainEntry;
  findAccounts(service: string): Promise<string[]>;
}

export const systemPluginKeychain: PluginKeychain = {
  entry: (service, account) => new AsyncEntry(service, account),
  findAccounts: async (service) =>
    (await findCredentialsAsync(service)).map(
      (credential) => credential.account,
    ),
};

export class KeychainUnavailableError extends Error {
  constructor(operation: string) {
    super(`macOS Keychain is unavailable during ${operation}`);
    this.name = "KeychainUnavailableError";
  }
}

function keychainService(dataDir: string, pluginId: string): string {
  const namespace = createHash("sha256")
    .update(resolve(dataDir))
    .update("\0")
    .update(pluginId)
    .digest("hex");
  return `dev.bb.personal.plugin-secrets.${namespace}`;
}

function entryFor(
  keychain: PluginKeychain,
  args: { dataDir: string; key: string; pluginId: string },
): PluginKeychainEntry {
  return keychain.entry(keychainService(args.dataDir, args.pluginId), args.key);
}

export async function readPluginKeychainSecret(
  args: { dataDir: string; key: string; pluginId: string },
  keychain: PluginKeychain = systemPluginKeychain,
): Promise<string | undefined> {
  try {
    const value = await entryFor(keychain, args).getSecret();
    return value === undefined || value === null
      ? undefined
      : new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(value),
        );
  } catch {
    throw new KeychainUnavailableError("read");
  }
}

export async function writePluginKeychainSecret(
  args: { dataDir: string; key: string; pluginId: string; value: string },
  keychain: PluginKeychain = systemPluginKeychain,
): Promise<void> {
  try {
    await entryFor(keychain, args).setSecret(
      new TextEncoder().encode(args.value),
    );
  } catch {
    throw new KeychainUnavailableError("write");
  }
}

export async function deletePluginKeychainSecret(
  args: { dataDir: string; key: string; pluginId: string },
  keychain: PluginKeychain = systemPluginKeychain,
): Promise<void> {
  try {
    await entryFor(keychain, args).deleteCredential();
  } catch {
    throw new KeychainUnavailableError("delete");
  }
}

export async function deletePluginKeychainSecrets(
  args: { dataDir: string; pluginId: string },
  keychain: PluginKeychain = systemPluginKeychain,
): Promise<void> {
  const service = keychainService(args.dataDir, args.pluginId);
  let accounts: string[];
  try {
    accounts = await keychain.findAccounts(service);
  } catch {
    throw new KeychainUnavailableError("list plugin secrets");
  }
  const uniqueAccounts = [...new Set(accounts)];
  if (uniqueAccounts.length > MAX_PLUGIN_DELETE_ITEMS) {
    throw new KeychainUnavailableError("delete plugin secrets");
  }
  try {
    for (const account of uniqueAccounts) {
      await keychain.entry(service, account).deleteCredential();
    }
  } catch {
    throw new KeychainUnavailableError("delete plugin secrets");
  }
}

export async function inspectPluginKeychainSecret(
  args: { dataDir: string; key: string; pluginId: string },
  keychain: PluginKeychain = systemPluginKeychain,
): Promise<PluginSecretStatus> {
  try {
    const value = await readPluginKeychainSecret(args, keychain);
    return {
      backend: "keychain",
      set: value !== undefined,
      status: value === undefined ? "not-configured" : "configured",
    };
  } catch (error) {
    if (!(error instanceof KeychainUnavailableError)) throw error;
    return { backend: "keychain", set: false, status: "unavailable" };
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export async function listPluginSecretFiles(
  dataDir: string,
): Promise<PluginSecretFileEntry[]> {
  const pluginsDir = join(dataDir, "plugins");
  let pluginEntries;
  try {
    pluginEntries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const entries: PluginSecretFileEntry[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const secretsDir = join(pluginsDir, pluginEntry.name, "secrets");
    let secretEntries;
    try {
      secretEntries = await readdir(secretsDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const secretEntry of secretEntries) {
      if (!secretEntry.isFile()) continue;
      entries.push({
        key: secretEntry.name,
        path: join(secretsDir, secretEntry.name),
        pluginId: pluginEntry.name,
      });
    }
  }
  return entries.sort((left, right) =>
    `${left.pluginId}\0${left.key}`.localeCompare(
      `${right.pluginId}\0${right.key}`,
    ),
  );
}

async function readStableSecretFile(path: string): Promise<{
  dev: number;
  ino: number;
  value: string;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error("Plugin secret migration source is not a regular file");
    }
    return {
      dev: fileStat.dev,
      ino: fileStat.ino,
      value: await handle.readFile("utf8"),
    };
  } finally {
    await handle.close();
  }
}

async function deleteUnchangedSource(
  path: string,
  identity: { dev: number; ino: number },
): Promise<void> {
  const quarantineDir = await mkdtemp(
    join(dirname(path), ".bb-keychain-migration-quarantine-"),
  );
  const quarantinePath = join(quarantineDir, basename(path));
  try {
    await rename(path, quarantinePath);
  } catch {
    await rmdir(quarantineDir).catch(() => undefined);
    throw new Error("Plugin secret migration source changed during migration");
  }
  const current = await lstat(quarantinePath).catch(() => undefined);
  if (
    current === undefined ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    let restoreError: unknown;
    if (
      current !== undefined &&
      current.isFile() &&
      !current.isSymbolicLink()
    ) {
      try {
        await copyFile(quarantinePath, path, constants.COPYFILE_EXCL);
        await unlink(quarantinePath);
      } catch (error) {
        restoreError = error;
      }
    }
    await rmdir(quarantineDir).catch(() => undefined);
    if (
      await lstat(quarantinePath).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(
        `Plugin secret migration source changed during migration; replacement preserved at ${quarantinePath}`,
        { cause: restoreError },
      );
    }
    throw new Error("Plugin secret migration source changed during migration");
  }
  await unlink(quarantinePath);
  await rmdir(quarantineDir).catch(() => undefined);
}

export async function migratePluginSecretFilesToKeychain(args: {
  dataDir: string;
  keychain?: PluginKeychain;
}): Promise<PluginSecretMigrationEntry[]> {
  const files = await listPluginSecretFiles(args.dataDir);
  const results: PluginSecretMigrationEntry[] = [];
  for (const file of files) {
    const source = await readStableSecretFile(file.path);
    const keychainArgs = {
      dataDir: args.dataDir,
      key: file.key,
      pluginId: file.pluginId,
    };
    const existing = await readPluginKeychainSecret(
      keychainArgs,
      args.keychain,
    );
    if (existing !== undefined && existing !== source.value) {
      results.push({
        key: file.key,
        pluginId: file.pluginId,
        status: "conflict",
      });
      continue;
    }
    if (existing === undefined) {
      await writePluginKeychainSecret(
        { ...keychainArgs, value: source.value },
        args.keychain,
      );
    }
    const verified = await readPluginKeychainSecret(
      keychainArgs,
      args.keychain,
    );
    if (verified !== source.value) {
      throw new Error("Plugin secret migration verification failed");
    }
    await deleteUnchangedSource(file.path, source);
    results.push({
      key: file.key,
      pluginId: file.pluginId,
      status: existing === undefined ? "migrated" : "resumed",
    });
  }
  return results;
}
