(function () {
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  const I = {
    bank: '<path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
    shield:
      '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><circle cx="12" cy="11" r="1.5"/><path d="M12 12.5V15"/>',
    scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
    theme:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
    people:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.5 3-5 6-5s6 1.5 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4 1.5 4 4"/>',
    logout:
      '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    invest: '<path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/>',
    widget:
      '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><path d="M17 14v6M14 17h6"/>',
    switch: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
    wallet:
      '<path d="M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h14V9H5a2 2 0 0 1-2-2zM16 14h2"/>',
  };
  const svg = (k) =>
    '<svg viewBox="0 0 24 24" aria-hidden="true">' + I[k] + "</svg>";
  const chev =
    '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const money = (n) =>
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // ---- Real account data (comes from the server through NXAPI.sync) ----
  const btcFmt = (n) =>
    Number(n).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0");
  const satsFmt = (n) => Number(n || 0).toLocaleString("en-US");
  const dateFmt = (iso) => {
    const d = new Date(iso);
    return isNaN(d)
      ? ""
      : d.toLocaleDateString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        });
  };

  // Live Bitcoin price (CoinGecko). Cached for a minute; stays null if it can't be reached.
  const priceInfo = { price: null, chg24: null, at: 0 };
  async function loadPrice() {
    if (priceInfo.price && Date.now() - priceInfo.at < 60000) return priceInfo;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
        { signal: ctl.signal },
      );
      clearTimeout(timer);
      if (!r.ok) throw new Error("price failed");
      const j = await r.json();
      priceInfo.price = j.bitcoin.usd;
      priceInfo.chg24 = j.bitcoin.usd_24h_change;
      priceInfo.at = Date.now();
    } catch (e) {}
    return priceInfo;
  }

  // The user's real balance and deposit history
  const investments = () => {
    const U = NX.get();
    const sats = Number(U.balanceSats) || 0;
    const deposits = (U.transactions || []).filter((t) => t.type === "deposit");
    return {
      sats,
      btc: sats / 100_000_000,
      price: priceInfo.price,
      chg24: priceInfo.chg24,
      deposits,
    };
  };

  let sheetKind = ""; // which sheet is open, so late data only updates the right one

  function doLogout() {
    // End the session on the server too, then clear it in this browser
    NXAPI.api("/api/logout", { method: "POST", noRedirect: true })
      .catch(() => {})
      .finally(() => NXAPI.logout());
  }

  // ---- Settings sections ----
  const SECTIONS = [
    {
      title: "Account",
      items: [
        {
          id: "invest",
          icon: "invest",
          color: "#1414ff",
          title: "My Bitcoin",
          desc: "View your Bitcoin balance and purchases",
          chev: true,
        },
        {
          id: "wallets",
          icon: "wallet",
          color: "#1fae4b",
          title: "Wallet Details",
          desc: "Save your crypto withdrawal addresses",
          chev: true,
        },
        {
          id: "switch",
          icon: "switch",
          color: "#0b7285",
          title: "Switch Account",
          desc: "Move between your Nexvest accounts",
          chev: true,
        },
      ],
    },
    {
      title: "Security",
      items: [
        {
          id: "pin",
          icon: "shield",
          color: "#8f0d0d",
          title: "PIN Management",
          desc: "Update or reset your transaction PIN",
          chev: true,
        },
        {
          id: "password",
          icon: "shield",
          color: "#e09400",
          title: "Password Management",
          desc: "Change your login password securely",
          chev: true,
        },
        {
          id: "bio",
          icon: "scan",
          color: "#1b0f9e",
          title: "Login with Biometrics",
          desc: "Enable Face ID or fingerprint login",
          toggle: "nx_bio",
          def: false,
        },
        {
          id: "autobio",
          icon: "scan",
          color: "#1b0f9e",
          title: "Auto Login with Biometrics",
          desc: "Enable automatic login using biometrics",
          toggle: "nx_autobio",
          def: false,
        },
      ],
    },
    {
      title: "Preferences",
      items: [
        {
          id: "theme",
          icon: "theme",
          color: "#4a4a4a",
          title: "App Theme",
          desc: "Switch between light and dark modes",
          chev: true,
        },
        {
          id: "widget",
          icon: "widget",
          color: "#14a368",
          title: "Home Screen Widget",
          desc: "Show your Bitcoin balance on your home screen",
          chev: true,
        },
      ],
    },
    {
      title: "More",
      items: [
        {
          id: "referrals",
          icon: "people",
          color: "#800080",
          title: "Referrals",
          desc: "See the people you have referred",
          chev: true,
        },
      ],
    },
  ];

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 1800);
  };

  function rowHTML(it) {
    let right = "";
    if (it.toggle)
      right =
        '<span class="switch" role="switch" aria-checked="' +
        store.get(it.toggle, it.def) +
        '"></span>';
    else if (it.chev) right = chev;
    return (
      '<button class="row" type="button" data-id="' +
      it.id +
      '">' +
      '<span class="tile" style="background:' +
      it.color +
      '">' +
      svg(it.icon) +
      "</span>" +
      '<span class="row-copy"><span class="row-title">' +
      it.title +
      '</span><span class="row-desc">' +
      it.desc +
      "</span></span>" +
      right +
      "</button>"
    );
  }

  $("sections").innerHTML = SECTIONS.map(
    (s) =>
      '<section class="section"><p class="group-label">' +
      s.title +
      '</p><div class="card group">' +
      s.items.map(rowHTML).join("") +
      "</div></section>",
  ).join("");

  $("logoutRow").innerHTML =
    '<span class="tile" style="background:#8f0d0d">' +
    svg("logout") +
    '</span><span class="row-copy"><span class="row-title">Logout</span><span class="row-desc">Sign out of your account securely</span></span>' +
    chev;
  $("closeRow").innerHTML =
    '<span class="tile" style="background:#8f0d0d">' +
    svg("trash") +
    '</span><span class="row-copy"><span class="row-title">Close or Disable my Account</span><span class="row-desc">Permanently close or temporarily disable your account</span></span>' +
    chev;

  // ---- Back arrow: return to the previous page, or Home if there is no history ----
  function goBack() {
    if (history.length > 1) {
      history.back();
    } else {
      try {
        NX.go("home");
      } catch (e) {
        location.href = "home.html";
      }
    }
  }
  $("backBtn").onclick = goBack;

  // ---- Theme ----
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
  }
  applyTheme(store.get("nx_theme", "light"));

  // ---- Confirm modal ----
  let onOk = null;
  function confirmBox(title, text, okLabel, fn) {
    $("modalTitle").textContent = title;
    $("modalText").textContent = text;
    $("modalOk").textContent = okLabel;
    onOk = fn;
    $("modal").hidden = false;
  }
  $("modalCancel").onclick = () => ($("modal").hidden = true);
  $("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") $("modal").hidden = true;
  });
  $("modalOk").onclick = () => {
    $("modal").hidden = true;
    onOk && onOk();
  };

  // ---- Bottom sheet ----
  function openSheet(title, html, after) {
    $("sheetTitle").textContent = title;
    $("sheetBody").innerHTML = html;
    $("sheet").hidden = false;
    $("sheetBody").scrollTop = 0;
    after && after($("sheetBody"));
  }
  function closeSheet() {
    $("sheet").hidden = true;
    sheetKind = "";
  }
  $("sheetClose").onclick = closeSheet;
  $("sheet").addEventListener("click", (e) => {
    if (e.target.id === "sheet") closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("sheet").hidden) closeSheet();
  });

  // ---- My Bitcoin (real balance + deposits) ----
  function showInvestments() {
    const html = () => {
      const d = investments();
      const usd = d.price == null ? null : d.btc * d.price;
      const confirmed = d.deposits.filter((x) => x.status === "Confirmed");
      const totalDep = confirmed.reduce((n, x) => n + x.sats, 0);
      const rows = d.deposits
        .slice(0, 10)
        .map(
          (h) =>
            '<div class="list-row"><span class="coin btc">₿</span>' +
            '<span class="row-copy"><span class="row-title">Deposit</span><span class="row-desc">' +
            esc(dateFmt(h.date)) +
            "</span></span>" +
            '<span class="amt"><strong>' +
            satsFmt(h.sats) +
            " sats</strong>" +
            '<span class="tag ' +
            (h.status === "Confirmed" ? "ok" : "wait") +
            '">' +
            esc(h.status) +
            "</span></span></div>",
        )
        .join("");
      const chg = d.chg24;
      return (
        '<div class="invest-hero"><span>Bitcoin balance</span><strong>' +
        (usd == null ? "—" : money(usd)) +
        "</strong>" +
        "<span>" +
        btcFmt(d.btc) +
        " BTC</span>" +
        "<span>" +
        satsFmt(d.sats) +
        " sats</span></div>" +
        '<div class="stat-grid">' +
        '<div class="stat"><span>BTC price</span><strong>' +
        (d.price == null ? "—" : money(d.price)) +
        "</strong>" +
        (chg == null
          ? ""
          : '<small class="' +
            (chg >= 0 ? "pos" : "neg") +
            '">' +
            (chg >= 0 ? "+" : "") +
            chg.toFixed(2) +
            "% 24h</small>") +
        "</div>" +
        '<div class="stat"><span>Confirmed deposits</span><strong>' +
        satsFmt(totalDep) +
        " sats</strong></div>" +
        '<div class="stat"><span>Deposits</span><strong>' +
        d.deposits.length +
        "</strong></div>" +
        '<div class="stat"><span>Pending</span><strong>' +
        (d.deposits.length - confirmed.length) +
        "</strong></div>" +
        "</div>" +
        '<p class="group-label">Recent deposits</p><div class="card group list">' +
        (rows || '<p class="empty">No deposits yet.</p>') +
        "</div>"
      );
    };
    openSheet("My Bitcoin", html());
    sheetKind = "invest";
    const redraw = () => {
      if (sheetKind === "invest") $("sheetBody").innerHTML = html();
    };
    NXAPI.sync()
      .then(redraw)
      .catch(() => {});
    loadPrice().then(redraw);
  }

  // ---- PIN management ----
  function showPin() {
    const hasPin = !!NX.get().hasPin;
    openSheet(
      "PIN Management",
      '<p class="hint">' +
        (hasPin
          ? "Enter your current PIN, then choose a new 4-digit PIN."
          : "You have not set a transaction PIN yet. Choose a 4-digit PIN.") +
        "</p>" +
        '<form id="pinForm" autocomplete="off">' +
        (hasPin
          ? '<label class="field"><span>Current PIN</span><input id="pinCur" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="••••" /></label>'
          : "") +
        '<label class="field"><span>New PIN</span><input id="pinNew" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="••••" /></label>' +
        '<label class="field"><span>Confirm new PIN</span><input id="pinCon" type="password" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="••••" /></label>' +
        '<p class="form-err" id="pinErr" role="alert"></p>' +
        '<button class="pill-button primary" type="submit">' +
        (hasPin ? "Update PIN" : "Set PIN") +
        "</button>" +
        "</form>",
      (body) => {
        body
          .querySelectorAll("input")
          .forEach((i) =>
            i.addEventListener(
              "input",
              () => (i.value = i.value.replace(/\D/g, "").slice(0, 4)),
            ),
          );
        $("pinForm").onsubmit = async (e) => {
          e.preventDefault();
          const err = $("pinErr");
          err.textContent = "";
          const cur = hasPin ? $("pinCur").value : "";
          const nw = $("pinNew").value;
          const con = $("pinCon").value;
          if (hasPin && !/^\d{4}$/.test(cur))
            return (err.textContent = "Enter your current 4-digit PIN.");
          if (!/^\d{4}$/.test(nw))
            return (err.textContent = "New PIN must be exactly 4 digits.");
          if (/^(\d)\1{3}$/.test(nw) || nw === "1234" || nw === "4321")
            return (err.textContent = "Choose a PIN that is harder to guess.");
          if (nw !== con) return (err.textContent = "PINs do not match.");
          try {
            await NXAPI.setPin(nw, hasPin ? cur : undefined);
            NX.update({ hasPin: true });
            closeSheet();
            toast(hasPin ? "PIN updated" : "PIN set");
          } catch (x) {
            err.textContent = x.message;
          }
        };
      },
    );
  }

  // ---- Password management ----
  function strength(p) {
    let s = 0;
    if (p.length >= 8) s++;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return s;
  }
  function showPassword() {
    openSheet(
      "Password Management",
      '<p class="hint">Use at least 8 characters with upper and lower case letters, a number and a symbol.</p>' +
        '<form id="pwForm" autocomplete="off">' +
        '<label class="field"><span>Current password</span><input id="pwCur" type="password" placeholder="Current password" /></label>' +
        '<label class="field"><span>New password</span><input id="pwNew" type="password" placeholder="New password" /></label>' +
        '<div class="meter"><i id="pwBar"></i></div><p class="meter-label" id="pwLabel">&nbsp;</p>' +
        '<label class="field"><span>Confirm new password</span><input id="pwCon" type="password" placeholder="Confirm new password" /></label>' +
        '<label class="show-pw"><input id="pwShow" type="checkbox" /> Show passwords</label>' +
        '<p class="form-err" id="pwErr" role="alert"></p>' +
        '<button class="pill-button primary" type="submit">Change password</button>' +
        "</form>",
      () => {
        const labels = ["Too weak", "Weak", "Fair", "Good", "Strong"];
        const colors = ["#d01f1f", "#e0302e", "#e09400", "#2eb487", "#1f9d6b"];
        $("pwNew").addEventListener("input", () => {
          const v = $("pwNew").value;
          const s = v ? strength(v) : 0;
          $("pwBar").style.width = (v ? Math.max(1, s) * 25 : 0) + "%";
          $("pwBar").style.background = colors[s];
          $("pwLabel").textContent = v ? labels[s] : " ";
        });
        $("pwShow").onchange = (e) => {
          ["pwCur", "pwNew", "pwCon"].forEach(
            (id) => ($(id).type = e.target.checked ? "text" : "password"),
          );
        };
        $("pwForm").onsubmit = async (e) => {
          e.preventDefault();
          const err = $("pwErr");
          err.textContent = "";
          const cur = $("pwCur").value,
            nw = $("pwNew").value,
            con = $("pwCon").value;
          if (!cur) return (err.textContent = "Enter your current password.");
          if (strength(nw) < 4 || nw.length < 8)
            return (err.textContent =
              "New password does not meet the requirements.");
          if (nw === cur)
            return (err.textContent =
              "New password must be different from the current one.");
          if (nw !== con) return (err.textContent = "Passwords do not match.");
          const btn = e.target.querySelector('button[type="submit"]');
          btn.disabled = true;
          try {
            // The server checks the current password and saves the new one
            await NXAPI.api("/api/password", {
              method: "PUT",
              body: { currentPassword: cur, newPassword: nw },
            });
            closeSheet();
            toast("Password changed");
          } catch (x) {
            err.textContent = x.message;
          } finally {
            btn.disabled = false;
          }
        };
      },
    );
  }

  // ---- Switch account (one real account per login) ----
  function showSwitch() {
    const U = NX.get();
    const name = NX.displayName(U) || U.username || "My account";
    openSheet(
      "Switch Account",
      '<p class="hint">You are signed in as this account.</p>' +
        '<div class="card group list"><div class="list-row acct">' +
        '<span class="avatar sm">' +
        esc(NX.initials(U)) +
        "</span>" +
        '<span class="row-copy"><span class="row-title">' +
        esc(name) +
        '</span><span class="row-desc">' +
        esc(U.email || "") +
        "</span></span>" +
        '<span class="radio on"></span></div></div>' +
        '<button class="pill-button" id="addAcct" type="button">Sign in with another account</button>',
      () => {
        $("addAcct").onclick = () => {
          closeSheet();
          confirmBox(
            "Sign out?",
            "You will be signed out so you can log in with a different account.",
            "Sign out",
            doLogout,
          );
        };
      },
    );
  }

  // ---- Referrals (real data from the server) ----
  function copyText(text, msg) {
    const done = () => toast(msg);
    if (navigator.clipboard)
      navigator.clipboard.writeText(text).then(done, done);
    else done();
  }

  function showReferrals() {
    openSheet("Referrals", '<p class="empty">Loading…</p>');
    sheetKind = "referrals";
    Promise.all([
      NXAPI.referral().catch(() => null),
      NXAPI.api("/api/referrals").catch(() => []),
    ]).then(([info, list]) => {
      if (sheetKind !== "referrals") return;
      const code = (info && info.code) || NX.get().referralCode || "";
      const count = info ? info.referred : list.length;
      const earned = info ? info.earnedSats : 0;
      const rows = list.length
        ? list
            .map(
              (r) =>
                '<div class="list-row"><span class="avatar sm">' +
                esc((r.name || "?").slice(0, 2).toUpperCase()) +
                "</span>" +
                '<span class="row-copy"><span class="row-title">' +
                esc(r.name) +
                '</span><span class="row-desc">Joined ' +
                esc(dateFmt(r.joined)) +
                "</span></span>" +
                '<span class="amt"><span class="tag ' +
                (r.status === "Active" ? "ok" : "wait") +
                '">' +
                esc(r.status) +
                "</span>" +
                "<small>" +
                (r.bonusSats ? "+" + satsFmt(r.bonusSats) + " sats" : "—") +
                "</small></span></div>",
            )
            .join("")
        : '<p class="empty">No referrals yet. Share your code to get started.</p>';
      $("sheetBody").innerHTML =
        '<div class="invest-hero"><span>Your referral code</span><strong class="code">' +
        esc(code || "—") +
        "</strong>" +
        '<button class="pill-button light" id="copyCode" type="button">Copy code</button>' +
        (info && info.link
          ? '<button class="pill-button light" id="copyRefLink" type="button">Copy link</button>'
          : "") +
        "</div>" +
        '<div class="stat-grid">' +
        '<div class="stat"><span>People referred</span><strong>' +
        count +
        "</strong></div>" +
        '<div class="stat"><span>Rewards earned</span><strong>' +
        satsFmt(earned) +
        " sats</strong></div></div>" +
        '<p class="group-label">Your referrals</p><div class="card group list">' +
        rows +
        "</div>";
      $("copyCode").onclick = () => copyText(code, "Code copied");
      if ($("copyRefLink"))
        $("copyRefLink").onclick = () => copyText(info.link, "Link copied");
    });
  }

  // ---- Home screen widget ----
  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
  });
  const widgetCfg = () =>
    store.get("nx_widget", {
      unit: "usd",
      size: "small",
      hide: false,
      change: true,
    });
  function showWidget() {
    const c = widgetCfg();
    const opts = (items, key) =>
      items
        .map(
          (i) =>
            '<button type="button" class="seg' +
            (c[key] === i[0] ? " on" : "") +
            '" data-key="' +
            key +
            '" data-val="' +
            i[0] +
            '">' +
            i[1] +
            "</button>",
        )
        .join("");
    const switchRow = (key, title, desc) =>
      '<button class="row wrow" type="button" data-wsw="' +
      key +
      '"><span class="row-copy"><span class="row-title">' +
      title +
      '</span><span class="row-desc">' +
      desc +
      '</span></span><span class="switch" role="switch" aria-checked="' +
      !!c[key] +
      '"></span></button>';
    sheetKind = "widget";
    openSheet(
      "Home Screen Widget",
      '<div class="wpreview-wrap"><div class="wpreview ' +
        c.size +
        '" id="wPrev"></div></div>' +
        '<p class="group-label">Show my Bitcoin balance in</p><div class="seg-group">' +
        opts(
          [
            ["usd", "US Dollars"],
            ["btc", "BTC"],
          ],
          "unit",
        ) +
        "</div>" +
        '<p class="group-label">Widget size</p><div class="seg-group">' +
        opts(
          [
            ["small", "Small"],
            ["medium", "Medium"],
          ],
          "size",
        ) +
        "</div>" +
        '<div class="card group list">' +
        switchRow("hide", "Hide balance", "Show •••• instead of the amount") +
        switchRow("change", "Show 24h change", "Display the price movement") +
        "</div>" +
        '<button class="pill-button primary" id="wAdd" type="button">Add to home screen</button>' +
        '<p class="hint small" id="wHint"></p>',
      () => {
        const draw = () => {
          const cfg = widgetCfg();
          const inv = investments();
          const bal =
            cfg.unit === "btc"
              ? btcFmt(inv.btc) + " BTC"
              : inv.price == null
                ? "—"
                : money(inv.btc * inv.price);
          const chg = inv.chg24;
          $("wPrev").className = "wpreview " + cfg.size;
          $("wPrev").innerHTML =
            '<span class="wl">₿ Bitcoin</span><strong>' +
            (cfg.hide ? "••••••" : bal) +
            "</strong>" +
            (cfg.change && chg != null
              ? '<span class="wc ' +
                (chg >= 0 ? "pos" : "neg") +
                '">' +
                (chg >= 0 ? "▲ " : "▼ ") +
                Math.abs(chg).toFixed(2) +
                "% today</span>"
              : "") +
            '<span class="wb">Nexvest</span>';
        };
        draw();
        loadPrice().then(() => sheetKind === "widget" && draw());
        $("sheetBody").onclick = (e) => {
          const s = e.target.closest(".seg");
          const w = e.target.closest("[data-wsw]");
          if (s) {
            const cfg = widgetCfg();
            cfg[s.dataset.key] = s.dataset.val;
            store.set("nx_widget", cfg);
            s.parentNode
              .querySelectorAll(".seg")
              .forEach((x) => x.classList.toggle("on", x === s));
            draw();
          } else if (w) {
            const cfg = widgetCfg();
            cfg[w.dataset.wsw] = !cfg[w.dataset.wsw];
            store.set("nx_widget", cfg);
            w.querySelector(".switch").setAttribute(
              "aria-checked",
              cfg[w.dataset.wsw],
            );
            draw();
          }
        };
        $("wAdd").onclick = async () => {
          if (deferredInstall) {
            deferredInstall.prompt();
            await deferredInstall.userChoice;
            deferredInstall = null;
            toast("Widget settings saved");
          } else {
            store.set("nx_widget", widgetCfg());
            $("wHint").textContent =
              "Settings saved. To place it: on iPhone use Share → Add to Home Screen; on Android use the browser menu → Install app / Add to Home screen, then long-press your home screen and choose the Nexvest widget.";
            toast("Widget settings saved");
          }
        };
      },
    );
  }

  // ---- Actions ----
  const actions = {
    invest: showInvestments,
    wallets: () => NX.go("profile", "#wallets"),
    switch: showSwitch,
    pin: showPin,
    password: showPassword,
    theme: () => {
      const t = store.get("nx_theme", "light") === "light" ? "dark" : "light";
      store.set("nx_theme", t);
      applyTheme(t);
      toast("Theme: " + t);
    },
    widget: showWidget,
    referrals: showReferrals,
  };

  $("sections").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const sw = row.querySelector(".switch");
    if (sw) {
      const key = SECTIONS.flatMap((s) => s.items).find(
        (i) => i.id === row.dataset.id,
      ).toggle;
      const next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", next);
      store.set(key, next);
      return toast(next ? "Enabled" : "Disabled");
    }
    (actions[row.dataset.id] || (() => {}))();
  });

  $("viewProfile").onclick = () => NX.go("profile");
  $("logoutRow").onclick = () =>
    confirmBox(
      "Log out?",
      "You will need to sign in again to access your Bitcoin.",
      "Logout",
      doLogout,
    );
  $("closeRow").onclick = () =>
    confirmBox(
      "Close or disable account?",
      "This is a sensitive action. Our team will guide you through the next steps.",
      "Continue",
      () => toast("To close your account, please contact support."),
    );

  // Name, email, avatar and bank summary come from saved data (signup + profile page)
  function fillDynamic() {
    const U = NX.get();
    $("profileName").textContent = NX.displayName(U).toUpperCase();
    $("profileEmail").textContent = U.email || "—";
    $("avatar").textContent = NX.initials(U);
    const d = document.querySelector('[data-id="wallets"] .row-desc');
    const n = Object.keys(U.wallets || {}).length;
    if (d)
      d.textContent = n
        ? n + " saved withdrawal address" + (n > 1 ? "es" : "")
        : "Add your crypto withdrawal addresses";
  }
  fillDynamic();
  window.nxSettingsShow = fillDynamic;
  // Latest name, email, bank and PIN status from the server
  NXAPI.sync()
    .then(fillDynamic)
    .catch(() => {});
})();
