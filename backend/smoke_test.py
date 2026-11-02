
"""Health check for your RUNNING backend. Use it before you deploy.
 
  Terminal A:   uvicorn main:app --reload        (leave this running)
  Terminal B:   python smoke_test.py              (or: python smoke_test.py http://127.0.0.1:8000)
 
It checks your .env, then signs up a throw-away test account (smoke...@nexvest-smoketest.com) and walks through
login, deposit address, 2FA setup, withdrawal and admin protection.
LOCAL TESTING ONLY: it edits your local database directly (marks the test email verified and gives the test
account 100,000 sats), so never run it against a live site.
"""
import json
import os
import secrets
import smtplib
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import unquote, urlparse
 
from dotenv import load_dotenv
 
BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")
URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
DB = os.getenv("NEXVEST_DB") or str(BASE / "nexvest.db")
count = {"PASS": 0, "FAIL": 0, "SKIP": 0}
 
 
def report(kind: str, msg: str, hint: str = "") -> None:
    """Print one result line (PASS / FAIL / SKIP) and remember it."""
    count[kind] += 1
    print(f"[{kind}] {msg}" + (f"\n       -> {hint}" if hint and kind != "PASS" else ""))
 
 
def check(ok: bool, msg: str, hint: str = "") -> bool:
    """PASS if ok is true, otherwise FAIL with a hint on what to do."""
    report("PASS" if ok else "FAIL", msg, hint)
    return ok
 
 
def call(method: str, path: str, body=None, token: str | None = None):
    """Send one request to the server. Returns (status_code, json_or_text). Status 0 = could not connect."""
    req = urllib.request.Request(URL + path, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"_text": raw[:200].decode(errors="replace")}
 
 
def err_of(data) -> str:
    """The error message from a reply, if any."""
    return str(data.get("error", "")) if isinstance(data, dict) else ""
 
 
def finish() -> None:
    """Print the summary and exit (non-zero if anything failed)."""
    print(f"\nResult: {count['PASS']} passed, {count['FAIL']} failed, {count['SKIP']} skipped.")
    print("All good." if not count["FAIL"] else "Fix the FAIL lines above (start from the first one), then run this again.")
    sys.exit(1 if count["FAIL"] else 0)
 
 
# ---------------------------------------------------------------- 1. your .env
print(f"Checking {URL}\n\n-- Settings in .env --")
check(len(os.getenv("JWT_SECRET", "")) >= 32, "JWT_SECRET is set and long enough", "Run: python new_secrets.py")
check(len(os.getenv("ENC_KEY", "")) >= 32, "ENC_KEY is set and long enough", "Run: python new_secrets.py")
 
if os.getenv("HD_XPUB"):
    report("PASS", "HD_XPUB is set (deposit addresses can be made)")
else:
    report("SKIP", "HD_XPUB is empty, so deposits are switched off", "Put your wallet's zpub (or the test zpub) in .env")
 
token, chat = os.getenv("TELEGRAM_BOT_TOKEN", "").strip(), os.getenv("TELEGRAM_ADMIN_CHAT_ID", "").strip()
if token and chat:
    try:
        payload = json.dumps({"chat_id": chat, "text": "Nexvest smoke test: Telegram is connected."}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=payload, headers={"Content-Type": "application/json"})
        ok = json.loads(urllib.request.urlopen(req, timeout=15).read()).get("ok")
        check(bool(ok), "Telegram works (a test message was sent to you)", "Check the token and chat id")
    except Exception as e:  # noqa: BLE001
        check(False, "Telegram works", f"{e}. Did you message your bot first? Are the token and chat id right?")
else:
    report("SKIP", "Telegram not configured (no alerts or Approve/Reject buttons)", "Fill TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID")
 
smtp = os.getenv("SMTP_URL", "").strip()
if smtp:
    try:
        u = urlparse(smtp)
        server = smtplib.SMTP_SSL(u.hostname, u.port or 465, timeout=15) if u.scheme == "smtps" else smtplib.SMTP(u.hostname, u.port or 587, timeout=15)
        if u.scheme != "smtps":
            server.starttls()
        if u.username:
            server.login(unquote(u.username), unquote(u.password or ""))
        server.quit()
        report("PASS", "Email (SMTP) login works")
    except Exception as e:  # noqa: BLE001
        check(False, "Email (SMTP) login works", str(e))
else:
    report("SKIP", "SMTP_URL is empty: verification codes print in the server terminal", "Fine for testing. Fill it before going live.")
 
# ---------------------------------------------------------------- 2. is the server running?
print("\n-- Server --")
status, _ = call("GET", "/docs")
if status == 0:
    check(False, "Server is reachable", "Nothing is listening. In another terminal: cd backend, activate venv, run  uvicorn main:app --reload  and keep it open. Read that window for errors.")
    finish()
check(status == 200, f"Server is running at {URL} (API docs page opens)")
 
# ---------------------------------------------------------------- 3. behaviour with a test account
print("\n-- Accounts and login --")
email = f"smoke{secrets.token_hex(3)}@nexvest-smoketest.com"
password = "SmokeTest-" + secrets.token_hex(4)
 
