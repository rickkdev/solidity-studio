# Code Visualizer

Code Visualizer is a Solidity-first visual IDE. This repository is an npm workspace containing the shell/local-service package, shared graph types, and React web UI.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer

## Development

Install every workspace dependency with one command:

```bash
npm install
```

Start the minimal web UI at `http://localhost:5173`:

```bash
npm run dev
```

After building, launch the visualizer for a Solidity project on the loopback-only local service:

```bash
npm run build
npm exec codevis -- watch ./path/to/project --port 4173
```

The command prints the local URL, serves the analyzed graph automatically, and stops cleanly with Ctrl-C.

Run repository checks and production builds from the root:

```bash
npm run typecheck
npm test
npm run build
```

The workspace packages are:

- `packages/cli`: Node.js CLI and local-service foundation
- `packages/shared`: language-independent graph model foundation
- `apps/web`: React web interface
