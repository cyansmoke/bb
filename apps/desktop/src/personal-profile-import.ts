import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  parseBbAppManagedConfig,
  type BbAppManagedConfig,
} from "@bb/config/bb-app-managed-config";
import { readBbAppRuntimeFile } from "@bb/config/app-runtime-file";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  deletePluginKeychainSecret,
  listPluginSecretFiles,
  migratePluginSecretFilesToKeychain,
  readPluginKeychainSecret,
  type PluginKeychain,
  type PluginSecretFileEntry,
} from "@bb/secret-storage";
import {
  discardImportBackups,
  extractServerArchive,
  installImportedServerFiles,
  listServerOwnedEntries,
  removeImportedServerFiles,
  writeServerArchive,
  writeServerImportFile,
  type ServerArchiveSourceFile,
} from "@bb/server-archive";

const PERSONAL_ONBOARDING_STATE_VERSION = 1;
const IMPORT_OWNER_FILE_NAME = ".bb-personal-import-owner";
const SANITIZED_CONFIG_FILE_NAME = "sanitized-config.json";
const PROFILE_ARCHIVE_FILE_NAME = "profile.tar.gz";
const ARCHIVE_STAGING_DIR_NAME = "staging";
const DATABASE_SNAPSHOT_DIR_NAME = "database-snapshots";
const SOURCE_DATABASE_FILE_NAME = "bb.db";
const IMPORT_LOCK_FILE_NAMES = [".config.json.lock", ".env.json.lock"];
const CONNECT_PLUGIN_ID = "connect";
const CONNECT_CREDENTIAL_KEY = "credential";
const OMITTED_TOP_LEVEL_PATHS = new Set([
  "auth-secret",
  "env.json",
  "machine-environment-key",
  "telemetry-id",
]);

export type PersonalImportProgressPhase =
  | "inspect"
  | "snapshot"
  | "archive"
  | "install"
  | "keychain"
  | "finalize";

export interface PersonalImportProgress {
  detail: string;
  percent: number;
  phase: PersonalImportProgressPhase;
}

export interface PersonalProfileInspection {
  canImport: boolean;
  pluginCount: number;
  reason:
    | "ready"
    | "source-missing"
    | "source-running"
    | "same-profile"
    | "target-not-empty";
  secretCount: number;
  sourceDataDir: string;
  targetDataDir: string;
}

export interface PersonalProfileImportReport {
  completedAt: string;
  connectCredentialRemoved: boolean;
  importedEntries: number;
  migratedSecrets: number;
  omitted: string[];
  pluginCount: number;
  resumedSecrets: number;
  skippedUnsafePaths: number;
  sourceDataDir: string;
  sourcePreserved: true;
  targetDataDir: string;
}

export interface PersonalOnboardingState {
  completedAt: string;
  outcome: "fresh" | "imported";
  report: PersonalProfileImportReport | null;
  version: typeof PERSONAL_ONBOARDING_STATE_VERSION;
}

interface PerformPersonalProfileImportArgs {
  appVersion: string;
  keychain?: PluginKeychain;
  onProgress?: (progress: PersonalImportProgress) => void;
  sourceDataDir: string;
  targetDataDir: string;
}

interface ProfileDatabaseFacts {
  connectCredentialRemoved: boolean;
  migrationCount: number;
  pluginCount: number;
}

interface PreparedArchive {
  databaseFacts: ProfileDatabaseFacts;
  files: ServerArchiveSourceFile[];
  skippedUnsafePaths: number;
}

interface KeychainRollbackEntry {
  key: string;
  pluginId: string;
}

