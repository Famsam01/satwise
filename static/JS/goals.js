/* Goals page. Needs pages.js loaded first. */

/* ---------- Settings you can edit ---------- */
// Plans differ by fees and features. None of them promise a return.
// Change the numbers to match your real business costs.
const PLANS = [
  {
    id: "standard",
    name: "Standard",
    tag: "Start small",
    minMonthly: 50,
    feePct: 1.0,
    features: [
      "Weekly or monthly auto-buy",
      "Goal tracking and buy streaks",
      "1 Stack Circle",
      "Email support",
    ],
  },
  {
    id: "premium",
    name: "Premium",
    tag: "Step up",
    minMonthly: 250,
    feePct: 0.6,
    features: [
      "Daily, weekly or monthly auto-buy",
      "Dip Radar alerts",
      "Up to 3 Stack Circles",
      "Priority support",
    ],
  },
  {
    id: "advanced",
    name: "Advanced",
    tag: "Full control",
    minMonthly: 1000,
    feePct: 0.35,
    features: [
      "Custom buy schedule",
      "Dip-buy rules: add a buy when price drops by a % you choose",
      "Unlimited Stack Circles",
      "Dedicated support",
    ],
  },
];

// Same demo values as home.js. Replace with the user's real data.
const DEMO_BALANCE_SATS = 184_500;
const GOAL = { title: "Stack 0.01 BTC", targetSats: 1_000_000 };
const FALLBACK_PRICE = 65_000;

/* ---------- State ---------- */
let selectedId = "standard";
try {
  const saved = localStorage.getItem("nexvest_plan");
  if (PLANS.some((p) => p.id === saved)) selectedId = saved;
} catch (e) {}

let btcPrice = FALLBACK_PRICE;
let priceIsLive = false;

const plan = () => PLANS.find((p) => p.id === selectedId);

/* ---------- Goal card ---------- */
function renderGoalProgress() {
  const pct = Math.min(100, (DEMO_BALANCE_SATS / GOAL.targetSats) * 100);
  document.getElementById("goalTitle").textContent = GOAL.title;
  document.getElementById("goalPercent").textContent = Math.floor(pct) + "%";
  document.getElementById("goalCurrent").textContent =
    fmtSats(DEMO_BALANCE_SATS) + " sats";
  document.getElementById("goalTarget").textContent =
    "of " + fmtSats(GOAL.targetSats) + " sats";
  document
    .getElementById("goalBar")
    .setAttribute("aria-valuenow", Math.floor(pct));
  setTimeout(() => {
    document.getElementById("goalFill").style.width = pct + "%";
  }, 150);
}

function renderTimeToGoal() {
  const monthly = Number(document.getElementById("simMonthly").value);
  const remaining = Math.max(0, GOAL.targetSats - DEMO_BALANCE_SATS);
  const satsPerMonth =
    ((monthly * (1 - plan().feePct / 100)) / btcPrice) * SATS_PER_BTC;
  const months = Math.ceil(remaining / satsPerMonth);
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const when =
    years > 0
      ? `${years} year${years > 1 ? "s" : ""}` +
        (rest ? ` ${rest} month${rest > 1 ? "s" : ""}` : "")
      : `${months} month${months > 1 ? "s" : ""}`;

  document.getElementById("timeToGoal").textContent =
    remaining === 0
      ? "Goal reached. Set a bigger one and keep stacking."
      : `On the ${plan().name} plan at ${fmtUsd(monthly)} a month, you'd ` +
        `reach this goal in about ${when} if the price stays flat.`;
}

/* ---------- Plan cards ---------- */
function renderPlans() {
  const grid = document.getElementById("planGrid");
  grid.innerHTML = PLANS.map(
    (p) => `
    <button class="plan-card" type="button" data-plan="${p.id}"
      aria-pressed="${p.id === selectedId}">
      <div class="plan-top">
        <div>
          <div class="plan-name">${p.name}</div>
          <div class="plan-tag">${p.tag}</div>
        </div>
        <div class="plan-price"><strong>${fmtUsd(p.minMonthly)}</strong>min. per month</div>
      </div>
      <div class="plan-fee">${p.feePct}% fee on each buy</div>
      <ul class="plan-features">${p.features.map((f) => `<li>${f}</li>`).join("")}</ul>
      <div class="plan-choose">${p.id === selectedId ? "Selected" : "Choose " + p.name}</div>
    </button>`,
  ).join("");

  grid.querySelectorAll(".plan-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedId = card.dataset.plan;
      try {
        localStorage.setItem("nexvest_plan", selectedId);
      } catch (e) {}
      renderPlans();
      applyPlanMinimum();
      showToast(plan().name + " plan selected. Connect payments to start it.");
    });
  });
}

