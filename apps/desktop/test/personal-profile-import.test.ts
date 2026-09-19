import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPluginKeychainSecret,
  type PluginKeychain,
  type PluginKeychainEntry,
  writePluginKeychainSecret,
} from "@bb/secret-storage";
import {
  inspectPersonalProfileImport,
  performPersonalProfileImport,
  sanitizePersonalImportedConfig,
} from "../src/personal-profile-import.js";
import { renderPersonalOnboardingHtml } from "../src/personal-onboarding-dialog.js";

const SYNTHETIC_SECRET = "synthetic-personal-import-secret";
const temporaryDirectories: string[] = [];

class MemoryKeychainEntry implements PluginKeychainEntry {
  constructor(
    private readonly values: Map<string, Uint8Array>,
    private readonly id: string,
    private readonly failWrites: boolean,
  ) {}

  async deleteCredential(): Promise<boolean> {
    return this.values.delete(this.id);
  }

  async getSecret(): Promise<Uint8Array | null> {
    return this.values.get(this.id) ?? null;
  }

  async setSecret(secret: Uint8Array): Promise<void> {
    if (this.failWrites) throw new Error("synthetic Keychain write failure");
    this.values.set(this.id, Uint8Array.from(secret));
  }
}

function createMemoryKeychain(failWrites = false): {
  keychain: PluginKeychain;
  values: Map<string, Uint8Array>;
} {
  const values = new Map<string, Uint8Array>();
  return {
    keychain: {
      entry(service, account) {
        return new MemoryKeychainEntry(
          values,
          `${service}\0${account}`,
          failWrites,
        );
      },
      async findAccounts(service) {
        const prefix = `${service}\0`;
        return [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length));
      },
    },
    values,
  };
}

