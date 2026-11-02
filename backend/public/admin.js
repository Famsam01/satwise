(function () {
  const app = document.getElementById("app");
  const logoutBtn = document.getElementById("logout");
  const tokenKey = "nx_admin_token";
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");

  // Safe DOM builder: all text goes through textContent, so user-supplied data can never inject HTML.
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) =>
      k.startsWith("on")
        ? (n[k] = v)
        : k === "class"
          ? (n.className = v)
          : n.setAttribute(k, v),
    );
    kids
      .flat()
      .forEach((k) =>
        n.append(
          k instanceof Node
            ? k
            : document.createTextNode(k == null ? "" : String(k)),
        ),
      );
    return n;
  }
  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + sessionStorage.getItem(tokenKey),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) {
      sessionStorage.removeItem(tokenKey);
      showLogin();
      throw new Error(j.error || "Signed out");
    }
    if (!r.ok) {
      const e = new Error(j.error || "Request failed");
      e.data = j;
      throw e;
    }
    return j;
  }
  logoutBtn.onclick = () => {
    sessionStorage.removeItem(tokenKey);
    showLogin();
  };

  function showLogin(msg, needs2fa) {
    logoutBtn.hidden = true;
    const err = el("div", { class: "err" }, msg || "");
    const email = el("input", {
      type: "email",
      placeholder: "Email",
      autocomplete: "username",
    });
    const pass = el("input", {
      type: "password",
      placeholder: "Password",
      autocomplete: "current-password",
    });
    const code = el("input", {
      inputmode: "numeric",
      placeholder: "2FA code",
      maxlength: 6,
    });
    code.hidden = !needs2fa;
    const go = async (e) => {
      e.preventDefault();
      try {
        const r = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.value,
            password: pass.value,
            code: code.value,
          }),
        });
        const j = await r.json();
        if (!r.ok) {
          code.hidden = !j.needs2fa && code.hidden;
          err.textContent = j.error;
          if (j.needs2fa) code.hidden = false;
          return;
        }
        sessionStorage.setItem(tokenKey, j.token);
        load();
      } catch (x) {
        err.textContent = "Network error";
      }
    };
    app.replaceChildren(
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Admin sign in"),
        err,
        el(
          "form",
          { onsubmit: go },
          email,
          pass,
          code,
          el("button", { class: "pri", type: "submit" }, "Sign in"),
        ),
      ),
    );
  }

  function show2faSetup() {
    const out = el("div", {}),
      err = el("div", { class: "err" });
    const start = async () => {
      try {
        const s = await api("/api/2fa/setup", { method: "POST" });
        const code = el("input", {
          inputmode: "numeric",
          placeholder: "6-digit code",
          maxlength: 6,
        });
        out.replaceChildren(
          el(
            "p",
            {},
            'Open your authenticator app (Google Authenticator, Authy, 1Password), choose "enter a setup key" and paste this key:',
          ),
          el("code", {}, s.secret),
          el("p", { class: "mut" }, "Then type the 6-digit code it shows:"),
          code,
          el(
            "button",
            {
              class: "pri",
              onclick: async () => {
                try {
                  await api("/api/2fa/enable", {
                    method: "POST",
                    body: { code: code.value },
                  });
                  load();
                } catch (e) {
                  err.textContent = e.message;
                }
              },
            },
            "Turn on 2FA",
          ),
        );
      } catch (e) {
        err.textContent = e.message;
      }
    };
    app.replaceChildren(
      el(
        "div",
        { class: "card" },
        el("h3", {}, "Set up 2FA to open the dashboard"),
        el(
          "p",
          { class: "mut" },
          "Admin accounts must use two-factor authentication.",
        ),
        err,
        out,
        el("button", { class: "pri", onclick: start }, "Start"),
      ),
    );
    logoutBtn.hidden = false;
  }

  function table(cols, rows) {
    return el(
      "div",
      { class: "wrap" },
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            cols.map((c) => el("th", {}, c.h)),
          ),
        ),
        el(
          "tbody",
          {},
          rows.length
            ? rows.map((r) =>
                el(
                  "tr",
                  {},
                  cols.map((c) => el("td", {}, c.f(r))),
                ),
              )
            : [
                el(
                  "tr",
                  {},
                  el(
                    "td",
                    { colspan: cols.length, class: "mut" },
                    "Nothing here yet.",
                  ),
                ),
              ],
        ),
      ),
    );
  }

  const tabs = {
    async Overview() {
      const o = await api("/api/admin/overview");
      const s = (l, v) =>
        el("div", { class: "card stat" }, el("span", {}, l), el("b", {}, v));
      return el(
        "div",
        { class: "grid" },
        s("Users", fmt(o.users)),
        s("Total user balances (sats)", fmt(o.totalBalanceSats)),
        s(
          "Withdrawals waiting",
          `${o.pendingWithdrawals.c} · ${fmt(o.pendingWithdrawals.s)} sats`,
        ),
        s(
          "Deposits confirming",
          `${o.pendingDeposits.c} · ${fmt(o.pendingDeposits.s)} sats`,
        ),
        s("Total deposited (sats)", fmt(o.depositedSats)),
        s("Referral bonuses paid (sats)", fmt(o.bonusesPaidSats)),
        s("Addresses issued", fmt(o.addressesIssued)),
      );
    },
    async Withdrawals() {
      const rows = await api("/api/admin/withdrawals");
      const act = (id, what, body) => async () => {
        if (what === "reject" && !confirm("Reject and refund " + id + "?"))
          return;
        try {
          await api(`/api/admin/withdrawals/${id}/${what}`, {
            method: "POST",
            body,
          });
          render("Withdrawals");
        } catch (e) {
          alert(e.message);
        }
      };
      return table(
        [
          { h: "ID", f: (r) => r.id },
          { h: "User", f: (r) => r.email },
          { h: "Method", f: (r) => r.method },
          { h: "Amount", f: (r) => fmt(r.sats) },
          { h: "Send", f: (r) => fmt(r.receive) },
          { h: "Destination", f: (r) => el("code", {}, r.dest_full) },
          { h: "Status", f: (r) => r.status },
          { h: "Date", f: (r) => r.created_at },
          {
            h: "",
            f: (r) =>
              r.status === "Pending"
                ? el(
                    "span",
                    {},
                    el(
                      "button",
                      { class: "ok", onclick: act(r.id, "approve") },
                      "Approve",
                    ),
                    " ",
                    el(
                      "button",
                      { class: "bad", onclick: act(r.id, "reject") },
                      "Reject",
                    ),
                  )
                : r.status === "Approved"
                  ? el(
                      "button",
                      {
                        class: "pri",
                        onclick: () => {
                          const ref = prompt(
                            "Transaction ID or bank reference:",
                          );
                          if (ref !== null) act(r.id, "paid", { ref })();
                        },
                      },
                      "Mark paid",
                    )
                  : r.txid || "",
          },
        ],
        rows,
      );
    },
    async Deposits() {
      const rows = await api("/api/admin/deposits");
      return table(
        [
          { h: "User", f: (r) => r.email },
          { h: "Sats", f: (r) => fmt(r.sats) },
          { h: "Confirmations", f: (r) => r.confirmations },
          { h: "Status", f: (r) => r.status },
          { h: "Tx", f: (r) => el("code", {}, r.txid.slice(0, 12) + "…") },
          { h: "Date", f: (r) => r.created_at },
        ],
        rows,
      );
    },
    async Users() {
      const rows = await api("/api/admin/users");
      return table(
        [
          { h: "ID", f: (r) => r.id },
          { h: "Email", f: (r) => r.email },
          { h: "Balance (sats)", f: (r) => fmt(r.balance_sats) },
          { h: "Email ✓", f: (r) => (r.email_verified ? "yes" : "no") },
          { h: "2FA", f: (r) => (r.totp_enabled ? "on" : "off") },
          { h: "Referred by", f: (r) => r.referred_by || "" },
          {
            h: "Bonus paid",
            f: (r) =>
              r.referred_by ? (r.referral_bonus_paid ? "yes" : "no") : "",
          },
          {
            h: "",
            f: (r) =>
              el(
                "button",
                {
                  onclick: async () => {
                    const sats = prompt(
                      "Add (+) or subtract (−) sats for " + r.email + ":",
                    );
                    if (!sats) return;
                    const reason = prompt("Reason (saved in the ledger):");
                    if (!reason) return;
                    try {
                      await api(`/api/admin/users/${r.id}/adjust`, {
                        method: "POST",
                        body: { sats: Number(sats), reason },
                      });
                      render("Users");
                    } catch (e) {
                      alert(e.message);
                    }
                  },
                },
                "Adjust",
              ),
          },
        ],
        rows,
      );
    },
  };

  async function render(name) {
    const content = el("div", {});
    document
      .querySelectorAll("nav button")
      .forEach((b) => b.classList.toggle("on", b.textContent === name));
    try {
      content.append(await tabs[name]());
    } catch (e) {
      if (e.data && e.data.need2fa) return show2faSetup();
      content.append(el("div", { class: "err" }, e.message));
    }
    document.getElementById("body").replaceChildren(content);
  }

  function load() {
    if (!sessionStorage.getItem(tokenKey)) return showLogin();
    logoutBtn.hidden = false;
    app.replaceChildren(
      el(
        "nav",
        {},
        Object.keys(tabs).map((n) =>
          el("button", { onclick: () => render(n) }, n),
        ),
      ),
      el("div", { id: "body" }),
    );
    render("Overview");
  }
  load();
})();
