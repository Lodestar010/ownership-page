/*
 * Ownership — one-page app logic.
 *
 * Reads are done with a plain JSON-RPC provider against the public Arc testnet
 * RPC (no wallet needed). Writes (registration) are built from the real
 * Registrar ABI and sent through the visitor's own wallet — this page never
 * holds keys and never signs anything itself.
 *
 * Contract facts (verified against @lodestarfo/arc-naming-contracts v0.2.2
 * ABIs and contracts/Registrar.sol):
 *   - Registrar.available(label) -> bool
 *   - Registrar.quoteFor(label, account) -> (tierPrice, fee)
 *       total = tierPrice + fee + Registrar.bulkPriceOf(account)
 *       7+ char names: tierPrice 0. 3-6 chars: tier price. 1-2 chars: locked.
 *   - Registrar.register(label, newOwner) payable — single step, no
 *     commit/reveal; overpayment is refunded by the contract.
 *   - Names hang off ROOT_NODE = bytes32(0):
 *       node = keccak256(abi.encodePacked(ROOT_NODE, keccak256(label)))
 *   - Registry.owner(node) -> current owner (zero address = unregistered)
 *   - Registrar.expiryOf(node) -> term expiry (terms are 2 years, renewals free)
 *   - Payment is the chain's native token (USDC on Arc, 18 decimals here).
 */
