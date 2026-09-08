import { afterEach, expect, it, vi } from "vitest";
import { discoverGitHub, localProject, parseGitHubURL, projectRemappings, readProject, safeProjectPath, type ProjectCandidate } from "./studio-project-import";
const signal = () => new AbortController().signal;
const file = (path: string, text: string) => ({ path, size: new TextEncoder().encode(text).length, read: async () => text });
const candidate = (files: ReturnType<typeof file>[]): ProjectCandidate => ({ label: "test", files, config: [], warnings: [] });
afterEach(() => vi.unstubAllGlobals());

it("preserves nested and duplicate basenames while removing only the selected folder root", async () => {
  const files = ['demo/src/Token.sol', 'demo/lib/Token.sol', 'demo/out/Token.sol'].map(path => {
    const entry = new File(['contract Token {}'], 'Token.sol'); Object.defineProperty(entry, 'webkitRelativePath', { value: path }); return entry;
  });
  const project = localProject(files);
  expect(project.files.map(f => f.path)).toEqual(['src/Token.sol', 'lib/Token.sol']);
  expect(() => safeProjectPath('../secret.sol')).toThrow();
  expect(() => localProject([new File([''], 'A.sol'), new File([''], 'A.sol')])).toThrow(/Duplicate/);
});
it("accepts GitHub repository links and rejects unrelated origins and ambiguous tree links", () => {
  expect(parseGitHubURL('https://github.com/rickkdev/solidity-studio.git/')).toEqual({ owner: 'rickkdev', repo: 'solidity-studio' });
  for (const url of ['https://github.com.evil.test/a/b', 'http://github.com/a/b', 'https://github.com/a/b/tree/main', 'https://token@github.com/a/b']) expect(() => parseGitHubURL(url)).toThrow();
});
it("loads explicit remappings before inferred dependency prefixes", async () => {
  const project = candidate([file('node_modules/@vendor/math/Math.sol', ''), file('lib/forge-std/src/Test.sol', ''), file('lib/openzeppelin-contracts/contracts/token/ERC20.sol', '')]);
  project.config = [file('remappings.txt', '# project settings\nforge-std/=custom/forge/\n'), file('foundry.toml', '[profile.default]\nremappings = ["tools/=lib/tools/"]\n[profile.ci]\nremappings = ["wrong/=wrong/"]')];
  expect(await projectRemappings(project, signal())).toEqual(['forge-std/=custom/forge/', 'tools/=lib/tools/', '@vendor/math/=node_modules/@vendor/math/', '@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/']);
});
it("bounds imports, preserves sources and remappings, and cancels before reading", async () => {
  const project = candidate([file('src/A.sol', 'α'), file('src/B.sol', 'β')]);
  const progress = vi.fn();
  expect(await readProject(project, new Set(['src/A.sol']), ['dep/=lib/dep/'], signal(), progress)).toEqual({ sources: { 'src/A.sol': 'α' }, remappings: ['dep/=lib/dep/'] });
  const abort = new AbortController(); abort.abort();
  await expect(readProject(project, new Set(['src/A.sol']), [], abort.signal, progress)).rejects.toThrow();
  await expect(readProject(candidate([{ ...file('huge.sol', ''), size: 2_000_001 }]), new Set(['huge.sol']), [], signal(), progress)).rejects.toThrow(/2 MB/);
  await expect(readProject(project, new Set(), [], signal(), progress)).rejects.toThrow(/Select/);
});
it("pins raw downloads to a commit and ignores symlinks and non-Solidity files", async () => {
  const sha = 'a'.repeat(40); const tree = 'b'.repeat(40);
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('raw.githubusercontent.com')) return new Response('pragma solidity ^0.8.26; contract A {}');
    if (url.includes('/git/trees/')) return Response.json({ tree: [{ type: 'blob', mode: '100644', path: 'src/A.sol', size: 40 }, { type: 'blob', mode: '120000', path: 'Link.sol', size: 10 }, { type: 'commit', path: 'lib/dep' }, { type: 'blob', mode: '100644', path: 'README.md', size: 4 }], truncated: false });
    if (url.includes('/commits/')) return Response.json({ sha, commit: { tree: { sha: tree } } });
    return Response.json({ default_branch: 'feature/branch' });
  }); vi.stubGlobal('fetch', fetcher);
  const project = await discoverGitHub('https://github.com/example/project', '', signal());
  expect(project.files.map(f => f.path)).toEqual(['src/A.sol']); expect(project.warnings).toHaveLength(1);
  await readProject(project, new Set(['src/A.sol']), [], signal(), () => {});
  expect(fetcher.mock.calls.map(call => call[0])).toContain(`https://raw.githubusercontent.com/example/project/${sha}/src/A.sol`);
  expect(fetcher.mock.calls.map(call => call[0])).toContain('https://api.github.com/repos/example/project/commits/feature%2Fbranch');
});
it("reports GitHub rate limits, missing repositories and truncated trees", async () => {
  for (const [status, message] of [[403, /limit/], [404, /public repositories/]] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(discoverGitHub('https://github.com/example/project', '', signal())).rejects.toThrow(message);
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/git/trees/') ? { truncated: true } : url.includes('/commits/') ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } : { default_branch: 'main' })));
  await expect(discoverGitHub('https://github.com/example/project', '', signal())).rejects.toThrow(/incomplete/);
});
