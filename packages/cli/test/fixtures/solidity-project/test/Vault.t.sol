// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INotifier} from "../src/INotifier.sol";
import {Vault} from "../src/Vault.sol";

contract RecordingNotifier is INotifier {
    address public lastAccount;
    uint256 public lastAmount;

    function notify(address account, uint256 amount) external {
        lastAccount = account;
        lastAmount = amount;
    }
}

contract VaultTest {
    RecordingNotifier private notifier;
    Vault private vault;

    function setUp() public {
        notifier = new RecordingNotifier();
        vault = new Vault(notifier);
    }

    function testOwnerIsDeployingTest() public view {
        require(vault.owner() == address(this), "unexpected owner");
    }

    function testIntentionalFailure() public pure {
        require(false, "intentional fixture failure");
    }
}

