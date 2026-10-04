// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgoranomosSettlement} from "../src/AgoranomosSettlement.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AgoranomosSettlementTest is Test {
    AgoranomosSettlement internal settlement;
    MockUSDC internal usdc;

    uint256 internal verifierKey = 0xA11CE;
    uint256 internal agentKey = 0xB0B;
    address internal verifier;
    address internal agent;
    address internal owner = address(0x0DD);
    address internal supplier = address(0x5117);
    address internal tenant = address(0x7E7);
    address internal stranger = address(0xBAD);

    bytes32 internal constant RULES = keccak256("rules-v1");
    uint64 internal constant PERIOD = 1 days;
    uint256 internal constant BUDGET = 1_000e6;
    uint256 internal constant THRESHOLD = 100e6;

    function setUp() public {
        verifier = vm.addr(verifierKey);
        agent = vm.addr(agentKey);
        usdc = new MockUSDC();
        settlement = new AgoranomosSettlement(
            address(usdc), owner, agent, verifier, RULES, PERIOD, BUDGET, THRESHOLD
        );
        usdc.mint(address(settlement), 10_000e6);
        vm.startPrank(owner);
        settlement.setPayee(supplier, true);
        settlement.setPayee(tenant, true);
        vm.stopPrank();
        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------ helpers

    function _att(bytes32 caseId, address payee, uint256 maxAmount)
        internal
        view
        returns (AgoranomosSettlement.Attestation memory a)
    {
        a = AgoranomosSettlement.Attestation({
            caseId: caseId,
            payee: payee,
            token: address(usdc),
            maxAmount: maxAmount,
            ruleVersion: RULES,
            evidenceHash: keccak256(abi.encode("evidence", caseId)),
            expiry: uint64(vm.getBlockTimestamp() + 1 hours)
        });
    }

    function _sign(uint256 key, AgoranomosSettlement.Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.attestationDigest(a));
        return abi.encodePacked(r, s, v);
    }

    /// An honest new payment: it carries the next intent number for its case.
    function _settle(AgoranomosSettlement.Attestation memory a, bytes memory sig, uint256 amount) internal {
        uint256 seq = settlement.nextIntent(a.caseId);
        vm.prank(agent);
        settlement.settle(a, sig, amount, seq, keccak256("reasoning"));
    }

    // ------------------------------------------------------- happy path

    function test_settlesAnAttestedCase() public {
        AgoranomosSettlement.Attestation memory a = _att("case-1", supplier, 40e6);
        _settle(a, _sign(verifierKey, a), 40e6);
        assertEq(usdc.balanceOf(supplier), 40e6, "supplier paid");
        assertEq(settlement.paid("case-1"), 40e6, "case records what was paid");
    }

    function test_partialPaymentsUpToTheAttestedMaximum() public {
        AgoranomosSettlement.Attestation memory a = _att("case-2", supplier, 50e6);
        bytes memory sig = _sign(verifierKey, a);
        _settle(a, sig, 30e6);
        _settle(a, sig, 20e6);
        assertEq(usdc.balanceOf(supplier), 50e6);
    }

    // ------------------------------------ the four attacks the judge named

    /// A record the agent wrote and signed itself is not an attestation.
    function test_attack_forgedRecordIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-3", supplier, 40e6);
        bytes memory agentSig = _sign(agentKey, a);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.ForgedAttestation.selector);
        settlement.settle(a, agentSig, 40e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 0);
    }

    /// Reusing a real signature with a different payee breaks the signature.
    function test_attack_swappedPayeeIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-4", supplier, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        a.payee = tenant; // allowlisted, so only the signature can stop it
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.ForgedAttestation.selector);
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(tenant), 0);
        assertEq(usdc.balanceOf(supplier), 0);
    }

    /// A retry of a payment that already ran is refused by its intent number.
    function test_attack_retryCannotPayTwice() public {
        AgoranomosSettlement.Attestation memory a = _att("case-5", supplier, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        _settle(a, sig, 40e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.IntentAlreadyUsed.selector, 1, 0));
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 40e6, "paid exactly once");
    }

    /// The case the ceiling cannot catch: paying 3 against a ceiling of 10,
    /// then retrying the same payment, stays under the ceiling both times.
    /// Only the intent number stops the second one.
    function test_attack_partialRetryUnderTheCeilingIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-5b", supplier, 10e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        settlement.settle(a, sig, 3e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 3e6);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.IntentAlreadyUsed.selector, 1, 0));
        settlement.settle(a, sig, 3e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 3e6, "the retry paid nothing");
        assertEq(settlement.paid("case-5b"), 3e6, "and reserved nothing");
    }

    /// A genuinely new partial payment against the same case carries the next
    /// number and goes through, up to the ceiling.
    function test_aSecondPartialPaymentIsANewIntent() public {
        AgoranomosSettlement.Attestation memory a = _att("case-5c", supplier, 10e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        settlement.settle(a, sig, 3e6, 0, bytes32(0));
        vm.prank(agent);
        settlement.settle(a, sig, 3e6, 1, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 6e6);
    }

    /// The ceiling still holds on its own, for a new intent that asks too much.
    function test_aNewIntentStillCannotPassTheCeiling() public {
        AgoranomosSettlement.Attestation memory a = _att("case-5d", supplier, 10e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        settlement.settle(a, sig, 8e6, 0, bytes32(0));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgoranomosSettlement.ExceedsAttestedMaximum.selector, 8e6, 3e6, 10e6)
        );
        settlement.settle(a, sig, 3e6, 1, bytes32(0));
    }

    /// Skipping ahead is refused too: intents run in order, one at a time.
    function test_anIntentNumberFromTheFutureIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-5e", supplier, 10e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.IntentAlreadyUsed.selector, 0, 5));
        settlement.settle(a, sig, 3e6, 5, bytes32(0));
    }

    /// Two submissions of the same case while the first waits for a person:
    /// the parked amount is reserved, so the second cannot go around it.
    function test_attack_retryWhileEscalatedIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-6", supplier, 150e6);
        bytes memory sig = _sign(verifierKey, a);
        _settle(a, sig, 150e6); // over the threshold, so it parks
        (,,,,, bool open) = settlement.pending("case-6");
        assertTrue(open, "parked for a person");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.IntentAlreadyUsed.selector, 1, 0));
        settlement.settle(a, sig, 150e6, 0, bytes32(0));
        assertEq(usdc.balanceOf(supplier), 0, "nothing paid while it waits");
        // And a new intent cannot go around the parked one either: its amount
        // is already reserved against the case.
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgoranomosSettlement.ExceedsAttestedMaximum.selector, 150e6, 150e6, 150e6)
        );
        settlement.settle(a, sig, 150e6, 1, bytes32(0));
    }

    /// Splitting one large payment into several cases, each under the
    /// threshold, does not get under it: the threshold counts per payee per
    /// period, across cases.
    function test_attack_splittingUnderTheThresholdEscalates() public {
        for (uint256 i = 0; i < 2; i++) {
            bytes32 id = keccak256(abi.encode("split", i));
            AgoranomosSettlement.Attestation memory a = _att(id, supplier, 45e6);
            _settle(a, _sign(verifierKey, a), 45e6);
        }
        assertEq(usdc.balanceOf(supplier), 90e6, "first two paid, 90 under the 100 threshold");

        bytes32 third = keccak256(abi.encode("split", uint256(2)));
        AgoranomosSettlement.Attestation memory c = _att(third, supplier, 45e6);
        _settle(c, _sign(verifierKey, c), 45e6);
        assertEq(usdc.balanceOf(supplier), 90e6, "third would reach 135, so it waits for a person");
        (,,,,, bool open) = settlement.pending(third);
        assertTrue(open);
    }

    // ------------------------------------------------ the other boundaries

    function test_expiredAttestationIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-7", supplier, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.AttestationExpired.selector);
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
    }

    function test_attestationUnderOldRulesIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-8", supplier, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(owner);
        settlement.setRuleVersion(keccak256("rules-v2"));
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.WrongRuleVersion.selector);
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
    }

    function test_payeeOutsideTheAllowlistIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-9", stranger, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.PayeeNotAllowed.selector);
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
    }

    /// An attestation signed for another deployment of this contract does not
    /// verify here: the domain binds it to one chain and one address.
    function test_attestationForAnotherContractIsRefused() public {
        AgoranomosSettlement other = new AgoranomosSettlement(
            address(usdc), owner, agent, verifier, RULES, PERIOD, BUDGET, THRESHOLD
        );
        AgoranomosSettlement.Attestation memory a = _att("case-10", supplier, 40e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, other.attestationDigest(a));
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.ForgedAttestation.selector);
        settlement.settle(a, abi.encodePacked(r, s, v), 40e6, 0, bytes32(0));
    }

    /// An attestation signed for the same contract address on another chain
    /// does not verify here. The chain-1 digest is built from the EIP-712
    /// formula in this test, independently of the contract.
    function test_attestationForAnotherChainIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-11", supplier, 40e6);
        bytes32 domainOnChainOne = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AgoranomosSettlement"),
                keccak256("1"),
                uint256(1),
                address(settlement)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Attestation(bytes32 caseId,address payee,address token,uint256 maxAmount,bytes32 ruleVersion,bytes32 evidenceHash,uint64 expiry)"
                ),
                a.caseId, a.payee, a.token, a.maxAmount, a.ruleVersion, a.evidenceHash, a.expiry
            )
        );
        bytes32 digestOnChainOne = keccak256(abi.encodePacked("\x19\x01", domainOnChainOne, structHash));
        assertTrue(digestOnChainOne != settlement.attestationDigest(a), "the two chains must hash differently");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digestOnChainOne);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.ForgedAttestation.selector);
        settlement.settle(a, abi.encodePacked(r, s, v), 40e6, 0, bytes32(0));
    }

    /// The same formula with this chain's id reproduces the contract's digest
    /// exactly, which is what makes the test above meaningful.
    function test_theIndependentDigestFormulaMatchesTheContract() public view {
        AgoranomosSettlement.Attestation memory a = _att("case-11b", supplier, 40e6);
        bytes32 domainHere = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AgoranomosSettlement"),
                keccak256("1"),
                block.chainid,
                address(settlement)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Attestation(bytes32 caseId,address payee,address token,uint256 maxAmount,bytes32 ruleVersion,bytes32 evidenceHash,uint64 expiry)"
                ),
                a.caseId, a.payee, a.token, a.maxAmount, a.ruleVersion, a.evidenceHash, a.expiry
            )
        );
        assertEq(keccak256(abi.encodePacked("\x19\x01", domainHere, structHash)), settlement.attestationDigest(a));
    }

    function test_onlyTheAgentCanSettle() public {
        AgoranomosSettlement.Attestation memory a = _att("case-12", supplier, 40e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(verifier);
        vm.expectRevert(AgoranomosSettlement.NotAgent.selector);
        settlement.settle(a, sig, 40e6, 0, bytes32(0));
    }

    /// A budget of zero stops payments. It never means "no limit".
    function test_zeroBudgetIsAStop() public {
        vm.prank(owner);
        settlement.setLimits(PERIOD, 0, THRESHOLD);
        AgoranomosSettlement.Attestation memory a = _att("case-13", supplier, 1e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.ExceedsPeriodBudget.selector, 0, 1e6, 0));
        settlement.settle(a, sig, 1e6, 0, bytes32(0));
    }

    function test_periodBudgetCapsEveryoneTogether() public {
        vm.prank(owner);
        settlement.setLimits(PERIOD, 60e6, THRESHOLD);
        AgoranomosSettlement.Attestation memory a = _att("case-14", supplier, 40e6);
        _settle(a, _sign(verifierKey, a), 40e6);
        AgoranomosSettlement.Attestation memory b = _att("case-15", tenant, 40e6);
        bytes memory sigB = _sign(verifierKey, b);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgoranomosSettlement.ExceedsPeriodBudget.selector, 40e6, 40e6, 60e6)
        );
        settlement.settle(b, sigB, 40e6, 0, bytes32(0));
    }

    function test_theBudgetResetsNextPeriod() public {
        vm.prank(owner);
        settlement.setLimits(PERIOD, 40e6, THRESHOLD);
        AgoranomosSettlement.Attestation memory a = _att("case-16", supplier, 40e6);
        _settle(a, _sign(verifierKey, a), 40e6);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        AgoranomosSettlement.Attestation memory b = _att("case-17", supplier, 40e6);
        _settle(b, _sign(verifierKey, b), 40e6);
        assertEq(usdc.balanceOf(supplier), 80e6);
    }

    // --------------------------------------------------- the person's say

    function test_aPersonApprovesAParkedPayment() public {
        AgoranomosSettlement.Attestation memory a = _att("case-18", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        assertEq(usdc.balanceOf(supplier), 0);
        vm.prank(owner);
        settlement.approve("case-18");
        assertEq(usdc.balanceOf(supplier), 150e6);
    }

    /// A person's approval lifts the per-payee threshold, not the ceiling on
    /// the whole period: a parked payment that no longer fits the budget
    /// cannot be approved through it.
    function test_approvalStillRespectsThePeriodBudget() public {
        vm.prank(owner);
        settlement.setLimits(PERIOD, 200e6, THRESHOLD);

        AgoranomosSettlement.Attestation memory big = _att("case-19", supplier, 150e6);
        _settle(big, _sign(verifierKey, big), 150e6); // parks: over the 100 threshold

        AgoranomosSettlement.Attestation memory small = _att("case-19b", tenant, 80e6);
        _settle(small, _sign(verifierKey, small), 80e6); // pays: 80 spent this period

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AgoranomosSettlement.ExceedsPeriodBudget.selector, 80e6, 150e6, 200e6)
        );
        settlement.approve("case-19");
        assertEq(usdc.balanceOf(supplier), 0, "approval could not break the budget");
    }

    function test_aParkedPaymentThatAlreadyBreaksTheBudgetIsRefusedAtOnce() public {
        vm.prank(owner);
        settlement.setLimits(PERIOD, 120e6, THRESHOLD);
        AgoranomosSettlement.Attestation memory a = _att("case-19c", supplier, 150e6);
        bytes memory sig = _sign(verifierKey, a);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgoranomosSettlement.ExceedsPeriodBudget.selector, 0, 150e6, 120e6)
        );
        settlement.settle(a, sig, 150e6, 0, bytes32(0));
    }

    function test_onlyTheOwnerApproves() public {
        AgoranomosSettlement.Attestation memory a = _att("case-20", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.NotOwner.selector);
        settlement.approve("case-20");
    }

    function test_rejectingReleasesTheReservation() public {
        AgoranomosSettlement.Attestation memory a = _att("case-21", supplier, 150e6);
        bytes memory sig = _sign(verifierKey, a);
        _settle(a, sig, 150e6);
        vm.prank(owner);
        settlement.reject("case-21");
        assertEq(settlement.paid("case-21"), 0, "reservation released");
        _settle(a, sig, 60e6); // a corrected, smaller proposal goes through
        assertEq(usdc.balanceOf(supplier), 60e6);
    }

    function test_malleableSignatureIsRefused() public {
        AgoranomosSettlement.Attestation memory a = _att("case-22", supplier, 40e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, settlement.attestationDigest(a));
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes32 highS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.MalleableSignature.selector);
        settlement.settle(a, abi.encodePacked(r, highS, flippedV), 40e6, 0, bytes32(0));
    }
    function test_pendingCannotBeOverwrittenByNextIntent() public {
        AgoranomosSettlement.Attestation memory a = _att("pending-overwrite", supplier, 300e6);
        bytes memory sig = _sign(verifierKey, a);
        _settle(a, sig, 150e6);
        vm.prank(agent);
        vm.expectRevert(AgoranomosSettlement.PendingAlreadyOpen.selector);
        settlement.settle(a, sig, 10e6, 1, keccak256("reasoning"));
        (, , uint256 amount, , , bool open) = settlement.pending(a.caseId);
        assertTrue(open);
        assertEq(amount, 150e6);
        assertEq(settlement.nextIntent(a.caseId), 1);
        vm.prank(owner);
        settlement.approve(a.caseId);
        assertEq(usdc.balanceOf(supplier), 150e6);
    }
    function test_invalidRoleConfigurationRefused() public {
        vm.prank(owner);
        vm.expectRevert(AgoranomosSettlement.InvalidRoles.selector);
        settlement.setRoles(owner, agent, address(0));
        vm.prank(owner);
        vm.expectRevert(AgoranomosSettlement.InvalidRoles.selector);
        settlement.setRoles(owner, agent, agent);
    }
    function test_pendingApprovalRefusesRevokedPayee() public {
        AgoranomosSettlement.Attestation memory a = _att("revoked-payee", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        vm.startPrank(owner);
        settlement.setPayee(supplier, false);
        vm.expectRevert(AgoranomosSettlement.PayeeNotAllowed.selector);
        settlement.approve(a.caseId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(supplier), 0);
    }
    function test_pendingApprovalRefusesExpiredProof() public {
        AgoranomosSettlement.Attestation memory a = _att("expired-pending", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        vm.warp(uint256(a.expiry) + 1);
        vm.prank(owner);
        vm.expectRevert(AgoranomosSettlement.AttestationExpired.selector);
        settlement.approve(a.caseId);
    }
    function test_pendingApprovalRefusesChangedRules() public {
        AgoranomosSettlement.Attestation memory a = _att("changed-rules", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        vm.startPrank(owner);
        settlement.setRuleVersion(keccak256("new-rules"));
        vm.expectRevert(AgoranomosSettlement.PendingPolicyRevoked.selector);
        settlement.approve(a.caseId);
        vm.stopPrank();
    }
    function test_constructorRefusesZeroVerifier() public {
        vm.expectRevert(AgoranomosSettlement.InvalidRoles.selector);
        new AgoranomosSettlement(address(usdc), owner, agent, address(0), RULES, PERIOD, BUDGET, THRESHOLD);
    }

    function test_pendingVerifierRotationRefusesApprovalAndRejectRecovers() public {
        AgoranomosSettlement.Attestation memory a = _att("rotated-verifier", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        uint256 newVerifierKey = 0xC0FFEE;
        vm.startPrank(owner);
        settlement.setRoles(owner, agent, vm.addr(newVerifierKey));
        vm.expectRevert(AgoranomosSettlement.PendingPolicyRevoked.selector);
        settlement.approve(a.caseId);
        vm.stopPrank();
        assertEq(usdc.balanceOf(supplier), 0);
        assertEq(settlement.paid(a.caseId), 150e6);
        (, , , , , bool open) = settlement.pending(a.caseId);
        assertTrue(open);
        vm.prank(owner);
        settlement.reject(a.caseId);
        assertEq(settlement.paid(a.caseId), 0);
        assertEq(settlement.nextIntent(a.caseId), 1);
        assertEq(settlement.pendingExpiry(a.caseId), 0);
        assertEq(settlement.pendingRule(a.caseId), bytes32(0));
        assertEq(settlement.pendingVerifier(a.caseId), address(0));
        bytes memory freshSignature = _sign(newVerifierKey, a);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgoranomosSettlement.IntentAlreadyUsed.selector, 1, 0));
        settlement.settle(a, freshSignature, 50e6, 0, bytes32(0));
        _settle(a, freshSignature, 50e6);
        assertEq(usdc.balanceOf(supplier), 50e6);
        assertEq(settlement.paid(a.caseId), 50e6);
        assertEq(settlement.nextIntent(a.caseId), 2);
    }

    function test_expiredPendingRejectAllowsFreshProofAndIntent() public {
        AgoranomosSettlement.Attestation memory a = _att("expired-recovery", supplier, 150e6);
        _settle(a, _sign(verifierKey, a), 150e6);
        vm.warp(uint256(a.expiry) + 1);
        vm.startPrank(owner);
        vm.expectRevert(AgoranomosSettlement.AttestationExpired.selector);
        settlement.approve(a.caseId);
        settlement.reject(a.caseId);
        vm.stopPrank();
        assertEq(settlement.paid(a.caseId), 0);
        assertEq(settlement.nextIntent(a.caseId), 1);
        a.expiry = uint64(vm.getBlockTimestamp() + 1 hours);
        _settle(a, _sign(verifierKey, a), 50e6);
        assertEq(usdc.balanceOf(supplier), 50e6);
        assertEq(settlement.nextIntent(a.caseId), 2);
    }
}
