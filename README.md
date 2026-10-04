# Sumplus Agoranomos on Arbitrum

AI suppliers can bill for work that was shortened, missing, or repeated. A payment agent should settle only the amount supported by evidence and by the owner's authorization.

Agoranomos computes a maximum payment from observed invoice and delivery facts in a separate verifier. The agent proposes a payment; an EIP-712 signature and a settlement contract enforce the ceiling, approved recipient, daily budget, and one-use payment intent. A signature binds one case, token, payee, evidence hash, rule version, expiry, chain, and contract.

## Try the demonstration

Open [the public demonstration](https://sumplus-real.github.io/agoranomos-arbitrum/) or serve `docs/` with any static HTTP server. Watch the [90-second demonstration](https://sumplus-real.github.io/agoranomos-arbitrum/agoranomos-demo-90s.mp4). Its interactive controls are explicitly a browser simulation using public synthetic fixtures. They cannot move funds.

The executable contract demonstration runs locally:

```sh
npm ci
npm run typecheck
npm test
forge test --root contracts
npx tsx scripts/local-e2e.ts
```

Requirements: Node 20+, Foundry (`forge`, `anvil`). The local runner uses public deterministic test accounts, a mock ERC-20, and an Anvil instance on `127.0.0.1:18545`. Its local transaction fee is explicitly set to a dummy 0.01 gwei to avoid inheriting Ethereum priority-fee defaults; live RPC fee estimation is unaffected. It sets chain ID 421614 to test the domain, but it is **not** a deployment to Arbitrum Sepolia. The script deletes its temporary role files and stops Anvil on completion.

Inspect `artifacts/local/public-report.json`: an actual local token balance increases by 0.20; an independent second case proposes 0.10, taking the same payee's daily total above 0.25; no token moves until the owner approves; approval transfers 0.10. Six `eth_call` controls check agent self-signing, altered signed recipient, overpayment, wrong-chain signature, expired proof, and consumed intent replay.

## Arbitrum configuration

- Chain: Arbitrum Sepolia, **421614**. ETH pays transaction gas.
- Token: Circle test USDC, `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, **6 decimals**, ERC-20.
- Owner budget in the demonstration: **1 test USDC per 86,400-second fixed window**.
- Owner approval threshold: **0.25 test USDC per payee per window**, cumulative across cases. Above the threshold, a valid proposal parks for approval. Splitting a payment across cases does not avoid the threshold.

The configured USDC address comes from [Circle's contract list](https://developers.circle.com/stablecoins/usdc-contract-addresses). `npx tsx scripts/check-network.ts` verifies chain ID, deployed token bytecode, decimals, and symbol against the public RPC. `artifacts/sepolia-readonly.json` records that read-only verification. It does not prove a settlement deployment.

**Current evidence:** 35 Solidity tests, 9 verifier/signature/configuration checks and 1 local-runner service-collision guard, TypeScript validation, and the complete local transaction demonstration pass. Public Arbitrum Sepolia deployment and the live test-USDC demonstration completed on October 4, 2026. The live run settled 0.20 test USDC, parked a separate 0.10 payment until owner approval, and passed all six rejection controls. Fixtures remain synthetic.

## Deploy to the public testnet

Use three separate private role files supplied through `OWNER_ENV_FILE`, `AGENT_ENV_FILE`, and `VERIFIER_ENV_FILE`. The files contain `DEPLOYER_PRIVATE_KEY`, `AGENT_PRIVATE_KEY`, and `VERIFIER_PRIVATE_KEY`, respectively. Never commit them. `scripts/role-config.ts` has no private-path defaults.

Fund the owner with free **test** ETH and at least 1 Circle **test** USDC. The deployment script checks the chain and balances before broadcasting, estimates Arbitrum gas, caps owner setup expenditure to **0.002 test ETH** including a **0.0001 test ETH** agent gas top-up, requires explicit `BROADCAST_TESTNET=1`, checks current build hashes and deployed bytecode, checkpoints every submitted hash, and resumes confirmed steps without deploying twice. Deployment reserves 1 test USDC inside the contract. The demo payee is the test treasury, so the test tokens return to that treasury.

```sh
npx tsx scripts/wallet-status.ts
npx tsx scripts/deploy.ts # preflight; does not broadcast
BROADCAST_TESTNET=1 npx tsx scripts/deploy.ts # explicit testnet execution
BROADCAST_TESTNET=1 npx tsx scripts/live-e2e.ts
```

Only the local runner permits the mock token. The live runner requires the canonical Circle test token and chain 421614. The live demonstration separately caps maximum gas charges across its three transactions to **0.0005 test ETH**. The public `artifacts/public-report.json` should be published only after its checks pass. Set no live role files in a static host.

## Security boundaries and limits

The contract refuses zero or overlapping owner/agent/verifier roles. The agent cannot set roles, limits, rules, recipients, or approve payments. A pending case cannot be overwritten. Approval rechecks proof expiry, recipient allowlisting, and the rule/verifier policy under which it was parked. After rejection, reservation is released while the intent remains used.

The public fixture is synthetic and proves a mechanism, not customer usage or autonomous evidence collection. An observed fact supplied to the verifier still requires trustworthy ingestion; this prototype does not authenticate arbitrary external invoices. The demonstration runner orchestrates roles in one process for reproducibility. Production separation requires separately secured processes or services, keys, source authentication, and a security review. This prototype is not audited.

## Build history

This entry extends the team's existing **Sumplus Agoranomos** implementation. The evidence schema, deterministic verifier rules, EIP-712 types/signing, agent submission pattern, settlement contract, and initial tests were reused under MIT from prior team work (baseline source revision `550680eccaa55af6850bb3b5216d1ef419830360`, 2026-09-28). They are not claimed as newly written during this entry.

The Arbitrum entry adds chain 421614 and canonical ERC-20 test-USDC configuration, independent ETH gas handling, checkpointed/capped deployment, public synthetic demonstrations, local executable transaction evidence, public RPC verification, and new contract protections for pending overwrite, invalid roles, and approval-policy revocation, with regression coverage. No private replay, customer record, production configuration, or key file is included.

MIT license. See `LICENSE`.

## Public Arbitrum Sepolia evidence

- Contract: https://sepolia.arbiscan.io/address/0x8d38dbad863f7bf2b32fc227243a5092afad90e6
- Settlement: https://sepolia.arbiscan.io/tx/0x637ff59f80fd9c0e0e3154152b2484f16560fd63d16183039ab290d998eec573
- Owner approval: https://sepolia.arbiscan.io/tx/0x18b6ea58f587e3bebb79698d3ef9a69f1b83d9c1101e8c22917e3278a90f460b
- Demo video: https://youtu.be/x1lE_p4HCKg

Machine-readable receipts: `artifacts/public-report.json`. The browser UI and recorded video remain synthetic simulations; the linked live transactions use Circle test USDC.