/* ---------- Simulator ---------- */
const monthlyEl = document.getElementById("simMonthly");
const yearsEl = document.getElementById("simYears");
const growthEl = document.getElementById("simGrowth");

// The monthly slider can't go below the selected plan's minimum
function applyPlanMinimum() {
  monthlyEl.min = plan().minMonthly;
  if (Number(monthlyEl.value) < plan().minMonthly) {
    monthlyEl.value = plan().minMonthly;
  }
  runSimulator();
}

function simulate({ monthly, years, growthPct, feePct, startPrice }) {
  const months = years * 12;
  // Turn the yearly what-if into a steady monthly change
  const monthlyRate = Math.pow(1 + growthPct / 100, 1 / 12) - 1;
  let btc = 0;

  for (let i = 0; i < months; i++) {
    const price = startPrice * Math.pow(1 + monthlyRate, i);
    btc += (monthly * (1 - feePct / 100)) / price;
  }

  const contributed = monthly * months;
  const endPrice = startPrice * Math.pow(1 + monthlyRate, months);

  return {
    contributed,
    fees: (contributed * feePct) / 100,
    sats: btc * SATS_PER_BTC,
    value: btc * endPrice,
    avgPrice: (contributed * (1 - feePct / 100)) / btc,
  };
}

function runSimulator() {
  const monthly = Number(monthlyEl.value);
  const years = Number(yearsEl.value);
  const growthPct = Number(growthEl.value);

  document.getElementById("simMonthlyOut").textContent = fmtUsd(monthly);
  document.getElementById("simYearsOut").textContent =
    years + (years === 1 ? " year" : " years");
  document.getElementById("simGrowthOut").textContent =
    (growthPct > 0 ? "+" : "") + growthPct + "% a year";

  document.querySelectorAll(".scenario").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.growth) === growthPct);
  });

  const r = simulate({
    monthly,
    years,
    growthPct,
    feePct: plan().feePct,
    startPrice: btcPrice,
  });

  document.getElementById("outContributed").textContent = fmtUsd(r.contributed);
  document.getElementById("outFees").textContent = fmtUsd(r.fees);
  document.getElementById("outSats").textContent = fmtSats(r.sats);
  document.getElementById("outAvg").textContent = fmtUsd(r.avgPrice);
  document.getElementById("outValue").textContent = fmtUsd(r.value);

  const diff = r.value - r.contributed;
  const diffEl = document.getElementById("outDiff");
  diffEl.textContent =
    (diff >= 0 ? "+" : "−") +
    fmtUsd(Math.abs(diff)) +
    " compared with what you put in";
  diffEl.className = diff >= 0 ? "pos" : "neg";

  document.getElementById("simNote").textContent = priceIsLive
    ? `Starts from today's live Bitcoin price of ${fmtUsd(btcPrice)}. ` +
      `Fees use the ${plan().name} plan rate of ${plan().feePct}%.`
    : `Live price unavailable, so this uses a sample price of ${fmtUsd(btcPrice)}. ` +
      `Fees use the ${plan().name} plan rate of ${plan().feePct}%.`;

  renderTimeToGoal();
}

[monthlyEl, yearsEl, growthEl].forEach((el) =>
  el.addEventListener("input", runSimulator),
);

document.querySelectorAll(".scenario").forEach((btn) => {
  btn.addEventListener("click", () => {
    growthEl.value = btn.dataset.growth;
    runSimulator();
  });
});

/* ---------- Init ---------- */
renderGoalProgress();
renderPlans();
applyPlanMinimum();

getBtcPrice().then((price) => {
  if (price) {
    btcPrice = price;
    priceIsLive = true;
    runSimulator();
  }
});

// Real balance from the server
NXAPI.sync()
  .then((me) => {
    DEMO_BALANCE_SATS = me.balanceSats;
    renderGoalProgress();
    renderTimeToGoal();
  })
  .catch(() => {});
