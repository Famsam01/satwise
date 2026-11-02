// Usage: node make-admin.js you@email.com   (the account must already be registered)
const Database = require("better-sqlite3");
const db = new Database("nexvest.db");
const r = db
  .prepare("UPDATE users SET is_admin=1 WHERE email=?")
  .run((process.argv[2] || "").toLowerCase());
console.log(
  r.changes
    ? "Done. Now log in at /admin and set up 2FA."
    : "No user with that email.",
);
