/* Learn page. Needs pages.js loaded first. */

// Change these to your real support details
const SUPPORT_EMAIL = "satwisehr@gmail.com";
const SUPPORT_HOURS = "Monday to Friday, 9:00 to 18:00";

document.getElementById("supportEmailText").textContent = SUPPORT_EMAIL;
document.getElementById("supportHoursText").textContent = SUPPORT_HOURS;

// Prefill name and email if the user signed up on this device
const knownUser = loadUser();
if (knownUser) {
  document.getElementById("supportName").value = knownUser.username || "";
  document.getElementById("supportEmail").value = knownUser.email || "";
}

// Opens the user's email app with the message filled in (no backend needed)
document.getElementById("supportForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const name = document.getElementById("supportName").value.trim();
  const email = document.getElementById("supportEmail").value.trim();
  const topic = document.getElementById("supportTopic").value;
  const message = document.getElementById("supportMessage").value.trim();

  if (!name || !email || !message) {
    showToast("Please fill in your name, email and message.");
    return;
  }

  const subject = encodeURIComponent(`Satwise support: ${topic}`);
  const body = encodeURIComponent(
    `${message}\n\n---\nName: ${name}\nEmail: ${email}`,
  );

  window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  showToast("Opening your email app…");
});
