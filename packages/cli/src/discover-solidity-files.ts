import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "out",
  "cache",
]);

export interface DiscoverSolidityFilesOptions {
  /** Project-relative files or directories to skip. Single directory names match at any depth. */
  ignoredPaths?: readonly string[];
}

export class SolidityDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SolidityDiscoveryError";
  }
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
}

function normalizeIgnoredPaths(
  projectRoot: string,
  ignoredPaths: readonly string[],
): string[] {
  return ignoredPaths.map((ignoredPath) => {
    const absolutePath = path.isAbsolute(ignoredPath)
      ? ignoredPath
      : path.resolve(projectRoot, ignoredPath);
    const relativePath = normalizeRelativePath(path.relative(projectRoot, absolutePath));

    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath === ""
    ) {
      throw new SolidityDiscoveryError(
        `Ignored path must identify an entry inside the project: ${ignoredPath}`,
      );
    }

    return relativePath;
  });
}

function isCustomIgnored(relativePath: string, ignoredPaths: readonly string[]): boolean {
  return ignoredPaths.some((ignoredPath) => {
    if (!ignoredPath.includes("/")) {
      return relativePath.split("/").includes(ignoredPath);
    }

    return relativePath === ignoredPath || relativePath.startsWith(`${ignoredPath}/`);
  });
}

/** Discover Solidity source files below a project directory. */
export async function discoverSolidityFiles(
  projectDirectory: string,
  options: DiscoverSolidityFilesOptions = {},
): Promise<string[]> {
  const requestedRoot = path.resolve(projectDirectory);
  let projectRoot: string;

  try {
    const rootStats = await stat(requestedRoot);
    if (!rootStats.isDirectory()) {
      throw new SolidityDiscoveryError(
        `Cannot discover Solidity files: project path is not a directory: ${requestedRoot}`,
      );
    }
    projectRoot = await realpath(requestedRoot);
  } catch (error) {
    if (error instanceof SolidityDiscoveryError) throw error;
    throw new SolidityDiscoveryError(
      `Cannot access Solidity project directory: ${requestedRoot}`,
      { cause: error },
    );
  }

  const ignoredPaths = normalizeIgnoredPaths(projectRoot, options.ignoredPaths ?? []);
  const solidityFiles: string[] = [];

  async function visit(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    let entries;

    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      const displayPath = relativeDirectory || ".";
      throw new SolidityDiscoveryError(
        `Cannot read project directory "${displayPath}" inside ${projectRoot}`,
        { cause: error },
      );
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(
        path.join(relativeDirectory, entry.name),
      );

      if (isCustomIgnored(relativePath, ignoredPaths)) continue;

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        await visit(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".sol")) {
        solidityFiles.push(relativePath);
      }
    }
  }

  await visit("");

  if (solidityFiles.length === 0) {
    throw new SolidityDiscoveryError(
      `No Solidity (.sol) files found in project directory: ${projectRoot}`,
    );
  }

  return solidityFiles.sort((left, right) => left.localeCompare(right));
}
