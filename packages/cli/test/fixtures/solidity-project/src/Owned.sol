// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract Owned {
    error Unauthorized(address caller);

    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }
}

