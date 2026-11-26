# Onchain support payments

TerraField accepts **voluntary onchain support payments**. They are not a
subscription purchase, not a card/fiat checkout, and not an entitlement
mechanism. Core capabilities stay free for every account; support payments
never unlock, lock, extend, or shorten access. Only compute-cost limits may
differ by plan, and those limits are configured by plan, not by payment.

## Non-custodial design

- The server **never holds a private key** and never signs a transaction.
- The treasury key is never on the server, in environment variables, in the
  database, or in this repository. The configured `ONCHAIN_TREASURY` is a public
  recipient address only.
- A support payment goes directly from the payer's wallet to the treasury (or
  through `TerraFieldSupport`, which forwards it in the same transaction).
  TerraField never has custody at any point.
- `contracts/TerraFieldSupport.sol` has no owner withdrawal path, no fees, no
  upgradeability, and no state beyond `treasury`. `supportNative` and
  `supportToken` forward the full amount immediately. The owner can only rotate
  the public treasury address.
- Verification is read-only against a public JSON-RPC endpoint. The server
  records what the chain already did; it cannot move funds.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `ONCHAIN_RPC_URL` | yes | HTTP(S) JSON-RPC endpoint used to read chain state. |
| `ONCHAIN_CHAIN_ID` | yes | Expected EVM chain id; mismatches are rejected before any write. |
| `ONCHAIN_TREASURY` | yes | Public `0x`-prefixed 20-byte recipient address. |
| `ONCHAIN_TOKEN_ADDRESS` | yes | ERC20 contract address, or the literal sentinel `native` for the gas coin. |
| `ONCHAIN_TOKEN_SYMBOL` | no | Display symbol; defaults to `USDC`, or `ETH` in native mode. |
| `ONCHAIN_TOKEN_DECIMALS` | no | Token base-unit decimals; defaults to `6`, or `18` in native mode. |
| `ONCHAIN_SUPPORT_CONTRACT` | no | Address of the deployed `TerraFieldSupport` forwarder; enables acceptance of its `Support` event for native payments. |
| `ONCHAIN_CONFIRMATIONS` | no | Required confirmation depth; defaults to `3`, hard floor `1`. Invoice-linked admin settlement uses at least `6`. |

When any required variable is missing or invalid, `GET /api/v1/billing/onchain/config`
returns `200` with `enabled: false` and the mutation endpoints return
`503 ONCHAIN_NOT_CONFIGURED`. The RPC URL is never returned to the browser.

### Native mode

`ONCHAIN_TOKEN_ADDRESS=native` verifies native value transfers. Two settlement
shapes are accepted:

- **Direct-to-treasury:** `tx.to == ONCHAIN_TREASURY` and
  `tx.value == intent.amountUnits` exactly.
- **Via the support contract:** `tx.to == ONCHAIN_SUPPORT_CONTRACT`,
  `tx.value == intent.amountUnits`, and the receipt contains a `Support` event
  from that contract with `token == address(0)`, `amount == intent.amountUnits`,
  `payer == tx.from`, and `memo == intent.memo`. The contract emits the event
  only after the treasury forward succeeds.

There is deliberately no price oracle: the intent quote treats one whole native
unit as the configured fiat unit. Enable native mode only where that par
assumption is acceptable and the treasury accepts the chain's gas coin.
Otherwise use a stablecoin ERC20.

## Deployment

The artifact is generated locally; it is never fetched at runtime.

```bash
bun run scripts/compile-contract.mjs   # or: node scripts/compile-contract.mjs
```

This writes `contracts/abi/TerraFieldSupport.json` (ABI + bytecode) and fails on
any compiler error, including an unresolved OpenZeppelin import.

Deploy with Foundry:

```bash
forge create contracts/TerraFieldSupport.sol:TerraFieldSupport \
  --rpc-url "$ONCHAIN_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args "$ONCHAIN_TREASURY"
```

Or with Hardhat:

```js
const Support = await ethers.getContractFactory('TerraFieldSupport');
const support = await Support.deploy(process.env.ONCHAIN_TREASURY);
await support.waitForDeployment();
```

`DEPLOYER_PRIVATE_KEY` is a deployment-time secret; it is not the treasury key
and is not used by the application server.

## Intent lifecycle

1. `POST /api/v1/billing/onchain/intents` with `{ "amountMinor": 1000 }` (USD
   minor units, minimum `100` = $1, maximum `1_000_000` = $10,000). Without
   `invoiceId` this is a support intent and changes no entitlement. A tenant
   billing manager may add `invoiceId` for an open invoice of their workspace;
   the amount must equal the invoice total, and that intent is a subscription
   payment for cost-bearing compute, not support.
