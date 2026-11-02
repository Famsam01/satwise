/* ---------- Bottom navigation ---------- */
const NAV_PAGES = {
  home: "home.html",
  goals: "goals.html",
  activity: "activities.html",
  learn: "learn.html",
};

const activeNav = document.querySelector(".nav-item.active");
const currentNav = activeNav ? activeNav.dataset.nav : null;

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.nav === currentNav) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.location.href = NAV_PAGES[item.dataset.nav];
  });
});

document.getElementById("settingsButton").addEventListener("click", () => {
  location.href = "settings.html";
});

document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- Helpers ---------- */

const SATS_PER_BTC = 100_000_000;

const fmtSats = (n) => Math.round(n).toLocaleString("en-US");

const fmtUsd = (n) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

// Account saved at sign-up (demo storage in this browser)
function loadUser() {
  try {
    return JSON.parse(localStorage.getItem("nexvest_user"));
  } catch (e) {
    return null;
  }
}

// Referral link = sign-up page + the user's code
function buildReferralLink(code) {
  const url = new URL("index.html", window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("ref", code);
  return url.toString();
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage);
  } catch (e) {
    showToast("Couldn't copy. Select the text and copy it manually.");
  }
}

// Live BTC price in USD, or null if it can't be fetched
async function getBtcPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    );
    if (!res.ok) throw new Error("price failed");
    const json = await res.json();
    return json.bitcoin.usd;
  } catch (e) {
    return null;
  }
}
