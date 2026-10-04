// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgoranomosSettlement
/// @notice Pays a supplier, or refunds a tenant, only when a verifier the agent
/// cannot impersonate has signed off on the case, and only inside limits the
/// agent cannot change.
///
/// Three parties, three keys:
///   - the owner (a person) sets payees, budgets and the rule version, and signs
///     off anything above the escalation threshold;
///   - the agent proposes settlements, and can do nothing else;
///   - the verifier signs an attestation for each case. Its key lives in a
///     separate service the agent has no access to, so a model that decides the
///     amount cannot also vouch for it.
///
/// The attestation is EIP-712 typed data. Its domain binds it to this chain and
/// this contract, and its fields bind it to one case, one token, one payee, a
/// maximum amount, one rule version and an expiry. Everything the agent could
/// want to change after the fact is inside the signature.
contract AgoranomosSettlement {
    // ---------------------------------------------------------------- types

    struct Attestation {
        bytes32 caseId;
        address payee;
        address token;
        uint256 maxAmount;
        bytes32 ruleVersion;
        bytes32 evidenceHash;
        uint64 expiry;
    }

    struct Pending {
        uint256 intentSeq;
        address payee;
        uint256 amount;
        bytes32 evidenceHash;
        bytes32 reasoningHash;
        bool open;
    }

    // ------------------------------------------------------------- constants

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(bytes32 caseId,address payee,address token,uint256 maxAmount,bytes32 ruleVersion,bytes32 evidenceHash,uint64 expiry)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("AgoranomosSettlement");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// secp256k1n / 2. Signatures with a higher s are malleable and refused.
    uint256 private constant HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // --------------------------------------------------------------- storage

    IERC20 public immutable token;
    address public owner;
    address public agent;
    address public verifier;

    /// The rule set the verifier must have applied. Changing it invalidates
    /// every attestation signed under the old one.
    bytes32 public ruleVersion;

    /// Budgets are counted in fixed windows of `periodLength` seconds.
    uint64 public periodLength;
    /// Most the contract will pay out, to everyone, in one window. Zero is a
    /// stop, never "no limit".
    uint256 public periodBudget;
    /// Most a single payee may receive in one window before a person signs.
    /// Counted across cases, so splitting a payment into several cases does
    /// not get under it.
    uint256 public escalationThreshold;

    mapping(address => bool) public allowedPayee;
    /// Paid so far against each case. A case can be paid in parts, never
    /// past the maximum its attestation allows.
    mapping(bytes32 => uint256) public paid;
    /// The sequence number the next payment against each case must carry.
    /// Every payment is one intent; an intent executes once. A retry of an
    /// intent that already ran carries a number that is no longer next, and
    /// is refused. The ceiling alone cannot do this: paying 3 against a
    /// ceiling of 10 and then retrying the same 3 stays under it both times.
    mapping(bytes32 => uint256) public nextIntent;
    mapping(uint256 => uint256) public spentInPeriod;
    mapping(uint256 => mapping(address => uint256)) public payeeSpentInPeriod;
    mapping(bytes32 => Pending) public pending;
    mapping(bytes32 => uint64) public pendingExpiry;
    mapping(bytes32 => bytes32) public pendingRule;
    mapping(bytes32 => address) public pendingVerifier;

    bool private entered;

    // ---------------------------------------------------------------- events

    event Settled(
        bytes32 indexed caseId,
        address indexed payee,
        uint256 intentSeq,
        uint256 amount,
        uint256 paidToDate,
        bytes32 evidenceHash,
        bytes32 ruleVersion,
        bytes32 reasoningHash
    );
    event Escalated(
        bytes32 indexed caseId,
        address indexed payee,
        uint256 intentSeq,
        uint256 amount,
        uint256 payeeSpentThisPeriod,
        bytes32 evidenceHash,
        bytes32 reasoningHash
    );
    event Approved(bytes32 indexed caseId, address indexed by);
    event Rejected(bytes32 indexed caseId, address indexed by);
    event PayeeSet(address indexed payee, bool allowed);
    event LimitsSet(uint64 periodLength, uint256 periodBudget, uint256 escalationThreshold);
    event RuleVersionSet(bytes32 ruleVersion);
    event RolesSet(address owner, address agent, address verifier);

    // ---------------------------------------------------------------- errors

    error InvalidRoles();
    error PendingPolicyRevoked();
    error NotOwner();
    error NotAgent();
    error ForgedAttestation();
    error MalleableSignature();
    error AttestationExpired();
    error WrongToken();
    error WrongRuleVersion();
    error PayeeNotAllowed();
    error ExceedsAttestedMaximum(uint256 paidToDate, uint256 requested, uint256 maximum);
    error ExceedsPeriodBudget(uint256 spent, uint256 requested, uint256 budget);
    error IntentAlreadyUsed(uint256 expected, uint256 given);
    error NothingPending();
    error PendingAlreadyOpen();
    error ZeroAmount();
    error Reentrant();
    error TransferFailed();

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    // ----------------------------------------------------------- constructor

    constructor(
        address token_,
        address owner_,
        address agent_,
        address verifier_,
        bytes32 ruleVersion_,
        uint64 periodLength_,
        uint256 periodBudget_,
        uint256 escalationThreshold_
    ) {
        _checkRoles(owner_, agent_, verifier_);
        token = IERC20(token_);
        owner = owner_;
        agent = agent_;
        verifier = verifier_;
        ruleVersion = ruleVersion_;
        periodLength = periodLength_;
        periodBudget = periodBudget_;
        escalationThreshold = escalationThreshold_;
        emit RolesSet(owner_, agent_, verifier_);
        emit RuleVersionSet(ruleVersion_);
        emit LimitsSet(periodLength_, periodBudget_, escalationThreshold_);
    }

    // ------------------------------------------------------- owner controls

    function setPayee(address payee, bool allowed) external onlyOwner {
        allowedPayee[payee] = allowed;
        emit PayeeSet(payee, allowed);
    }

    function setLimits(uint64 periodLength_, uint256 periodBudget_, uint256 escalationThreshold_)
        external
        onlyOwner
    {
        periodLength = periodLength_;
        periodBudget = periodBudget_;
        escalationThreshold = escalationThreshold_;
        emit LimitsSet(periodLength_, periodBudget_, escalationThreshold_);
    }

    function setRuleVersion(bytes32 ruleVersion_) external onlyOwner {
        ruleVersion = ruleVersion_;
        emit RuleVersionSet(ruleVersion_);
    }

    function setRoles(address owner_, address agent_, address verifier_) external onlyOwner {
        _checkRoles(owner_, agent_, verifier_);
        owner = owner_;
        agent = agent_;
        verifier = verifier_;
        emit RolesSet(owner_, agent_, verifier_);
    }

    // ---------------------------------------------------------------- views

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function attestationDigest(Attestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                a.caseId,
                a.payee,
                a.token,
                a.maxAmount,
                a.ruleVersion,
                a.evidenceHash,
                a.expiry
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function currentPeriod() public view returns (uint256) {
        return periodLength == 0 ? 0 : block.timestamp / periodLength;
    }

    // --------------------------------------------------------------- settle

    /// @notice The agent's only power. It proposes paying `amount` against a
    /// case the verifier has signed. The contract either pays it, parks it for
    /// a person, or refuses; the agent cannot choose which.
    function settle(
        Attestation calldata a,
        bytes calldata signature,
        uint256 amount,
        uint256 intentSeq,
        bytes32 reasoningHash
    ) external onlyAgent nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _verify(a, signature);

        uint256 expected = nextIntent[a.caseId];
        if (intentSeq != expected) revert IntentAlreadyUsed(expected, intentSeq);
        nextIntent[a.caseId] = expected + 1;

        uint256 paidToDate = paid[a.caseId];
        if (paidToDate + amount > a.maxAmount) {
            revert ExceedsAttestedMaximum(paidToDate, amount, a.maxAmount);
        }

        uint256 period = currentPeriod();
        uint256 spent = spentInPeriod[period];
        if (spent + amount > periodBudget) revert ExceedsPeriodBudget(spent, amount, periodBudget);

        if (pending[a.caseId].open) revert PendingAlreadyOpen();

        // Reserve the amount against the case now, whether it is paid or
        // parked, so a second proposal for the same case cannot slip in while
        // the first one waits for a person.
        paid[a.caseId] = paidToDate + amount;

        uint256 payeeSpent = payeeSpentInPeriod[period][a.payee];
        if (payeeSpent + amount > escalationThreshold) {
            pending[a.caseId] = Pending({
                intentSeq: intentSeq,
                payee: a.payee,
                amount: amount,
                evidenceHash: a.evidenceHash,
                reasoningHash: reasoningHash,
                open: true
            });
            pendingExpiry[a.caseId] = a.expiry;
            pendingRule[a.caseId] = a.ruleVersion;
            pendingVerifier[a.caseId] = verifier;
            emit Escalated(a.caseId, a.payee, intentSeq, amount, payeeSpent, a.evidenceHash, reasoningHash);
            return;
        }

        spentInPeriod[period] = spent + amount;
        payeeSpentInPeriod[period][a.payee] = payeeSpent + amount;
        _pay(a.payee, amount);
        emit Settled(a.caseId, a.payee, intentSeq, amount, paidToDate + amount, a.evidenceHash, ruleVersion, reasoningHash);
    }

    /// @notice A person signs off a parked payment. The period budget still
    /// applies: approval lifts the per-payee threshold, not the ceiling.
    function approve(bytes32 caseId) external onlyOwner nonReentrant {
        Pending memory p = pending[caseId];
        if (!p.open) revert NothingPending();
        if (block.timestamp > pendingExpiry[caseId]) revert AttestationExpired();
        if (!allowedPayee[p.payee]) revert PayeeNotAllowed();
        if (pendingRule[caseId] != ruleVersion || pendingVerifier[caseId] != verifier) revert PendingPolicyRevoked();
        delete pending[caseId];
        delete pendingExpiry[caseId];
        delete pendingRule[caseId];
        delete pendingVerifier[caseId];

        uint256 period = currentPeriod();
        uint256 spent = spentInPeriod[period];
        if (spent + p.amount > periodBudget) revert ExceedsPeriodBudget(spent, p.amount, periodBudget);

        spentInPeriod[period] = spent + p.amount;
        payeeSpentInPeriod[period][p.payee] += p.amount;
        _pay(p.payee, p.amount);
        emit Approved(caseId, msg.sender);
        emit Settled(caseId, p.payee, p.intentSeq, p.amount, paid[caseId], p.evidenceHash, ruleVersion, p.reasoningHash);
    }

    /// @notice A person declines a parked payment. The reservation against the
    /// case is released, so a corrected proposal can be made. The rejected
    /// intent stays used; the correction is a new intent with the next number.
    function reject(bytes32 caseId) external onlyOwner {
        Pending memory p = pending[caseId];
        if (!p.open) revert NothingPending();
        delete pending[caseId];
        delete pendingExpiry[caseId];
        delete pendingRule[caseId];
        delete pendingVerifier[caseId];
        paid[caseId] -= p.amount;
        emit Rejected(caseId, msg.sender);
    }

    // -------------------------------------------------------------- internal

    function _checkRoles(address owner_, address agent_, address verifier_) internal pure {
        if (owner_ == address(0) || agent_ == address(0) || verifier_ == address(0)
            || owner_ == agent_ || owner_ == verifier_ || agent_ == verifier_) revert InvalidRoles();
    }

    function _verify(Attestation calldata a, bytes calldata signature) internal view {
        if (block.timestamp > a.expiry) revert AttestationExpired();
        if (a.token != address(token)) revert WrongToken();
        if (a.ruleVersion != ruleVersion) revert WrongRuleVersion();
        if (!allowedPayee[a.payee]) revert PayeeNotAllowed();
        if (_recover(attestationDigest(a), signature) != verifier) revert ForgedAttestation();
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_ORDER) revert MalleableSignature();
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    function _pay(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
