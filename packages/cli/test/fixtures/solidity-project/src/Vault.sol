// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INotifier} from "./INotifier.sol";
import {Owned} from "./Owned.sol";

contract Vault is Owned {
    error InsufficientBalance(uint256 available, uint256 requested);
    error TransferFailed();

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed recipient, uint256 amount);

    mapping(address => uint256) public balances;
    INotifier public immutable notifier;

    constructor(INotifier notifier_) {
        notifier = notifier_;
    }

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function balanceOf(address account) public view returns (uint256) {
        return balances[account];
    }

    function withdraw(address payable recipient, uint256 amount) external onlyOwner {
        _debit(msg.sender, amount);

        (bool sent, ) = recipient.call{value: amount}("");
        if (!sent) revert TransferFailed();

        notifier.notify(recipient, amount);
        emit Withdrawn(recipient, amount);
    }

    function _debit(address account, uint256 amount) internal {
        uint256 available = balanceOf(account);
        if (available < amount) revert InsufficientBalance(available, amount);
        balances[account] = available - amount;
    }
}

