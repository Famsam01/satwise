/* Activity page. Load order: pages.js, user.js, activities.js */
(function () {
  "use strict";

  window.__nxActivityLoaded = true;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const fmt = (n) =>
    typeof fmtSats === "function"
      ? fmtSats(n)
      : Number(n).toLocaleString("en-US");
  const go = (page, hash) =>
    window.NX
      ? NX.go(page, hash)
      : (location.href = page + ".html" + (hash || ""));

  function toast(msg) {
    if (typeof showToast === "function") return showToast(msg);
    const t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ---------- Settings you can edit ---------- */
  // true = show sample friends/circle so you can see the design.
  // false = start empty (everything at 0) until you connect a backend.
  const USE_DEMO_DATA = false;

  // ---- Referral link path ----
  // Put your live website address here once it's hosted, no trailing page name.
  // Example: "https://nexvest.com"  ->  https://nexvest.com/index.html?ref=ABC123
  // Leave "" while testing; the link then uses wherever the page is opened from.
  const SITE_URL = "";
  const REF_PAGE = "index.html"; // the signup page friends land on
  const REF_PARAM = "ref"; // query name your signup page reads

  const REFERRAL = {
    friends: USE_DEMO_DATA
      ? [
          { name: "Ada", status: "rewarded" },
          { name: "Tolu", status: "waiting" },
          { name: "Chidi", status: "waiting" },
          { name: "Bisi", status: "invited" },
        ]
      : [],
    perFriendSats: 2000, // paid to BOTH people after the friend qualifies
    minFirstBuyUsd: 20,
    holdDays: 30,
    milestones: [
      { friends: 5, bonusSats: 10000 },
      { friends: 10, bonusSats: 30000 },
    ],
  };

  const CIRCLE_KEY = "nx_circle";
  const DEMO_CIRCLE = {
    name: "Family Stack",
    maxMembers: 5,
    members: [
      { name: "You", boughtThisWeek: true },
      { name: "Ada", boughtThisWeek: true },
      { name: "Tolu", boughtThisWeek: false },
    ],
    streakWeeks: 4,
    stackedSats: 612000,
    goalSats: 2000000,
    discountPct: 25,
  };
  const emptyCircle = () => ({
    name: "",
    maxMembers: 5,
    members: [{ name: "You", boughtThisWeek: false }],
    streakWeeks: 0,
    stackedSats: 0,
    goalSats: 2000000,
    discountPct: 25,
    empty: true,
  });
  let CIRCLE = (function () {
    try {
      const saved = JSON.parse(localStorage.getItem(CIRCLE_KEY));
      if (saved && saved.members) return saved;
    } catch (e) {}
    return USE_DEMO_DATA ? DEMO_CIRCLE : emptyCircle();
  })();
  function saveCircle() {
    try {
      localStorage.setItem(CIRCLE_KEY, JSON.stringify(CIRCLE));
    } catch (e) {}
  }

  // Which of the last 12 weeks you bought in. Index 0 = this week.
  const WEEKLY_BUYS = USE_DEMO_DATA
    ? [1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0]
    : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  const MY_ACTIVITY = USE_DEMO_DATA
    ? [
        { icon: "buy", text: "Bought 25,000 sats", daysAgo: 4 },
        { icon: "streak", text: "Buy streak reached 4 weeks", daysAgo: 4 },
        { icon: "buy", text: "Bought 30,000 sats", daysAgo: 11 },
        {
          icon: "friend",
          text: "A friend joined with your invite code",
          daysAgo: 9,
        },
        { icon: "goal", text: "Your goal passed 15%", daysAgo: 18 },
      ]
    : [];

  const NEWS = [
    {
      tag: "New",
      title: "Withdrawals are here",
      body: "Withdraw to your saved bank account or to a Bitcoin wallet from the Withdraw button on the home page.",
    },
    {
      tag: "New",
      title: "Profile and bank details",
      body: "Save your personal, bank and next of kin details once. Your name and email from signup are locked for safety.",
    },
    {
      tag: "Preview",
      title: "Stack Circles",
      body: "Save together with up to 5 people. Everyone keeps their own Bitcoin. The circle shares a goal and a streak.",
    },
    {
      tag: "Tip",
      title: "Weekly buys add up",
      body: "Small, regular buys smooth out price swings. Your buy streak shows how consistent you've been.",
    },
  ];

  const PROJECT_UPDATES = [
    {
      status: "Live",
      title: "Bitcoin-only accounts",
      note: "Sign up, set a goal and track your sats.",
    },
    {
      status: "Live",
      title: "Goals and plans",
      note: "Standard, Premium and Advanced plans with a plan simulator.",
    },
    {
      status: "Beta",
      title: "Referral rewards",
      note: "Invite friends and earn bonus sats.",
    },
    {
      status: "Next",
      title: "Stack Circles",
      note: "Save together while everyone keeps their own Bitcoin.",
    },
    { status: "Planned", title: "Mobile app", note: "iOS and Android." },
  ];

  const ICONS = {
    buy: '<path d="M12 5v14M5 12h14" />',
    streak:
      '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" />',
    friend:
      '<circle cx="9" cy="8" r="3.5" /><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M18 8v6M15 11h6" />',
    goal: '<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" />',
  };
  const icon = (name) =>
    `<span class="feed-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg></span>`;

  /* ---------- Invite code + referral link ---------- */
  function inviteCode() {
    let c = "";
    try {
      c = (window.NX && NX.get().inviteCode) || "";
    } catch (e) {}
    try {
      if (!c && typeof loadUser === "function") {
        const u = loadUser();
        c = (u && u.inviteCode) || "";
      }
    } catch (e) {}
    try {
      if (!c) c = localStorage.getItem("nexvest_invite") || "";
    } catch (e) {}
    if (!c) {
      const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ";
      c = Array.from(
        { length: 6 },
        () => abc[Math.floor(Math.random() * abc.length)],
      ).join("");
      try {
        localStorage.setItem("nexvest_invite", c);
      } catch (e) {}
    }
    c = c.toUpperCase();
    try {
      if (window.NX && NX.get().inviteCode !== c) NX.update({ inviteCode: c });
    } catch (e) {}
    return c;
  }

  // Builds: <SITE_URL or current folder>/index.html?ref=CODE
  function buildLink(code, extra) {
    try {
      const base = SITE_URL
        ? SITE_URL.replace(/\/+$/, "") + "/"
        : location.href;
      const u = new URL(REF_PAGE, base);
      u.search = "";
      u.hash = "";
      u.searchParams.set(REF_PARAM, code);
      if (extra)
        Object.keys(extra).forEach((k) => u.searchParams.set(k, extra[k]));
      return u.href;
    } catch (e) {
      return REF_PAGE + "?" + REF_PARAM + "=" + code;
    }
  }

  /* ---------- Copy + share ---------- */
  async function copyText(text, msg) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {}
    if (!ok) {
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(t);
      t.select();
      try {
        ok = document.execCommand("copy");
      } catch (e) {}
      t.remove();
    }
    toast(ok ? msg : "Couldn't copy. Press and hold the link to copy it.");
  }

  function closeSheet() {
    $("shareSheet").hidden = true;
  }

  function openSheet(title, text, url) {
    const msg = text + " " + url;
    const e = encodeURIComponent;
    const opts = [
      ["WhatsApp", "https://wa.me/?text=" + e(msg), "#25d366"],
      [
        "Telegram",
        "https://t.me/share/url?url=" + e(url) + "&text=" + e(text),
        "#229ed9",
      ],
      [
        "X",
        "https://twitter.com/intent/tweet?text=" + e(text) + "&url=" + e(url),
        "#111",
      ],
      ["Email", "mailto:?subject=" + e(title) + "&body=" + e(msg), "#6b7a73"],
      ["SMS", "sms:?body=" + e(msg), "#2eb487"],
    ];
    $("shareSheet").innerHTML =
      '<div class="sh-box" role="dialog" aria-modal="true" aria-label="Share"><strong class="sh-title">Share your link</strong>' +
      '<div class="sh-grid">' +
      opts
        .map(
          (o) =>
            `<a class="sh-opt" href="${o[1]}" target="_blank" rel="noopener noreferrer"><span class="sh-dot" style="background:${o[2]}">${o[0][0]}</span>${o[0]}</a>`,
        )
        .join("") +
      '<button class="sh-opt" type="button" id="shCopy"><span class="sh-dot" style="background:#7d7d7d">⧉</span>Copy link</button></div>' +
      '<button class="sh-close" type="button" id="shClose">Close</button></div>';
    $("shareSheet").hidden = false;
    $("shCopy").onclick = () => {
      copyText(url, "Referral link copied.");
      closeSheet();
    };
    $("shClose").onclick = closeSheet;
  }
  if ($("shareSheet"))
    $("shareSheet").addEventListener("click", (ev) => {
      if (ev.target.id === "shareSheet") closeSheet();
    });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeSheet();
  });

  async function share(title, text, url) {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (mobile && navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    openSheet(title, text, url);
  }

  /* ---------- Tabs ---------- */
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("hidden", panel.id !== "tab-" + tab.dataset.tab);
      });
    });
  });

  /* ---------- Referrals ---------- */
  function renderTree() {
    const F = REFERRAL.friends.slice(0, 8);
    const slots = F.length ? F : Array.from({ length: 5 }, () => null);
    const cx = 160,
      cy = 130,
      R = 92,
      n = slots.length;
    let lines = "",
      nodes = "";
    slots.forEach((fr, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const x = (cx + R * Math.cos(a)).toFixed(1),
        y = (cy + R * Math.sin(a)).toFixed(1);
      const st = fr ? fr.status : "empty";
      lines += `<line class="rt-line ${st}" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" />`;
      nodes +=
        `<circle class="rt-node ${st}" cx="${x}" cy="${y}" r="22" />` +
        `<text class="rt-ini${fr ? "" : " muted"}" x="${x}" y="${y}">${fr ? esc(fr.name[0].toUpperCase()) : "+"}</text>` +
        (fr
          ? `<text class="rt-name" x="${x}" y="${(+y + 36).toFixed(1)}">${esc(fr.name.slice(0, 9))}</text>`
          : "");
    });
    const rewarded = F.filter((f) => f.status === "rewarded").length;
    $("refTree").innerHTML = `
      <div class="card-head"><div><span class="sub-label">Your referral circle</span>
        <strong class="card-title">${F.length ? F.length + (F.length === 1 ? " friend" : " friends") + " in your circle" : "Invite your first friend"}</strong></div>
        <span class="chip ${rewarded ? "" : "grey"}">${rewarded} rewarded</span></div>
      <svg class="rt-svg" viewBox="0 0 320 270" role="img" aria-label="Your referral circle">
        <circle class="rt-ring" cx="${cx}" cy="${cy}" r="${R}" />${lines}
        <circle class="rt-root" cx="${cx}" cy="${cy}" r="32" /><text class="rt-ini" x="${cx}" y="${cy}">You</text>${nodes}
      </svg>
      <div class="rt-legend"><span><i class="d rewarded"></i>Rewarded</span><span><i class="d waiting"></i>Waiting period</span><span><i class="d invited"></i>Invited</span></div>
      <p class="note">You earn from the friends you invite directly. A friend moves to "Waiting" after their first buy, and to "Rewarded" once the waiting period ends.</p>
      <div class="btn-row"><button class="copy-button" type="button" id="treeInvite">Invite a friend</button></div>`;
    $("treeInvite").onclick = () => $("shareRef").click();
  }

  function renderReferrals() {
    const F = REFERRAL.friends;
    const rewarded = F.filter((f) => f.status === "rewarded").length;
    $("statInvited").textContent = F.length;
    $("statJoined").textContent = F.filter(
      (f) => f.status !== "invited",
    ).length;
    $("statQualified").textContent = rewarded;

    const code = inviteCode();
    const link = buildLink(code);
    $("refLink").textContent = link;
    const hint = $("refHint");
    if (hint) {
      const local =
        !SITE_URL && /^(file:|http:\/\/(localhost|127\.))/i.test(location.href);
      hint.hidden = !local;
      if (local)
        hint.textContent =
          "This link only works on this computer. Set SITE_URL in activities.js to your live website so friends can open it.";
    }
    $("refCode").textContent = code;
    $("copyRef").onclick = () => copyText(link, "Referral link copied.");
    $("copyCode").onclick = () => copyText(code, "Invite code copied.");
    $("shareRef").onclick = () =>
      share(
        "Join me on Nexvest",
        "Stack Bitcoin with me on Nexvest. Use my invite code " +
          code +
          " when you sign up.",
        link,
      );

    const earned =
      rewarded * REFERRAL.perFriendSats +
      REFERRAL.milestones
        .filter((m) => rewarded >= m.friends)
        .reduce((s, m) => s + m.bonusSats, 0);
    $("earnedNote").textContent =
      `Earned so far: ${fmt(earned)} sats. Bonuses are paid after a friend qualifies, so they can take a few weeks to show up.`;

    renderTree();

    const steps = [
      [
        "Share your link",
        "Send your referral link or invite code to a friend.",
      ],
      [
        "Your friend signs up",
        "They join with your code, or use your link and it's filled in for them.",
      ],
      [
        "Their first buy",
        `They make a first buy of at least $${REFERRAL.minFirstBuyUsd}.`,
      ],
      [
        "A short waiting period",
        `After ${REFERRAL.holdDays} days with no withdrawal or refund, the referral qualifies. This stops fake accounts.`,
      ],
      [
        "You both get sats",
        `You and your friend each receive ${fmt(REFERRAL.perFriendSats)} sats.`,
      ],
    ];
    $("cycleSteps").innerHTML = stepsHTML(steps);

    $("milestones").innerHTML = REFERRAL.milestones
      .map((m) => {
        const done = rewarded >= m.friends;
        const pct = Math.min(100, Math.round((rewarded / m.friends) * 100));
        return `<div class="milestone"><div>${m.friends} rewarded friends
            <small>${done ? "Unlocked" : rewarded + " of " + m.friends + " so far"}</small>
            <div class="progress"><span style="width:${pct}%"></span></div></div>
          <span class="chip ${done ? "" : "grey"}">+${fmt(m.bonusSats)} sats</span></div>`;
      })
      .join("");
  }

  const stepsHTML = (steps) =>
    steps
      .map(
        ([title, text], i) =>
          `<li class="step"><span class="step-num">${i + 1}</span><div><strong>${title}</strong><p>${text}</p></div></li>`,
      )
      .join("");

  /* ---------- Circles ---------- */
  function circleCode() {
    if (!CIRCLE.code) {
      CIRCLE.code = "C" + inviteCode();
      saveCircle();
    }
    return CIRCLE.code;
  }

  function openCircleForm() {
    const box = $("shareSheet");
    box.innerHTML =
      '<div class="sh-box" role="dialog" aria-modal="true" aria-label="New circle">' +
      '<strong class="sh-title">Start a circle</strong>' +
      '<label class="sh-label" for="cName">Circle name</label>' +
      '<input class="sh-input" id="cName" maxlength="24" placeholder="e.g. Family Stack" autocomplete="off" />' +
      '<label class="sh-label" for="cGoal">Shared goal (sats)</label>' +
      '<input class="sh-input" id="cGoal" type="number" inputmode="numeric" min="100000" step="100000" value="2000000" />' +
      '<p class="note">Up to 5 people. Everyone keeps their own Bitcoin. The circle only shares a goal and a streak.</p>' +
      '<button class="copy-button" type="button" id="cCreate">Create circle</button>' +
      '<button class="sh-close" type="button" id="shClose">Cancel</button></div>';
    box.hidden = false;
    $("cName").focus();
    $("shClose").onclick = closeSheet;
    $("cCreate").onclick = () => {
      const name = $("cName").value.trim();
      const goal = Math.round(Number($("cGoal").value));
      if (!name) return toast("Give your circle a name first.");
      if (!(goal >= 100000))
        return toast("Set a goal of at least 100,000 sats.");
      CIRCLE = Object.assign(emptyCircle(), { name, goalSats: goal });
      delete CIRCLE.empty;
      circleCode();
      saveCircle();
      closeSheet();
      renderCircles();
      toast("Circle created. Invite up to 4 people.");
    };
  }

  function renderCircles() {
    // No circle yet: invite the user to start one
    if (CIRCLE.empty) {
      $("circleCard").innerHTML = `
        <div class="card-head"><div><span class="sub-label">Your circle</span><strong class="card-title">You're not in a circle yet</strong></div></div>
        <p class="note">Start one, then invite friends or family with your link. Each person keeps their own Bitcoin.</p>
        <div class="btn-row"><button class="copy-button" type="button" id="newCircle">Start a circle</button></div>`;
      $("newCircle").onclick = openCircleForm;
    } else {
      const done = CIRCLE.members.filter((m) => m.boughtThisWeek).length;
      const allDone = done === CIRCLE.members.length;
      const open = CIRCLE.maxMembers - CIRCLE.members.length;
      const pct = Math.min(100, (CIRCLE.stackedSats / CIRCLE.goalSats) * 100);

      $("circleCard").innerHTML = `
        <div class="card-head"><div><span class="sub-label">Your circle</span><strong class="card-title">${esc(CIRCLE.name)}</strong></div>
          <span class="chip ${CIRCLE.streakWeeks ? "" : "grey"}">${CIRCLE.streakWeeks} week streak</span></div>
        <div class="members">
          ${CIRCLE.members.map((m) => `<div class="member"><span class="avatar ${m.boughtThisWeek ? "" : "pending"}">${esc(m.name[0])}</span><span>${esc(m.name)}</span><small>${m.boughtThisWeek ? "Bought" : "Not yet"}</small></div>`).join("")}
          ${Array.from({ length: Math.max(0, open) }, () => '<div class="member"><span class="avatar pending">+</span><span>Open</span><small>&nbsp;</small></div>').join("")}
        </div>
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div class="goal-numbers"><span>${fmt(CIRCLE.stackedSats)} sats together</span><span>of ${fmt(CIRCLE.goalSats)} sats</span></div>
        <p class="note">${
          allDone
            ? `Everyone bought this week, so the circle gets ${CIRCLE.discountPct}% off fees next week.`
            : `${done} of ${CIRCLE.members.length} bought this week. If everyone does, the circle gets ${CIRCLE.discountPct}% off fees next week.`
        }</p>
        <span class="circle-code">Circle code: ${esc(circleCode())}</span>
        <div class="btn-row">
          <button class="copy-button ghost" type="button" id="newCircle">New circle</button>
          <button class="copy-button" type="button" id="inviteCircle">Invite to circle</button>
        </div>
        <button class="link-btn" type="button" id="leaveCircle">Leave this circle</button>`;

      $("newCircle").onclick = openCircleForm;
      $("inviteCircle").onclick = () => {
        const code = inviteCode();
        share(
          "Join my Stack Circle",
          `Join my Stack Circle "${CIRCLE.name}" on Nexvest. Use my invite code ${code} when you sign up.`,
          buildLink(code, { circle: circleCode() }),
        );
      };
      $("leaveCircle").onclick = () => {
        if (!confirm("Leave this circle? Your Bitcoin stays yours.")) return;
        CIRCLE = emptyCircle();
        saveCircle();
        renderCircles();
        toast("You left the circle.");
      };
    }

    $("circleSteps").innerHTML = stepsHTML([
      [
        "Create or join a circle",
        "Up to 5 people. Each person has their own account and their own Bitcoin.",
      ],
      [
        "Set a shared goal",
        "The circle's goal is the total of what everyone has stacked.",
      ],
      [
        "Buy every week",
        "When all members make a buy in the same week, the circle streak grows.",
      ],
      [
        "Earn a fee discount",
        `A full week gives the circle ${CIRCLE.discountPct}% off fees the next week.`,
      ],
    ]);
  }

  /* ---------- Buy streak (Updates tab) ---------- */
  function renderStreak() {
    const W = WEEKLY_BUYS;
    let streak = 0;
    for (let i = W[0] ? 0 : 1; i < W.length && W[i]; i++) streak++;
    const total = W.filter(Boolean).length;
    $("streakTitle").textContent = streak
      ? streak + (streak === 1 ? " week in a row" : " weeks in a row")
      : "Start your streak";
    $("streakChip").textContent = total + " of 12 weeks";
    $("streakChip").className = "chip" + (total ? "" : " grey");
    $("streakGrid").innerHTML = W.map((on, i) => ({ on, i }))
      .reverse()
      .map(
        ({ on, i }) =>
          `<span class="wk${on ? " on" : ""}${i === 0 ? " now" : ""}" title="${i === 0 ? "This week" : i + (i === 1 ? " week ago" : " weeks ago")}: ${on ? "bought" : "no buy"}"></span>`,
      )
      .join("");
    $("streakNote").textContent = W[0]
      ? "You've bought this week. Nice work staying consistent."
      : streak
        ? "Buy this week to keep your streak going."
        : "Make a buy this week to start a streak.";
  }

  /* ---------- Updates tab ---------- */
  function renderChecklist() {
    const U = window.NX ? NX.get() : {};
    let bio = true,
      verified = false;
    try {
      const v = JSON.parse(localStorage.getItem("nx_bio"));
      if (v !== null) bio = !!v;
    } catch (e) {}
    try {
      verified = !!JSON.parse(localStorage.getItem("nx_verified"));
    } catch (e) {}
    const items = [
      ["Add your full name", !!(U.firstName && U.lastName), "profile", ""],
      [
        "Add your bank details",
        !!(U.bankName && U.accountNumber && U.accountName),
        "profile",
        "#bank",
      ],
      ["Add your next of kin", !!(U.nokName && U.nokPhone), "profile", "#kin"],
      ["Upload proof of address", !!U.proofName, "profile", ""],
      ["Turn on biometric login", bio, "settings", ""],
      ["Verify your identity", verified, "settings", ""],
    ];
    const done = items.filter((i) => i[1]).length;
    $("checkChip").textContent = done + "/" + items.length;
    $("checkChip").className = "chip" + (done === items.length ? "" : " grey");
    $("checkTitle").textContent =
      done === items.length ? "You're all set" : "Finish setting up";
    $("checkFill").style.width = Math.round((done / items.length) * 100) + "%";
    $("checklist").innerHTML = items
      .map(
        (it, i) =>
          `<li><button type="button" class="ck ${it[1] ? "done" : ""}" data-i="${i}"><span class="ck-box">${it[1] ? "✓" : ""}</span><span class="ck-text">${it[0]}</span><span class="ck-go">${it[1] ? "Done" : "Go ›"}</span></button></li>`,
      )
      .join("");
    $("checklist").onclick = (e) => {
      const b = e.target.closest(".ck");
      if (!b) return;
      const it = items[+b.dataset.i];
      go(it[2], it[3]);
    };
  }

  function ago(days) {
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return days + " days ago";
  }

  function renderFeeds() {
    $("myFeed").innerHTML = MY_ACTIVITY.length
      ? [...MY_ACTIVITY]
          .sort((a, b) => a.daysAgo - b.daysAgo)
          .map(
            (a) =>
              `<li>${icon(a.icon)}<div><strong>${a.text}</strong><small>${ago(a.daysAgo)}</small></div></li>`,
          )
          .join("")
      : "<li><div><strong>No activity yet</strong><small>Your buys, streaks and referrals will show up here.</small></div></li>";

    $("newsList").innerHTML = NEWS.map(
      (n) =>
        `<details class="news"><summary><span class="chip ${n.tag === "New" ? "" : n.tag === "Soon" || n.tag === "Preview" ? "warn" : "grey"}">${n.tag}</span><strong>${n.title}</strong><span class="news-arrow">›</span></summary><p>${n.body}</p></details>`,
    ).join("");

    const chipClass = { Live: "", Beta: "warn", Next: "grey", Planned: "grey" };
    $("projectFeed").innerHTML = PROJECT_UPDATES.map(
      (u) =>
        `<li><div><strong>${u.title}</strong><small>${u.note}</small></div><span class="chip ${chipClass[u.status] || "grey"}">${u.status}</span></li>`,
    ).join("");
  }

  /* ---------- Dip Radar ---------- */
  async function renderRadar() {
    const title = $("radarTitle"),
      chip = $("radarChip"),
      marker = $("radarMarker");
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7",
      );
      if (!res.ok) throw new Error("history failed");
      const json = await res.json();
      const prices = json.prices.map(([, p]) => p);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const now = prices[prices.length - 1];
      const diff = ((now - avg) / avg) * 100;
      marker.style.left = Math.max(0, Math.min(100, 50 + diff * 5)) + "%";
      const abs = Math.abs(diff).toFixed(1);
      if (diff <= -3) {
        title.textContent = `${abs}% below its 7-day average`;
        chip.textContent = "Lower than usual";
        chip.className = "chip";
      } else if (diff >= 3) {
        title.textContent = `${abs}% above its 7-day average`;
        chip.textContent = "Higher than usual";
        chip.className = "chip warn";
      } else {
        title.textContent = "Near its 7-day average";
        chip.textContent = "About usual";
        chip.className = "chip grey";
      }
    } catch (e) {
      title.textContent = "Live price unavailable right now";
      chip.textContent = "Offline";
      chip.className = "chip grey";
    }
  }

  /* ---------- Navigation ---------- */
  const NAV_PAGES = {
    goals: "goals.html",
    home: "home.html",
    learn: "learn.html",
  };
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      const page = NAV_PAGES[item.dataset.nav];
      if (page) window.location.href = page; // "activity" is this page, so nothing to do
    });
  });
  const sb = $("settingsButton");
  if (sb)
    sb.addEventListener(
      "click",
      () => (window.location.href = "settings.html"),
    );
  const yr = $("year");
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- Init ---------- */
  // Each part runs on its own, so one error can't stop the rest.
  function safe(name, fn) {
    try {
      fn();
    } catch (e) {
      console.error(name, e);
      const b = document.createElement("div");
      b.className = "nx-error";
      b.textContent = name + " failed: " + e.message;
      const t = document.querySelector(".page-title");
      if (t) t.after(b);
    }
  }
  safe("Referrals", renderReferrals);
  safe("Circles", renderCircles);
  safe("Checklist", renderChecklist);
  safe("Feeds", renderFeeds);
  safe("Streak", renderStreak);
  safe("Dip Radar", renderRadar);

  // Real deposits, withdrawals and bonuses from the server
  NXAPI.sync()
    .then((me) => {
      (me.transactions || []).forEach((t) => {
        const days = Math.max(
          0,
          Math.floor((Date.now() - new Date(t.date).getTime()) / 86400000),
        );
        const n = Number(t.sats).toLocaleString("en-US");
        const text =
          t.type === "withdrawal"
            ? "Withdrawal of " + n + " sats · " + t.status
            : t.type === "deposit"
              ? "Deposit of " + n + " sats · " + t.status
              : (t.note || "Bonus") + " of " + n + " sats";
        MY_ACTIVITY.push({
          icon: t.type === "bonus" ? "goal" : "buy",
          text: esc(text),
          daysAgo: days,
        });
      });
      safe("Feeds", renderFeeds);
    })
    .catch(() => {});
})();
