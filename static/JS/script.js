const loginView = document.getElementById("loginView");
const signupView = document.getElementById("signupView");
const toast = document.getElementById("toast");
const phoneInput = document.getElementById("phone");

const phoneValidator = window.intlTelInput(phoneInput, {
  initialCountry: "ng",
  separateDialCode: true,
  nationalMode: true,
  allowDropdown: true,
  autoPlaceholder: "polite",
  countrySearch: true,
  loadUtils: () =>
    import("https://cdn.jsdelivr.net/npm/intl-tel-input@latest/build/js/utils.js"),
});

/* ---------- Demo storage (replace with a real backend) ---------- */
// Saved in this browser only. Never store passwords here.
function loadUser() {
  try {
    return JSON.parse(localStorage.getItem("nexvest_user"));
  } catch (e) {
    return null;
  }
}

function saveUser(user) {
  try {
    localStorage.setItem("nexvest_user", JSON.stringify(user));
    return true;
  } catch (e) {
    return false;
  }
}

// Every new account gets its own invite code (no 0/O/1/I so it is easy to read out)
function generateInviteCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join("");
}

let toastTimer;

// Display a message
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

// Switch between login and signup
function showView(view) {
  const showSignup = view === "signup";

  loginView.classList.toggle("hidden", showSignup);
  signupView.classList.toggle("hidden", !showSignup);

  window.scrollTo({
    top: 0,
    behavior: "smooth",
  });
}

// Connect page navigation buttons
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    showView(button.dataset.view);
  });
});

// Show or hide passwords
document.querySelectorAll("[data-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.toggle);

    const show = input.type === "password";

    input.type = show ? "text" : "password";

    button.setAttribute("aria-label", show ? "Hide password" : "Show password");

    button.textContent = show ? "⊘" : "◉";
  });
});

// Highlight the selected account type
document.querySelectorAll('input[name="accountType"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    document.querySelectorAll(".account-option").forEach((option) => {
      option.classList.remove("selected");
    });

    radio.closest(".account-option").classList.add("selected");
  });
});

// Login form validation
document.getElementById("loginForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const email = document.getElementById("loginEmail");
  const password = document.getElementById("loginPassword");

  if (!email.value.trim() || !password.value) {
    showToast("Please enter your email/username and password.");

    (!email.value.trim() ? email : password).focus();
    return;
  }

  showToast("Demo only: connect a backend to log in.");
});

// Signup form validation

document.getElementById("signupForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const form = event.currentTarget;

  const email = document.getElementById("signupEmail");
  const phone = document.getElementById("phone");
  const password = document.getElementById("signupPassword");
  const consent = document.getElementById("consent");

  if (!email.checkValidity()) {
    showToast("Please enter a valid email address.");
    email.focus();
    return;
  }

  if (!phoneValidator.isValidNumber()) {
    showToast("Please select a country and enter a valid phone number.");
    phone.focus();
    return;
  }

  const internationalPhoneNumber = phoneValidator.getNumber();

  if (password.value.length < 8) {
    showToast("Your password must contain at least 8 characters.");

    password.focus();
    return;
  }

  if (!consent.checked) {
    showToast("Please agree to the Privacy Policy to continue.");

    consent.focus();
    return;
  }

  const accountType = form.querySelector(
    'input[name="accountType"]:checked',
  ).value;

  showToast(
    `Form validated for ${accountType} account. ` +
      "Connect a secure backend to create the account.",
  );
});

// Forgot password
document.getElementById("forgotButton").addEventListener("click", () => {
  showToast("Password recovery needs a backend connection.");
});

// Switch account
document.getElementById("switchAccount").addEventListener("click", () => {
  document.getElementById("loginEmail").value = "";
  document.getElementById("loginPassword").value = "";

  document.getElementById("loginEmail").focus();

  showToast("Enter the details for your other account.");
});

// Biometric login demonstration
document.getElementById("biometricButton").addEventListener("click", () => {
  showToast("Biometric login is not enabled in this demo.");
});

// Privacy policy placeholder
document.getElementById("privacyLink").addEventListener("click", (event) => {
  event.preventDefault();

  showToast("Add your actual Privacy Policy page before publishing.");
});

// Automatically update the copyright year
document.getElementById("year").textContent = new Date().getFullYear();

NX.saveSignup({
  username: document.getElementById("signupUsername").value.trim(),
  email: document.getElementById("signupEmail").value.trim(),
  phone: document.getElementById("phone").value.trim(), // or iti.getNumber() for the full +234... number
  accountType: document.querySelector('input[name="accountType"]:checked')
    .value,
});