2. The server fixes chain id, token, treasury, exact base units (BigInt
   arithmetic, no floating point), a random 32-byte memo, and a 30-minute
   expiry.
3. The payer sends the exact amount to the treasury with the memo as an
   offchain reference. The support contract emits the memo in its `Support`
   event; a direct wallet transfer is still verified by recipient/token/amount,
   with the memo kept only as a local reference.
4. `POST /api/v1/billing/onchain/intents/:id/verify` with `{ "txHash": "0x…" }`.

## Exact verification rules

A transaction is accepted only when all of these hold:

- `eth_chainId` equals `ONCHAIN_CHAIN_ID`.
- `eth_getTransactionReceipt` exists for the exact hash and `status == 1`.
- The intent is `open`, belongs to the caller's tenant, and has not expired.
- The intent chain/token/treasury match the active configuration.
- **ERC20:** a `Transfer(address,address,uint256)` log (topic0
  `0xddf252ad…`) from the configured token has `to == treasury` and
  `value == intent.amountUnits` **exactly**. Values greater than the intent are
  rejected, so overpayment does not silently settle a different amount. The
  sender may be any address.
- **Native:** direct `tx.to == treasury` with `tx.value == intent.amountUnits`
  exactly, or `tx.to == support contract` with a matching `Support` event and
  exact `tx.value`. Malformed event data is a non-match, never an RPC error.
- Confirmations = `latestBlock - receiptBlock + 1 >= ONCHAIN_CONFIRMATIONS`
  (at least `6` for an invoice-linked admin settlement).
- `txHash` has never been recorded before. `OnchainPayment.txHash` and
  `OnchainPayment.intentId` are unique; concurrent verification therefore
  produces exactly one recorded payment and the loser receives `409`.
- An unknown receipt short-circuits verification before any block or
  transaction lookup.

Intent creation is limited to 10 requests per minute per tenant and
verification to 6 per minute per tenant (shared Redis token buckets; if Redis
is unavailable these endpoints fail closed with `503`). Creating an intent
opportunistically marks the tenant's open intents older than 30 minutes as
`expired`.

The pre-RPC intent lookup runs on the owner database connection because it
happens before a tenant transaction exists. Every write then runs inside the
tenant-scoped transaction with an explicit ownership re-check, and the unique
constraints are the final concurrency gate.

## Invoice-linked settlement (self-service for tenant billing managers)

Support intents remain support-only and change no entitlement. Separately, a
tenant `billing.manage` holder may link an intent to an **open invoice** of
their active workspace; that is a subscription payment for cost-bearing compute
(not a support payment). Voluntary support without `invoiceId` still cannot
change subscription state.

Invoice-linked verification requires at least 6 confirmations and commits in
one serializable transaction:

- the invoice must still be open and belong to the tenant;
- a `Payment` row is written with method `onchain` and the transaction hash as
  the reference;
- the linked subscription is activated and advanced by one month exactly as a
  manual settlement does;
- the invoice is marked paid once; a second settlement attempt is rejected.

Only the server verifier can reach the onchain settlement path. The public
manual-settlement route rejects `method: "onchain"`; the library exposes a
module-private capability that `settleVerifiedOnchainInvoiceInTransaction`
sets after RPC verification. `method: "provider"` remains rejected because no
payment provider adapter exists.

## Limitations

- **RPC trust:** verification trusts the configured RPC endpoint for chain id,
  receipts, logs, and block height. Use a reputable endpoint, ideally with
  redundant infrastructure; a lying RPC can misreport a payment, but it still
  cannot move funds.
- **Reorgs:** confirmations reduce, but do not eliminate, reorg risk. A recorded
  payment is not automatically reverted if a deep reorg orphans its block.
- **Fee-on-transfer / rebasing tokens are unsupported.** The verifier requires
  the transfer log value to equal the quoted amount exactly. Tokens that deduct
  a fee on transfer, rebase balances, or use non-standard transfer semantics
  will fail verification.
- **No price oracle.** USD-to-token conversion assumes the configured token is
  pegged 1:1 to the fiat minor unit (stablecoins), or native par mode as noted
  above.
- **No refunds or chargebacks.** Onchain transfers are final. Support is
  voluntary; contact the operator out of band if a mistake occurs.
- **Memo is an offchain reference.** Verification matches recipient, token, and
  amount; it does not require the memo to appear in calldata. Only payments made
  through `TerraFieldSupport` emit it onchain.
- **No fiat/card processing.** The product does not claim card, bank, or fiat
  support through this path.

## Freemium policy

Support payments are voluntary. They do not alter `Entitlements`, plan codes,
quotas, trials, or access checks. The only plan-dependent limits are
compute-cost limits configured by the plan definition. A deployment can disable
onchain support entirely and every core feature continues to work.
