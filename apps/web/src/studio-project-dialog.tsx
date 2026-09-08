import { useEffect, useRef, useState } from "react";
import { discoverGitHub, localProject, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, projectRemappings, readProject, type ImportedProject, type ProjectCandidate } from "./studio-project-import";
import "./studio-project-import.css";

export function ProjectImportDialog({ onClose, onImport, hasWorkspace }: { onClose: () => void; onImport: (project: ImportedProject, merge: boolean) => void; hasWorkspace: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null); const folder = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [url, setURL] = useState(""); const [branch, setBranch] = useState("");
  const [project, setProject] = useState<ProjectCandidate | null>(null); const [selected, setSelected] = useState(new Set<string>());
  const [mappingText, setMappingText] = useState(""); const [merge, setMerge] = useState(false);
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState(""); const [error, setError] = useState(""); const [filter, setFilter] = useState("");
  useEffect(() => { dialog.current?.showModal(); folder.current?.setAttribute("webkitdirectory", ""); return () => abort.current?.abort(); }, []);
  async function discover(load: (signal: AbortSignal) => Promise<ProjectCandidate>) {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setError(""); setProject(null); setStatus("Finding Solidity files…");
    try {
      const candidate = await load(controller.signal);
      if (!candidate.files.length) throw new Error("No Solidity files found in this project.");
      const remappings = await projectRemappings(candidate, controller.signal);
      controller.signal.throwIfAborted();
      setProject(candidate); setSelected(new Set(candidate.files.length <= MAX_PROJECT_FILES && candidate.files.reduce((sum, file) => sum + file.size, 0) <= MAX_PROJECT_BYTES ? candidate.files.map(file => file.path) : []));
      setMappingText(remappings.join("\n")); setFilter(""); setStatus(`${candidate.files.length} Solidity files found`);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Project discovery failed."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function importSelected() {
    if (!project) return;
    const controller = new AbortController(); abort.current = controller; setBusy(true); setError("");
    try {
      const imported = await readProject(project, selected, mappingText.split(/\r?\n/).map(line => line.trim()).filter(Boolean), controller.signal, count => setStatus(`Reading ${count}/${selected.size} files…`));
      controller.signal.throwIfAborted(); onImport(imported, merge); onClose();
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not import project."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  const visible = project?.files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 500) ?? [];
  const bytes = project?.files.reduce((sum, file) => sum + (selected.has(file.path) ? file.size : 0), 0) ?? 0;
  return <dialog className="studio-project-dialog" ref={dialog} aria-labelledby="project-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <header><div><h2 id="project-title">Import Solidity project</h2><p>Keep files connected through their original paths and imports.</p></div><button onClick={onClose} aria-label="Close project importer">×</button></header>
    <button disabled={busy} onClick={() => folder.current?.click()}>Choose project folder</button>
    <input ref={folder} type="file" multiple hidden aria-label="Solidity project folder" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void discover(async () => localProject(files)); e.target.value = ""; }} />
    <form onSubmit={e => { e.preventDefault(); void discover(signal => discoverGitHub(url, branch, signal)); }}>
      <label>Public GitHub repository<input aria-label="GitHub repository URL" type="url" value={url} placeholder="https://github.com/owner/repository" onChange={e => setURL(e.target.value)} required disabled={busy} /></label>
      <label>Branch, tag, or commit <small>optional; defaults to the repository’s default branch</small><input aria-label="GitHub branch" value={branch} onChange={e => setBranch(e.target.value)} disabled={busy} /></label>
      <button disabled={busy || !url.trim()}>Find Solidity files</button>
    </form>
    {status && <p aria-live="polite">{status}</p>}{error && <p role="alert" className="project-error">{error}</p>}
    {project && <section><h3>{project.label}</h3>{project.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <input aria-label="Filter project files" placeholder="Filter paths…" value={filter} onChange={e => setFilter(e.target.value)} />
      <div className="project-selection"><button disabled={busy} onClick={() => setSelected(new Set([...selected, ...visible.map(file => file.path)]))}>Select visible</button><button disabled={busy} onClick={() => setSelected(new Set())}>Clear selection</button><span>{selected.size} selected · {(bytes / 1000).toFixed(1)} KB / 2 MB</span></div>
      {project.files.length > 500 && <p>Showing up to 500 matches. Filter by folder or filename to narrow the list.</p>}
      <div className="project-files">{visible.map(file => <label key={file.path}><input type="checkbox" checked={selected.has(file.path)} disabled={busy} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(file.path); else next.delete(file.path); return next; })} /><span>{file.path}</span><small>{(file.size / 1000).toFixed(1)} KB</small></label>)}</div>
      <details><summary>Import remappings</summary><p>One prefix=path per line. Detected from root remappings.txt, default Foundry settings, and common dependency folders. Review or adjust before importing.</p><textarea aria-label="Project import remappings" value={mappingText} onChange={e => setMappingText(e.target.value)} disabled={busy} placeholder="@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/" /></details>
      <p>Select up to 100 files, including their dependencies. Missing packages and unsupported compiler versions appear as compiler diagnostics; dependencies are not installed automatically.</p>
      {hasWorkspace && <label><input type="checkbox" checked={merge} onChange={e => setMerge(e.target.checked)} disabled={busy} /> Add to current workspace (conflicting paths are rejected)</label>}
      <button className="project-import-button" disabled={busy || !selected.size || selected.size > MAX_PROJECT_FILES || bytes > MAX_PROJECT_BYTES} onClick={() => void importSelected()}>Import selected Solidity files</button>
    </section>}
    <footer><button onClick={onClose}>{busy ? "Cancel import" : "Cancel"}</button><small>Public repositories are fetched directly from GitHub. For private repositories, use a local folder.</small></footer>
  </dialog>;
}
