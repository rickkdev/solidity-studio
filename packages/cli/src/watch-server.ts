import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStableNodeId, parseGraph, parseWorkEvent, serializeGraph, type Graph, type GraphNodeStatus, type WorkEvent, type WorkEventType } from "@codevis/shared";
import { watch, type FSWatcher } from "chokidar";
import { analyzeSolidityStructure, type SolidityDiagnostic } from "./analyze-solidity-structure.js";

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url));

export interface WatchServerOptions {
  readonly port?: number;
  readonly webRoot?: string;
  readonly ignoredPaths?: readonly string[];
  readonly debounceMs?: number;
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

  const analysisOptions = options.ignoredPaths === undefined ? {} : { ignoredPaths: options.ignoredPaths };
  const analysis = await analyzeSolidityStructure(projectPath, analysisOptions);
  const errors = analysis.diagnostics.filter(({ severity }) => severity === "error");
  if (errors.length > 0) throw new WatchAnalysisError(errors);

  let graph = await graphFromAnalysis(projectPath, analysis);
  const workEvents: WorkEvent[] = [];
  let eventSequence = 0;
  const addEvent = (type: WorkEventType, message: string, targetIds: readonly string[] = [], metadata: WorkEvent["metadata"] = {}) => {
    const event = parseWorkEvent({ schemaVersion: 1, id: `session-${++eventSequence}`, type, timestamp: new Date().toISOString(), message, targetIds, metadata });
    workEvents.push(event);
    graph = withWorkEvents(graph, workEvents);
    return event;
  };
  const repositoryId = graph.nodes.find(({ kind }) => kind === "repository")?.id;
  addEvent("plan_created", "Started repository watch session", repositoryId ? [repositoryId] : []);
  addEvent("command_started", "Analyzed Solidity project", repositoryId ? [repositoryId] : [], { command: "analyze" });
  addEvent("work_completed", "Initial analysis completed", repositoryId ? [repositoryId] : []);
  const clients = new Set<import("node:http").ServerResponse>();

  const server = createServer((request, response) => {
    void handleRequest(request, response, webRoot, () => graph, clients, (event) => {
      workEvents.push(event);
      workEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
      graph = withWorkEvents(graph, workEvents);
      broadcast(clients, graph);
    });
  });
  await listen(server, port);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine watch server address.");

  const changedFiles = new Map<string, "created" | "modified" | "deleted">();
  let timer: NodeJS.Timeout | undefined;
  let queued = Promise.resolve();
  const schedule = (file: string, change: "created" | "modified" | "deleted") => {
    const relative = path.relative(projectPath, file).replaceAll(path.sep, "/");
    changedFiles.set(relative, change);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const changes = new Map(changedFiles);
      changedFiles.clear();
      queued = queued.then(async () => {
        const targets = graph.nodes.filter((node) => node.source && changes.has(node.source.file)).map(({ id }) => id);
        addEvent("file_edit_started", `Processing ${changes.size} Solidity file change${changes.size === 1 ? "" : "s"}`, targets, { files: [...changes.keys()] });
        graph = withStatuses(graph, changes, "active");
        graph = withWorkEvents(graph, workEvents);
        broadcast(clients, graph);
        try {
          const nextAnalysis = await analyzeSolidityStructure(projectPath, analysisOptions);
          const analysisErrors = nextAnalysis.diagnostics.filter(({ severity }) => severity === "error");
          if (analysisErrors.length > 0) {
            graph = withStatuses(graph, changes, "failed", analysisErrors);
          } else {
            const next = await graphFromAnalysis(projectPath, nextAnalysis);
            graph = mergeChangeStatuses(graph, next, changes);
          }
        } catch (error) {
          graph = withStatuses(graph, changes, "failed", [{ severity: "error", message: error instanceof Error ? error.message : String(error) }]);
        }
        const failed = graph.nodes.some((node) => node.source && changes.has(node.source.file) && node.status === "failed");
        addEvent("file_edit_completed", failed ? "Analysis completed with errors" : "Solidity file changes analyzed", graph.nodes.filter((node) => node.source && changes.has(node.source.file)).map(({ id }) => id), { files: [...changes.keys()], outcome: failed ? "failed" : "passed" });
        broadcast(clients, graph);
      });
    }, options.debounceMs ?? 100);
  };
  const watcher = watch(projectPath, {
    ignored: (candidate) => isIgnoredWatchPath(projectPath, candidate, options.ignoredPaths ?? []),
    ignoreInitial: true,
  });
  watcher.on("add", (file) => { if (file.endsWith(".sol")) schedule(file, "created"); });
  watcher.on("change", (file) => { if (file.endsWith(".sol")) schedule(file, "modified"); });
  watcher.on("unlink", (file) => { if (file.endsWith(".sol")) schedule(file, "deleted"); });
  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", resolve);
    watcher.once("error", reject);
  });

  return {
    get graph() { return graph; },
    projectPath,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
      await queued;
      clients.forEach((client) => client.end());
      await closeServer(server);
    },
  };
}

