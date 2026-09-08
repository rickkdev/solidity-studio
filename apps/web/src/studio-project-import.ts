import { validateStudioRemappings } from "@codevis/shared";
export const MAX_PROJECT_FILES = 100;
export const MAX_PROJECT_BYTES = 2_000_000;
export interface ProjectFile { path: string; size: number; read: (signal: AbortSignal) => Promise<string> }
export interface ProjectCandidate { label: string; files: ProjectFile[]; config: ProjectFile[]; warnings: string[] }
export interface ImportedProject { sources: Record<string, string>; remappings: string[] }
const ignored = /(^|\/)(\.git|artifacts|out|cache|broadcast|coverage)(\/|$)/;
const configFile = /(^|\/)(remappings\.txt|foundry\.toml)$/;
export function safeProjectPath(path: string): string {
  if (!path || path.startsWith("/") || /[\\\x00-\x1f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid project file path.");
  return path;
}
export function localProject(files: File[]): ProjectCandidate {
  const entries = files.map(file => {
    const relative = file.webkitRelativePath;
    const path = safeProjectPath(relative ? relative.split("/").slice(1).join("/") : file.name);
    return { path, size: file.size, read: async (signal: AbortSignal) => { signal.throwIfAborted(); const text = await file.text(); signal.throwIfAborted(); return text; } };
  }).filter(file => !ignored.test(file.path));
  if (new Set(entries.map(file => file.path)).size !== entries.length) throw new Error("Duplicate paths. Choose the project folder to preserve its directory structure.");
  return { label: files[0]?.webkitRelativePath.split("/")[0] || "Selected files", files: entries.filter(file => file.path.endsWith(".sol")), config: entries.filter(file => configFile.test(file.path)), warnings: [] };
}
export function parseGitHubURL(input: string): { owner: string; repo: string } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Enter a GitHub repository URL: https://github.com/owner/repository"); }
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || parts.length !== 2 || parts.some(p => !/^[\w.-]+$/.test(p) || p === "." || p === "..")) throw new Error("Use https://github.com/owner/repository. Enter a branch or tag in the separate field.");
  return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/, "") };
}
async function limitedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("Empty download response.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new Error("Downloaded file exceeds the project size limit."); chunks.push(value); } }
  catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function githubJSON(path: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, { signal, credentials: "omit", headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 403 || response.status === 429) throw new Error("GitHub request limit reached or access denied. Try later, or download the repository and import its folder.");
  if (response.status === 404) throw new Error("Repository or branch not found. Only public repositories are supported; import a local folder for private projects.");
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Retry or import a local folder.`);
  return JSON.parse(await limitedText(response, 10_000_000));
}
export async function discoverGitHub(input: string, ref: string, signal: AbortSignal): Promise<ProjectCandidate> {
  const { owner, repo } = parseGitHubURL(input);
  const api = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const metadata = await githubJSON(api, signal);
  const branch = ref.trim() || metadata.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("This repository has no default branch.");
  const commit = await githubJSON(`${api}/commits/${encodeURIComponent(branch)}`, signal);
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || !/^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha)) throw new Error("Invalid GitHub commit response.");
  const tree = await githubJSON(`${api}/git/trees/${commit.commit.tree.sha}?recursive=1`, signal);
  if (tree.truncated) throw new Error("GitHub returned an incomplete repository tree. Download and import the project folder instead.");
  if (!Array.isArray(tree.tree)) throw new Error("Invalid GitHub file listing.");
  const entries: ProjectFile[] = tree.tree.filter((file: any) => file.type === "blob" && /^100(644|755)$/.test(file.mode) && typeof file.path === "string" && !ignored.test(file.path) && (file.path.endsWith(".sol") || configFile.test(file.path))).map((file: any) => {
    const path = safeProjectPath(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid GitHub file size.");
    return { path, size: file.size, read: async (downloadSignal: AbortSignal) => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(url, { signal: downloadSignal, credentials: "omit" });
      if (!response.ok) throw new Error(`Could not download ${path} (${response.status}). No files were added.`);
      return limitedText(response, path.endsWith(".sol") ? MAX_PROJECT_BYTES : 100_000);
    } };
  });
  return { label: `${owner}/${repo} · ${branch} · ${commit.sha.slice(0, 7)}`, files: entries.filter(file => file.path.endsWith(".sol")), config: entries.filter(file => configFile.test(file.path)), warnings: tree.tree.some((file: any) => file.type === "commit") ? ["Git submodules are not downloaded. Add missing dependencies from a local project folder."] : [] };
}
export async function projectRemappings(project: ProjectCandidate, signal: AbortSignal): Promise<string[]> {
  const mappings: string[] = [];
  // Root configuration only; dependency projects can have conflicting settings.
  for (const file of project.config.filter(file => !file.path.includes("/"))) {
    if (file.size > 100_000) throw new Error("Project configuration is too large.");
    const text = await file.read(signal);
    if (file.path === "remappings.txt") mappings.push(...text.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean));
    else {
      const section = text.split(/\[profile\.default\]/)[1]?.split(/\n\s*\[/)[0] ?? text.split(/\n\s*\[/)[0] ?? "";
      const list = section.match(/\bremappings\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
      mappings.push(...[...list.matchAll(/["']([^"']+=[^"']+)["']/g)].map(match => match[1]!));
    }
  }
  const paths = project.files.map(file => file.path);
  const inferred = new Map<string, string>();
  for (const path of paths) {
    const npm = path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//); if (npm) inferred.set(`${npm[1]}/`, `node_modules/${npm[1]}/`);
    const foundry = path.match(/^lib\/([^/]+)\/src\//); if (foundry) inferred.set(`${foundry[1]}/`, `lib/${foundry[1]}/src/`);
    if (path.startsWith("lib/openzeppelin-contracts/contracts/")) inferred.set("@openzeppelin/contracts/", "lib/openzeppelin-contracts/contracts/");
    if (path.startsWith("lib/openzeppelin-contracts-upgradeable/contracts/")) inferred.set("@openzeppelin/contracts-upgradeable/", "lib/openzeppelin-contracts-upgradeable/contracts/");
  }
  for (const [prefix, target] of inferred) if (!mappings.some(line => line.split("=")[0] === prefix)) mappings.push(`${prefix}=${target}`);
  const result = [...new Set(mappings)]; validateStudioRemappings(result); return result;
}
export async function readProject(project: ProjectCandidate, selected: Set<string>, remappings: string[], signal: AbortSignal, progress: (count: number) => void): Promise<ImportedProject> {
  const files = project.files.filter(file => selected.has(file.path));
  if (!files.length || files.length > MAX_PROJECT_FILES) throw new Error(`Select between 1 and ${MAX_PROJECT_FILES} Solidity files.`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_PROJECT_BYTES) throw new Error("Selected sources exceed 2 MB. Choose fewer files.");
  validateStudioRemappings(remappings);
  const entries: [string, string][] = []; let bytes = 0;
  for (let i = 0; i < files.length; i += 4) {
    signal.throwIfAborted();
    const batch = await Promise.all(files.slice(i, i + 4).map(async file => [file.path, await file.read(signal)] as [string, string]));
    for (const entry of batch) { bytes += new TextEncoder().encode(entry[1]).length; if (bytes > MAX_PROJECT_BYTES) throw new Error("Downloaded sources exceed 2 MB. Choose fewer files."); entries.push(entry); }
    progress(entries.length);
  }
  signal.throwIfAborted();
  return { sources: Object.fromEntries(entries), remappings };
}
