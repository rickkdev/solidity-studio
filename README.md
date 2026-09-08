# Code Visualizer

Solidity Studio is a two-way visual Solidity editor: turn contracts into Blueprint-style nodes, edit their logic, and export compiling Solidity. The repository also retains the existing local repository explorer and Foundry tooling.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- [Foundry](https://getfoundry.sh/) (`forge` for tests, `anvil` for local function execution)

## Development

Install every workspace dependency with one command:

```bash
npm install
```

Start the editor and local compiler at `http://localhost:5173`:

```bash
npm run dev
```

## Two-way Solidity Studio

Start the editor and local compiler together:

```bash
npm run dev
```

For a built standalone session:

```bash
npm run build
npm exec codevis -- studio --port 4173
```

Open the printed URL, then choose **Paste Solidity**, **New contract**, **Import files**, or **Explore a vault**. No repository or AI account is required.

1. Imported contracts open their first ordinary function automatically. Click the contract breadcrumb for an overview connecting functions to the state, events, errors, and other functions they use; click a function node to open its execution flow. Blue execution connections show statement order; green ports carry typed values. Select a node to reveal its expression graph, or enable **All values**.
2. Use the node palette to add state, mappings, functions, checks, branches, loops, calls, events, and returns. Forms configure common operations; the draft preview accepts Solidity expressions and signatures.
3. Select a node to edit its inputs. Drag a reusable value output into an input to replace that expression. Drag execution output to a sibling statement to place that statement next in the same body. Branch and loop boundaries remain structured.
4. **Apply node edit** compiles the candidate before accepting it. Invalid node drafts keep the accepted source intact. Edit source directly to rebuild the canvas; invalid source keeps the last valid canvas visible and disables semantic node edits until recovery.
5. Use **Undo / Redo**, **Focus**, and **Auto-layout**. Selecting source highlights the corresponding node. The compiler panel links diagnostics to source.
6. **Export Solidity** downloads the selected source file; select other files to export them individually. **Save workspace** exports all sources and canvas positions as JSON. Import that JSON to restore a session. Accepted sources, invalid source drafts, pending node drafts, and layout also save in browser local storage.

Imports resolve within the uploaded source-file map. Missing files and incompatible pragmas produce diagnostics. The first version uses the installed `solc` version; it does not download dependencies or select compiler versions automatically.

Assembly, modifiers, inheritance declarations, custom types, and other advanced constructs are preserved as source blocks. Unsupported source can be edited in the code panel. Modifier and inheritance boundaries are labeled; the function graph does not expand their execution. The source graph remains available without execution. Runtime highlights come from recorded local execution; compiler-generated code and unknown external calls without matching source nodes are reported as unmapped steps. AI explanations and public-chain deployment are not part of Studio.

The editor sends revision-tagged source maps to `POST /api/studio/analyze` and source maps plus validated edit operations to `POST /api/studio/generate`. Compilation runs in a bounded local worker. No source is written to repository files. Analysis/generation endpoints do not execute contracts; the separate execution endpoint runs only in an isolated local Anvil sandbox. Source-range edits preserve untouched text; no-op import/export preserves every byte.

## Run functions and follow execution

1. Open a function and use **Inputs** to focus its entry node. Fill its typed input fields; address fields suggest the three funded local test accounts. Arrays and tuples use JSON; quote large integers in JSON to retain precision.
2. Select the **Caller** (`msg.sender`), and set **ETH value** in wei for payable functions. The first run deploys a fresh contract from Account 1. Supply constructor arguments under **Deployment inputs**, or open the constructor and press **Deploy contract** first (including any payable constructor ETH).
3. Press **Run function** on the entry node or **Run selected function** in the toolbar. The sandbox keeps contract state between calls. Internal/private functions execute through their public callers; they cannot be invoked directly as transactions.
4. The console reports success or decoded reverts, return values, emitted events, gas, and changed raw storage slots. Runtime inputs do not edit the Solidity source. Reverted calls roll back their state changes.
5. The canvas zooms out to fit the recorded path once per function and holds its position while glowing wires and nodes replay execution. Completed connections retain a faint glow. Default playback is one second per step (Slow: 1.8 seconds; Fast: 0.6 seconds). Use **Pause replay**, **Step**, **Replay trace**, **Finish replay**, and the speed selector to inspect it. Replaying never sends another transaction. Mapping follows the compiler's [instruction source maps](https://docs.soliditylang.org/en/latest/internals/source_mappings.html), including PUSH instruction lengths, rather than guessing a path through the static graph.
6. **Reset sandbox** removes the deployment and console history. Editing code, changing contracts, or reloading the page requires fresh runtime state. Source/layout saves are separate from transient EVM state.

The welcome input is prefilled with a self-contained `TokenFactory` playground. Convert it, then run `createToken("Demo", "DEMO", 1000, true, true, true)` to enable minting, burning, and pausing. Use the returned token ID (`0` initially) with `mint`, `transfer`, `burn`, `setPaused`, `balanceOf`, and `totalSupply`. Tokens have independent balances in a single contract; this example does not deploy separate ERC-20 contracts. **Load token factory example** restores the sample after replacing the input.

For the `Coin` example: mint `100` to Account 2 from Account 1, then open `send`, choose Account 2 as caller, send `40` to Account 3, and inspect the `Sent` event. Sending another `70` reverts with `InsufficientBalance(70, 60)`; the balance remains `60`.

Execution uses `POST /api/studio/run` and `POST /api/studio/reset-runtime`. Anvil starts only on the first Run, binds to loopback on an ephemeral port, and has no fork or public RPC configuration. Each sandbox has three accounts with test ETH; no wallet is connected. Calls are bounded to 500,000 gas and deployment to 2,000,000 gas. Replay is capped at 1,000 mapped steps, and skipped/unmapped trace coverage is disclosed. Up to four isolated sandboxes may be active; idle sandboxes expire after 20 minutes and are stopped when Studio closes. The compiler and sandbox use the Cancun EVM target.

## Existing repository workflow

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

The guided explorer works from local AST evidence by default. To precompute beginner-friendly explanations with your authenticated local Codex installation, opt in explicitly:

```bash
npm exec codevis -- watch ./path/to/project --port 4173 --explain
```

`--explain` sends focused contract/function evidence to Codex in a read-only background queue. The UI opens immediately, caches validated explanations outside the repository, and remains usable if Codex is unavailable.

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
