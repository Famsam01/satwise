/* Shared user data for Nexvest (signup -> settings -> profile).
   Everything lives in localStorage under one key. */
window.NX = (function () {
  const KEY = "nexvest_user";
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  const write = (o) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) {}
  };
  return {
    get: read,
    update(patch) {
      const u = Object.assign(read(), patch);
      write(u);
      return u;
    },
    // Call this from your signup submit handler
    saveSignup(d) {
      return this.update({
        username: d.username,
        email: d.email,
        phone: d.phone,
        accountType: d.accountType,
      });
    },
    displayName(u) {
      u = u || read();
      return (
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.username ||
        "Investor"
      );
    },
    initials(u) {
      const p = this.displayName(u).trim().split(/\s+/);
      return (
        p.length > 1 ? p[0][0] + p[1][0] : p[0].slice(0, 2)
      ).toUpperCase();
    },
    go(page, hash) {
      if (window.NX_NAV) return window.NX_NAV(page, hash);
      location.href = page + ".html" + (hash || "");
    },
  };
})();