async function createFixture(): Promise<{
  root: string;
  sourceDataDir: string;
  targetDataDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-personal-profile-import-"));
  temporaryDirectories.push(root);
  const sourceDataDir = join(root, "official");
  const targetDataDir = join(root, "personal");
  await mkdir(join(sourceDataDir, "plugins", "demo-plugin", "secrets"), {
    recursive: true,
  });
  await writeFile(
    join(sourceDataDir, "plugins", "demo-plugin", "secrets", "api-token"),
    SYNTHETIC_SECRET,
    { mode: 0o600 },
  );
  await writeFile(
    join(sourceDataDir, "config.json"),
    JSON.stringify({
      config: { BB_LOG_LEVEL: "debug" },
      customAcpAgents: [
        {
          id: "synthetic",
          displayName: "Synthetic",
          command: "synthetic-agent",
          env: { PRIVATE_TOKEN: SYNTHETIC_SECRET },
        },
      ],
      customModels: [{ providerId: "codex", model: "synthetic-model" }],
      machineCredential: "synthetic-machine-credential",
      serverHeaders: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
      serverUrl: "https://synthetic.invalid",
      sharedSkillRoots: { user: ["synthetic-skills"] },
    }),
    { mode: 0o600 },
  );
  const database = new DatabaseSync(join(sourceDataDir, "bb.db"));
  database.exec(`
    CREATE TABLE plugins (id TEXT PRIMARY KEY, removed_at INTEGER);
    CREATE TABLE plugin_kv (
      plugin_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    );
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
    INSERT INTO plugins (id, removed_at) VALUES ('demo-plugin', NULL);
    INSERT INTO plugin_kv (plugin_id, key, value)
      VALUES ('connect', 'credential', '{"credential":"synthetic-connect"}');
    INSERT INTO __drizzle_migrations (id, hash, created_at)
      VALUES (1, 'synthetic', 1);
  `);
  database.close();
  return { root, sourceDataDir, targetDataDir };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("personal profile import", () => {
  it("sanitizes credential-bearing managed configuration", () => {
    const sanitized = sanitizePersonalImportedConfig({
      config: { BB_LOG_LEVEL: "debug" },
      customAcpAgents: [
        {
          id: "synthetic",
          displayName: "Synthetic",
          command: "synthetic-agent",
          env: { TOKEN: SYNTHETIC_SECRET },
        },
      ],
      customModels: [{ providerId: "codex", model: "synthetic-model" }],
      machineCredential: "synthetic-machine-credential",
      serverHeaders: { authorization: SYNTHETIC_SECRET },
      serverUrl: "https://synthetic.invalid",
    });

    expect(sanitized).toEqual({
      config: { BB_LOG_LEVEL: "debug" },
      customModels: [{ providerId: "codex", model: "synthetic-model" }],
    });
    expect(JSON.stringify(sanitized)).not.toContain(SYNTHETIC_SECRET);
  });

  it("copies a synthetic profile, removes copied credentials, and migrates secret settings", async () => {
    const fixture = await createFixture();
    const memory = createMemoryKeychain();
    const progress: number[] = [];

    const inspection = await inspectPersonalProfileImport({
      sourceDataDir: fixture.sourceDataDir,
      targetDataDir: fixture.targetDataDir,
    });
    expect(inspection).toMatchObject({
      canImport: true,
      pluginCount: 1,
      reason: "ready",
      secretCount: 1,
    });

    const report = await performPersonalProfileImport({
      appVersion: "0.0.0-synthetic",
      keychain: memory.keychain,
      onProgress: (entry) => progress.push(entry.percent),
      sourceDataDir: fixture.sourceDataDir,
      targetDataDir: fixture.targetDataDir,
    });

    expect(report).toMatchObject({
      connectCredentialRemoved: true,
      migratedSecrets: 1,
      pluginCount: 1,
      resumedSecrets: 0,
      sourcePreserved: true,
    });
    expect(progress).toEqual([5, 18, 36, 58, 76, 92, 100]);
    expect(memory.values.size).toBe(1);
    expect(
      await readFile(
        join(
          fixture.sourceDataDir,
          "plugins",
          "demo-plugin",
          "secrets",
          "api-token",
        ),
        "utf8",
      ),
    ).toBe(SYNTHETIC_SECRET);
    await expect(
      readFile(
        join(
          fixture.targetDataDir,
          "plugins",
          "demo-plugin",
          "secrets",
          "api-token",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const importedConfig = JSON.parse(
      await readFile(join(fixture.targetDataDir, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(importedConfig).toEqual({
      config: { BB_LOG_LEVEL: "debug" },
      customModels: [{ providerId: "codex", model: "synthetic-model" }],
      sharedSkillRoots: { project: [], user: ["synthetic-skills"] },
    });
    expect(JSON.stringify(importedConfig)).not.toContain(SYNTHETIC_SECRET);
    const importedDatabase = new DatabaseSync(
      join(fixture.targetDataDir, "bb.db"),
      { readOnly: true },
    );
    expect(
      importedDatabase
        .prepare(
          "SELECT count(*) AS count FROM plugin_kv WHERE plugin_id = 'connect' AND key = 'credential'",
        )
        .get(),
    ).toEqual({ count: 0 });
    importedDatabase.close();
  });

  it("rolls back an interrupted Keychain migration without deleting a pre-existing empty target", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.targetDataDir);
    const memory = createMemoryKeychain(true);

    await expect(
      performPersonalProfileImport({
        appVersion: "0.0.0-synthetic",
        keychain: memory.keychain,
        sourceDataDir: fixture.sourceDataDir,
        targetDataDir: fixture.targetDataDir,
      }),
    ).rejects.toThrow("macOS Keychain is unavailable during write");

    expect(await readdir(fixture.targetDataDir)).toEqual([]);
    expect(memory.values.size).toBe(0);
  });

  it("aborts and rolls back if the official profile starts while the archive is being created", async () => {
    const fixture = await createFixture();
    const memory = createMemoryKeychain();

    await expect(
      performPersonalProfileImport({
        appVersion: "0.0.0-synthetic",
        keychain: memory.keychain,
        onProgress: (entry) => {
          if (entry.percent !== 36) return;
          writeFileSync(
            join(fixture.sourceDataDir, "bb-app-runtime.json"),
            JSON.stringify({
              entryPath: "/synthetic/bb",
              pid: process.pid,
              serverUrl: "http://127.0.0.1:1",
              startedAt: "2026-09-19T00:00:00.000Z",
              surface: "synthetic",
              version: "0.0.0-synthetic",
            }),
          );
        },
        sourceDataDir: fixture.sourceDataDir,
        targetDataDir: fixture.targetDataDir,
      }),
    ).rejects.toThrow(
      "The official bb profile started while the import archive was being created",
    );

    await expect(readdir(fixture.targetDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(memory.values.size).toBe(0);
  });

  it("preserves a conflicting pre-existing target Keychain value and source plaintext", async () => {
    const fixture = await createFixture();
    const memory = createMemoryKeychain();
    const existingValue = "synthetic-existing-target-value";
    await writePluginKeychainSecret(
      {
        dataDir: fixture.targetDataDir,
        key: "api-token",
        pluginId: "demo-plugin",
        value: existingValue,
      },
      memory.keychain,
    );

    await expect(
      performPersonalProfileImport({
        appVersion: "0.0.0-synthetic",
        keychain: memory.keychain,
        sourceDataDir: fixture.sourceDataDir,
        targetDataDir: fixture.targetDataDir,
      }),
    ).rejects.toThrow(
      "Keychain already contains a different value for demo-plugin/api-token",
    );

    await expect(
      readPluginKeychainSecret(
        {
          dataDir: fixture.targetDataDir,
          key: "api-token",
          pluginId: "demo-plugin",
        },
        memory.keychain,
      ),
    ).resolves.toBe(existingValue);
    expect(
      await readFile(
        join(
          fixture.sourceDataDir,
          "plugins",
          "demo-plugin",
          "secrets",
          "api-token",
        ),
        "utf8",
      ),
    ).toBe(SYNTHETIC_SECRET);
    await expect(readdir(fixture.targetDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("personal onboarding dialog", () => {
  it("explains isolation, Keychain, manual updates, import scope, and omissions", () => {
    const html = renderPersonalOnboardingHtml({
      canImport: true,
      pluginCount: 3,
      reason: "ready",
      secretCount: 2,
      sourceDataDir: "/synthetic/official",
      targetDataDir: "/synthetic/personal",
    });

    expect(html).toContain("Welcome to bb Personal");
    expect(html).toContain("isolated");
    expect(html).toContain("Keychain");
    expect(html).toContain("official binary updater is disabled");
    expect(html).toContain("What import copies");
    expect(html).toContain("What import deliberately leaves behind");
    expect(html).toContain('data-choice="import"');
    expect(html).toContain('data-choice="fresh"');
    expect(html).toContain('data-choice="quit"');
  });

  it("disables import while the official profile is running and escapes paths", () => {
    const html = renderPersonalOnboardingHtml({
      canImport: false,
      pluginCount: 3,
      reason: "source-running",
      secretCount: 2,
      sourceDataDir: "/synthetic/<official>",
      targetDataDir: "/synthetic/personal",
    });

    expect(html).toContain("Quit it completely");
    expect(html).toContain("Import unavailable");
    expect(html).not.toContain('data-choice="import"');
    expect(html).not.toContain("/synthetic/<official>");
    expect(html).toContain("/synthetic/&lt;official&gt;");
  });
});
