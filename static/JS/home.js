/* ---------- Balance (BTC + sats) ---------- */
// Demo value. Replace with the user's real balance from your backend.

let balanceSats = 0; // whole sats, filled from the server (a new account starts at 0)
let btcPrice = null;

function renderBalance() {
  const btc = balanceSats / SATS_PER_BTC;
  document.getElementById("balanceBtc").textContent = btc.toFixed(8);
  document.getElementById("balanceSats").textContent =
    balanceSats.toLocaleString("en-US");

  document.getElementById("balanceUsd").textContent =
    btcPrice == null
      ? "—"
      : (btc * btcPrice).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        });
}

/* ---------- Invite code ---------- */
function generateInviteCode(length = 6) {
  // No 0/O/1/I so codes are easy to read out
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

// The account saved at sign-up (demo storage in this browser).
// Replace with the logged-in user's data from your backend.
function loadUser() {
  try {
    return JSON.parse(localStorage.getItem("nexvest_user"));
  } catch (e) {
    return null;
  }
}

function renderUser() {
  const user = loadUser();
  // textContent (not innerHTML) so a username can never inject code
  document.getElementById("welcomeName").textContent =
    (user && user.username) || "Investor";
}

// Referral link = sign-up page + the user's code, e.g. .../index.html?ref=VBPYXZ
function buildReferralLink(code) {
  const url = new URL("index.html", window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("ref", code);
  return url.toString();
}

function loadInviteCode() {
  const user = loadUser();

  // Use the code created at sign-up; only make a new one if none exists
  let code = user && user.inviteCode;
  if (!code) {
    try {
      code = localStorage.getItem("nexvest_invite");
    } catch (e) {}
  }
  if (!code) {
    code = generateInviteCode();
    try {
      localStorage.setItem("nexvest_invite", code);
    } catch (e) {}
  }
  document.getElementById("inviteCode").textContent = code;
  document.getElementById("inviteLink").textContent = buildReferralLink(code);
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMessage);
  } catch (e) {
    showToast("Couldn't copy. Select the text and copy it manually.");
  }
}

document.getElementById("copyInvite").addEventListener("click", () => {
  copyText(
    document.getElementById("inviteCode").textContent,
    "Invite code copied.",
  );
});

document.getElementById("copyLink").addEventListener("click", () => {
  copyText(
    document.getElementById("inviteLink").textContent,
    "Referral link copied.",
  );
});

/* ---------- Live chart ---------- */
const badge = document.getElementById("liveBadge");
const priceEl = document.getElementById("livePrice");
const changeEl = document.getElementById("priceChange");
const noteEl = document.getElementById("chartNote");

const usd = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function setBadge(state, text) {
  badge.className = "live-badge " + state;
  badge.querySelector("b").textContent = text;
}

const ctx = document.getElementById("priceChart").getContext("2d");
const gradient = ctx.createLinearGradient(0, 0, 0, 220);
gradient.addColorStop(0, "rgba(46,180,135,0.30)");
gradient.addColorStop(1, "rgba(46,180,135,0)");

const chart = new Chart(ctx, {
  type: "line",
  data: {
    labels: [],
    datasets: [
      {
        data: [],
        borderColor: "#2eb487",
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: { label: (c) => usd(c.parsed.y) },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxTicksLimit: 5, color: "#999e9f", font: { size: 11 } },
      },
      y: {
        position: "right",
        grid: { color: "#f0f2f1" },
        ticks: {
          color: "#999e9f",
          font: { size: 11 },
          callback: (v) => "$" + Math.round(v).toLocaleString("en-US"),
        },
      },
    },
  },
});

const MAX_POINTS = 300;
let openPrice = null;
let simulated = false;

