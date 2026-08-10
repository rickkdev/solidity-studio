import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGraph, serializeGraph, type Graph } from "@codevis/shared";
import { analyzeSolidityStructure, type SolidityDiagnostic } from "./analyze-solidity-structure.js";
import { startWatchServer, WatchAnalysisError } from "./watch-server.js";
import { runFoundryTests } from "./run-foundry-tests.js";

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

const HELP = `Usage: codevis <command> [path] [options]

Analyze a Solidity project and emit its validated graph as JSON.

Commands:
  analyze [path]       Analyze path (defaults to the current directory)
  watch [path]         Start the local visualizer for path
  test [filter]        Run Foundry tests in the current directory

Options:
  -o, --output <file>  Write graph JSON to a file instead of stdout
  -p, --port <number>  Watch server port (defaults to 4173)
  -h, --help           Show this help
`;

/** Runs the public command and returns the process exit code. */
export async function runCli(
  args: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseArguments(args);
    if (parsed.help) {
      io.stdout.write(HELP);
      return 0;
    }

    if (parsed.command === "watch") {
      const project = path.resolve(parsed.projectPath);
      io.stderr.write(`Analyzing Solidity project: ${project}\n`);
      try {
        const service = await startWatchServer(
          project,
          parsed.port === undefined ? {} : { port: parsed.port },
        );
        io.stderr.write(`Code Visualizer: ${service.url}\n`);
        io.stderr.write(`Project: ${service.projectPath}\n`);
        await waitForShutdown(service.close);
        io.stderr.write("Watch server stopped.\n");
        return 0;
      } catch (error) {
        if (error instanceof WatchAnalysisError) writeDiagnostics(error.diagnostics, io.stderr);
        throw error;
      }
    }

    if (parsed.command === "test") {
      io.stderr.write(`Running Foundry tests: ${path.resolve(parsed.projectPath)}\n`);
      const run = await runFoundryTests(parsed.projectPath, parsed.testFilter);
      for (const diagnostic of run.diagnostics) io.stderr.write(`${diagnostic}\n`);
      io.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      const passed = run.results.filter(({ status }) => status === "passed").length;
      const failed = run.results.filter(({ status }) => status === "failed").length;
      const skipped = run.results.filter(({ status }) => status === "skipped").length;
      io.stderr.write(`Foundry complete: ${passed} passed, ${failed} failed, ${skipped} skipped.\n`);
      return run.exitCode === 0 && failed === 0 ? 0 : 1;
    }

    const project = path.resolve(parsed.projectPath);
    io.stderr.write(`Analyzing Solidity project: ${project}\n`);
    const analysis = await analyzeSolidityStructure(project);
    writeDiagnostics(analysis.diagnostics, io.stderr);

    const errors = analysis.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length > 0) {
      io.stderr.write(`Analysis failed with ${errors.length} compiler error${errors.length === 1 ? "" : "s"}.\n`);
      return 1;
    }

    const graph: Graph = parseGraph({
      schemaVersion: 1,
      repository: project,
      nodes: analysis.nodes,
      edges: analysis.edges,
      metadata: {
        language: "Solidity",
        compilerVersion: analysis.compilerVersion,
        files: analysis.files,
      },
    });
    const json = `${serializeGraph(graph)}\n`;
    if (parsed.outputPath) {
      const output = path.resolve(parsed.outputPath);
      await writeFile(output, json, "utf8");
      io.stderr.write(`Graph written to ${output}\n`);
    } else {
      io.stdout.write(json);
    }
    io.stderr.write(`Analysis complete: ${graph.nodes.length} nodes, ${graph.edges.length} edges.\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`codevis: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

interface ParsedArguments {
  readonly command: "analyze" | "watch" | "test";
  readonly help: boolean;
  readonly projectPath: string;
  readonly outputPath?: string;
  readonly port?: number;
  readonly testFilter?: string;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  if (args.includes("--help") || args.includes("-h")) return { command: "analyze", help: true, projectPath: "." };
  if (args[0] !== "analyze" && args[0] !== "watch" && args[0] !== "test") {
    throw new Error(args.length === 0
      ? "missing command. Run 'codevis --help' for usage."
      : `unknown command '${args[0]}'. Run 'codevis --help' for usage.`);
  }

  const projectPath = ".";
  let outputPath: string | undefined;
  let positional: string | undefined;
  let port: number | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--output" || argument === "-o") {
      if (args[0] !== "analyze") throw new Error(`${argument} is only available for analyze.`);
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a file path.`);
      outputPath = value;
      index += 1;
    } else if (argument === "--port" || argument === "-p") {
      if (args[0] !== "watch") throw new Error(`${argument} is only available for watch.`);
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) throw new Error(`${argument} requires a numeric port.`);
      port = Number(value);
      if (port < 1 || port > 65_535) throw new Error(`Invalid port '${value}'. Expected a number from 1 to 65535.`);
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'. Run 'codevis --help' for usage.`);
    } else if (positional !== undefined) {
      throw new Error(`unexpected argument '${argument}'. Run 'codevis --help' for usage.`);
    } else {
      positional = argument;
    }
  }
  return {
    command: args[0],
    help: false,
    projectPath: args[0] === "test" ? projectPath : (positional ?? projectPath),
    ...(args[0] === "test" && positional !== undefined ? { testFilter: positional } : {}),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(port === undefined ? {} : { port }),
  };
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function writeDiagnostics(
  diagnostics: readonly SolidityDiagnostic[],
  stderr: Pick<NodeJS.WriteStream, "write">,
): void {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.source
      ? `${diagnostic.source.file}:${diagnostic.source.start.line}:${diagnostic.source.start.column}: `
      : "";
    stderr.write(`${location}${diagnostic.severity}: ${diagnostic.message}\n`);
  }
}
