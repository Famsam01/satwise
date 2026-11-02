(function () {
  // Shows the username saved at signup (falls back to "Investor")
  var u = "";
  try {
    u = (window.NX && NX.get().username) || "";
  } catch (e) {}
  var el = document.getElementById("homeUser");
  if (el) el.textContent = u || "Investor";
  // Then use the real name from the server
  if (el && window.NXAPI)
    NXAPI.sync()
      .then(function (me) {
        el.textContent = me.username || "Investor";
      })
      .catch(function () {});
})();

// Withdraw button -> withdrawal page
(function () {
  var wb = document.getElementById("withdrawBtn");
  if (!wb) return;
  wb.addEventListener(
    "click",
    function (e) {
      e.stopImmediatePropagation();
      location.href = "withdraw.html";
    },
    true,
  );
})();