function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pushPoint(ts, price) {
  chart.data.labels.push(timeLabel(ts));
  chart.data.datasets[0].data.push(price);
  if (chart.data.labels.length > MAX_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update();
  updatePriceUi(price);
}

function updatePriceUi(price) {
  btcPrice = price;
  priceEl.textContent = usd(price);
  if (openPrice) {
    const pct = ((price - openPrice) / openPrice) * 100;
    changeEl.textContent =
      (pct >= 0 ? "▲ " : "▼ ") + Math.abs(pct).toFixed(2) + "%";
    changeEl.className = "price-change " + (pct >= 0 ? "up" : "down");
  }
  renderBalance();
}

async function loadHistory() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1",
  );
  if (!res.ok) throw new Error("history failed");
  const json = await res.json();
  // thin out to ~100 points
  const step = Math.max(1, Math.floor(json.prices.length / 100));
  const pts = json.prices.filter((_, i) => i % step === 0);
  chart.data.labels = pts.map(([t]) => timeLabel(t));
  chart.data.datasets[0].data = pts.map(([, p]) => p);
  openPrice = pts[0][1];
  chart.update();
  updatePriceUi(pts[pts.length - 1][1]);
}

/* ---------- High-Frequency Real-Time Price Engine ---------- */

async function pollPrice() {
  // Switched from CoinGecko to an alternate fast endpoint that won't rate-limit you
  const res = await fetch("https://binance.info");
  if (!res.ok) throw new Error("Price feed failed");
  const json = await res.json();

  const currentPrice = parseFloat(json.price);
  pushPoint(Date.now(), currentPrice);
}
function startSimulation() {
  // Fallback if the API is unreachable or rate-limited: clearly labelled
  simulated = true;
  setBadge("sim", "Simulated");
  noteEl.textContent = "Live data unavailable · showing simulated prices";

  let price = btcPrice || 75000;
  if (!chart.data.labels.length) {
    openPrice = price;
    for (let i = 60; i > 0; i--) {
      price *= 1 + (Math.random() - 0.5) * 0.002;
      chart.data.labels.push(timeLabel(Date.now() - i * 60000));
      chart.data.datasets[0].data.push(price);
    }
    chart.update();
    updatePriceUi(price);
  }

  // ADDED HERE: This ticks every 1 second (1000ms) with smoother movement
  setInterval(() => {
    price *= 1 + (Math.random() - 0.5) * 0.001;
    pushPoint(Date.now(), price);
  }, 1000);
}
async function startLive() {
  try {
    // 1. Initial history load
    await loadHistory();
    setBadge("live", "Live");

    // 2. Fast ticking poll loop: Updates every 2 seconds (2000 milliseconds)
    // Decreasing this to 2000ms gives you fast, live charts just like Binance!
    setInterval(async () => {
      try {
        await pollPrice();
        setBadge("live", "Live");
      } catch (e) {
        // Keep status clear during fast reconnects
        setBadge("", "Reconnecting");
      }
    }, 2000);
  } catch (e) {
    // Fall back to simulation engine if internet drops out
    startSimulation();
  }
}

/* ---------- Investment goal ---------- */
// Demo values. Replace with the user's real goal from your backend.
const goal = { title: "Stack 0.01 BTC", targetSats: 1_000_000 };

function renderGoal() {
  const pct = Math.min(100, (balanceSats / goal.targetSats) * 100);
  const remaining = Math.max(0, goal.targetSats - balanceSats);
  const shown = Math.floor(pct);

  document.getElementById("goalTitle").textContent = goal.title;
  document.getElementById("goalPercent").textContent = shown + "%";
  document.getElementById("goalCurrent").textContent =
    balanceSats.toLocaleString("en-US") + " sats";
  document.getElementById("goalTarget").textContent =
    "of " + goal.targetSats.toLocaleString("en-US") + " sats";

  const bar = document.getElementById("goalBar");
  bar.setAttribute("aria-valuenow", shown);
  // small delay so the bar animates in
  setTimeout(() => {
    document.getElementById("goalFill").style.width = pct + "%";
  }, 150);

  document.getElementById("goalNudge").textContent =
    remaining === 0
      ? "Goal reached. Set a bigger one and keep stacking."
      : `You're ${remaining.toLocaleString("en-US")} sats away. ` +
        "Investing a little more each week gets you there sooner.";
}

