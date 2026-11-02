// Include on BOTH pages, before script.js / home.js:
//   <script src="api.js"></script>

const API = {
  token: () => localStorage.getItem("nexvest_token"),

  async call(path, method = "GET", body) {
    const res = await fetch("/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(API.token() ? { Authorization: "Bearer " + API.token() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data.detail;
      throw new Error(typeof d === "string" ? d : "Something went wrong");
    }
    return data;
  },

  saveSession(data) {
    localStorage.setItem("nexvest_token", data.token);
  },
};

/* ---------- index.html (put inside your script.js) ----------
 
// Sign up  (iti = the intlTelInput instance on #phone)
document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await API.call("/signup", "POST", {
      account_type: document.querySelector('input[name="accountType"]:checked').value,
      username: document.getElementById("signupUsername").value.trim(),
      email: document.getElementById("signupEmail").value.trim(),
      phone: iti ? iti.getNumber() : document.getElementById("phone").value,
      password: document.getElementById("signupPassword").value,
      invite_code: document.getElementById("inviteInput").value.trim() || null,
    });
    API.saveSession(data);
    location.href = "home.html";
  } catch (err) { showToast(err.message); }   // use your existing toast function
});
 
// Login
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await API.call("/login", "POST", {
      identifier: document.getElementById("loginEmail").value.trim(),
      password: document.getElementById("loginPassword").value,
    });
    API.saveSession(data);
    location.href = "home.html";
  } catch (err) { showToast(err.message); }
});
*/

/* ---------- home.html (put inside your home.js) ----------
 
async function loadHome() {
  if (!API.token()) return (location.href = "index.html");
  try {
    const u = await API.call("/me");
    document.getElementById("homeUser").textContent = u.username;
    document.getElementById("balanceBtc").textContent = u.balance_btc;
    document.getElementById("balanceSats").textContent = u.balance_sats.toLocaleString();
    document.getElementById("inviteCode").textContent = u.invite_code;
    document.getElementById("goalPercent").textContent = u.goal_percent + "%";
    document.getElementById("goalFill").style.width = u.goal_percent + "%";
    document.getElementById("goalCurrent").textContent = u.balance_sats.toLocaleString() + " sats";
    // USD: (u.balance_sats / 1e8) * livePrice  -> your existing price feed
  } catch (err) {
    localStorage.removeItem("nexvest_token");
    location.href = "index.html";
  }
}
loadHome();
*/
