(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  try {
    const t = JSON.parse(localStorage.getItem("nx_theme"));
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}

  // ---- Defaults (the server sends the real list, minimum and fees from /api/withdraw-options) ----
  let MIN_SATS = 10000;
  let OPTIONS = [
    {
      id: "btc",
      label: "Bitcoin (BTC)",
      coin: "BTC",
      network: "Bitcoin",
      fee: 1500,
      hint: "bc1q… or 1… or 3…",
    },
  ];
  const DEMO_BALANCE = 0; // shown until the real balance arrives from the server
  let price = 65000; // BTC/USD, updated live below

  // Address format per option (the server checks again; this just gives instant feedback)
  const EVM = /^0x[a-fA-F0-9]{40}$/;
  const ADDR = {
    btc: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
    usdt_trc20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    usdt_erc20: EVM,
    usdt_bep20: EVM,
    eth: EVM,
  };

  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const btcStr = (s) => (s / 1e8).toFixed(8);
  const usdStr = (s) =>
    "$" +
    ((s / 1e8) * price).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // The balance is read from shared storage (NX), which NXAPI.sync() fills from the server.
  const balance = () => {
    const b = NX.get().balanceSats;
    return typeof b === "number" ? b : DEMO_BALANCE;
  };

  let coinId = "btc",
    pendingTx = null;
  const opt = () => OPTIONS.find((o) => o.id === coinId) || OPTIONS[0];
  const labelOf = (id) => {
    const o = OPTIONS.find((x) => x.id === id);
    return o ? o.label : id === "bank" ? "bank account (old)" : id;
  };

  const toast = (m) => {
    const t = $("wdToast");
    t.textContent = m;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  };
  const row = (a, b, cls) =>
    '<div class="wd-row' +
    (cls ? " " + cls : "") +
    '"><span>' +
    a +
    "</span><span>" +
    b +
    "</span></div>";
  const amountVal = () =>
    parseInt(($("wdAmount").value || "").replace(/[^\d]/g, ""), 10) || 0;
  const addrVal = () => ($("wdAddr") ? $("wdAddr").value.trim() : "");

  function renderBalance() {
    const b = balance();
    $("wdSats").textContent = fmt(b) + " sats";
    $("wdBtc").textContent = "₿ " + btcStr(b);
    $("wdUsd").textContent = "≈ " + usdStr(b);
  }

  function renderCoins() {
    $("wdCoin").innerHTML = OPTIONS.map(
      (o) =>
        '<option value="' +
        esc(o.id) +
        '"' +
        (o.id === coinId ? " selected" : "") +
        ">" +
        esc(o.label) +
        "</option>",
    ).join("");
  }

  function renderDest() {
    const o = opt();
    $("wdDest").innerHTML =
      '<label class="wd-label" style="margin-top:0" for="wdAddr">' +
      esc(o.coin) +
      " wallet address (" +
      esc(o.network) +
      ')</label><input class="wd-input" id="wdAddr" type="text" placeholder="' +
      esc(o.hint) +
      '" autocomplete="off" spellcheck="false" />' +
      '<p class="wd-warn">Only send to a ' +
      esc(o.coin) +
      " address on the <strong>" +
      esc(o.network) +
      "</strong> network. Funds sent to the wrong network are lost.</p>";
    $("wdAddr").addEventListener("input", update);
    // Fill in the address saved in the profile for this currency, if there is one
    const saved = (NX.get().wallets || {})[o.id];
    if (saved) $("wdAddr").value = saved;
  }

  function calc() {
    const o = opt();
    const amt = amountVal(),
      fee = o.fee,
      b = balance();
    let err = "";
    if (!amt) err = "";
    else if (amt < MIN_SATS)
      err = "Minimum withdrawal is " + fmt(MIN_SATS) + " sats";
    else if (amt > b) err = "That's more than your available balance";
    else if (amt <= fee) err = "Amount must be more than the network fee";
    const a = addrVal();
    const re = ADDR[o.id];
    const destOk = re ? re.test(a) : a.length > 10;
    if (a && !destOk && !err)
      err = "Enter a valid " + o.coin + " address (" + o.network + ")";
    return {
      amt,
      fee,
      receive: Math.max(amt - fee, 0),
      ok: !!amt && !err && destOk,
      err,
    };
  }

  function update() {
    const c = calc();
    const o = opt();
    $("wdErr").textContent = c.err;
    $("wdSummary").innerHTML =
      row("Amount", fmt(c.amt) + " sats") +
      row("Network fee", fmt(c.fee) + " sats") +
      row("You receive", fmt(c.receive) + " sats", "total") +
      row("Paid out as", esc(o.label)) +
      row("Estimated value", "≈ " + usdStr(c.receive));
    $("wdContinue").disabled = !c.ok;
  }

  function renderHistory() {
    const list = (NX.get().transactions || [])
      .filter((t) => t.type === "withdrawal")
      .slice(0, 3);
    $("wdHistory").innerHTML = list.length
      ? list
          .map(
            (t) =>
              "<li><div><strong>To " +
              esc(labelOf(t.method)) +
              "</strong><small>" +
              esc(t.dest) +
              " · " +
              new Date(t.date).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              }) +
              '</small></div><div class="amt">−' +
              fmt(t.sats) +
              ' sats<br><span class="wd-badge">' +
              esc(t.status) +
              "</span></div></li>",
          )
          .join("")
      : '<li class="wd-empty">No withdrawals yet.</li>';
  }

  // ---- events ----
  $("wdCoin").addEventListener("change", (e) => {
    coinId = e.target.value;
    renderDest();
    update();
  });

  $("wdAmount").addEventListener("input", (e) => {
    const n = e.target.value.replace(/[^\d]/g, "");
    e.target.value = n ? Number(n).toLocaleString("en-US") : "";
    update();
  });
  $("wdQuick").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $("wdAmount").value = fmt(
      Math.floor(balance() * (Number(b.dataset.p) / 100)),
    );
    update();
  });

  $("wdContinue").onclick = () => {
    const c = calc();
    if (!c.ok) return;
    const o = opt();
    const a = addrVal();
    pendingTx = {
      method: o.id,
      sats: c.amt,
      fee: c.fee,
      receive: c.receive,
      address: a,
      short: a.slice(0, 8) + "…" + a.slice(-6),
    };
    $("wdSheetSummary").innerHTML =
      row("Currency", esc(o.coin)) +
      row("Network", esc(o.network)) +
      row("To", esc(pendingTx.short)) +
      row("Amount", fmt(c.amt) + " sats") +
      row("Network fee", fmt(c.fee) + " sats") +
      row("You receive", fmt(c.receive) + " sats", "total") +
      row("Estimated value", "≈ " + usdStr(c.receive));
    $("wdSheetWarn").textContent =
      "Crypto transfers can't be reversed. Check the address and that it is on the " +
      o.network +
      " network." +
      (o.coin === "BTC"
        ? ""
        : " You'll be paid in " +
          o.coin +
          " at the rate when your request is processed.");
    $("wdSheet").hidden = false;
  };
  $("wdCancel").onclick = () => ($("wdSheet").hidden = true);
  $("wdSheet").addEventListener("click", (e) => {
    if (e.target.id === "wdSheet") $("wdSheet").hidden = true;
  });

  $("wdConfirm").onclick = async () => {
    if (!pendingTx) return;
    $("wdConfirm").disabled = true;
    try {
      const r = await NXAPI.withdraw({
        method: pendingTx.method,
        sats: pendingTx.sats,
        address: pendingTx.address,
      });
      const tx = r.withdrawal;
      pendingTx = null;
      $("wdSheet").hidden = true;
      $("wdSuccessText").textContent =
        "Your request is being processed. We'll send it shortly.";
      $("wdSuccessSummary").innerHTML =
        row("To", esc(tx.dest)) +
        row("Paid out as", esc(labelOf(tx.method))) +
        row("You receive", fmt(tx.receive) + " sats", "total") +
        row("Reference", esc(tx.id)) +
        row("Status", esc(tx.status));
      $("wdForm").hidden = true;
      $("wdSuccess").hidden = false;
      await NXAPI.sync();
      renderBalance();
      renderHistory();
      window.scrollTo(0, 0);
    } catch (e) {
      toast(e.message);
    } finally {
      $("wdConfirm").disabled = false;
    }
  };

  $("wdHome").onclick = () => NX.go("home");
  $("wdBack").onclick = () => NX.go("home");
  $("wdAgain").onclick = () => {
    $("wdSuccess").hidden = true;
    $("wdForm").hidden = false;
    $("wdAmount").value = "";
    renderBalance();
    renderDest();
    update();
    renderHistory();
  };

  // ---- go ----
  renderCoins();
  renderBalance();
  renderDest();
  update();
  renderHistory();

  // Real balance and withdrawal history from the server
  NXAPI.sync()
    .then(() => {
      renderBalance();
      if (!addrVal()) renderDest(); // picks up the saved wallet address
      update();
      renderHistory();
    })
    .catch(() => {});

  // The currencies, fees and minimum come from the server so they always match what it enforces
  NXAPI.api("/api/withdraw-options")
    .then((j) => {
      if (j && Array.isArray(j.options) && j.options.length) {
        OPTIONS = j.options;
        MIN_SATS = j.minSats || MIN_SATS;
        if (!OPTIONS.some((o) => o.id === coinId)) coinId = OPTIONS[0].id;
        renderCoins();
        if (!addrVal()) renderDest(); // don't wipe an address the user already typed
        update();
        renderHistory();
      }
    })
    .catch(() => {});

  // Live BTC price (falls back to the default above if the request fails)
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 4000);
    fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      signal: ctl.signal,
    })
      .then((r) => r.json())
      .then((j) => {
        const p = parseFloat(j.data.amount);
        if (p > 0) {
          price = p;
          renderBalance();
          update();
        }
      })
      .catch(() => {});
  } catch (e) {}
})();
