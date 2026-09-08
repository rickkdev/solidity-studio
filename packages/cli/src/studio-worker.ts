import { parentPort } from "node:worker_threads";
import { analyzeStudio, generateStudio, buildStudioRuntime } from "./studio-compiler.js";
parentPort?.on("message", ({ id, operation, request }) => {
  try { parentPort?.postMessage({ id, result: operation === "runtime" ? buildStudioRuntime(request) : operation === "generate" ? generateStudio(request) : analyzeStudio(request) }); }
  catch (error) { parentPort?.postMessage({ id, error: error instanceof Error ? error.message : "Compilation failed." }); }
});
