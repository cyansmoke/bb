import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deletePluginKeychainSecret,
  deletePluginKeychainSecrets,
  inspectPluginKeychainSecret,
  migratePluginSecretFilesToKeychain,
  readPluginKeychainSecret,
  writePluginKeychainSecret,
  type PluginKeychain,
  type PluginKeychainEntry,
} from "../src/index.js";

const tempDirs: string[] = [];

function createFakeKeychain(): {
  items: Map<string, Uint8Array>;
  keychain: PluginKeychain;
  operations: Array<{ account?: string; operation: string; service: string }>;
} {
  const items = new Map<string, Uint8Array>();
  const operations: Array<{
    account?: string;
    operation: string;
    service: string;
  }> = [];
  const itemKey = (service: string, account: string) =>
    `${service}\0${account}`;
  const entry = (service: string, account: string): PluginKeychainEntry => ({
    async deleteCredential() {
      operations.push({ account, operation: "delete", service });
      return items.delete(itemKey(service, account));
    },
    async getSecret() {
      operations.push({ account, operation: "read", service });
      const value = items.get(itemKey(service, account));
      return value === undefined ? undefined : Uint8Array.from(value);
    },
    async setSecret(value) {
      operations.push({ account, operation: "write", service });
      items.set(itemKey(service, account), Uint8Array.from(value));
    },
  });
  const keychain: PluginKeychain = {
    entry,
    async findAccounts(service) {
      operations.push({ operation: "list", service });
      const prefix = `${service}\0`;
      return [...items.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
  };
  return { items, keychain, operations };
}

function unavailableKeychain(): PluginKeychain {
  const unavailableEntry: PluginKeychainEntry = {
    async deleteCredential() {
      throw new Error("synthetic backend failure");
    },
    async getSecret() {
      throw new Error("synthetic backend failure");
    },
    async setSecret() {
      throw new Error("synthetic backend failure");
    },
  };
  return {
    entry: () => unavailableEntry,
    async findAccounts() {
      throw new Error("synthetic backend failure");
    },
  };
}

async function migrationFixture(): Promise<{
  dataDir: string;
  secretPath: string;
  value: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-keychain-migration-"));
  tempDirs.push(dataDir);
  const secretPath = join(dataDir, "plugins", "fixture", "secrets", "apiKey");
  const value = "synthetic-migration-secret";
  await mkdir(join(secretPath, ".."), { recursive: true });
  await writeFile(secretPath, value, { encoding: "utf8", mode: 0o600 });
  return { dataDir, secretPath, value };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("plugin Keychain storage", () => {
  it("round-trips, replaces, and removes a synthetic secret without process arguments", async () => {
    const fake = createFakeKeychain();
    const item = {
      dataDir: "/tmp/bb-keychain-profile-a",
      key: "apiKey",
      pluginId: "fixture",
    };
    const first = "synthetic-first\nline-two";
    const second = "synthetic-second";

    await writePluginKeychainSecret({ ...item, value: first }, fake.keychain);
    await expect(readPluginKeychainSecret(item, fake.keychain)).resolves.toBe(
      first,
    );
    await writePluginKeychainSecret({ ...item, value: second }, fake.keychain);
    await expect(readPluginKeychainSecret(item, fake.keychain)).resolves.toBe(
      second,
    );

    expect(JSON.stringify(fake.operations)).not.toContain("synthetic-");

    await deletePluginKeychainSecret(item, fake.keychain);
    await expect(
      readPluginKeychainSecret(item, fake.keychain),
    ).resolves.toBeUndefined();
  });

  it("isolates data-dir profiles and deletes every item for one plugin", async () => {
    const fake = createFakeKeychain();
    const shared = { key: "token", pluginId: "fixture" };
    await writePluginKeychainSecret(
      { ...shared, dataDir: "/tmp/profile-a", value: "synthetic-a" },
      fake.keychain,
    );
    await writePluginKeychainSecret(
      { ...shared, dataDir: "/tmp/profile-b", value: "synthetic-b" },
      fake.keychain,
    );
    await writePluginKeychainSecret(
      {
        dataDir: "/tmp/profile-a",
        key: "second",
        pluginId: "fixture",
        value: "synthetic-second",
      },
      fake.keychain,
    );

    await deletePluginKeychainSecrets(
      { dataDir: "/tmp/profile-a", pluginId: "fixture" },
      fake.keychain,
    );

    await expect(
      readPluginKeychainSecret(
        { ...shared, dataDir: "/tmp/profile-a" },
        fake.keychain,
      ),
    ).resolves.toBeUndefined();
    await expect(
      readPluginKeychainSecret(
        { ...shared, dataDir: "/tmp/profile-b" },
        fake.keychain,
      ),
    ).resolves.toBe("synthetic-b");
  });

  it("reports unavailable separately from a missing entry", async () => {
    const fake = createFakeKeychain();
    const item = {
      dataDir: "/tmp/profile-status",
      key: "token",
      pluginId: "fixture",
    };
    await expect(
      inspectPluginKeychainSecret(item, fake.keychain),
    ).resolves.toEqual({
      backend: "keychain",
      set: false,
      status: "not-configured",
    });
    await expect(
      inspectPluginKeychainSecret(item, unavailableKeychain()),
    ).resolves.toEqual({
      backend: "keychain",
      set: false,
      status: "unavailable",
    });
    await expect(
      writePluginKeychainSecret(
        { ...item, value: "synthetic-never-in-error" },
        unavailableKeychain(),
      ),
    ).rejects.toThrow("macOS Keychain is unavailable during write");
  });

  it.runIf(
    process.platform === "darwin" && process.env.BB_TEST_MACOS_KEYCHAIN === "1",
  )(
    "round-trips and bulk-deletes synthetic values in an isolated macOS Keychain namespace",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "bb-keychain-live-"));
      tempDirs.push(dataDir);
      const item = { dataDir, key: "apiKey", pluginId: "synthetic-fixture" };
      const secondItem = { ...item, key: "refreshToken" };
      const value = `synthetic-${randomUUID()}`;
      try {
        await expect(
          deletePluginKeychainSecrets({
            dataDir,
            pluginId: item.pluginId,
          }),
        ).resolves.toBeUndefined();
        await writePluginKeychainSecret({ ...item, value });
        await writePluginKeychainSecret({
          ...secondItem,
          value: `synthetic-${randomUUID()}`,
        });
        await expect(readPluginKeychainSecret(item)).resolves.toBe(value);
        await expect(inspectPluginKeychainSecret(item)).resolves.toEqual({
          backend: "keychain",
          set: true,
          status: "configured",
        });
        await deletePluginKeychainSecrets({
          dataDir,
          pluginId: item.pluginId,
        });
        await expect(readPluginKeychainSecret(item)).resolves.toBeUndefined();
        await expect(
          readPluginKeychainSecret(secondItem),
        ).resolves.toBeUndefined();
      } finally {
        await deletePluginKeychainSecret(item);
        await deletePluginKeychainSecret(secondItem);
      }
    },
  );
});

