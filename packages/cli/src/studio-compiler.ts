import solc from "solc";
import legacySolc from "solc-0.7";
import { createStudioCompiler, selectStudioCompiler, compilerSelectionFailure, type StudioRequest } from "@codevis/shared";
const compilers = { "0.8.36": createStudioCompiler(solc), "0.7.6": createStudioCompiler(legacySolc) };
export function analyzeStudio(request: StudioRequest) {
  let version;
  try { version = selectStudioCompiler(request.sources); } catch (error) { return compilerSelectionFailure(request, error); }
  return compilers[version].analyzeStudio(request);
}
export function generateStudio(request: StudioRequest) { return compilers[selectStudioCompiler(request.sources)].generateStudio(request); }
export function buildStudioRuntime(request: StudioRequest) { return compilers[selectStudioCompiler(request.sources)].buildStudioRuntime(request); }
