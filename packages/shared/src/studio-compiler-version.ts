import { satisfies, validRange } from "semver";
import type { StudioRequest, StudioResult } from "./studio.js";
export const STUDIO_COMPILER_VERSIONS = ["0.8.36", "0.7.6"] as const;
export type StudioCompilerVersion = typeof STUDIO_COMPILER_VERSIONS[number];
export function solidityPragmas(sources: Record<string, string>): { file: string; range: string }[] {
  return Object.entries(sources).flatMap(([file, source]) => {
    if (typeof source !== "string") throw new Error("Sources must contain Solidity text.");
    const code = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
    return [...code.matchAll(/\bpragma\s+solidity\s+([^;]+);/g)].map(match => ({ file, range: match[1]!.trim() }));
  });
}
export function selectStudioCompiler(sources: Record<string, string>): StudioCompilerVersion {
  const pragmas = solidityPragmas(sources);
  const compatible = STUDIO_COMPILER_VERSIONS.find(version => pragmas.every(({ range }) => validRange(range) && satisfies(version, range)));
  if (!compatible) throw new Error(`No supported compiler satisfies all selected files. Available: ${STUDIO_COMPILER_VERSIONS.join(", ")}. Import production files separately from tests/audits or select a compatible source set.\n${pragmas.slice(0, 8).map(({ file, range }) => `${file}: ${range}`).join("\n")}`);
  return compatible;
}
export function compilerSelectionFailure(request: StudioRequest, error: unknown): StudioResult {
  return { revision: request.revision, sources: request.sources, ...(request.remappings ? { remappings: request.remappings } : {}), compilerVersion: "not selected", program: null, diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : "Could not select a Solidity compiler." }] };
}