interface ImportOwner {
  createdTarget: boolean;
  token: string;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function sourceRuntimeIsRunning(sourceDataDir: string): Promise<boolean> {
  const runtime = await readBbAppRuntimeFile(sourceDataDir);
  return runtime !== null && processIsRunning(runtime.pid);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function readSqliteCount(database: DatabaseSync, sql: string): number {
  try {
    const row = database.prepare(sql).get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function countInstalledPlugins(databasePath: string): number {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, {
      open: true,
      readOnly: true,
    });
    return readSqliteCount(
      database,
      "SELECT count(*) AS count FROM plugins WHERE removed_at IS NULL",
    );
  } catch {
    return 0;
  } finally {
    database?.close();
  }
}

export async function inspectPersonalProfileImport(args: {
  sourceDataDir: string;
  targetDataDir: string;
}): Promise<PersonalProfileInspection> {
  const sourceDataDir = resolve(args.sourceDataDir);
  const targetDataDir = resolve(args.targetDataDir);
  if (sourceDataDir === targetDataDir) {
    return {
      canImport: false,
      pluginCount: 0,
      reason: "same-profile",
      secretCount: 0,
      sourceDataDir,
      targetDataDir,
    };
  }
  const sourceDatabasePath = join(sourceDataDir, SOURCE_DATABASE_FILE_NAME);
  if (!(await pathExists(sourceDatabasePath))) {
    return {
      canImport: false,
      pluginCount: 0,
      reason: "source-missing",
      secretCount: 0,
      sourceDataDir,
      targetDataDir,
    };
  }
  if (!(await directoryIsEmpty(targetDataDir))) {
    return {
      canImport: false,
      pluginCount: countInstalledPlugins(sourceDatabasePath),
      reason: "target-not-empty",
      secretCount: (await listPluginSecretFiles(sourceDataDir)).length,
      sourceDataDir,
      targetDataDir,
    };
  }
  if (await sourceRuntimeIsRunning(sourceDataDir)) {
    return {
      canImport: false,
      pluginCount: countInstalledPlugins(sourceDatabasePath),
      reason: "source-running",
      secretCount: (await listPluginSecretFiles(sourceDataDir)).length,
      sourceDataDir,
      targetDataDir,
    };
  }
  return {
    canImport: true,
    pluginCount: countInstalledPlugins(sourceDatabasePath),
    reason: "ready",
    secretCount: (await listPluginSecretFiles(sourceDataDir)).length,
    sourceDataDir,
    targetDataDir,
  };
}

export function sanitizePersonalImportedConfig(
  rawConfig: unknown,
): BbAppManagedConfig {
  const parsed = parseBbAppManagedConfig(rawConfig);
  return {
    ...(parsed.config === undefined ? {} : { config: parsed.config }),
    ...(parsed.customModels === undefined
      ? {}
      : { customModels: parsed.customModels }),
    ...(parsed.sharedSkillRoots === undefined
      ? {}
      : { sharedSkillRoots: parsed.sharedSkillRoots }),
  };
}

async function snapshotDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(sourcePath, {
    open: true,
    readOnly: true,
  });
  try {
    await backup(database, destinationPath);
  } finally {
    database.close();
  }
}

async function prepareMainDatabaseSnapshot(args: {
  destinationPath: string;
  sourcePath: string;
}): Promise<ProfileDatabaseFacts> {
  await snapshotDatabase(args.sourcePath, args.destinationPath);
  const database = new DatabaseSync(args.destinationPath);
  try {
    const pluginCount = readSqliteCount(
      database,
      "SELECT count(*) AS count FROM plugins WHERE removed_at IS NULL",
    );
    const migrationCount = readSqliteCount(
      database,
      "SELECT count(*) AS count FROM __drizzle_migrations",
    );
    let connectCredentialRemoved = false;
    try {
      const result = database
        .prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?")
        .run(CONNECT_PLUGIN_ID, CONNECT_CREDENTIAL_KEY);
      connectCredentialRemoved = result.changes > 0;
    } catch {
      connectCredentialRemoved = false;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      connectCredentialRemoved,
      migrationCount,
      pluginCount,
    };
  } finally {
    database.close();
  }
}

async function prepareSanitizedConfig(
  sourcePath: string,
  destinationPath: string,
): Promise<boolean> {
  if (!(await pathExists(sourcePath))) {
    return false;
  }
  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  const sanitized = sanitizePersonalImportedConfig(raw);
  if (Object.keys(sanitized).length === 0) {
    return false;
  }
  await writeFile(destinationPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return true;
}

async function prepareArchiveSources(args: {
  sourceDataDir: string;
  workDir: string;
}): Promise<PreparedArchive> {
  const inventory = await listServerOwnedEntries(args.sourceDataDir);
  const snapshotRoot = join(args.workDir, DATABASE_SNAPSHOT_DIR_NAME);
  const mainDatabaseSnapshotPath = join(
    snapshotRoot,
    SOURCE_DATABASE_FILE_NAME,
  );
  const databaseFacts = await prepareMainDatabaseSnapshot({
    destinationPath: mainDatabaseSnapshotPath,
    sourcePath: join(args.sourceDataDir, SOURCE_DATABASE_FILE_NAME),
  });
  const files: ServerArchiveSourceFile[] = [
    {
      archivePath: SOURCE_DATABASE_FILE_NAME,
      sourcePath: mainDatabaseSnapshotPath,
    },
  ];
  const sanitizedConfigPath = join(args.workDir, SANITIZED_CONFIG_FILE_NAME);
  if (
    await prepareSanitizedConfig(
      join(args.sourceDataDir, "config.json"),
      sanitizedConfigPath,
    )
  ) {
    files.push({ archivePath: "config.json", sourcePath: sanitizedConfigPath });
  }
  for (const entry of inventory.entries) {
    for (const file of entry.files) {
      if (
        file.path === SOURCE_DATABASE_FILE_NAME ||
        file.path === "config.json" ||
        OMITTED_TOP_LEVEL_PATHS.has(file.path)
      ) {
        continue;
      }
      if (!file.sqliteDatabase) {
        files.push({ archivePath: file.path, sourcePath: file.absolutePath });
        continue;
      }
      const snapshotPath = join(snapshotRoot, ...file.path.split("/"));
      await snapshotDatabase(file.absolutePath, snapshotPath);
      files.push({ archivePath: file.path, sourcePath: snapshotPath });
    }
  }
  return {
    databaseFacts,
    files,
    skippedUnsafePaths: inventory.skippedPaths.length,
  };
}

function emitProgress(
  callback: PerformPersonalProfileImportArgs["onProgress"],
  progress: PersonalImportProgress,
): void {
  callback?.(progress);
}

async function planKeychainRollback(args: {
  dataDir: string;
  files: PluginSecretFileEntry[];
  keychain?: PluginKeychain;
}): Promise<KeychainRollbackEntry[]> {
  const rollback: KeychainRollbackEntry[] = [];
  for (const file of args.files) {
    const existing = await readPluginKeychainSecret(
      {
        dataDir: args.dataDir,
        key: file.key,
        pluginId: file.pluginId,
      },
      args.keychain,
    );
    if (existing === undefined) {
      rollback.push({ key: file.key, pluginId: file.pluginId });
      continue;
    }
    const source = await readFile(file.path, "utf8");
    if (existing !== source) {
      throw new Error(
        `Keychain already contains a different value for ${file.pluginId}/${file.key}`,
      );
    }
  }
  return rollback;
}

async function rollBackKeychainEntries(args: {
  dataDir: string;
  entries: KeychainRollbackEntry[];
  keychain?: PluginKeychain;
}): Promise<void> {
  for (const entry of args.entries) {
    await deletePluginKeychainSecret(
      { dataDir: args.dataDir, key: entry.key, pluginId: entry.pluginId },
      args.keychain,
    ).catch(() => undefined);
  }
}

async function createImportOwner(targetDataDir: string): Promise<ImportOwner> {
  const token = randomUUID();
  let createdTarget = false;
  try {
    await mkdir(targetDataDir, { recursive: false, mode: 0o700 });
    createdTarget = true;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  await writeFile(join(targetDataDir, IMPORT_OWNER_FILE_NAME), token, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { createdTarget, token };
}

async function removeOwnedEmptyTarget(
  targetDataDir: string,
  owner: ImportOwner,
): Promise<void> {
  const ownerPath = join(targetDataDir, IMPORT_OWNER_FILE_NAME);
  const currentOwner = await readFile(ownerPath, "utf8").catch(() => null);
  if (currentOwner !== owner.token) {
    return;
  }
  await Promise.all(
    IMPORT_LOCK_FILE_NAMES.map((name) =>
      unlink(join(targetDataDir, name)).catch(() => undefined),
    ),
  );
  await unlink(ownerPath).catch(() => undefined);
  if (owner.createdTarget) {
    await rmdir(targetDataDir).catch(() => undefined);
  }
}

export async function performPersonalProfileImport(
  args: PerformPersonalProfileImportArgs,
): Promise<PersonalProfileImportReport> {
  const sourceDataDir = resolve(args.sourceDataDir);
  const targetDataDir = resolve(args.targetDataDir);
  emitProgress(args.onProgress, {
    detail: "Checking both profiles and the official bb process",
    percent: 5,
    phase: "inspect",
  });
  const inspection = await inspectPersonalProfileImport({
    sourceDataDir,
    targetDataDir,
  });
  if (!inspection.canImport) {
    throw new Error(
      `Personal profile import is not ready: ${inspection.reason}`,
    );
  }

  const owner = await createImportOwner(targetDataDir);
  const workDir = await mkdtemp(
    join(dirname(targetDataDir), ".bb-personal-import-"),
  );
  let importedEntries: string[] = [];
  let keychainRollback: KeychainRollbackEntry[] = [];
  try {
    emitProgress(args.onProgress, {
      detail: "Creating consistent SQLite snapshots",
      percent: 18,
      phase: "snapshot",
    });
    const prepared = await prepareArchiveSources({ sourceDataDir, workDir });
    const archivePath = join(workDir, PROFILE_ARCHIVE_FILE_NAME);
    emitProgress(args.onProgress, {
      detail: "Building and verifying the local profile archive",
      percent: 36,
      phase: "archive",
    });
    await writeServerArchive({
      outPath: archivePath,
      files: prepared.files,
      manifest: {
        bbVersion: args.appVersion,
        createdAt: Date.now(),
        migrationCount: prepared.databaseFacts.migrationCount,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverMoveExperiment: false,
        sourceDataDir,
        sourceServerHostId: null,
      },
    });
    const stagingDir = join(workDir, ARCHIVE_STAGING_DIR_NAME);
    const manifest = await extractServerArchive({
      archivePath,
      destinationDir: stagingDir,
    });
    if (await sourceRuntimeIsRunning(sourceDataDir)) {
      throw new Error(
        "The official bb profile started while the import archive was being created",
      );
    }
    emitProgress(args.onProgress, {
      detail: "Installing the isolated personal profile",
      percent: 58,
      phase: "install",
    });
    const installed = await installImportedServerFiles({
      dataDir: targetDataDir,
      localServerUrl: null,
      manifest,
      stagingDir,
    });
    importedEntries = installed.importedEntries;
    const secretFiles = await listPluginSecretFiles(targetDataDir);
    emitProgress(args.onProgress, {
      detail: `Moving ${String(secretFiles.length)} plugin secret setting(s) into Keychain`,
      percent: 76,
      phase: "keychain",
    });
    keychainRollback = await planKeychainRollback({
      dataDir: targetDataDir,
      files: secretFiles,
      keychain: args.keychain,
    });
    const migration = await migratePluginSecretFilesToKeychain({
      dataDir: targetDataDir,
      keychain: args.keychain,
    });
    const conflicts = migration.filter((entry) => entry.status === "conflict");
    if (conflicts.length > 0) {
      throw new Error(
        `${String(conflicts.length)} plugin secret setting(s) conflict with existing Keychain entries`,
      );
    }
    emitProgress(args.onProgress, {
      detail: "Preparing imported paths and a new personal machine identity",
      percent: 92,
      phase: "finalize",
    });
    await writeServerImportFile(targetDataDir, {
      activationToken: null,
      createdAt: Date.now(),
      fixupsAppliedAt: null,
      importedEntries,
      kind: "manual",
      moveId: null,
      serverUrl: null,
      sourceDataDir,
      sourceServerHostId: null,
      targetHostId: null,
      version: 1,
    });
    await discardImportBackups(targetDataDir);
    await unlink(join(targetDataDir, IMPORT_OWNER_FILE_NAME));
    const report: PersonalProfileImportReport = {
      completedAt: new Date().toISOString(),
      connectCredentialRemoved: prepared.databaseFacts.connectCredentialRemoved,
      importedEntries: importedEntries.length,
      migratedSecrets: migration.filter((entry) => entry.status === "migrated")
        .length,
      omitted: [
        "env.json and custom agent environment values",
        "server credentials and custom server headers",
        "machine identity, Connect session, and telemetry identity",
      ],
      pluginCount: prepared.databaseFacts.pluginCount,
      resumedSecrets: migration.filter((entry) => entry.status === "resumed")
        .length,
      skippedUnsafePaths: prepared.skippedUnsafePaths,
      sourceDataDir,
      sourcePreserved: true,
      targetDataDir,
    };
    emitProgress(args.onProgress, {
      detail: "Import verified. The official profile was not changed.",
      percent: 100,
      phase: "finalize",
    });
    return report;
  } catch (error) {
    await rollBackKeychainEntries({
      dataDir: targetDataDir,
      entries: keychainRollback,
      keychain: args.keychain,
    });
    if (importedEntries.length > 0) {
      await removeImportedServerFiles({
        dataDir: targetDataDir,
        importedEntries,
      }).catch(() => undefined);
    }
    await removeOwnedEmptyTarget(targetDataDir, owner);
    throw error;
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

export async function readPersonalOnboardingState(
  path: string,
): Promise<PersonalOnboardingState | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("version" in raw) ||
      raw.version !== PERSONAL_ONBOARDING_STATE_VERSION ||
      !("outcome" in raw) ||
      (raw.outcome !== "fresh" && raw.outcome !== "imported")
    ) {
      return null;
    }
    return raw as PersonalOnboardingState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writePersonalOnboardingState(args: {
  path: string;
  outcome: PersonalOnboardingState["outcome"];
  report: PersonalProfileImportReport | null;
}): Promise<void> {
  await mkdir(dirname(args.path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(args.path), `.${randomUUID()}.tmp`);
  const state: PersonalOnboardingState = {
    completedAt: new Date().toISOString(),
    outcome: args.outcome,
    report: args.report,
    version: PERSONAL_ONBOARDING_STATE_VERSION,
  };
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(tempPath, args.path);
}
