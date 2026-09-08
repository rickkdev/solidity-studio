import { selectStudioCompiler, compilerSelectionFailure, type StudioRequest, type StudioResult } from "@codevis/shared";
let worker: Worker | undefined;
let workerVersion = "";

/** One request at a time; aborting kills synchronous compiler work off the UI thread. */
export function compileInBrowser(operation: string, request: StudioRequest, signal: AbortSignal): Promise<StudioResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    let version;
    try { version = selectStudioCompiler(request.sources); } catch (error) { resolve(compilerSelectionFailure(request, error)); return; }
    if (worker && version !== workerVersion) { worker.terminate(); worker = undefined; }
    workerVersion = version;
    worker ??= new Worker(new URL("./studio-browser-worker.ts", import.meta.url));
    const current = worker;
    const clean = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); current.onmessage = null; current.onerror = null; };
    const fail = (error: Error) => { clean(); current.terminate(); if (worker === current) worker = undefined; reject(error); };
    const abort = () => fail(new DOMException("Aborted", "AbortError"));
    const timeout = setTimeout(() => fail(new Error("Browser compilation timed out. Try a smaller contract.")), 60_000);
    signal.addEventListener("abort", abort, { once: true });
    current.onerror = () => fail(new Error("Could not load the browser compiler. Reload the page and try again."));
    current.onmessage = (event: MessageEvent<{ result?: StudioResult; error?: string }>) => {
      clean();
      if (event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "Browser compilation failed."));
    };
    current.postMessage({ operation, request });
  });
}
