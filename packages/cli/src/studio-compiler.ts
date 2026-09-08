import solc from "solc";
import { createStudioCompiler } from "@codevis/shared";
export const { analyzeStudio, generateStudio, buildStudioRuntime } = createStudioCompiler(solc);
