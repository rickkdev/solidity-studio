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
