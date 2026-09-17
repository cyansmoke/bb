import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getPluginSettingsValues,
  setPluginSettingsValues,
  type DbConnection,
} from "@bb/db";
import type {
  PluginSettingDescriptor,
  PluginSettingDescriptors,
  PluginSettingValue,
} from "@get-bb/plugin-sdk";
import { coerceStoredPluginSettingValue } from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginSettingDescriptor as PublicPluginSettingDescriptor } from "@bb/server-contract";
import {
  deletePluginKeychainSecret,
  deletePluginKeychainSecrets,
  deleteSecretFile,
  inspectPluginKeychainSecret,
  readPluginKeychainSecret,
  writePluginKeychainSecret,
  writeSecretFile,
} from "@bb/secret-storage";

export class PluginSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSettingsValidationError";
  }
}

export function pluginSecretsDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId, "secrets");
}

function secretFilePath(
  dataDir: string,
  pluginId: string,
  key: string,
): string {
  return join(pluginSecretsDir(dataDir, pluginId), key);
}

function isSecret(descriptor: PluginSettingDescriptor): boolean {
  return descriptor.type === "string" && descriptor.secret === true;
}

export type PluginSecretBackend = "file" | "keychain";

export function resolvePluginSecretBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PluginSecretBackend {
  const configured = env.BB_PLUGIN_SECRET_BACKEND?.trim() || undefined;
  if (configured === "file" && env.NODE_ENV === "test") return "file";
  if (configured === "file") {
    throw new Error("The file plugin secret backend is test-only");
  }
  if (configured !== undefined && configured !== "keychain") {
    throw new Error(
      `BB_PLUGIN_SECRET_BACKEND must be keychain or file, got ${configured}`,
    );
  }
  if (configured === "keychain" && platform !== "darwin") {
    throw new Error("The keychain plugin secret backend requires macOS");
  }
  if (configured === undefined && env.NODE_ENV === "test") return "file";
  if (configured === "keychain" || platform === "darwin") return "keychain";
  throw new Error(
    "Plugin secret storage requires macOS Keychain in this personal build",
  );
}

export async function readSecret(
  dataDir: string,
  pluginId: string,
  key: string,
): Promise<string | undefined> {
  if (resolvePluginSecretBackend() === "keychain") {
    return readPluginKeychainSecret({ dataDir, key, pluginId });
  }
  try {
    return await readFile(secretFilePath(dataDir, pluginId, key), "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function deletePluginSettingsSecrets(
  dataDir: string,
  pluginId: string,
): Promise<void> {
  if (resolvePluginSecretBackend() === "keychain") {
    await deletePluginKeychainSecrets({ dataDir, pluginId });
  }
  await rm(pluginSecretsDir(dataDir, pluginId), {
    recursive: true,
    force: true,
  });
}

interface PluginSettingsStoreArgs {
  db: DbConnection;
  dataDir: string;
  pluginId: string;
  descriptors: PluginSettingDescriptors;
}

function parseStoredSettingValue(
  descriptor: PluginSettingDescriptor,
  raw: string | undefined,
): PluginSettingValue | undefined {
  let parsed: unknown;
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  return coerceStoredPluginSettingValue(descriptor, parsed);
}

export function readPluginSettingsValuesSync(
  args: Omit<PluginSettingsStoreArgs, "dataDir">,
): Record<string, PluginSettingValue | undefined> {
  const stored = getPluginSettingsValues(args.db, args.pluginId);
  const values: Record<string, PluginSettingValue | undefined> = {};
  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (isSecret(descriptor)) continue;
    values[key] = parseStoredSettingValue(descriptor, stored[key]);
  }
  return values;
}

export async function readPluginSettingsValues(
  args: PluginSettingsStoreArgs,
): Promise<Record<string, PluginSettingValue | undefined>> {
  const values = readPluginSettingsValuesSync(args);
  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (!isSecret(descriptor)) continue;
    values[key] =
      (await readSecret(args.dataDir, args.pluginId, key)) ??
      descriptor.default;
  }
  return values;
}

export async function writePluginSettingsUpdate(
  args: PluginSettingsStoreArgs & { values: Record<string, unknown> },
): Promise<void> {
  const rowUpdates: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(args.values)) {
    const descriptor = args.descriptors[key];
    if (!descriptor) continue;
    if (isSecret(descriptor)) {
      if (resolvePluginSecretBackend() === "keychain") {
        const keychainArgs = {
          dataDir: args.dataDir,
          key,
          pluginId: args.pluginId,
        };
        if (value === null) await deletePluginKeychainSecret(keychainArgs);
        else
          await writePluginKeychainSecret({
            ...keychainArgs,
            value: value as string,
          });
      } else {
        const path = secretFilePath(args.dataDir, args.pluginId, key);
        if (value === null) await deleteSecretFile(path);
        else await writeSecretFile(path, value as string);
      }
      continue;
    }
    rowUpdates[key] = value === null ? null : JSON.stringify(value);
  }
  if (Object.keys(rowUpdates).length > 0) {
    setPluginSettingsValues(args.db, args.pluginId, rowUpdates);
  }
}

export interface PluginSettingsView {
  schema: Record<string, PublicPluginSettingDescriptor>;
  values: Record<string, unknown>;
}

function publicSettingDescriptor(
  descriptor: PluginSettingDescriptor,
): PublicPluginSettingDescriptor {
  const publicDescriptor = { ...descriptor };
  delete publicDescriptor.experimental_schema;
  return publicDescriptor;
}

export async function buildPluginSettingsView(
  args: PluginSettingsStoreArgs,
): Promise<PluginSettingsView> {
  const effective = readPluginSettingsValuesSync(args);
  const values: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (isSecret(descriptor)) {
      values[key] =
        resolvePluginSecretBackend() === "keychain"
          ? await inspectPluginKeychainSecret({
              dataDir: args.dataDir,
              key,
              pluginId: args.pluginId,
            })
          : {
              set: await stat(secretFilePath(args.dataDir, args.pluginId, key))
                .then(() => true)
                .catch(() => false),
            };
    } else if (effective[key] !== undefined) {
      values[key] = effective[key];
    }
  }
  return {
    schema: Object.fromEntries(
      Object.entries(args.descriptors).map(([key, descriptor]) => [
        key,
        publicSettingDescriptor(descriptor),
      ]),
    ),
    values,
  };
}
