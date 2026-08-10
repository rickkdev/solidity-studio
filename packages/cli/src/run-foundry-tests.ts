import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

export type FoundryTestStatus = "passed" | "failed" | "skipped";

export interface FoundryTestResult {
  readonly suite: string;
  readonly name: string;
  readonly status: FoundryTestStatus;
  readonly durationMs: number;
  readonly reason?: string;
}

export interface FoundryTestRun {
  readonly projectPath: string;
  readonly filter?: string;
  readonly results: readonly FoundryTestResult[];
  readonly diagnostics: readonly string[];
  readonly exitCode: number;
}

export class FoundryPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundryPrerequisiteError";
  }
}

export interface RunFoundryTestsOptions {
  readonly forgeExecutable?: string;
}

/** Runs Foundry directly (without a shell) and parses its machine-readable results. */
export async function runFoundryTests(
  projectDirectory: string,
  filter?: string,
  options: RunFoundryTestsOptions = {},
): Promise<FoundryTestRun> {
  const projectPath = path.resolve(projectDirectory);
  await assertFoundryProject(projectPath);
  const executable = options.forgeExecutable ?? "forge";
  await assertForgeAvailable(executable);

  const args = ["test", "--json"];
  if (filter !== undefined) args.push("--match-test", filter);
  const processResult = await execute(executable, args, projectPath);
  const parsed = parseFoundryJson(processResult.stdout);
  const diagnostics = [...parsed.diagnostics];
  if (processResult.stderr.trim()) diagnostics.push(processResult.stderr.trim());
  if (processResult.exitCode !== 0 && parsed.results.length === 0) {
    diagnostics.push("Foundry did not produce test results. Check the compiler output above.");
  }
  return {
    projectPath,
    ...(filter === undefined ? {} : { filter }),
    results: parsed.results,
    diagnostics,
    exitCode: processResult.exitCode,
  };
}

async function assertFoundryProject(projectPath: string): Promise<void> {
  try {
    await readFile(path.join(projectPath, "foundry.toml"), "utf8");
  } catch {
    throw new FoundryPrerequisiteError(`Not a Foundry project: no foundry.toml found in ${projectPath}.`);
  }
}

async function assertForgeAvailable(executable: string): Promise<void> {
  if (executable.includes(path.sep)) {
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw new FoundryPrerequisiteError(`Foundry forge executable is unavailable at ${executable}. Install Foundry and ensure forge is executable.`);
    }
  }
  try {
    await execute(executable, ["--version"], process.cwd());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FoundryPrerequisiteError("Foundry forge is unavailable. Install Foundry and ensure 'forge' is on PATH.");
    }
    throw error;
  }
}

function execute(executable: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

export function parseFoundryJson(output: string): { results: FoundryTestResult[]; diagnostics: string[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return { results: [], diagnostics: output.trim() ? [output.trim()] : [] };
  }
  if (!isRecord(payload)) return { results: [], diagnostics: ["Foundry returned malformed JSON output."] };

  const results: FoundryTestResult[] = [];
  for (const suite of Object.keys(payload).sort()) {
    const suiteValue = payload[suite];
    if (!isRecord(suiteValue) || !isRecord(suiteValue.test_results)) continue;
    for (const name of Object.keys(suiteValue.test_results).sort()) {
      const test = suiteValue.test_results[name];
      if (!isRecord(test)) continue;
      const status = normalizeStatus(test.status);
      if (!status) continue;
      results.push({
        suite,
        name,
        status,
        durationMs: parseDuration(String(test.duration ?? "0")),
        ...(typeof test.reason === "string" ? { reason: test.reason } : {}),
      });
    }
  }
  return { results, diagnostics: [] };
}

function normalizeStatus(status: unknown): FoundryTestStatus | undefined {
  if (status === "Success") return "passed";
  if (status === "Failure") return "failed";
  if (status === "Skipped") return "skipped";
  return undefined;
}

function parseDuration(value: string): number {
  const units: Record<string, number> = { s: 1_000, ms: 1, "µs": 0.001, us: 0.001, ns: 0.000_001 };
  let total = 0;
  for (const match of value.matchAll(/([\d.]+)\s*(ms|µs|us|ns|s)\b/g)) total += Number(match[1]) * units[match[2]!]!;
  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
