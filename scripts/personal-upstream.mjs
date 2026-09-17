import { appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const CONFLICT_EXIT_CODE = 2;
const MERGE_CONFLICT_STATUS = 1;

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
  return result;
}

function parseFetchTarget(target) {
  const separator = target.indexOf("/");
  if (separator <= 0 || separator === target.length - 1) {
    throw new Error(
      `--upstream must be REMOTE/BRANCH when fetching, got ${target}`,
    );
  }
  return {
    branch: target.slice(separator + 1),
    remote: target.slice(0, separator),
  };
}

function conflictPaths(output) {
  const lines = output.split("\n");
  const paths = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) break;
    paths.push(line);
  }
  return [...new Set(paths)].sort();
}

export function escapeWorkflowCommandProperty(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function countRange(cwd, range) {
  return Number.parseInt(
    runGit(["rev-list", "--count", range], { cwd }).stdout.trim(),
    10,
  );
}

async function writeSummary(lines, env = process.env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (path === undefined || path.length === 0) return;
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

export async function inspectUpstream(args) {
  const target = args.target;
  runGit(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: args.cwd });
  runGit(["rev-parse", "--verify", `${target}^{commit}`], { cwd: args.cwd });
  const ahead = countRange(args.cwd, `${target}..HEAD`);
  const behind = countRange(args.cwd, `HEAD..${target}`);
  if (behind === 0) {
    return { ahead, behind, conflicts: [], target };
  }
  const merge = runGit(
    ["merge-tree", "--write-tree", "--name-only", "--messages", "HEAD", target],
    { allowFailure: true, cwd: args.cwd },
  );
  if (merge.status === 0) {
    return { ahead, behind, conflicts: [], target };
  }
  if (merge.status !== MERGE_CONFLICT_STATUS) {
    const detail = `${merge.stdout ?? ""}${merge.stderr ?? ""}`.trim();
    throw new Error(
      detail || `git merge-tree failed with status ${merge.status}`,
    );
  }
  const conflicts = conflictPaths(merge.stdout);
  if (conflicts.length === 0) {
    throw new Error("git merge-tree reported conflicts without any paths");
  }
  return {
    ahead,
    behind,
    conflicts,
    target,
  };
}

export async function main(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const mode = argv[0] ?? "check";
  if (mode !== "check" && mode !== "apply") {
    throw new Error(
      "Usage: personal-upstream.mjs check|apply [--upstream REMOTE/BRANCH] [--no-fetch]",
    );
  }
  const target = optionValue(argv, "--upstream", "upstream/main");
  if (target === undefined || target.length === 0) {
    throw new Error("--upstream requires a value");
  }
  if (mode === "apply") {
    const dirty = runGit(["status", "--porcelain"], { cwd }).stdout.trim();
    if (dirty.length > 0) {
      throw new Error("Refusing to update a dirty working tree");
    }
  }
  if (!argv.includes("--no-fetch")) {
    const fetchTarget = parseFetchTarget(target);
    runGit(["fetch", "--prune", fetchTarget.remote, fetchTarget.branch], {
      cwd,
      inherit: true,
    });
  }
  const result = await inspectUpstream({ cwd, target });
  const headline = `${target}: ahead ${result.ahead}, behind ${result.behind}`;
  if (result.conflicts.length > 0) {
    process.stderr.write(`${headline}; conflicts:\n`);
    for (const path of result.conflicts) {
      process.stderr.write(`- ${path}\n`);
      if (env.GITHUB_ACTIONS === "true") {
        process.stderr.write(
          `::error file=${escapeWorkflowCommandProperty(path)}::Conflicts with ${target}\n`,
        );
      }
    }
    await writeSummary(
      [
        "## Personal fork upstream check",
        "",
        `${headline}.`,
        "",
        "Conflicting paths:",
        ...result.conflicts.map((path) => `- \`${path}\``),
      ],
      env,
    );
    return CONFLICT_EXIT_CODE;
  }
  process.stdout.write(`${headline}; merge is clean.\n`);
  await writeSummary(
    ["## Personal fork upstream check", "", `${headline}; merge is clean.`],
    env,
  );
  if (mode === "apply" && result.behind > 0) {
    runGit(["merge", "--no-edit", "--no-ff", target], {
      cwd,
      inherit: true,
    });
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
