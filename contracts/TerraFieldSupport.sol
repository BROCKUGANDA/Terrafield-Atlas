// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * TerraField voluntary support receiver.
 *
 * The contract never holds a balance: every native or ERC20 support payment is
 * forwarded to the treasury in the same transaction. It has no fees, no
 * upgradeability, no owner withdrawal path, and no ability to move user funds.
 * The memo is an offchain reference emitted for reconciliation; it does not
 * confer entitlements.
 */
contract TerraFieldSupport is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Recipient of all support payments. Never holds funds between transactions.
    address payable public treasury;

    /// @notice Emitted for every forwarded support payment.
    /// @param payer Sender that called this contract.
    /// @param token ERC20 token address, or the zero address for native value.
    /// @param amount Base units forwarded to the treasury.
    /// @param memo Opaque offchain reference (payment intent memo).
    event Support(address indexed payer, address indexed token, uint256 amount, bytes32 indexed memo);

    error ZeroAddress();
    error ZeroAmount();
    error NativeTransferFailed();

    constructor(address payable initialTreasury) Ownable(msg.sender) {
        if (initialTreasury == address(0)) revert ZeroAddress();
        treasury = initialTreasury;
    }

    /// @notice Update the treasury. Restricted to the contract owner.
    function setTreasury(address payable nextTreasury) external onlyOwner {
        if (nextTreasury == address(0)) revert ZeroAddress();
        treasury = nextTreasury;
    }

    /// @notice Forward native value to the treasury.
    function supportNative(bytes32 memo) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        (bool sent, ) = treasury.call{value: msg.value}("");
        if (!sent) revert NativeTransferFailed();
        emit Support(msg.sender, address(0), msg.value, memo);
    }

    /// @notice Pull an ERC20 support payment from the payer and forward it to the treasury.
    function supportToken(address token, uint256 amount, bytes32 memo) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, treasury, amount);
        emit Support(msg.sender, token, amount, memo);
    }
}
