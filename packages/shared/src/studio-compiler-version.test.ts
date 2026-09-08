import { expect, it } from "vitest";
import { selectStudioCompiler } from "./studio-compiler-version.js";
it("selects a compiler satisfying every Solidity pragma without rewriting sources", () => {
  expect(selectStudioCompiler({ 'Main.sol': 'pragma solidity =0.7.6;', 'Lib.sol': 'pragma solidity >=0.5.0 <0.8.0;' })).toBe('0.7.6');
  expect(selectStudioCompiler({ 'Main.sol': 'pragma solidity ^0.8.26;' })).toBe('0.8.36');
  expect(selectStudioCompiler({ 'Main.sol': '// pragma solidity =0.4.0;\n/* pragma solidity =0.5.0; */\npragma solidity ^0.8.26; string constant s = "pragma solidity 0.6.0;";' })).toBe('0.8.36');
  expect(() => selectStudioCompiler({ 'Old.sol': 'pragma solidity =0.7.6;', 'New.sol': 'pragma solidity ^0.8.0;' })).toThrow(/No supported compiler/);
  expect(() => selectStudioCompiler({ 'Old.sol': 'pragma solidity =0.6.12;' })).toThrow(/0.8.36, 0.7.6/);
});
