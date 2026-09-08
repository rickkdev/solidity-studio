import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StudioRequest, StudioResult, StudioBuild, StudioRunRequest } from "@codevis/shared";

import { createStudioRuntime } from "./studio-runtime.js";

export async function startStudioServer(options: { port?: number; webRoot?: string } = {}) {
  const webRoot = options.webRoot ?? fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));
  let worker = new Worker(new URL("./studio-worker.js", import.meta.url));
  let sequence = 0;
  const pending = new Map<number, { resolve: (r: StudioResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function bindWorker() {
    worker.on("message", ({ id, result, error }) => { const task = pending.get(id); if (!task) return; clearTimeout(task.timer); pending.delete(id); error ? task.reject(new Error(error)) : task.resolve(result); });
    worker.on("error", error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); });
  }
  bindWorker();
  const compile = (operation: string, request: StudioRequest) => new Promise<StudioResult>((resolve, reject) => {
    if (pending.size >= 8) { reject(new Error("Compiler busy. Retry shortly.")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Compilation timed out. Reduce the workspace and retry.")); }
      pending.clear(); void worker.terminate(); worker = new Worker(new URL("./studio-worker.js", import.meta.url)); bindWorker();
    }, 30_000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, operation, request });
  });
  const runtime = createStudioRuntime(async request => await compile("runtime", request) as StudioBuild);
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
      if (url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        const host = req.headers.host;
        // Same-origin local studio, or the explicitly supported local Vite dev origin.
        const allowed = new Set([`http://${host}`, "http://localhost:5173", "http://127.0.0.1:5173"]);
        if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || (origin && !allowed.has(origin))) { send(403, { error: "Only local studio origins are allowed." }); return; }
        if (url.pathname === "/api/studio/status" && req.method === "GET") { send(200, { studio: true }); return; }
        if (!["/api/studio/analyze", "/api/studio/generate", "/api/studio/run", "/api/studio/reset-runtime"].includes(url.pathname) || req.method !== "POST") { send(404, { error: "Unknown studio endpoint." }); return; }
        if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, { error: "Send application/json." }); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 2_500_000) { send(413, { error: "Workspace exceeds request limit." }); return; } chunks.push(chunk); }
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StudioRequest;
        if (url.pathname === "/api/studio/run") { send(200, await runtime.run(request as StudioRunRequest)); return; }
        if (url.pathname === "/api/studio/reset-runtime") {
          const id = (request as unknown as { sessionId: string }).sessionId;
          if (typeof id !== "string") throw new Error("A sandbox session ID is required.");
          runtime.reset(id); send(200, { reset: true }); return;
        }
        const result = await compile(url.pathname.endsWith("generate") ? "generate" : "analyze", request);
        send(200, result); return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      const full = path.resolve(webRoot, relative);
      if (path.relative(webRoot, full).startsWith("..") || path.isAbsolute(path.relative(webRoot, full))) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(full);
        const types: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
        res.writeHead(200, { "content-type": types[path.extname(full)] ?? "application/octet-stream" }); res.end(req.method === "HEAD" ? undefined : body);
      } catch { res.writeHead(404).end("Build the web app with npm run build, then restart codevis studio."); }
    })().catch(error => { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." })); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4173, "127.0.0.1", resolve); }).catch(async error => { await worker.terminate(); throw error; });
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 4173}`, close: async () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Studio closed.")); } pending.clear();
    await runtime.close(); await worker.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
