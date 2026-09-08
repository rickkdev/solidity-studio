import { createStudioCompiler, type StudioRequest } from "@codevis/shared";
import compilerUrl from "solc/soljson.js?url";

type Soljson = { cwrap: (name: string, result: string | null, args: string[]) => (...args: any[]) => any };
const scope = self as unknown as { importScripts: (...urls: string[]) => void; Module: Soljson; postMessage: (data: unknown) => void; onmessage: ((event: MessageEvent) => void) | null };
let compiler: ReturnType<typeof createStudioCompiler> | undefined;
scope.onmessage = (event: MessageEvent<{ operation: string; request: StudioRequest }>) => {
  try {
    if (!compiler) {
      scope.importScripts(compilerUrl);
      const compile = scope.Module.cwrap("solidity_compile", "string", ["string", "number", "number"]);
      const reset = scope.Module.cwrap("solidity_reset", null, []);
      compiler = createStudioCompiler({
        version: scope.Module.cwrap("solidity_version", "string", []),
        compile: input => { try { return compile(input, 0, 0) as string; } finally { reset(); } },
      });
    }
    const { operation, request } = event.data;
    scope.postMessage({ result: operation === "generate" ? compiler.generateStudio(request) : compiler.analyzeStudio(request) });
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : "Browser compilation failed." }); }
};
