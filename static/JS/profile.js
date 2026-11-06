(function () {
  const $ = (id) => document.getElementById(id);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  try {
    const t = JSON.parse(localStorage.getItem("nx_theme"));
    if (t) document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}

  const LOCK =
    '<svg class="pf-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="4"/><path d="M8 10V8a4 4 0 0 1 8 0v2"/><circle cx="12" cy="15.5" r="1.3"/></svg>';
  const Crypto = [
    "Coinbase",
    "MEXC",
    "Bitget",
    "OKX",
    "Binance",
    "KuCoin",
    "Bybit",
    "Gate.io",
    "BitMart",
    "Bitfinex",
    "Huobi",
    "Kraken",
    "Bitstamp",
    "Poloniex",
    "Bittrex",
    "Gemini",
    "Crypto.com",
    "eToro",
    "BitFlyer",
    "Coincheck",
    "Liquid",
    "Upbit",
    "WazirX",
    "Luno",
    "Bitso",
    "Paxful",
    "Changelly",
  ];
  const RELATIONS = [
    "Spouse",
    "Parent",
    "Child",
    "Sibling",
    "Relative",
    "Friend",
    "Other",
  ];

  // lock: true  -> comes from signup, read-only. Everything else is editable.
  const S = [
    {
      id: "personal",
      title: "Personal Information",
      fields: [
        { k: "firstName", l: "First Name", ph: "Enter your first name" },
        { k: "lastName", l: "Last Name", ph: "Enter your last name" },
        { k: "username", l: "Username", lock: true },
        { k: "email", l: "Email Address", lock: true },
        { k: "phone_number", l: "Phone Number", lock: true },
        { k: "accountType", l: "Account Type", lock: true },
      ],
    },
    {
      id: "address",
      title: "Address",
      fields: [
        { k: "address", l: "Address", ph: "House number and street" },
        [
          { k: "city", l: "City", ph: "City" },
          { k: "state", l: "State", ph: "State" },
        ],
        [
          { k: "country", l: "Country", ph: "Country" },
          { k: "lga", l: "Local Government Area", ph: "LGA" },
        ],
      ],
    },
    {
      id: "crypto",
      title: "Crypto Account",
      fields: [
        {
          k: "cryptoExchange",
          l: "Crypto Exchange",
          ph: "Select or type your crypto exchange",
          list: "pfCryptoExchanges",
        },
        {
          k: "exchangeUid",
          l: "Exchange User ID (UID)",
          ph: "Your user ID on the exchange",
          validate: "exchangeUid",
        },
        {
          k: "cryptoaddress",
          l: "Crypto Address / Public Key",
          ph: "Enter your public wallet address",
          validate: "cryptoAddress",
        },
      ],
    },

    {
      id: "kin",
      title: "Next of Kin",
      fields: [
        { k: "nokName", l: "Full Name", ph: "Next of kin's full name" },
        { k: "nokRelationship", l: "Relationship", opts: RELATIONS },
        {
          k: "nokPhone",
          l: "Phone Number",
          ph: "Next of kin's phone",
          attr: ' inputmode="tel"',
        },
      ],
    },
  ];
  const ALL = S.flatMap((s) => s.fields.flat());
  const RULES = {
    cryptoAddress: (v) =>
      !v ||
      /^(0x[a-fA-F0-9]{40}|[13km][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-zA-HJ-NP-Z0-9]{25,62})$/.test(
        v,
      ) ||
      "Enter a valid crypto wallet address",
    exchangeUid: (v) =>
      !v ||
      /^\d{5,12}$/.test(v) ||
      "Enter a valid exchange User ID (5-12 digits)",
    nokPhone: (v) =>
      !v ||
      /^\+?\d{7,15}$/.test(v.replace(/[\s-]/g, "")) ||
      "Enter a valid phone number",
  };

  function fieldHTML(f, U) {
    const v = f.k === "accountType" ? cap(U[f.k]) : U[f.k];
    const id = "f_" + f.k;
    const ctl = f.opts
      ? '<select id="' +
        id +
        '" name="' +
        f.k +
        '"><option value="">Select</option>' +
        f.opts
          .map(
            (o) =>
              "<option" + (o === v ? " selected" : "") + ">" + o + "</option>",
          )
          .join("") +
        "</select>"
      : '<input id="' +
        id +
        '" name="' +
        f.k +
        '" type="text" value="' +
        esc(v) +
        '" placeholder="' +
        esc(f.lock ? "—" : f.ph || "") +
        '"' +
        (f.list ? ' list="' + f.list + '"' : "") +
        (f.lock ? ' readonly tabindex="-1"' : ' autocomplete="off"') +
        (f.attr || "") +
        ">";
    return (
      '<div class="pf-field"><label for="' +
      id +
      '">' +
      f.l +
      '</label><div class="pf-input' +
      (f.lock ? " locked" : "") +
      '">' +
      ctl +
      (f.lock ? LOCK : "") +
      '</div><small class="pf-err" id="e_' +
      f.k +
      '"></small></div>'
    );
  }

  let dirty = false,
    backArmed = false;
  const setDirty = (d) => {
    dirty = d;
    $("pfSave").disabled = !d;
  };
  function toast(msg) {
    const t = $("pfToast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2000);
  }
  function proofLabel() {
    const U = NX.get();
    $("pfProof").textContent = U.proofName
      ? "Proof of address: " + U.proofName + " (tap to change)"
      : "Tap here to update your proof of address";
  }

  function render() {
    const U = NX.get();
    $("pfSections").innerHTML =
      S.map(
        (s) =>
          '<section class="pf-sec" id="sec_' +
          s.id +
          '"><h2 class="pf-group">' +
          s.title +
          "</h2>" +
          s.fields
            .map((f) =>
              Array.isArray(f)
                ? '<div class="pf-pair">' +
                  f.map((x) => fieldHTML(x, U)).join("") +
                  "</div>"
                : fieldHTML(f, U),
            )
            .join("") +
          "</section>",
      ).join("") +
      '<datalist id="pfCryptoExchanges">' +
      Crypto.map((c) => '<option value="' + c + '">').join("") +
      "</datalist>";
    $("pfAvatar").textContent = NX.initials(U);
    proofLabel();
    setDirty(false);
    backArmed = false;
  }

  function focusHash(h) {
    const el = h && $("sec_" + h.replace("#", ""));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo(0, 0);
  }

  $("pfForm").addEventListener("input", () => {
    setDirty(true);
    backArmed = false;
  });

  $("pfForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const patch = {};
    let ok = true;
    ALL.filter((f) => !f.lock).forEach((f) => {
      const val = $("f_" + f.k).value.trim();
      const r = RULES[f.k] ? RULES[f.k](val) : true;
      $("e_" + f.k).textContent = r === true ? "" : r;
      if (r !== true) ok = false;
      patch[f.k] = val;
    });
    if (!ok) return toast("Please fix the highlighted fields");
    const U = NX.update(patch);
    $("pfAvatar").textContent = NX.initials(U);
    setDirty(false);
    toast("Profile saved");
  });

  $("pfProofBtn").onclick = () => $("pfFile").click();
  $("pfFile").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast("File is too large (max 5 MB)");
    NX.update({ proofName: f.name });
    proofLabel();
    toast("Proof of address selected");
    // Note: the file itself needs a backend/upload endpoint to be stored.
  };

  $("pfBack").onclick = () => {
    if (dirty && !backArmed) {
      backArmed = true;
      return toast("Unsaved changes. Tap back again to discard");
    }
    NX.go("settings");
  };

  window.nxProfileShow = (hash) => {
    render();
    focusHash(hash);
  };
  render();
  focusHash(location.hash);
})();
