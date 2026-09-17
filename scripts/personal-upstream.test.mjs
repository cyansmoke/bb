import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

const tempDirs = [];
const scriptPath = new URL("./personal-upstream.mjs", import.meta.url).pathname;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "bb-personal-upstream-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-b", "personal"]);
  git(cwd, ["config", "user.email", "synthetic@example.invalid"]);
  git(cwd, ["config", "user.name", "Synthetic Test"]);
  await writeFile(join(cwd, "shared.txt"), "base\n");
  await writeFile(join(cwd, "personal.txt"), "base\n");
  await writeFile(join(cwd, "upstream.txt"), "base\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "base"]);
  return cwd;
}

function runScript(cwd, mode, target) {
  return spawnSync(
    process.execPath,
    [scriptPath, mode, "--no-fetch", "--upstream", target],
    { cwd, encoding: "utf8" },
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("reports a clean upstream merge without changing the worktree", async () => {
  const cwd = await fixture();
  const base = git(cwd, ["rev-parse", "HEAD"]);
  git(cwd, ["switch", "-c", "upstream-clean"]);
  await writeFile(join(cwd, "upstream.txt"), "upstream\n");
  git(cwd, ["commit", "-am", "upstream"]);
  git(cwd, ["switch", "personal"]);
  await writeFile(join(cwd, "personal.txt"), "personal\n");
  git(cwd, ["commit", "-am", "personal"]);

  const before = git(cwd, ["rev-parse", "HEAD"]);
  const result = runScript(cwd, "check", "upstream-clean");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ahead 1, behind 1; merge is clean/);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before);
  assert.equal(git(cwd, ["merge-base", "HEAD", "upstream-clean"]), base);
});

test("lists conflicting paths and leaves the repository untouched", async () => {
  const cwd = await fixture();
  git(cwd, ["switch", "-c", "upstream-conflict"]);
  await writeFile(join(cwd, "shared.txt"), "upstream\n");
  git(cwd, ["commit", "-am", "upstream"]);
  git(cwd, ["switch", "personal"]);
  await writeFile(join(cwd, "shared.txt"), "personal\n");
  git(cwd, ["commit", "-am", "personal"]);

  const before = git(cwd, ["rev-parse", "HEAD"]);
  const result = runScript(cwd, "check", "upstream-conflict");

  assert.equal(result.status, CONFLICT_EXIT_CODE);
  assert.match(result.stderr, /conflicts:\n- shared\.txt/);
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), before);
  assert.equal(git(cwd, ["status", "--porcelain"]), "");
});

test("applies a clean upstream update as a merge commit", async () => {
  const cwd = await fixture();
  git(cwd, ["switch", "-c", "upstream-clean"]);
  await writeFile(join(cwd, "upstream.txt"), "upstream\n");
  git(cwd, ["commit", "-am", "upstream"]);
  git(cwd, ["switch", "personal"]);
  await writeFile(join(cwd, "personal.txt"), "personal\n");
  git(cwd, ["commit", "-am", "personal"]);

  const result = runScript(cwd, "apply", "upstream-clean");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(cwd, "upstream.txt"), "utf8"), "upstream\n");
  assert.equal(
    git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length,
    3,
  );
});

const CONFLICT_EXIT_CODE = 2;
