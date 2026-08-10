# Code Visualizer

Code Visualizer is a Solidity-first visual IDE. This repository is an npm workspace containing the shell/local-service package, shared graph types, and React web UI.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- [Foundry](https://getfoundry.sh/) (`forge`) to run Solidity tests

## Development

Install every workspace dependency with one command:

```bash
npm install
```

Start the minimal web UI at `http://localhost:5173`:

```bash
npm run dev
```

## Solidity workflow

Build once, then use the public `codevis` command through npm:

```bash
npm run build
```

Analyze a project and emit a validated graph to stdout (or use `--output graph.json`):

```bash
npm exec codevis -- analyze ./path/to/project
```

Launch the visualizer for that project on the loopback-only local service:

```bash
npm run build
npm exec codevis -- watch ./path/to/project --port 4173
```

The command prints the local URL, serves the analyzed graph automatically, and stops cleanly with Ctrl-C.

Run all Foundry tests from inside the project, or pass a test-name filter:

```bash
cd ./path/to/project
npm exec --prefix /path/to/code-visualizer codevis -- test
npm exec --prefix /path/to/code-visualizer codevis -- test testDeposit
```

`analyze` keeps JSON on stdout and diagnostics on stderr. `watch` binds to `127.0.0.1` by default; use `--port 0` to select an available port.

## Five-minute fixture demo

1. Run `npm run build`, then `npm exec codevis -- watch packages/cli/test/fixtures/solidity-project --port 4173`.
2. Open the printed URL. Expand `Vault.sol`, then `Vault`, and select `deposit` to inspect its exact source and relationships.
3. In another editor, change a harmless line in `src/Vault.sol` and save. Watch the affected nodes move through active to passed; introduce a syntax error briefly to see the compiler recovery state, then undo it.
4. Select **Run Foundry tests**. The fixture's passing test turns green and its intentionally failing test turns red; select either the node or its timeline event for details.
5. Stop the session with Ctrl-C. The fixture is test data, so revert any demo edit afterward.

The in-canvas legend distinguishes structural node families, relationship kinds, static versus runtime evidence, and live statuses. Missing data, compiler failures, a missing `forge` executable, and a disconnected event stream all include an on-screen retry or recovery action.

Run repository checks and production builds from the root:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The workspace packages are:

- `packages/cli`: Node.js CLI and local-service foundation
- `packages/shared`: language-independent graph model foundation
- `apps/web`: React web interface
