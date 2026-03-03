// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

contract ForceSend {
    constructor() payable {}

    function destroy(address payable recipient) external {
        selfdestruct(recipient);
    }
}
