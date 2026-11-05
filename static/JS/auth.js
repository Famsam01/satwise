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

    const typed = $("inviteInput") ? $("inviteInput").value.trim() : "";
    const ref = (typed || NXAPI.refFromUrl() || "").toUpperCase() || undefined;

    const btn = form.querySelector('button[type="submit"]');
    busy(btn, true);
    try {
      await NXAPI.register(email.value.trim(), password.value, ref, {
        username,
        phone,
        account_type: accountType,
      });
      done(); // goes straight to /home.html, with no verification step
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
