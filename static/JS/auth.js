(function () {
  const $ = (id) => document.getElementById(id);
  const loginView = $("loginView");
  const signupView = $("signupView");
  const toast = $("toast");
  const phoneInput = $("phone");

  // Phone input (country picker)
  let phoneValidator = null;
  try {
    phoneValidator = window.intlTelInput(phoneInput, {
      initialCountry: "ng",
      separateDialCode: true,
      nationalMode: true,
      allowDropdown: true,
      autoPlaceholder: "polite",
      countrySearch: true,
      loadUtils: () =>
        import("https://cdn.jsdelivr.net/npm/intl-tel-input@latest/build/js/utils.js"),
    });
  } catch (e) {}

  // ---------- helpers ----------
  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }
  function showView(view) {
    const showSignup = view === "signup";
    loginView.classList.toggle("hidden", showSignup);
    signupView.classList.toggle("hidden", !showSignup);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function busy(btn, on, text) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = text || "Please wait…";
    } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = on;
  }
  function done() {
    location.href = "/home.html";
  }

  // ---------- email verification popup (built here, no HTML changes needed) ----------
  const panel = document.createElement("div");
  panel.style.cssText =
    "display:none;position:fixed;inset:0;z-index:100;align-items:center;justify-content:center;background:rgba(0,0,0,.7);padding:16px";
  panel.innerHTML = `
    <div style="background:#fff;color:#111;max-width:380px;width:100%;border-radius:16px;padding:24px;font-family:inherit">
      <h2 style="margin:0 0 8px;font-size:20px">Verify your email</h2>
      <p id="vText" style="margin:0 0 16px;font-size:14px;line-height:1.5"></p>
      <input id="vCode" inputmode="numeric" maxlength="6" placeholder="6-digit code"
        style="width:100%;box-sizing:border-box;padding:12px;font-size:20px;letter-spacing:6px;text-align:center;border:1px solid #bbb;border-radius:10px;margin-bottom:12px">
      <button id="vBtn" style="width:100%;padding:12px;border:0;border-radius:10px;background:#111;color:#fff;font-size:15px;cursor:pointer">Verify</button>
      <button id="resendBtn" style="width:100%;padding:10px;margin-top:8px;border:0;background:none;color:#111;cursor:pointer;text-decoration:underline">Resend code</button>
      <button id="vOut" style="width:100%;padding:8px;border:0;background:none;color:#666;font-size:13px;cursor:pointer">Use a different account</button>
    </div>`;
  document.body.appendChild(panel);

  let cooldownTimer = null;
  function startCooldown(seconds) {
    const b = $("resendBtn");
    clearInterval(cooldownTimer);
    let left = seconds;
    b.disabled = true;
    const tick = () => {
      b.textContent = left > 0 ? "Resend in " + left + "s" : "Resend code";
      if (left <= 0) {
        b.disabled = false;
        clearInterval(cooldownTimer);
      }
      left--;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }
  function showVerify(email) {
    $("vText").textContent =
      "We sent a 6-digit code to " +
      (email && email.includes("@") ? email : "your email address") +
      ". It expires in 15 minutes.";
    $("vCode").value = "";
    panel.style.display = "flex";
    startCooldown(60);
    $("vCode").focus();
  }
  $("vCode").addEventListener("input", () => {
    $("vCode").value = $("vCode").value.replace(/\D/g, "").slice(0, 6);
  });
  $("vBtn").addEventListener("click", async () => {
    const code = $("vCode").value.trim();
    if (!/^\d{6}$/.test(code)) return showToast("Enter the 6-digit code.");
    busy($("vBtn"), true, "Checking…");
    try {
      await NXAPI.verifyEmail(code);
      done();
    } catch (x) {
      showToast(x.message);
    } finally {
      busy($("vBtn"), false);
    }
  });
  $("resendBtn").addEventListener("click", async () => {
    try {
      await NXAPI.resendVerification();
      showToast("A new code was sent.");
      startCooldown(60);
    } catch (x) {
      showToast(x.message);
    }
  });
  $("vOut").addEventListener("click", () => {
    localStorage.removeItem("nx_token");
    panel.style.display = "none";
  });

  // ---------- page buttons ----------
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.addEventListener("click", () => showView(b.dataset.view)),
    );
  document.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", () => {
      const input = $(b.dataset.toggle);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "⊘" : "◉";
    }),
  );
  document.querySelectorAll('input[name="accountType"]').forEach((radio) =>
    radio.addEventListener("change", () => {
      document
        .querySelectorAll(".account-option")
        .forEach((o) => o.classList.remove("selected"));
      radio.closest(".account-option").classList.add("selected");
    }),
  );

  // ---------- login ----------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    if (!email || !password)
      return showToast("Please enter your email/username and password.");
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    busy(btn, true);
    try {
      await NXAPI.login(email, password);
      done();
    } catch (x) {
      showToast(x.message);
    } finally {
      busy(btn, false);
    }
  });

  // ---------- sign up ----------
  $("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = $("signupEmail");
    const password = $("signupPassword");

    if (!email.checkValidity())
      return showToast("Please enter a valid email address.");
    if (phoneValidator && !phoneValidator.isValidNumber())
      return showToast(
        "Please select a country and enter a valid phone number.",
      );
    if (password.value.length < 8)
      return showToast("Your password must contain at least 8 characters.");
    if (!$("consent").checked)
      return showToast("Please agree to the Privacy Policy to continue.");

    const phone = phoneValidator
      ? phoneValidator.getNumber()
      : phoneInput.value.trim();
    const username =
      ($("signupUsername") ? $("signupUsername").value.trim() : "") ||
      undefined;
    const accountType = form.querySelector(
      'input[name="accountType"]:checked',
    ).value;
    const ref = (NXAPI.refFromUrl() || "").toUpperCase() || undefined;

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true);
    try {
      await NXAPI.register(email.value.trim(), password.value, ref, {
        username,
        phone,
        account_type: accountType,
      });
      showVerify(email.value.trim());
    } catch (x) {
      showToast(x.message);
    } finally {
      busy(btn, false);
    }
  });

  // ---------- other buttons ----------
  const on = (id, fn) => $(id) && $(id).addEventListener("click", fn);
  on("forgotButton", () =>
    showToast("Password recovery is not available yet."),
  );
  on("privacyLink", (e) => {
    e.preventDefault();
    showToast("Add your actual Privacy Policy page before publishing.");
  });
  if ($("year")) $("year").textContent = new Date().getFullYear();

  if (NXAPI.refFromUrl()) showView("signup");

  // Already signed in? Skip this page (or ask for the email code).
  if (localStorage.getItem("nx_token")) {
    NXAPI.api("/api/me", { noRedirect: true })
      .then(() => done())
      .catch(() => localStorage.removeItem("nx_token"));
  }
})();
