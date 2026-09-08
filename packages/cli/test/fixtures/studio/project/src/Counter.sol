// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Math} from "@math/Math.sol";
contract Counter {
    function sum(uint256 amount) public pure returns (uint256) {
        return Math.add(amount, 1);
    }
}