describe("plugin secret migration", () => {
  it("writes, verifies, and only then removes the plaintext source", async () => {
    const source = await migrationFixture();
    const fake = createFakeKeychain();

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: fake.keychain,
      }),
    ).resolves.toEqual([
      { key: "apiKey", pluginId: "fixture", status: "migrated" },
    ]);
    await expect(stat(source.secretPath)).rejects.toThrow();
    await expect(readdir(join(source.secretPath, ".."))).resolves.toEqual([]);
    await expect(
      readPluginKeychainSecret(
        {
          dataDir: source.dataDir,
          key: "apiKey",
          pluginId: "fixture",
        },
        fake.keychain,
      ),
    ).resolves.toBe(source.value);
  });

  it("keeps the source on conflict", async () => {
    const source = await migrationFixture();
    const fake = createFakeKeychain();
    await writePluginKeychainSecret(
      {
        dataDir: source.dataDir,
        key: "apiKey",
        pluginId: "fixture",
        value: "synthetic-other",
      },
      fake.keychain,
    );

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: fake.keychain,
      }),
    ).resolves.toEqual([
      { key: "apiKey", pluginId: "fixture", status: "conflict" },
    ]);
    await expect(readFile(source.secretPath, "utf8")).resolves.toBe(
      source.value,
    );
  });

  it("retries safely after a failure between Keychain write and source deletion", async () => {
    const source = await migrationFixture();
    const fake = createFakeKeychain();
    let reads = 0;
    const failVerificationOnce: PluginKeychain = {
      ...fake.keychain,
      entry(service, account) {
        const entry = fake.keychain.entry(service, account);
        return {
          ...entry,
          async getSecret() {
            reads += 1;
            if (reads === 2) throw new Error("synthetic verification failure");
            return entry.getSecret();
          },
        };
      },
    };

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: failVerificationOnce,
      }),
    ).rejects.toThrow("Keychain is unavailable");
    await expect(readFile(source.secretPath, "utf8")).resolves.toBe(
      source.value,
    );

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: fake.keychain,
      }),
    ).resolves.toEqual([
      { key: "apiKey", pluginId: "fixture", status: "resumed" },
    ]);
    await expect(stat(source.secretPath)).rejects.toThrow();
  });

  it("preserves a replacement quarantined after verification", async () => {
    const source = await migrationFixture();
    const fake = createFakeKeychain();
    let reads = 0;
    const replaceBeforeDelete: PluginKeychain = {
      ...fake.keychain,
      entry(service, account) {
        const entry = fake.keychain.entry(service, account);
        return {
          ...entry,
          async getSecret() {
            const value = await entry.getSecret();
            reads += 1;
            if (reads === 2) {
              await rm(source.secretPath);
              await writeFile(source.secretPath, "synthetic-replacement", {
                encoding: "utf8",
                mode: 0o600,
              });
            }
            return value;
          },
        };
      },
    };

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: replaceBeforeDelete,
      }),
    ).rejects.toThrow("source changed during migration");
    await expect(readFile(source.secretPath, "utf8")).resolves.toBe(
      "synthetic-replacement",
    );
    await expect(readdir(join(source.secretPath, ".."))).resolves.toEqual([
      "apiKey",
    ]);
  });

  it("reports the quarantine path when a non-file replacement cannot be restored", async () => {
    const source = await migrationFixture();
    const fake = createFakeKeychain();
    let reads = 0;
    const replaceWithDirectory: PluginKeychain = {
      ...fake.keychain,
      entry(service, account) {
        const entry = fake.keychain.entry(service, account);
        return {
          ...entry,
          async getSecret() {
            const value = await entry.getSecret();
            reads += 1;
            if (reads === 2) {
              await rm(source.secretPath);
              await mkdir(source.secretPath);
              await writeFile(
                join(source.secretPath, "replacement"),
                "synthetic-replacement",
              );
            }
            return value;
          },
        };
      },
    };

    await expect(
      migratePluginSecretFilesToKeychain({
        dataDir: source.dataDir,
        keychain: replaceWithDirectory,
      }),
    ).rejects.toThrow(
      /replacement preserved at .*\.bb-keychain-migration-quarantine-/,
    );
    const entries = await readdir(join(source.secretPath, ".."));
    expect(entries).toHaveLength(1);
    await expect(
      readFile(
        join(source.secretPath, "..", entries[0]!, "apiKey", "replacement"),
        "utf8",
      ),
    ).resolves.toBe("synthetic-replacement");
  });
});
