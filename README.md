# Ownership — one-page site

The public one-page site for **Ownership, the Arc Naming Service**.
Tagline: *Yours outright and freely.* Built 2026-10-15. **Not deployed yet** —
deployment (Cloudflare Pages + GitHub Pages + Pinata/IPFS) is a separate step.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole page. Config block is the `<script>` at the bottom (`window.OWNERSHIP_CONFIG`). |
| `js/app.js` | Lookup, wallet connect (injected), registration flow. Contract facts documented at the top of the file. |
| `js/ethers.umd.min.js` | Vendored ethers v6.17.0 browser build (no CDN). |
| `js/walletconnect.js` | Vendored Reown AppKit bundle (see "Rebuilding" below). Inert until a project ID is set. |
| `assets/ownership-logo-with-tm.png` | Header logo — the ™ social master (see provenance). |
| `assets/avatar-o-512.png` | Favicon — clean O-ring helm icon. |
| `assets/ownership-logo-clean.svg` | Clean vector master (no ™), kept for future print/formal use. |
| `test/` | Live read-path + register-construction tests (never broadcasts). |

## Brand

Per `naming-service/brand/IDENTITY.md`: Deep Navy `#002040`, Yellow Gold
`#F8D000`, white background, no gradients/shadows/effects, ™ rides with the
lockup (upper-right superscript, navy) on distributed files. The header uses
`2026-10-04-ownership-logo-with-tm.png` copied unchanged from
`naming-service/brand/vector/`; the favicon is
`2026-10-04-avatar-o-512.png` from `naming-service/brand/social/`.

## Contracts (Arc testnet, chain 5042002, RPC https://rpc.testnet.arc.io)

- Registry proxy: `0x523553fC7fC78F97386F0740847d9E594119D8Bb`
- Registrar proxy: `0xb8351Bcc980dA96b091C42092b8d53A7C647E35b`

Provenance — all three agree:
`@lodestarfo/arc-naming-contracts@0.2.2` `addresses.json` (npm, canonical);
`naming-service/deployments/arc-testnet.json`;
`naming-service/packages/arc-naming-contracts/addresses.json`.
ABIs likewise from the npm package, cross-checked against
`naming-service/contracts/Registrar.sol` / `Registry.sol`.

Registration mechanics (from the ABI + source): single-step payable
`register(label, newOwner)` — no commit/reveal. Live price per registration =
`quoteFor(label, account)` (tierPrice + matching fee) + `bulkPriceOf(account)`,
read fresh before every transaction; never hardcoded. Names hang off
`ROOT_NODE = bytes32(0)`: `node = keccak256(0x00…00 ‖ keccak256(label))`.

## Turning on WalletConnect (one line)

The MetaMask (injected) connect button works with no configuration.
For WalletConnect (phone/QR): create a free project at
https://cloud.reown.com (owner's account), then in `index.html` set

```js
REOWN_PROJECT_ID: "REPLACE_ME"  →  REOWN_PROJECT_ID: "<your project id>"
```

Arc testnet is defined as a custom chain inside `js/walletconnect.js`
(chainId 5042002, USDC, the RPC above); the page also prompts
`wallet_addEthereumChain` / `wallet_switchEthereumChain` when a wallet is on
the wrong network. Until the ID is set, the WalletConnect button explains
itself instead of failing silently.

## Rebuilding `js/walletconnect.js`

```bash
mkdir wc-build && cd wc-build
npm init -y
npm install @reown/appkit@1.8.24 @reown/appkit-adapter-ethers@1.8.24 esbuild
# entry source: window.OwnershipWC wrapper around createAppKit +
# EthersAdapter + defineChain for Arc Testnet (kept with the build notes)
npx esbuild wc-entry.js --bundle --format=iife --platform=browser \
  --target=es2020 --minify --outfile=../js/walletconnect.js
```

## How-to video

Section embeds the real walkthrough — "Ownership MetaMask walkthrough" v3
(2026-10-05), YouTube `MZH12b3T8wc`, via youtube-nocookie. Production file:
`naming-service/video/2026-10-05-ownership-walkthrough-v3.mp4`. On an
IPFS-only mirror the embed needs YouTube reachable; everything else on the
page is self-contained.

## Tests

```bash
cd test && npm install && node lookup-and-register.test.mjs
```

15 checks against the live RPC: ROOT_NODE, known-taken names (`acme` →
BrandVault owner; `pimlico-proof-d46a`), a nonsense name available, quote
shapes, and `register()` dry-runs via `eth_call` only — success at the quoted
total, `InsufficientPayment` when underpaid, `AlreadyRegistered` for a taken
name. Nothing is ever broadcast.