(function () {
  "use strict";
  var CFG = window.OWNERSHIP_CONFIG;

  var REGISTRY_ABI = [
    "function owner(bytes32 node) view returns (address)"
  ];
  var REGISTRAR_ABI = [
    "function available(string label) view returns (bool)",
    "function quoteFor(string label, address account) view returns (uint256 tierPrice, uint256 fee)",
    "function bulkPriceOf(address account) view returns (uint256)",
    "function expiryOf(bytes32 node) view returns (uint64)",
    "function register(string label, address newOwner) payable"
  ];

  var readProvider = new ethers.JsonRpcProvider(CFG.RPC_URL);
  var registry = new ethers.Contract(CFG.REGISTRY_ADDRESS, REGISTRY_ABI, readProvider);
  var registrar = new ethers.Contract(CFG.REGISTRAR_ADDRESS, REGISTRAR_ABI, readProvider);

  // Wallet state: { kind: 'metamask' | 'walletconnect', provider (BrowserProvider),
  //                 signer, address }
  var wallet = null;
  // Last lookup: { label, available, node }
  var lastLookup = null;

  var $ = function (id) { return document.getElementById(id); };
  var connectBtn = $("connect-btn"), connectPanel = $("connect-panel"), connectNote = $("connect-note");
  var lookupForm = $("lookup-form"), labelInput = $("label-input"), lookupBtn = $("lookup-btn");
  var resultBox = $("lookup-result"), registerPanel = $("register-panel");
  var registerPrice = $("register-price"), registerBtn = $("register-btn"), registerStatus = $("register-status");

  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function fmtUsdc(wei) {
    var s = ethers.formatEther(wei);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, ".0");
    return s + " USDC";
  }
  function nodeForLabel(label) {
    var labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
    // ROOT_NODE is bytes32(0) in both Registry and Registrar (see contracts/*.sol).
    return ethers.keccak256(ethers.concat([ethers.ZeroHash, labelHash]));
  }
  function errText(e) {
    if (!e) return "unknown error";
    if (e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001)) return "You rejected the request in your wallet.";
    if (e.shortMessage) return e.shortMessage;
    if (e.reason) return e.reason;
    return e.message || String(e);
  }
  function contractErrText(e) {
    var m = errText(e);
    if (m.indexOf("NameLocked") >= 0) return "That name is locked (1–2 character names can't be registered).";
    if (m.indexOf("AlreadyRegistered") >= 0) return "That name was just registered by someone else.";
    if (m.indexOf("InsufficientPayment") >= 0) return "The price changed before the transaction went through — look the name up again for a fresh quote.";
    if (m.indexOf("LabelTooLong") >= 0) return "That name is too long.";
    if (m.indexOf("CALL_EXCEPTION") >= 0) return "The contract rejected the transaction. Look the name up again and retry.";
    return m;
  }

  /* ---------------- Wallet connection ---------------- */

  function wcConfigured() {
    return CFG.REOWN_PROJECT_ID && CFG.REOWN_PROJECT_ID !== "REPLACE_ME" &&
      window.OwnershipWC && typeof window.OwnershipWC.init === "function";
  }
  if (wcConfigured()) {
    try {
      window.OwnershipWC.init(CFG.REOWN_PROJECT_ID, {
        chainId: CFG.CHAIN_ID, chainName: CFG.CHAIN_NAME,
        rpcUrl: CFG.RPC_URL, explorerUrl: CFG.EXPLORER_URL
      });
    } catch (e) { /* WalletConnect stays off; MetaMask path unaffected. */ }
  }

  function refreshConnectButton() {
    if (wallet) {
      connectBtn.textContent = shortAddr(wallet.address) + " — Disconnect";
      connectPanel.classList.add("hidden");
    } else {
      connectBtn.textContent = "Connect Wallet";
    }
  }

  async function ensureArcNetwork(eip1193) {
    var chainIdHex = await eip1193.request({ method: "eth_chainId" });
    if (parseInt(chainIdHex, 16) === CFG.CHAIN_ID) return;
    try {
      await eip1193.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CFG.CHAIN_ID.toString(16) }]
      });
    } catch (switchErr) {
      // 4902 = chain not added yet: offer to add Arc Testnet, then switch.
      if (switchErr && (switchErr.code === 4902 || (switchErr.data && switchErr.data.originalError && switchErr.data.originalError.code === 4902))) {
        await eip1193.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + CFG.CHAIN_ID.toString(16),
            chainName: CFG.CHAIN_NAME,
            nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
            rpcUrls: [CFG.RPC_URL],
            blockExplorerUrls: [CFG.EXPLORER_URL]
          }]
        });
      } else {
        throw switchErr;
      }
    }
  }

  async function adoptProvider(eip1193, kind) {
    await ensureArcNetwork(eip1193);
    var provider = new ethers.BrowserProvider(eip1193);
    var signer = await provider.getSigner();
    var address = await signer.getAddress();
    // Re-check the network after any switch/add.
    var net = await provider.getNetwork();
    if (Number(net.chainId) !== CFG.CHAIN_ID) {
      throw new Error("Your wallet is not on Arc Testnet yet. Switch networks and try again.");
    }
    wallet = { kind: kind, eip1193: eip1193, provider: provider, signer: signer, address: address };
    refreshConnectButton();
    if (lastLookup && lastLookup.available) showRegisterPanel(lastLookup.label);
    if (eip1193 && typeof eip1193.on === "function") {
      eip1193.on("accountsChanged", function () { disconnectWallet(); });
      eip1193.on("chainChanged", function () { window.location.reload(); });
    }
  }

  async function connectInjected() {
    connectNote.textContent = "";
    if (!window.ethereum) {
      connectNote.textContent = "No browser wallet found. On a phone, use the WalletConnect option, or open this page inside the MetaMask app's browser.";
      return;
    }
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await adoptProvider(window.ethereum, "metamask");
    } catch (e) {
      connectNote.textContent = errText(e);
    }
  }

  async function connectWalletConnect() {
    connectNote.textContent = "";
    if (!wcConfigured()) {
      connectNote.textContent = "WalletConnect isn't switched on for this copy of the page yet (no Reown project ID configured). The MetaMask option works now.";
      return;
    }
    try {
      var eip1193 = await window.OwnershipWC.connect();
      await adoptProvider(eip1193, "walletconnect");
    } catch (e) {
      connectNote.textContent = errText(e);
    }
  }

  async function disconnectWallet() {
    if (wallet && wallet.kind === "walletconnect" && window.OwnershipWC) {
      try { await window.OwnershipWC.disconnect(); } catch (e) { /* already gone */ }
    }
    wallet = null;
    refreshConnectButton();
    registerStatus.textContent = "";
    if (lastLookup && lastLookup.available) showRegisterPanel(lastLookup.label);
  }

  connectBtn.addEventListener("click", function () {
    if (wallet) { disconnectWallet(); return; }
    connectPanel.classList.toggle("hidden");
  });
  $("connect-metamask").addEventListener("click", connectInjected);
  $("connect-walletconnect").addEventListener("click", connectWalletConnect);

  /* ---------------- Lookup + register ---------------- */

  function normalizeLabel(raw) {
    var label = (raw || "").trim().toLowerCase();
    if (label.slice(-4) === ".arc") label = label.slice(0, -4);
    return label;
  }

  async function quote(label, account) {
    var q = await registrar.quoteFor(label, account);
    var bulk = await registrar.bulkPriceOf(account);
    var total = q[0] + q[1] + bulk;
    return { tierPrice: q[0], fee: q[1], bulk: bulk, total: total };
  }

  function hideRegister() { registerPanel.classList.add("hidden"); }

  async function showRegisterPanel(label) {
    var account = wallet ? wallet.address : ethers.ZeroAddress;
    var q;
    try {
      q = await quote(label, account);
    } catch (e) {
      hideRegister();
      return;
    }
    var parts = [];
    if (q.total === 0n) {
      registerPrice.innerHTML = "<strong>Price: free</strong> for this name" + (wallet ? "" : " (connect a wallet to register)") + ".";
    } else {
      parts.push("name price " + fmtUsdc(q.tierPrice));
      if (q.fee > 0n) parts.push("matching fee " + fmtUsdc(q.fee));
      if (q.bulk > 0n) parts.push("bulk surcharge " + fmtUsdc(q.bulk));
      registerPrice.innerHTML = "<strong>Price: " + fmtUsdc(q.total) + "</strong> (" + parts.join(" + ") + "), testnet USDC. Gas is extra.";
    }
    registerPanel.classList.remove("hidden");
    registerBtn.disabled = !wallet;
    registerStatus.textContent = wallet ? "" : "Connect your wallet (top right) to register this name.";
  }

  async function doLookup(ev) {
    ev.preventDefault();
    var label = normalizeLabel(labelInput.value);
    hideRegister();
    registerStatus.textContent = "";
    resultBox.classList.remove("hidden");
    if (label.length < 3) {
      resultBox.innerHTML = "<p class='err'>Names are at least 3 characters — 1–2 character names are locked.</p>";
      lastLookup = null;
      return;
    }
    if (label.length > 64) {
      resultBox.innerHTML = "<p class='err'>That name is too long.</p>";
      lastLookup = null;
      return;
    }
    lookupBtn.disabled = true;
    resultBox.innerHTML = "<p>Checking <strong>" + label + ".arc</strong> on Arc testnet…</p>";
    try {
      var node = nodeForLabel(label);
      var isAvailable = await registrar.available(label);
      if (isAvailable) {
        lastLookup = { label: label, available: true, node: node };
        resultBox.innerHTML = "<p class='status-available'>✓ " + label + ".arc is available.</p>";
        showRegisterPanel(label);
      } else {
        var owner = await registry.owner(node);
        var expiry = await registrar.expiryOf(node);
        lastLookup = { label: label, available: false, node: node };
        var when = expiry > 0n
          ? new Date(Number(expiry) * 1000).toISOString().slice(0, 10)
          : "unknown";
        resultBox.innerHTML =
          "<p class='status-taken'>✗ " + label + ".arc is taken.</p>" +
          "<p>Owner: <span class='mono'>" + owner + "</span><br>Term expires (UTC): " + when + " — renewals are free for the owner.</p>";
      }
    } catch (e) {
      lastLookup = null;
      resultBox.innerHTML = "<p class='err'>Lookup failed: " + contractErrText(e) + "</p>";
    } finally {
      lookupBtn.disabled = false;
    }
  }
  lookupForm.addEventListener("submit", doLookup);

  registerBtn.addEventListener("click", async function () {
    if (!wallet || !lastLookup || !lastLookup.available) return;
    var label = lastLookup.label;
    registerBtn.disabled = true;
    registerStatus.textContent = "Re-checking availability and price…";
    try {
      // Fresh reads right before building the transaction: the name may have
      // been taken, or the account-priced quote may have changed.
      var still = await registrar.available(label);
      if (!still) throw new Error("That name was just taken. Look it up again.");
      var q = await quote(label, wallet.address);
      var registrarSigned = new ethers.Contract(CFG.REGISTRAR_ADDRESS, REGISTRAR_ABI, wallet.signer);
      registerStatus.textContent = "Your wallet will ask you to confirm registering " + label + ".arc for " + fmtUsdc(q.total) + " (testnet).";
      var tx = await registrarSigned.register(label, wallet.address, { value: q.total });
      registerStatus.innerHTML = "Transaction sent — waiting for confirmation… <span class='mono'>" + tx.hash + "</span>";
      var receipt = await tx.wait();
      registerStatus.innerHTML =
        "✓ <strong>" + label + ".arc is yours.</strong> Registered to <span class='mono'>" + wallet.address +
        "</span> on Arc testnet. Tx: <a href='" + CFG.EXPLORER_URL + "/tx/" + receipt.hash + "'>" + receipt.hash + "</a>";
      // Refresh the lookup panel to the new reality.
      lastLookup.available = false;
      hideRegister();
      resultBox.innerHTML = "<p class='status-taken'>✗ " + label + ".arc is taken — by you. Welcome aboard.</p>";
    } catch (e) {
      registerStatus.textContent = "Registration failed: " + contractErrText(e);
    } finally {
      registerBtn.disabled = false;
    }
  });

  refreshConnectButton();
})();