async function handleRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  webRoot: string,
  currentGraph: () => Graph,
  clients: Set<import("node:http").ServerResponse>,
  recordExternalEvent: (event: WorkEvent) => void,
): Promise<void> {
  try {
    const requestUrl = request.url ?? "/";
    const pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
    if (pathname === "/api/graph") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(serializeGraph(currentGraph()));
      return;
    }
    if (pathname === "/api/work-events" && request.method === "POST") {
      try {
        const event = parseWorkEvent(JSON.parse(await readRequestBody(request)) as unknown);
        recordExternalEvent(event);
        response.writeHead(202, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(event));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      clients.add(response);
      response.write(`data: ${serializeGraph(currentGraph())}\n\n`);
      response.on("close", () => clients.delete(response));
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

function withWorkEvents(graph: Graph, events: readonly WorkEvent[]): Graph {
  return parseGraph({ ...graph, metadata: { ...graph.metadata, workEvents: events } });
}

function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("Event payload is too large."));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function graphFromAnalysis(projectPath: string, analysis: Awaited<ReturnType<typeof analyzeSolidityStructure>>): Promise<Graph> {
  const sources = Object.fromEntries(await Promise.all(
    analysis.files.map(async (file) => [file, await readFile(path.join(projectPath, file), "utf8")] as const),
  ));
  return parseGraph({ schemaVersion: 1, repository: projectPath, nodes: analysis.nodes, edges: analysis.edges,
    metadata: { language: "Solidity", compilerVersion: analysis.compilerVersion, files: analysis.files, sources } });
}

function withStatuses(graph: Graph, changes: ReadonlyMap<string, string>, status: GraphNodeStatus, diagnostics: readonly SolidityDiagnostic[] = []): Graph {
  const affected = new Set(changes.keys());
  const nodes = graph.nodes.map((node) => node.source && affected.has(node.source.file) ? { ...node, status } : node);
  for (const [file] of changes) {
    if (!nodes.some((node) => node.source?.file === file)) nodes.push({
      id: createStableNodeId({ kind: "file", path: file }), kind: "file", label: path.posix.basename(file), status,
      metadata: { transient: true }, source: { file, start: { offset: 0, line: 1, column: 1 }, end: { offset: 0, line: 1, column: 1 } },
    });
  }
  return parseGraph({ ...graph, nodes, metadata: { ...graph.metadata, diagnostics: diagnostics.map((item) => ({ severity: item.severity, message: item.message, ...(item.source ? { file: item.source.file, line: item.source.start.line } : {}) })) } });
}

function mergeChangeStatuses(previous: Graph, next: Graph, changes: ReadonlyMap<string, "created" | "modified" | "deleted">): Graph {
  const affected = new Set(changes.keys());
  const nodes = next.nodes.map((node) => node.source && affected.has(node.source.file) ? { ...node, status: "passed" as const } : node);
  for (const [file, change] of changes) if (change === "deleted") {
    nodes.push(...previous.nodes.filter((node) => node.source?.file === file).map((node) => ({ ...node, status: "deleted" as const })));
  }
  const ids = new Set(nodes.map((node) => node.id));
  const edges = [...next.edges, ...previous.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && !next.edges.some(({ id }) => id === edge.id))];
  return parseGraph({ ...next, nodes, edges, metadata: { ...next.metadata, diagnostics: [] } });
}

function broadcast(clients: ReadonlySet<import("node:http").ServerResponse>, graph: Graph): void {
  const message = `data: ${serializeGraph(graph)}\n\n`;
  clients.forEach((client) => client.write(message));
}

function isIgnoredWatchPath(projectPath: string, candidate: string, custom: readonly string[]): boolean {
  const relative = path.relative(projectPath, candidate).replaceAll(path.sep, "/");
  if (!relative) return false;
  const parts = relative.split("/");
  if (parts.some((part) => [".git", "node_modules", "out", "cache"].includes(part))) return true;
  return custom.some((ignored) => {
    const normalized = path.isAbsolute(ignored)
      ? path.relative(projectPath, ignored).replaceAll(path.sep, "/")
      : ignored.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized.includes("/")
      ? relative === normalized || relative.startsWith(`${normalized}/`)
      : parts.includes(normalized);
  });
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
