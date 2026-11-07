// Load on every page that talks to the server (after NX is defined, before the page's own script).
(function () {
  const API = ""; // same server as the page (FastAPI serves both), so no URL needed

  const token = () => {
    try {
      return localStorage.getItem("nx_token");
    } catch (e) {
      return null;
    }
  };

  // Turn whatever the backend sends back into a readable message
  function errorText(j) {
    if (j.error) return j.error;
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail) && j.detail[0] && j.detail[0].msg)
      return j.detail[0].msg; // validation errors (422)
    return "Request failed";
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token()) headers.Authorization = "Bearer " + token();

    const r = await fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !opts.noRedirect) {
      try {
        localStorage.removeItem("nx_token");
      } catch (e) {}
      location.href = "/"; // your login page
      throw new Error("Please sign in");
    }
    if (!r.ok) {
      const e = new Error(errorText(j));
      e.data = j;
      throw e;
    }
    return j;
  }
  const post = (p, body) => api(p, { method: "POST", body });

  // Ask for the 4-digit transaction PIN (gives back the PIN, or null if cancelled)
  function askPin(msg) {
    return new Promise((resolve) => {
      const o = document.createElement("div");
      o.style.cssText =
        "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:16px";
      o.innerHTML = `
        <div style="background:#fff;color:#111;max-width:340px;width:100%;border-radius:16px;padding:24px;font-family:inherit;text-align:center">
          <h2 style="margin:0 0 6px;font-size:20px">Enter your PIN</h2>
          <p style="margin:0 0 16px;font-size:14px">${msg || "Confirm this withdrawal with your 4-digit PIN."}</p>
          <input id="nxPin" type="password" inputmode="numeric" maxlength="4" placeholder="••••"
            style="width:100%;box-sizing:border-box;padding:12px;font-size:24px;letter-spacing:12px;text-align:center;border:1px solid #bbb;border-radius:10px;margin-bottom:12px">
          <button id="nxPinOk" style="width:100%;padding:12px;border:0;border-radius:10px;background:#111;color:#fff;font-size:15px;cursor:pointer">Confirm</button>
          <button id="nxPinNo" style="width:100%;padding:8px;margin-top:6px;border:0;background:none;color:#666;font-size:13px;cursor:pointer">Cancel</button>
        </div>`;
      document.body.appendChild(o);
      const input = o.querySelector("#nxPin");
      const ok = o.querySelector("#nxPinOk");
      const close = (v) => {
        o.remove();
        resolve(v);
      };
      input.focus();
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 4);
        input.style.borderColor = "#bbb";
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ok.click();
      });
      ok.onclick = () =>
        /^\d{4}$/.test(input.value)
          ? close(input.value)
          : (input.style.borderColor = "red");
      o.querySelector("#nxPinNo").onclick = () => close(null);
    });
  }

  // Every page that loads this file needs a login. No token = back to the login page.
  if (!token() && !/^\/(index\.html)?$/.test(location.pathname)) {
    location.replace("/");
  }

  window.NXAPI = {
    api,
    // Pull real balance + history from the server into NX storage so every page agrees.
    async sync() {
      const me = await api("/api/me");
      NX.update({
        balanceSats: me.balanceSats,
        transactions: me.transactions,
        emailVerified: me.emailVerified,
        hasPin: me.hasPin,
        username: me.username,
        email: me.email,
        accountType: me.accountType,
        referralCode: me.referralCode,
        bankName: me.bankName,
        accountNumber: me.accountNumber,
        accountName: me.accountName,
        wallets: me.wallets || {},
        phone_number: me.phone,
        phone: me.phone,
      });
      return me;
    },
    // account (only the token is stored in the browser, never the password)
    async register(email, password, ref, extra = {}) {
      const j = await post("/api/register", { email, password, ref, ...extra });
      localStorage.removeItem("nexvest_user"); // forget any previous account on this browser
      localStorage.setItem("nx_token", j.token);
      return j;
    },
    async login(email, password) {
      const j = await api("/api/login", {
        method: "POST",
        body: { email, password },
        noRedirect: true,
      });
      localStorage.removeItem("nexvest_user"); // forget any previous account on this browser
      localStorage.setItem("nx_token", j.token);
      return j;
    },
    // forgot password: email -> code -> new password
    forgotPassword: (email) => post("/api/forgot-password", { email }),
    checkResetCode: (email, code) =>
      post("/api/check-reset-code", { email, code }),
    resetPassword: (email, code, password) =>
      post("/api/reset-password", { email, code, password }),
    // transaction PIN (first time: setPin(newPin). Changing: setPin(newPin, currentPin))
    setPin: (pin, currentPin) =>
      api("/api/pin", { method: "PUT", body: { pin, currentPin } }),
    // referral
    referral: () => api("/api/referral"),
    refFromUrl: () =>
      (new URLSearchParams(location.search).get("ref") || "").trim(),
    // money
    depositAddress: async (forceNew) =>
      (await api("/api/deposit-address" + (forceNew ? "?new=1" : ""))).address,
    reportDeposit: (txid) => post("/api/deposits/report", { txid }),
    // body: { method: "bank" | "btc", sats, address? }. Asks for the PIN first.
    async withdraw(body) {
      const me = await api("/api/me");
      if (!me.hasPin) {
        alert("Please set your transaction PIN in Settings first.");
        location.href = "/settings.html";
        throw new Error("Set a PIN first");
      }
      const pin = await askPin();
      if (!pin) throw new Error("Withdrawal cancelled");
      return post("/api/withdraw", { ...body, pin });
    },
    // Withdrawal history, newest first: [{id, method, dest, sats, fee, receive, status, date}]
    async withdrawals() {
      const me = await api("/api/me");
      return me.transactions.filter((t) => t.type === "withdrawal");
    },
    saveBank: (body) => api("/api/bank", { method: "PUT", body }),
    // Save (or remove, with an empty address) the withdrawal address for one currency. Asks for the PIN.
    async saveWallet(option, address) {
      const me = await api("/api/me");
      if (!me.hasPin) {
        alert("Please set your transaction PIN in Settings first.");
        location.href = "/settings.html";
        throw new Error("Set a PIN first");
      }
      const pin = await askPin(
        "Confirm this wallet address change with your 4-digit PIN.",
      );
      if (!pin) throw new Error("Cancelled");
      return api("/api/wallets", {
        method: "PUT",
        body: { option, address, pin },
      });
    },
    logout() {
      try {
        localStorage.removeItem("nx_token");
        localStorage.removeItem("nexvest_user");
      } catch (e) {}
      location.href = "/";
    },
  };
})();
