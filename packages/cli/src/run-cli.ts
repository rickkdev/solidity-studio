import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseGraph, serializeGraph, type Graph } from "@codevis/shared";
import { analyzeSolidityStructure, type SolidityDiagnostic } from "./analyze-solidity-structure.js";

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

const HELP = `Usage: codevis analyze [path] [options]

Analyze a Solidity project and emit its validated graph as JSON.

Commands:
  analyze [path]       Analyze path (defaults to the current directory)

Options:
  -o, --output <file>  Write graph JSON to a file instead of stdout
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
  readonly help: boolean;
  readonly projectPath: string;
  readonly outputPath?: string;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  if (args.includes("--help") || args.includes("-h")) return { help: true, projectPath: "." };
  if (args[0] !== "analyze") {
    throw new Error(args.length === 0
      ? "missing command. Run 'codevis --help' for usage."
      : `unknown command '${args[0]}'. Run 'codevis --help' for usage.`);
  }

  let projectPath = ".";
  let outputPath: string | undefined;
  let hasProjectPath = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--output" || argument === "-o") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a file path.`);
      outputPath = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option '${argument}'. Run 'codevis --help' for usage.`);
    } else if (hasProjectPath) {
      throw new Error(`unexpected argument '${argument}'. Run 'codevis --help' for usage.`);
    } else {
      projectPath = argument;
      hasProjectPath = true;
    }
  }
  return outputPath === undefined
    ? { help: false, projectPath }
    : { help: false, projectPath, outputPath };
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