status, d = call("GET", "/api/me")
check(status == 401, "Protected pages refuse visitors who are not signed in", f"got {status}")
 
status, d = call("POST", "/api/register", {"email": email, "password": password})
if not check(status == 200 and bool(d.get("token")), "Sign up works", err_of(d) or f"got {status}"):
    finish()
tok = d["token"]
check(d.get("emailVerified") is False, "New accounts start with an unverified email")
 
status, d = call("POST", "/api/login", {"email": email, "password": "wrong-password"})
check(status == 401, "A wrong password is refused", f"got {status}")
 
status, d = call("POST", "/api/withdraw", {"method": "btc", "sats": 20000, "address": "bc1q" + "x" * 38}, tok)
check(status == 403 and "email" in err_of(d).lower(), "Withdrawing is blocked until the email is verified", f"got {status} {err_of(d)}")
 
# Local shortcut: the real code was printed in the server terminal or emailed. Here we mark it verified directly.
try:
    with sqlite3.connect(DB, timeout=30) as conn:
        conn.execute("UPDATE users SET email_verified=1 WHERE email=?", (email,))
    status, d = call("GET", "/api/me", token=tok)
    check(d.get("emailVerified") is True, "Email verified (set directly in the database for this test)", f"Is the script using the same database as the server? {DB}")
except sqlite3.Error as e:
    check(False, "Could open the database to verify the test email", str(e))
    finish()
 
status, d = call("POST", "/api/login", {"email": email, "password": password})
check(status == 200 and bool(d.get("token")), "Login with the right password works", err_of(d))
tok = d.get("token", tok)
 
print("\n-- Deposits --")
status, d1 = call("GET", "/api/deposit-address", token=tok)
if status == 503:
    report("SKIP", "Deposit address (HD_XPUB is not set on the server)", "Add HD_XPUB to .env and restart the server")
else:
    ok = check(status == 200 and str(d1.get("address", "")).startswith(("bc1", "1", "3")), "A deposit address is created", err_of(d1) or f"got {status}")
    if ok:
        _, d2 = call("GET", "/api/deposit-address", token=tok)
        check(d2.get("address") == d1["address"], "The same address is shown again while it is unused")
        _, d3 = call("GET", "/api/deposit-address?new=1", token=tok)
        check(d3.get("address") != d1["address"], "'New address' gives a different address")
 
print("\n-- 2FA --")
status, d = call("POST", "/api/2fa/setup", token=tok)
check(status == 200 and bool(d.get("secret")), "2FA setup returns a secret key for the authenticator app", err_of(d))
 
print("\n-- Withdrawals --")
status, d = call("POST", "/api/withdraw", {"method": "btc", "sats": 20000, "address": "bc1q" + "x" * 38}, tok)
check(status == 400, "Withdrawing more than the balance is refused", f"got {status} {err_of(d)}")
try:
    with sqlite3.connect(DB, timeout=30) as conn:
        conn.execute("UPDATE users SET balance_sats=100000 WHERE email=?", (email,))
        uid = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()[0]
        conn.execute("INSERT INTO ledger (user_id,kind,ref,sats,balance_after,created_at) VALUES (?,?,?,?,?,datetime('now'))",
                     (uid, "admin_adjust", "smoke-test", 100000, 100000))
except sqlite3.Error as e:
    check(False, "Could give the test account some sats", str(e))
    finish()
status, d = call("POST", "/api/withdraw", {"method": "btc", "sats": 20000, "address": "bc1q" + "x" * 38}, tok)
if check(status == 200 and d.get("withdrawal", {}).get("status") == "Pending", "A withdrawal request is accepted as Pending", err_of(d) or f"got {status}"):
    check(d.get("balanceSats") == 80000, "Balance dropped from 100,000 to 80,000 straight away", f"balance is {d.get('balanceSats')}")
    print(f"       -> If Telegram is set up, a message with Approve / Reject buttons for {d['withdrawal']['id']} should be on your phone now.")
    print("       -> Press Reject, then run: python show_db.py withdrawals   (status Rejected) and the balance returns to 100,000.")
 
print("\n-- Admin protection --")
status, d = call("GET", "/api/admin/overview", token=tok)
check(status == 403, "A normal user cannot open admin data", f"got {status}")
status, _ = call("GET", "/admin")
check(status == 200, "The admin dashboard page opens at /admin", "Does backend/public contain index.html and admin.js (lowercase)? Open http://127.0.0.1:8000/admin/ to see the error.")
 
print("\n-- Your website pages --")
for page in ["/login.html", "/home.html", "/deposit.html", "/withdraw.html", "/profile.html"]:
    status, _ = call("GET", page)
    if status == 200:
        report("PASS", f"{page} opens")
    else:
        report("SKIP", f"{page} not found", "Put it in the TEMPLATES folder (next to backend)")
for js in ["/static/js/nx-api.js", "/static/JS/nx-api.js"]:
    status, _ = call("GET", js)
    if status == 200:
        report("PASS", f"{js} opens")
        break
else:
    report("SKIP", "nx-api.js not found under /static/js/", "Check the folder name and the <script src> paths in your HTML (lowercase js is safest)")
 
print(f"\nThe test account was {email}. You can ignore it.")
finish()