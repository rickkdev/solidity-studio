/** Self-contained playground example; token IDs share one factory contract. */
export const STUDIO_TOKEN_FACTORY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Playground token factory: tokens have separate IDs and balances.
// This demo does not deploy separate ERC-20 contracts.
// Try createToken("Demo", "DEMO", 1000, true, true, true).
// Then use tokenId 0 in transfer, mint, burn, setPaused, and balanceOf.
// Amounts are whole demo units. Each new token gets the next ID.
contract TokenFactory {
    struct Token {
        string name;
        string symbol;
        address owner;
        uint256 totalSupply;
        bool mintable;
        bool burnable;
        bool pausable;
        bool paused;
    }

    Token[] public tokens;
    mapping(uint256 => mapping(address => uint256)) private balances;

    event TokenCreated(uint256 indexed tokenId, string name, string symbol, address owner);
    event Transfer(uint256 indexed tokenId, address from, address to, uint256 amount);
    event PauseChanged(uint256 indexed tokenId, bool paused);

    function createToken(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        bool mintable,
        bool burnable,
        bool pausable
    ) public returns (uint256 tokenId) {
        require(bytes(name).length > 0, "Name required");
        require(bytes(symbol).length > 0, "Symbol required");
        tokenId = tokens.length;
        tokens.push(Token(name, symbol, msg.sender, initialSupply, mintable, burnable, pausable, false));
        balances[tokenId][msg.sender] = initialSupply;
        emit TokenCreated(tokenId, name, symbol, msg.sender);
        emit Transfer(tokenId, address(0), msg.sender, initialSupply);
    }

    function transfer(uint256 tokenId, address receiver, uint256 amount) public {
        require(!tokens[tokenId].paused, "Token paused");
        require(receiver != address(0), "Invalid receiver");
        require(balances[tokenId][msg.sender] >= amount, "Insufficient balance");
        balances[tokenId][msg.sender] -= amount;
        balances[tokenId][receiver] += amount;
        emit Transfer(tokenId, msg.sender, receiver, amount);
    }

    function mint(uint256 tokenId, address receiver, uint256 amount) public {
        require(msg.sender == tokens[tokenId].owner, "Only token owner");
        require(tokens[tokenId].mintable, "Minting disabled");
        require(!tokens[tokenId].paused, "Token paused");
        require(receiver != address(0), "Invalid receiver");
        tokens[tokenId].totalSupply += amount;
        balances[tokenId][receiver] += amount;
        emit Transfer(tokenId, address(0), receiver, amount);
    }

    function burn(uint256 tokenId, uint256 amount) public {
        require(tokens[tokenId].burnable, "Burning disabled");
        require(!tokens[tokenId].paused, "Token paused");
        require(balances[tokenId][msg.sender] >= amount, "Insufficient balance");
        balances[tokenId][msg.sender] -= amount;
        tokens[tokenId].totalSupply -= amount;
        emit Transfer(tokenId, msg.sender, address(0), amount);
    }

    function setPaused(uint256 tokenId, bool paused) public {
        require(msg.sender == tokens[tokenId].owner, "Only token owner");
        require(tokens[tokenId].pausable, "Pausing disabled");
        tokens[tokenId].paused = paused;
        emit PauseChanged(tokenId, paused);
    }

    function balanceOf(uint256 tokenId, address account) public view returns (uint256) {
        require(tokenId < tokens.length, "Unknown token");
        return balances[tokenId][account];
    }

    function totalSupply(uint256 tokenId) public view returns (uint256) {
        return tokens[tokenId].totalSupply;
    }

    function tokenCount() public view returns (uint256) {
        return tokens.length;
    }
}
`;
