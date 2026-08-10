#!/usr/bin/env node
import { createEmptyGraph } from "@codevis/shared";

export {
  discoverSolidityFiles,
  SolidityDiscoveryError,
  type DiscoverSolidityFilesOptions,
} from "./discover-solidity-files.js";
export {
  analyzeSolidityStructure,
  type SolidityDiagnostic,
  type SolidityStructureAnalysis,
} from "./analyze-solidity-structure.js";
export { runCli, type CliIo } from "./run-cli.js";
export {
  FoundryPrerequisiteError,
  parseFoundryJson,
  runFoundryTests,
  type FoundryTestResult,
  type FoundryTestRun,
  type FoundryTestStatus,
  type RunFoundryTestsOptions,
} from "./run-foundry-tests.js";
export {
  startWatchServer,
  WatchAnalysisError,
  type WatchServer,
  type WatchServerOptions,
} from "./watch-server.js";

export function serviceStatus(): string {
  const graph = createEmptyGraph("Code Visualizer");
  return `${graph.name} local service ready`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { runCli } = await import("./run-cli.js");
  process.exitCode = await runCli(process.argv.slice(2));
}
