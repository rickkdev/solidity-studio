// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface INotifier {
    function notify(address account, uint256 amount) external;
}