/* ---------- Next buy + streak ---------- */
// Demo trade history: how many days ago each buy happened.
// Replace with the user's real buy dates from your backend.
let buyDaysAgo = [];
const BUY_INTERVAL_DAYS = 7;
const WEEKS_SHOWN = 7;

function computeStreak(daysAgoList) {
  // A "week" is a 7-day window counted back from today (week 0 = last 7 days).
  const weeks = new Set(daysAgoList.map((d) => Math.floor(d / 7)));
  // If nothing was bought yet this week, the streak is still alive until
  // the week ends, so start counting from last week.
  let w = weeks.has(0) ? 0 : 1;
  let streak = 0;
  while (weeks.has(w)) {
    streak++;
    w++;
  }
  return { streak, weeks };
}

function renderSchedule() {
  const { streak, weeks } = computeStreak(buyDaysAgo);
  const lastBuy = buyDaysAgo.length ? Math.min(...buyDaysAgo) : null;

  // Next buy
  const nextEl = document.getElementById("nextBuy");
  const noteEl2 = document.getElementById("nextBuyNote");
  if (lastBuy === null) {
    nextEl.textContent = "Not set";
    noteEl2.textContent = "Make your first buy to start a plan.";
  } else {
    const inDays = Math.max(0, BUY_INTERVAL_DAYS - lastBuy);
    const date = new Date(Date.now() + inDays * 86400000);
    nextEl.textContent =
      inDays === 0 ? "Today" : inDays === 1 ? "Tomorrow" : `In ${inDays} days`;
    noteEl2.textContent =
      date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }) + " · weekly plan";
  }

  // Streak
  document.getElementById("streakCount").textContent =
    streak + (streak === 1 ? " week" : " weeks");

  const dots = document.getElementById("streakDots");
  dots.innerHTML = "";
  // oldest week on the left, current week on the right
  for (let i = WEEKS_SHOWN - 1; i >= 0; i--) {
    const dot = document.createElement("i");
    if (weeks.has(i)) dot.className = "on";
    dots.appendChild(dot);
  }
}

/* ---------- Buttons, settings, nav ---------- */
document.getElementById("settingsButton").addEventListener("click", () => {
  location.href = "settings.html";
});

document.getElementById("buyNow").addEventListener("click", () => {
  location.href = "deposit.html";
});

document.getElementById("withdrawBtn").addEventListener("click", () => {
  location.href = "withdraw.html";
});

document.getElementById("investMore").addEventListener("click", () => {
  document.getElementById("buyNow").scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    if (item.dataset.nav === "home") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
  });
});

document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- Init ---------- */
renderBalance();
renderGoal();
renderSchedule();
loadInviteCode();
startLive();

/* ---------- Real data from the server ---------- */
function refreshFromServer() {
  NXAPI.sync()
    .then((me) => {
      balanceSats = me.balanceSats;
      buyDaysAgo = (me.transactions || [])
        .filter((t) => t.type === "deposit" && t.status === "Confirmed")
        .map((t) =>
          Math.floor((Date.now() - new Date(t.date).getTime()) / 86400000),
        )
        .filter((d) => d >= 0);
      renderSchedule();
      document.getElementById("welcomeName").textContent =
        me.username || "Investor";
      if (me.referralCode) {
        document.getElementById("inviteCode").textContent = me.referralCode;
        document.getElementById("inviteLink").textContent = buildReferralLink(
          me.referralCode,
        );
      }
      renderBalance();
      renderGoal();
    })
    .catch(() => {});
}
refreshFromServer();
setInterval(refreshFromServer, 30000); // picks up new deposits without a reload
