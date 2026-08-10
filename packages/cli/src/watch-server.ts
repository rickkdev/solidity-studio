import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGraph, serializeGraph, type Graph } from "@codevis/shared";
import { analyzeSolidityStructure, type SolidityDiagnostic } from "./analyze-solidity-structure.js";

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));

export interface WatchServerOptions {
  readonly port?: number;
  readonly webRoot?: string;
}

export interface WatchServer {
  readonly graph: Graph;
  readonly projectPath: string;
  readonly url: string;
  close(): Promise<void>;
}

export class WatchAnalysisError extends Error {
  public readonly diagnostics: readonly SolidityDiagnostic[];

  public constructor(diagnostics: readonly SolidityDiagnostic[]) {
    super(`Analysis failed with ${diagnostics.length} compiler error${diagnostics.length === 1 ? "" : "s"}.`);
    this.name = "WatchAnalysisError";
    this.diagnostics = diagnostics;
  }
}

/** Analyzes a project and starts the loopback-only visualizer HTTP service. */
export async function startWatchServer(
  projectDirectory: string,
  options: WatchServerOptions = {},
): Promise<WatchServer> {
  const projectPath = path.resolve(projectDirectory);
  const port = options.port ?? 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port '${port}'. Expected a number from 0 to 65535.`);
  }

  const webRoot = path.resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
  await access(path.join(webRoot, "index.html")).catch(() => {
    throw new Error(`Web UI build not found at ${webRoot}. Run 'npm run build' first.`);
  });

  const analysis = await analyzeSolidityStructure(projectPath);
  const errors = analysis.diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length > 0) throw new WatchAnalysisError(errors);

  const sources = Object.fromEntries(await Promise.all(
    analysis.files.map(async (file) => [file, await readFile(path.join(projectPath, file), "utf8")] as const),
  ));
  const graph = parseGraph({
    schemaVersion: 1,
    repository: projectPath,
    nodes: analysis.nodes,
    edges: analysis.edges,
    metadata: {
      language: "Solidity",
      compilerVersion: analysis.compilerVersion,
      files: analysis.files,
      sources,
    },
  });
  const graphJson = serializeGraph(graph);

  const server = createServer((request, response) => {
    void handleRequest(request.url ?? "/", response, webRoot, graphJson);
  });
  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine watch server address.");

  return {
    graph,
    projectPath,
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  requestUrl: string,
  response: import("node:http").ServerResponse,
  webRoot: string,
  graphJson: string,
): Promise<void> {
  try {
    const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
    if (pathname === "/api/graph") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(graphJson);
      return;
    }

    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const candidate = path.resolve(webRoot, requested);
    const relative = path.relative(webRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const file = await resolveStaticFile(candidate, webRoot);
    response.writeHead(200, { "content-type": contentType(file) });
    createReadStream(file).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

async function resolveStaticFile(candidate: string, webRoot: string): Promise<string> {
  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile()) return candidate;
  return path.join(webRoot, "index.html");
}

function contentType(file: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  return types[path.extname(file)] ?? "application/octet-stream";
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
