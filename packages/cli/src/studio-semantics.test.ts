import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { STUDIO_VAULT } from "@codevis/shared";
import { analyzeStudio, generateStudio } from "./studio-compiler.js";
const exec = promisify(execFile);
const require = createRequire(import.meta.url);

it("executes original and graph-edited contracts with identical results, storage, events and reverts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codevis-semantics-"));
  try {
    await mkdir(path.join(root, "src")); await mkdir(path.join(root, "test"));
    // Feed the installed JS compiler to Foundry's standard-json protocol. No compiler download.
    const compiler = path.join(root, "solc.cjs");
    await writeFile(compiler, `#!${process.execPath}\nconst solc = require(${JSON.stringify(require.resolve("solc"))});\nif(process.argv.includes('--version')) process.stdout.write('solc, the solidity compiler commandline interface\\nVersion: '+solc.version()+'\\n'); else { let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>process.stdout.write(solc.compile(input))); }\n`);
    await chmod(compiler, 0o755);
    await writeFile(path.join(root, "foundry.toml"), `[profile.default]\nsrc = "src"\ntest = "test"\nsolc = ${JSON.stringify(compiler)}\nevm_version = "cancun"\nfuzz.runs = 64\n`);
    const source = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Model {
 uint256 public value;
 event Changed(uint256 value);
 function touch() internal returns (bool) { value++; return true; }
 function run(uint256 amount) external returns(uint256) {
  require(amount < 10, "limit");
  value = 0;
  bool yes = amount > 2 && touch();
  if (yes) { value += 2; } else { value += 3; }
  for (uint256 i = 0; i < amount; i++) { if(i == 2) continue; if(i == 5) break; value += i; }
  do { value++; } while(value < 2);
  while(value < 3) { value++; }
  emit Changed(value);
  return value;
 }
}`;
    const model = analyzeStudio({ revision: 1, sources: { "Model.sol": source } });
    const condition = model.program!.nodes.find(n => n.text === "amount < 10")!;
    const changed = generateStudio({ revision: 2, sources: model.sources, edit: { kind: "replace", nodeId: condition.id, text: "amount <= 9" } });
    expect(changed.program).not.toBeNull();
    const vault = analyzeStudio({ revision: 1, sources: { "Vault.sol": STUDIO_VAULT } });
    const balance = vault.program!.nodes.find(n => n.text === "balances[msg.sender] >= amount")!;
    const editedVault = generateStudio({ revision: 2, sources: vault.sources, edit: { kind: "replace", nodeId: balance.id, text: "amount <= balances[msg.sender]" } });
    await writeFile(path.join(root, "src/Before.sol"), source);
    await writeFile(path.join(root, "src/After.sol"), changed.sources["Model.sol"]!);
    await writeFile(path.join(root, "src/VaultBefore.sol"), STUDIO_VAULT);
    await writeFile(path.join(root, "src/VaultAfter.sol"), editedVault.sources["Vault.sol"]!);
    await writeFile(path.join(root, "test/Equivalence.t.sol"), `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Model as Before} from "../src/Before.sol";
import {Model as After} from "../src/After.sol";
import {Vault as VaultBefore} from "../src/VaultBefore.sol";
import {Vault as VaultAfter} from "../src/VaultAfter.sol";
interface Vm { struct Log { bytes32[] topics; bytes data; address emitter; } function recordLogs() external; function getRecordedLogs() external returns(Log[] memory); function deal(address,uint256) external; }
contract EquivalenceTest {
 Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
 receive() external payable {}
 function testFuzzProgram(uint8 amount) public {
  Before a = new Before(); After b = new After();
  vm.recordLogs(); (bool okA, bytes memory dataA) = address(a).call(abi.encodeWithSignature("run(uint256)", uint256(amount))); Vm.Log[] memory logsA = vm.getRecordedLogs();
  vm.recordLogs(); (bool okB, bytes memory dataB) = address(b).call(abi.encodeWithSignature("run(uint256)", uint256(amount))); Vm.Log[] memory logsB = vm.getRecordedLogs();
  require(okA == okB && keccak256(dataA) == keccak256(dataB), "return or revert differs");
  require(a.value() == b.value(), "storage differs");
  require(logsA.length == logsB.length, "event count differs");
  for(uint256 i=0; i<logsA.length; i++) require(keccak256(abi.encode(logsA[i].topics,logsA[i].data)) == keccak256(abi.encode(logsB[i].topics,logsB[i].data)), "event differs");
 }
 function testVaultRoundTrip() public {
  vm.deal(address(this), 20 ether);
  VaultBefore a = new VaultBefore(); VaultAfter b = new VaultAfter();
  a.deposit{value: 5 ether}(); b.deposit{value: 5 ether}();
  a.withdraw(2 ether); b.withdraw(2 ether);
  require(a.balances(address(this)) == b.balances(address(this)), "balance mapping differs");
  require(address(a).balance == address(b).balance, "ETH differs");
  (bool okA, bytes memory dataA) = address(a).call(abi.encodeWithSignature("withdraw(uint256)", 4 ether));
  (bool okB, bytes memory dataB) = address(b).call(abi.encodeWithSignature("withdraw(uint256)", 4 ether));
  require(!okA && !okB && keccak256(dataA) == keccak256(dataB), "revert differs");
 }
}`);
    const run = await exec("forge", ["test", "--root", root, "-vv"], { timeout: 60_000, maxBuffer: 4_000_000 });
    expect(run.stdout).toContain("2 passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 70_000);
