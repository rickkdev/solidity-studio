# Solidity analysis fixture

This deliberately small Foundry project is test data for Code Visualizer's
Solidity analysis. It covers imports, inheritance, visibility, state access,
modifiers, events, custom errors, external calls, and value transfers.

`Vault.t.sol` includes one passing test and one intentionally failing test so
runtime integrations can exercise both outcomes. The fixture lives outside the
CLI `src` directory and is not included in production builds.

