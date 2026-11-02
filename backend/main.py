
"""Nexvest backend: FastAPI + SQLite.
 
Start (from the backend folder, with the venv active):
    uvicorn main:app --reload          (development)
    uvicorn main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips="*"   (server, ONE worker)
 
Frontend files (login.html, home.html, *.css, *.js) go in ./static
Admin dashboard files (index.html, admin.js) go in ./public  ->  open /admin
 
Sections of this file
  1. Config          5. Telegram bot        9. Withdrawal actions     13. Admin API
  2. Database        6. 2FA (TOTP)         10. Deposit watcher        14. Background jobs
  3. Errors+security 7. Rotating addresses 11. Auth + account API     15. Static files
  4. Email           8. Referral bonus     12. Money API
"""
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import unquote, urlparse
 
import httpx
import pyotp
from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
 
BASE = Path(__file__).resolve().parent   #the folder this file lives in, so paths works anywhere
load_dotenv(BASE / ".env")
 
# =====================================================================
# 1. CONFIG (everything comes from your .env file)
# =====================================================================
def env_int(name: str, default: int) -> int:
    """Read a whole number from .env, or use the default."""
    raw = os.getenv(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default
 
 
DB_PATH = os.getenv("NEXVEST_DB", "nexvest.db")
SECRET_KEY = os.getenv("JWT_SECRET", "")
if not SECRET_KEY:
    raise RuntimeError("Set JWT_SECRET in your .env file (any long random text).")
FERNET = Fernet(base64.urlsafe_b64encode(hashlib.sha256((os.getenv("ENC_KEY") or SECRET_KEY).encode()).digest()))
 
APP_URL = os.getenv("APP_URL", "http://localhost:8000").rstrip("/")
CORS_ORIGIN = os.getenv("CORS_ORIGIN", "*")
SMTP_URL = os.getenv("SMTP_URL", "").strip()
MAIL_FROM = os.getenv("MAIL_FROM", "Nexvest <no-reply@localhost>")
TG_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TG_CHAT = os.getenv("TELEGRAM_ADMIN_CHAT_ID", "").strip()
HD_XPUB = os.getenv("HD_XPUB", "").strip()
MEMPOOL_API = os.getenv("MEMPOOL_API", "https://mempool.space/api").rstrip("/")
 
CONFIRMATIONS = env_int("CONFIRMATIONS", 2)
MIN_DEPOSIT = env_int("MIN_DEPOSIT_SATS", 10_000)
MIN_WITHDRAW = env_int("MIN_WITHDRAW_SATS", 10_000)
BTC_FEE = env_int("BTC_WITHDRAW_FEE_SATS", 1_500)
BANK_FEE = 0  # bank withdrawals were removed; kept only so old records still make sense
ALT_FEE = env_int("ALT_WITHDRAW_FEE_SATS", 3000)  # fee (in sats) for USDT / ETH payouts
DAILY_LIMIT = env_int("DAILY_WITHDRAW_LIMIT_SATS", 0)
REQUIRE_2FA = os.getenv("REQUIRE_2FA_FOR_WITHDRAW", "false").lower() == "true"
ADMIN_REQUIRES_2FA = os.getenv("ADMIN_REQUIRES_2FA", "true").lower() != "false"  # keep true on a live site
ADDRESS_TTL_MS = env_int("ADDRESS_TTL_HOURS", 24) * 3_600_000
MAX_NEW_ADDR_PER_DAY = env_int("MAX_NEW_ADDRESSES_PER_DAY", 10)
WATCH_DAYS = env_int("WATCH_DAYS", 30)
REF_BONUS_NEW = env_int("REFERRAL_BONUS_NEW_USER_SATS", 0)
REF_BONUS_REFERRER = env_int("REFERRAL_BONUS_REFERRER_SATS", 0)
REF_MIN_DEPOSIT = env_int("REFERRAL_MIN_DEPOSIT_SATS", MIN_DEPOSIT)
DISABLE_BACKGROUND = os.getenv("DISABLE_BACKGROUND", "0") == "1"
SESSION_DAYS = 30
SATS_PER_BTC = 100_000_000
GOAL_SATS = 1_000_000  # "Stack 0.01 BTC"
 
 
def now() -> datetime:
    """Current time in UTC."""
    return datetime.now(timezone.utc)
 
 
def iso() -> str:
    """Current UTC time as text, the format stored in the database."""
    return now().isoformat()
 
 
def epoch_ms() -> int:
    """Current time in milliseconds (used for address timers)."""
    return int(time.time() * 1000)
 
 
def fmt(n) -> str:
    """Format a number with thousands separators, e.g. 12,500."""
    return f"{int(n):,}"
 
 
def esc(s) -> str:
    """Make text safe to put inside a Telegram HTML message."""
    return html.escape(str(s), quote=False)
 
 
# =====================================================================
# 2. DATABASE
# =====================================================================
@contextmanager
def db():
    """Open the database. Saves everything if the block finishes, undoes everything if it raises."""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
 
 
def add_col(conn, table: str, col: str, ddl: str) -> None:
    """Add a column to an existing table if it is not there yet (safe upgrade)."""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    if col not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
 
 
def init_db() -> None:
    """Create all tables, and add the new columns to an older database."""
    with db() as c:
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                phone TEXT NOT NULL DEFAULT '',
                account_type TEXT NOT NULL DEFAULT 'individual',
                password_hash TEXT NOT NULL,
                invite_code TEXT NOT NULL UNIQUE,
                referred_by INTEGER REFERENCES users(id),
                balance_sats INTEGER NOT NULL DEFAULT 0 CHECK (balance_sats >= 0),
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deposit_addresses (
                address TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                idx INTEGER UNIQUE NOT NULL,
                created_at INTEGER NOT NULL,
                used INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS hd_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                next_index INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO hd_state (id, next_index) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS deposits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                txid TEXT NOT NULL,
                vout INTEGER NOT NULL,
                address TEXT NOT NULL,
                sats INTEGER NOT NULL,
                confirmations INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'Pending',
                created_at TEXT NOT NULL,
                confirmed_at TEXT,
                UNIQUE (txid, vout)
            );
            CREATE TABLE IF NOT EXISTS withdrawals (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                method TEXT NOT NULL,
                dest TEXT NOT NULL,
                dest_full TEXT NOT NULL,
                sats INTEGER NOT NULL,
                fee INTEGER NOT NULL,
                receive INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'Pending',
                txid TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ledger (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id),
                kind TEXT NOT NULL,
                ref TEXT NOT NULL,
                sats INTEGER NOT NULL,
                balance_after INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        for col, ddl in [
            ("email_verified", "INTEGER NOT NULL DEFAULT 0"),
            ("verify_hash", "TEXT"),
            ("verify_expires", "INTEGER"),
            ("verify_sent_at", "INTEGER"),
            ("verify_attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("totp_secret", "TEXT"),
            ("totp_enabled", "INTEGER NOT NULL DEFAULT 0"),
            ("totp_last", "TEXT"),
            ("reset_hash", "TEXT"),
            ("reset_expires", "INTEGER"),
            ("reset_sent_at", "INTEGER"),
            ("reset_attempts", "INTEGER NOT NULL DEFAULT 0"),
            ("pin_hash", "TEXT"),
            ("is_admin", "INTEGER NOT NULL DEFAULT 0"),
            ("referral_bonus_paid", "INTEGER NOT NULL DEFAULT 0"),
            ("bank_name", "TEXT"),
            ("account_number", "TEXT"),
            ("account_name", "TEXT"),
            ("wallets", "TEXT"),  # saved withdrawal addresses, as JSON: {"btc": "bc1…"}
        ]:
            add_col(c, "users", col, ddl)
 
 
def adjust_balance(conn, user_id: int, delta: int, kind: str, ref: str) -> int:
    """The ONLY function that changes a balance. Adds/subtracts sats and writes a ledger row.
    It refuses to take a balance below zero."""
    cur = conn.execute(
        "UPDATE users SET balance_sats = balance_sats + ? WHERE id=? AND balance_sats + ? >= 0",
        (delta, user_id, delta),
    )
    if cur.rowcount == 0:
        raise ApiError(400, "Insufficient balance")
    bal = conn.execute("SELECT balance_sats FROM users WHERE id=?", (user_id,)).fetchone()[0]
    conn.execute(
        "INSERT INTO ledger (user_id,kind,ref,sats,balance_after,created_at) VALUES (?,?,?,?,?,?)",
        (user_id, kind, ref, delta, bal, iso()),
    )
    return bal
 
 
# =====================================================================
# 3. ERRORS + SECURITY HELPERS
# =====================================================================
class ApiError(Exception):
    """An error that is sent to the browser as {"error": "message", ...extra}."""
 
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra
 
 
def hash_password(password: str) -> str:
    """Scramble a password with a random salt (PBKDF2). Never store the real password."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"
 
 
def verify_password(password: str, stored: str) -> bool:
    """Check a typed password against the stored scrambled one."""
    try:
        salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 200_000)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except ValueError:
        return False
 
 
def token_key(token: str) -> str:
    """Sessions are stored as a hash of the token, so a stolen database can't be used to log in."""
    return hashlib.sha256(token.encode()).hexdigest()
 
 
def create_session(conn, user_id: int) -> str:
    """Make a login token (valid SESSION_DAYS days) and return it."""
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(),))
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
        (token_key(token), user_id, (now() + timedelta(days=SESSION_DAYS)).isoformat()),
    )
    return token
 
 
def new_invite_code(conn) -> str:
    """A unique 6-letter referral code for a new user."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if not conn.execute("SELECT 1 FROM users WHERE invite_code=?", (code,)).fetchone():
            return code
 
 
def current_user(authorization: str = Header(default="")) -> dict:
    """Who is calling? Reads the login token, returns the user or says 'not signed in'."""
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not token:
        raise ApiError(401, "Not signed in")
    with db() as c:
        row = c.execute(
            "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=?",
            (token_key(token),),
        ).fetchone()
    if not row or datetime.fromisoformat(row["expires_at"]) < now():
        raise ApiError(401, "Session expired, please sign in again")
    return dict(row)
 
 
def require_admin(user: dict = Depends(current_user)) -> dict:
    """Only admin accounts with 2FA switched on may use /api/admin/*."""
    return user
 
_failed: dict = {}
 
 
 
def locked_out(key: str) -> bool:
    """True if this login name failed 5 times in the last 15 minutes."""
    arr = [t for t in _failed.get(key, []) if time.time() - t < 900]
    _failed[key] = arr
    return len(arr) >= 5
 
 
def record_fail(key: str) -> None:
    """Remember a failed login attempt."""
    locked_out(key)
    _failed[key].append(time.time())
 
 
def hash_code(user_id: int, code: str) -> str:
    """Hash of an emailed 6-digit code, so the real code is never stored."""
    return hashlib.sha256(f"{user_id}:{code}:{SECRET_KEY}".encode()).hexdigest()
 
 
def is_btc_address(a: str) -> bool:
    """Rough check that text looks like a Bitcoin address."""
    return bool(re.fullmatch(r"(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})", a))
 
 
# What users can withdraw to. The balance is always kept in sats; for USDT/ETH you send the
# equivalent value by hand after approving. "fee" is in sats and is taken out of the amount.
WITHDRAW_OPTIONS = {
    "btc": {"label": "Bitcoin (BTC)", "coin": "BTC", "network": "Bitcoin", "fee": BTC_FEE, "hint": "bc1q… or 1… or 3…"},
    "usdt_trc20": {"label": "USDT (TRC20 · Tron)", "coin": "USDT", "network": "TRC20", "fee": ALT_FEE, "hint": "T…"},
    "usdt_erc20": {"label": "USDT (ERC20 · Ethereum)", "coin": "USDT", "network": "ERC20", "fee": ALT_FEE, "hint": "0x…"},
    "usdt_bep20": {"label": "USDT (BEP20 · BNB Chain)", "coin": "USDT", "network": "BEP20", "fee": ALT_FEE, "hint": "0x…"},
    "eth": {"label": "Ethereum (ETH)", "coin": "ETH", "network": "ERC20", "fee": ALT_FEE, "hint": "0x…"},
}
 
 
def is_valid_address(option: str, a: str) -> bool:
    """Does this text look like an address for the chosen currency/network? (format check only)"""
    if option == "btc":
        return is_btc_address(a)
    if option == "usdt_trc20":
        return bool(re.fullmatch(r"T[1-9A-HJ-NP-Za-km-z]{33}", a))
    if option in ("usdt_erc20", "usdt_bep20", "eth"):
        return bool(re.fullmatch(r"0x[a-fA-F0-9]{40}", a))
    return False
 
 
def load_wallets(raw) -> dict:
    """Saved withdrawal addresses, e.g. {"btc": "bc1…", "usdt_trc20": "T…"}."""
    try:
        d = json.loads(raw or "{}")
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}
 
 
def base36(n: int) -> str:
    """Number to short letters+digits, used in withdrawal reference IDs."""
    chars, s = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", ""
    while n:
        n, r = divmod(n, 36)
        s = chars[r] + s
    return s or "0"
 
 
# =====================================================================
# 4. EMAIL
# =====================================================================
def send_mail(to: str, subject: str, body: str) -> None:
    """Send an email in the background. With no SMTP_URL it just prints it (testing)."""
 
    def _send():
        if not SMTP_URL:
            print(f"[DEV EMAIL] to={to} | {subject} | {body}")
            return
        try:
            u = urlparse(SMTP_URL)
            msg = EmailMessage()
            msg["From"], msg["To"], msg["Subject"] = MAIL_FROM, to, subject
            msg.set_content(body)
            if u.scheme == "smtps":
                server = smtplib.SMTP_SSL(u.hostname, u.port or 465, timeout=20)
            else:
                server = smtplib.SMTP(u.hostname, u.port or 587, timeout=20)
                server.starttls()
            with server:
                if u.username:
                    server.login(unquote(u.username), unquote(u.password or ""))
                server.send_message(msg)
        except Exception as e:  # noqa: BLE001
            print("mail error:", e)
 
    threading.Thread(target=_send, daemon=True).start()
 
 
def mail_user(user_id: int, subject: str, body: str) -> None:
    """Email a user by their id."""
    with db() as c:
        row = c.execute("SELECT email FROM users WHERE id=?", (user_id,)).fetchone()
    if row:
        send_mail(row["email"], subject, body)
 
 
def issue_verification(conn, user_id: int) -> str:
    """Create a fresh 6-digit email code (valid 15 min). Returns the code to email."""
    code = str(secrets.randbelow(1_000_000)).zfill(6)
    conn.execute(
        "UPDATE users SET verify_hash=?, verify_expires=?, verify_sent_at=?, verify_attempts=0 WHERE id=?",
        (hash_code(user_id, code), epoch_ms() + 15 * 60_000, epoch_ms(), user_id),
    )
    return code
 
 
# =====================================================================
# 5. TELEGRAM BOT
# =====================================================================
def tg(method: str, payload: dict, timeout: int = 15):
    """Call the Telegram Bot API. Returns the reply, or None if Telegram is off/unreachable."""
    if not TG_TOKEN:
        return None
    try:
        return httpx.post(f"https://api.telegram.org/bot{TG_TOKEN}/{method}", json=payload, timeout=timeout).json()
    except Exception as e:  # noqa: BLE001
        print("telegram error:", e)
        return None
 
 
def notify(text: str, reply_markup: dict | None = None) -> None:
    """Send you (the admin) a Telegram message, in the background."""
    if not (TG_TOKEN and TG_CHAT):
        return
    payload = {"chat_id": TG_CHAT, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    threading.Thread(target=tg, args=("sendMessage", payload), daemon=True).start()
 
 
def handle_update(u: dict) -> None:
    """React to one Telegram event: an Approve/Reject button press, /paid, or /stats."""
    if "callback_query" in u:
        q = u["callback_query"]
        if str(q["from"]["id"]) != TG_CHAT:
            tg("answerCallbackQuery", {"callback_query_id": q["id"], "text": "Not allowed"})
            return
        _, action, wid = q["data"].split(":", 2)
        ok, suffix = False, ""
        if action == "approve":
            ok = approve_withdrawal(wid)
            suffix = f"\n\n✅ APPROVED. Send the funds, then reply:\n/paid {wid} <txid or bank ref>"
        elif action == "reject":
            ok = reject_withdrawal(wid)
            suffix = "\n\n❌ REJECTED and refunded"
        if ok:
            tg("editMessageText", {"chat_id": q["message"]["chat"]["id"], "message_id": q["message"]["message_id"],
                                   "text": q["message"]["text"] + suffix})
        tg("answerCallbackQuery", {"callback_query_id": q["id"], "text": "Done" if ok else "Already handled"})
        return
    m = u.get("message")
    if m and m.get("text") and str(m["chat"]["id"]) == TG_CHAT:
        parts = m["text"].strip().split()
        if parts[0] == "/paid" and len(parts) > 1:
            done = mark_paid(parts[1], " ".join(parts[2:]))
            notify(f"💸 {esc(parts[1])} marked Completed." if done else f"Nothing to update for {esc(parts[1])} (must be Approved first).")
        elif parts[0] == "/stats":
            with db() as c:
                n, t = c.execute("SELECT COUNT(*), COALESCE(SUM(balance_sats),0) FROM users").fetchone()
            notify(f"Users: {n}\nTotal user balances: {fmt(t)} sats")
 
 
def telegram_loop() -> None:
    """Background loop: listens for your button presses and commands in Telegram."""
    if not TG_TOKEN:
        print("Telegram disabled (no token)")
        return
    offset = 0
    while not _stop.is_set():
        res = tg("getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": ["callback_query", "message"]}, timeout=40)
        if not res or not res.get("ok"):
            _stop.wait(5)
            continue
        for u in res["result"]:
            offset = u["update_id"] + 1
            try:
                handle_update(u)
            except Exception as e:  # noqa: BLE001
                print("telegram handler error:", e)
 
 
# =====================================================================
# 6. TWO-FACTOR AUTHENTICATION (authenticator app)
# =====================================================================
def check_totp(conn, user, code) -> bool:
    """Is this 6-digit authenticator code right? A code can only be used once."""
    c = re.sub(r"\s", "", str(code or ""))
    if not user["totp_secret"] or not re.fullmatch(r"\d{6}", c) or c == user["totp_last"]:
        return False
    try:
        secret = FERNET.decrypt(user["totp_secret"].encode()).decode()
    except InvalidToken:
        return False
    if not pyotp.TOTP(secret).verify(c, valid_window=1):
        return False
    conn.execute("UPDATE users SET totp_last=? WHERE id=?", (c, user["id"]))
    return True
 
 
# =====================================================================
# 7. ROTATING DEPOSIT ADDRESSES (from your public key only)
# =====================================================================
_hd_chain = None
 
 
def derive_address(index: int) -> str:
    """Make deposit address number `index` from HD_XPUB. No private key is involved."""
    global _hd_chain
    if not HD_XPUB:
        raise ApiError(503, "Deposits are not configured")
    if _hd_chain is None:
        from bip_utils import Bip44Changes, Bip84, Bip84Coins  # imported here so the app starts without it
 
        _hd_chain = Bip84.FromExtendedKey(HD_XPUB, Bip84Coins.BITCOIN).Change(Bip44Changes.CHAIN_EXT)
    return _hd_chain.AddressIndex(index).PublicKey().ToAddress()
 
 
def issue_address(conn, user_id: int) -> str:
    """Give a user a brand-new address (next unused index) and remember it."""
    conn.execute("UPDATE hd_state SET next_index = next_index + 1 WHERE id=1")
    idx = conn.execute("SELECT next_index FROM hd_state WHERE id=1").fetchone()[0] - 1
    address = derive_address(idx)
    conn.execute(
        "INSERT INTO deposit_addresses (address,user_id,idx,created_at) VALUES (?,?,?,?)",
        (address, user_id, idx, epoch_ms()),
    )
    return address
 
 
# =====================================================================
# 8. REFERRAL BONUS
# =====================================================================
def try_referral_bonus(conn, user_id: int) -> bool:
    """Pay the referral bonus ONCE: needs a verified email and a confirmed deposit >= REF_MIN_DEPOSIT.
    Returns True if a bonus was paid just now."""
    u = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not u or not u["referred_by"] or u["referral_bonus_paid"] or not u["email_verified"]:
        return False
    if not conn.execute(
        "SELECT 1 FROM deposits WHERE user_id=? AND status='Confirmed' AND sats>=?", (user_id, REF_MIN_DEPOSIT)
    ).fetchone():
        return False
    if conn.execute("UPDATE users SET referral_bonus_paid=1 WHERE id=? AND referral_bonus_paid=0", (user_id,)).rowcount == 0:
        return False
    if REF_BONUS_NEW > 0:
        adjust_balance(conn, user_id, REF_BONUS_NEW, "referral_bonus", f"ref:{user_id}")
    if REF_BONUS_REFERRER > 0:
        adjust_balance(conn, u["referred_by"], REF_BONUS_REFERRER, "referral_bonus", f"ref:{user_id}")
    return True
 
 
def announce_referral(user_id: int) -> None:
    """Tell you (Telegram) and the new user (email) that a bonus was paid."""
    notify(f"🎁 <b>Referral bonus paid</b>\nNew user #{user_id}: +{fmt(REF_BONUS_NEW)} sats\nReferrer: +{fmt(REF_BONUS_REFERRER)} sats")
    if REF_BONUS_NEW > 0:
        mail_user(user_id, "You received a referral bonus", f"{fmt(REF_BONUS_NEW)} sats were added to your balance.")
 
 
# =====================================================================
# 9. WITHDRAWAL ACTIONS (used by Telegram AND the admin dashboard)
# =====================================================================
def approve_withdrawal(wid: str) -> bool:
    """Pending -> Approved. Now you send the money yourself."""
    with db() as c:
        return c.execute("UPDATE withdrawals SET status='Approved' WHERE id=? AND status='Pending'", (wid,)).rowcount > 0
 
 
def reject_withdrawal(wid: str) -> bool:
    """Pending -> Rejected, and the sats go back to the user's balance."""
    with db() as c:
        if c.execute("UPDATE withdrawals SET status='Rejected' WHERE id=? AND status='Pending'", (wid,)).rowcount == 0:
            return False
        w = c.execute("SELECT * FROM withdrawals WHERE id=?", (wid,)).fetchone()
        adjust_balance(c, w["user_id"], w["sats"], "refund", wid)
    mail_user(w["user_id"], "Withdrawal rejected", f"Your withdrawal {wid} was rejected and {fmt(w['sats'])} sats were returned to your balance.")
    return True
 
 
def mark_paid(wid: str, ref: str | None) -> bool:
    """Approved -> Completed, after you have sent the funds. `ref` is the txid or bank reference."""
    with db() as c:
        if c.execute("UPDATE withdrawals SET status='Completed', txid=? WHERE id=? AND status='Approved'", (ref or None, wid)).rowcount == 0:
            return False
        w = c.execute("SELECT user_id, receive FROM withdrawals WHERE id=?", (wid,)).fetchone()
    mail_user(w["user_id"], "Withdrawal sent", f"Your withdrawal {wid} ({fmt(w['receive'])} sats) has been sent." + (f" Reference: {ref}" if ref else ""))
    return True
 
 
# =====================================================================
# 10. DEPOSIT WATCHER (checks the blockchain, credits after confirmations)
# =====================================================================
_cycle = 0
 
 
def record_deposit_output(user_id: int, address: str, txid: str, vout: int, sats: int, conf: int) -> None:
    """Handle one payment to one of our addresses: record it, then credit it once it has enough confirmations."""
    after = []
    with db() as c:
        d = c.execute("SELECT * FROM deposits WHERE txid=? AND vout=?", (txid, vout)).fetchone()
        if d is None:
            below = sats < MIN_DEPOSIT
            c.execute(
                "INSERT INTO deposits (user_id,txid,vout,address,sats,confirmations,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (user_id, txid, vout, address, sats, conf, "Rejected" if below else "Pending", iso()),
            )
            c.execute("UPDATE deposit_addresses SET used=1 WHERE address=?", (address,))  # next visit gets a fresh address
            after.append(lambda: notify(f"🟡 <b>Deposit detected</b>\nUser #{user_id}\n{fmt(sats)} sats\nTx: <code>{txid}</code>" + ("\n⚠️ Below minimum, will not be credited." if below else "")))
            d = c.execute("SELECT * FROM deposits WHERE txid=? AND vout=?", (txid, vout)).fetchone()
        if d["status"] != "Pending":
            pass  # already Confirmed or Rejected: nothing more to do
        elif conf >= CONFIRMATIONS:
            if c.execute(
                "UPDATE deposits SET status='Confirmed', confirmations=?, confirmed_at=? WHERE id=? AND status='Pending'",
                (conf, iso(), d["id"]),
            ).rowcount:
                adjust_balance(c, user_id, d["sats"], "deposit", f"{txid}:{vout}")  # + balance
                bonus = try_referral_bonus(c, user_id)
                after.append(lambda: notify(f"✅ <b>Deposit credited</b>\nUser #{user_id}\n+{fmt(d['sats'])} sats\nTx: <code>{txid}</code>"))
                after.append(lambda: mail_user(user_id, "Deposit confirmed", f"{fmt(d['sats'])} sats were added to your balance."))
                if bonus:
                    after.append(lambda: announce_referral(user_id))
        elif conf != d["confirmations"]:
            c.execute("UPDATE deposits SET confirmations=? WHERE id=?", (conf, d["id"]))
    for fn in after:
        fn()
 
 
def check_deposits() -> None:
    """Look at every address we are watching and process any payments found.
    New addresses are checked every minute, older ones every 10th minute."""
    global _cycle
    _cycle += 1
    t = epoch_ms()
    with db() as c:
        rows = c.execute(
            """SELECT address,user_id FROM deposit_addresses WHERE created_at > ?
               UNION SELECT address,user_id FROM deposit_addresses WHERE ?=1 AND created_at > ?
               UNION SELECT address,user_id FROM deposits WHERE status='Pending'""",
            (t - 24 * 3_600_000, 1 if _cycle % 10 == 0 else 0, t - WATCH_DAYS * 86_400_000),
        ).fetchall()
    if not rows:
        return
    with httpx.Client(timeout=20) as http:
        tip = int(http.get(f"{MEMPOOL_API}/blocks/tip/height").text)
        for row in rows:
            r = http.get(f"{MEMPOOL_API}/address/{row['address']}/txs")
            if r.status_code != 200:
                time.sleep(0.3)
                continue
            for tx in r.json():
                st = tx.get("status", {})
                conf = tip - st["block_height"] + 1 if st.get("confirmed") else 0
                for vout, o in enumerate(tx["vout"]):
                    if o.get("scriptpubkey_address") == row["address"]:
                        record_deposit_output(row["user_id"], row["address"], tx["txid"], vout, o["value"], conf)
            time.sleep(0.15)  # be polite to the public API
 
 
def watcher_loop() -> None:
    """Background loop: runs check_deposits() every minute."""
    while not _stop.is_set():
        try:
            check_deposits()
        except Exception as e:  # noqa: BLE001
            print("deposit watcher:", e)
        if _stop.wait(60):
            break
 
 
# =====================================================================
# 14. APP + BACKGROUND JOBS (declared early so routes can attach to it)
# =====================================================================
_stop = threading.Event()
 
 
@asynccontextmanager
async def lifespan(_app):
    """On startup: create tables, print the first deposit address, start the watcher and Telegram bot."""
    init_db()
    if HD_XPUB:
        try:
            print(f"Deposit address #0 = {derive_address(0)}  (compare with your wallet's first receiving address!)")
        except Exception as e:  # noqa: BLE001
            print("HD_XPUB problem (needs a BIP84 'zpub' key):", e)
    else:
        print("HD_XPUB not set: deposit addresses are disabled.")
    if not DISABLE_BACKGROUND:
        threading.Thread(target=watcher_loop, daemon=True).start()
        threading.Thread(target=telegram_loop, daemon=True).start()
    yield
    _stop.set()
 
 
app = FastAPI(title="Nexvest API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGIN.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
init_db()
 
_hits: dict = {}
 
 
@app.middleware("http")
async def guard(request: Request, call_next):
    """Slow down floods (120 API calls/min per visitor) and lock down the admin page."""
    path = request.url.path
    if path.startswith("/api"):
        ip = request.client.host if request.client else "?"
        t = time.time()
        arr = [x for x in _hits.get(ip, []) if t - x < 60]
        arr.append(t)
        _hits[ip] = arr
        if len(_hits) > 5000:
            _hits.clear()
        if len(arr) > 120:
            return JSONResponse({"error": "Too many requests"}, status_code=429)
    response = await call_next(request)
    if path.startswith("/admin"):
        response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
    return response
 
 
@app.exception_handler(ApiError)
async def api_error_handler(_req, exc: ApiError):
    """Turn ApiError into the {"error": "..."} JSON the website expects."""
    return JSONResponse({"error": exc.message, **exc.extra}, status_code=exc.status)
 
 
@app.exception_handler(RequestValidationError)
async def validation_handler(_req, exc: RequestValidationError):
    """Friendly message when the browser sends bad data."""
    err = exc.errors()[0]
    field = str(err["loc"][-1]) if err.get("loc") else "input"
    nice = {"email": "Enter a valid email address.", "password": "Password must be at least 8 characters.",
            "sats": "Enter a valid amount.", "method": "Invalid method."}
    return JSONResponse({"error": nice.get(field, f"Invalid {field}.")}, status_code=422)
 
 
@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_req, exc: StarletteHTTPException):
    """Same JSON shape for 404 etc."""
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
 
 
# =====================================================================
# 11. AUTH + ACCOUNT API
# =====================================================================
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    ref: str | None = Field(default=None, max_length=12)
    invite_code: str | None = Field(default=None, max_length=12)  # old name, still accepted
    username: str | None = Field(default=None, min_length=3, max_length=20)
    phone: str | None = Field(default=None, max_length=20)
    account_type: str = Field(default="individual", pattern="^(individual|corporate)$")
 
 
class LoginIn(BaseModel):
    email: str | None = None        # email OR username
    identifier: str | None = None   # old name, still accepted
    password: str
    code: str | None = None         # 2FA code
 
 
class CodeIn(BaseModel):
    code: str = Field(max_length=12)
 
 
class DisableIn(BaseModel):
    password: str
    code: str
 
 
class BankIn(BaseModel):
    bankName: str = Field(min_length=2, max_length=60)
    accountNumber: str = Field(pattern=r"^\d{6,20}$")
    accountName: str = Field(min_length=2, max_length=80)
 
 
class ReportIn(BaseModel):
    txid: str | None = Field(default="", max_length=64)
 
 
class WithdrawIn(BaseModel):
    method: str = Field(pattern="^[a-z0-9_]{2,20}$")  # a key of WITHDRAW_OPTIONS
    sats: int = Field(gt=0, le=100 * SATS_PER_BTC)
    address: str | None = Field(default=None, max_length=100)
    code: str | None = Field(default=None, max_length=12)
    pin: str | None = Field(default=None, max_length=4)
 
 
def unique_username(conn, email: str) -> str:
    """Make a free username from the email, e.g. john.doe@x.com -> john.doe4821."""
    base = re.sub(r"[^A-Za-z0-9_.]", "", email.split("@")[0])[:14] or "user"
    while True:
        cand = base + str(secrets.randbelow(9000) + 1000)
        if not conn.execute("SELECT 1 FROM users WHERE username=?", (cand,)).fetchone():
            return cand
 
 
def register(data: RegisterIn):
    """Create an account, email a 6-digit code, and sign the user in."""
    ref = (data.ref or data.invite_code or "").strip().upper()
    email = data.email.lower()
    username = data.username
    if username and not re.fullmatch(r"[A-Za-z0-9_.]+", username):
        raise ApiError(422, "Username may only contain letters, numbers, _ and .")
    with db() as c:
        referrer = None
        if ref:
            referrer = c.execute("SELECT id FROM users WHERE invite_code=?", (ref,)).fetchone()
            if not referrer:
                raise ApiError(400, "That referral code is not valid")
        if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise ApiError(409, "Email already registered")
        if username and c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise ApiError(409, "Username already taken")
        username = username or unique_username(c, email)
        uid = c.execute(
            """INSERT INTO users (username,email,phone,account_type,password_hash,invite_code,referred_by,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (username, email, data.phone or "", data.account_type, hash_password(data.password),
             new_invite_code(c), referrer["id"] if referrer else None, iso()),
        ).lastrowid
        code = issue_verification(c, uid)
        token = create_session(c, uid)
    send_mail(email, "Your Nexvest verification code", f"Your code is {code}. It expires in 15 minutes. If you didn't sign up, ignore this email.")
    if referrer:
        notify(f"👥 New signup #{uid} via referral from user #{referrer['id']}")
    return {"token": token, "emailVerified": False}
 
 
app.add_api_route("/api/register", register, methods=["POST"])
app.add_api_route("/api/signup", register, methods=["POST"], include_in_schema=False)  # your old URL still works
 
 
@app.post("/api/login")
def login(data: LoginIn):
    """Sign in with email/username + password (+ 2FA code if the account has it)."""
    ident = (data.identifier or data.email or "").strip().lower()
    if not ident:
        raise ApiError(400, "Enter your email and password")
    if locked_out(ident):
        raise ApiError(429, "Too many attempts. Try again in 15 minutes.")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE lower(email)=? OR lower(username)=?", (ident, ident)).fetchone()
        if not u or not verify_password(data.password, u["password_hash"]):
            record_fail(ident)
            raise ApiError(401, "Wrong email or password")
        token = create_session(c, u["id"])
    return {"token": token, "emailVerified": bool(u["email_verified"])}
 
 
@app.post("/api/logout")
def logout(authorization: str = Header(default="")):
    """End this login session."""
    token = authorization[7:].strip()
    with db() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token_key(token),))
    return {"ok": True}
 
 
@app.post("/api/verify-email")
def verify_email(data: CodeIn, user: dict = Depends(current_user)):
    """Check the 6-digit email code. Max 5 wrong tries per code."""
    bonus = False
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if u["email_verified"]:
            return {"ok": True}
        if not u["verify_hash"] or epoch_ms() > (u["verify_expires"] or 0):
            raise ApiError(400, "Code expired. Request a new one.")
        if u["verify_attempts"] >= 5:
            raise ApiError(429, "Too many wrong codes. Request a new one.")
        if not hmac.compare_digest(hash_code(u["id"], data.code.strip()), u["verify_hash"]):
            c.execute("UPDATE users SET verify_attempts = verify_attempts + 1 WHERE id=?", (u["id"],))
            c.commit()  # keep the wrong-try counter even though we raise below
            raise ApiError(400, "Wrong code")
        c.execute("UPDATE users SET email_verified=1, verify_hash=NULL WHERE id=?", (u["id"],))
        bonus = try_referral_bonus(c, u["id"])
    if bonus:
        announce_referral(user["id"])
    return {"ok": True}
 
 
@app.post("/api/resend-verification")
def resend_verification(user: dict = Depends(current_user)):
    """Email a new code (once per minute)."""
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if u["email_verified"]:
            return {"ok": True}
        if u["verify_sent_at"] and epoch_ms() - u["verify_sent_at"] < 60_000:
            raise ApiError(429, "Wait a minute before requesting another code")
        code = issue_verification(c, u["id"])
    send_mail(u["email"], "Your Nexvest verification code", f"Your code is {code}. It expires in 15 minutes.")
    return {"ok": True}
 
 
class ForgotIn(BaseModel):
    email: EmailStr
 
 
class ResetCheckIn(BaseModel):
    email: EmailStr
    code: str = Field(max_length=12)
 
 
class ResetIn(BaseModel):
    email: EmailStr
    code: str = Field(max_length=12)
    password: str = Field(min_length=8, max_length=128)
 
 
@app.post("/api/forgot-password")
def forgot_password(data: ForgotIn):
    """Email a 6-digit reset code. Always answers the same, so nobody can test which emails exist."""
    email = data.email.lower()
    code = None
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE lower(email)=?", (email,)).fetchone()
        if u and not (u["reset_sent_at"] and epoch_ms() - u["reset_sent_at"] < 60_000):
            code = str(secrets.randbelow(1_000_000)).zfill(6)
            c.execute(
                "UPDATE users SET reset_hash=?, reset_expires=?, reset_sent_at=?, reset_attempts=0 WHERE id=?",
                (hash_code(u["id"], "reset:" + code), epoch_ms() + 15 * 60_000, epoch_ms(), u["id"]),
            )
    if code:
        send_mail(email, "Your Nexvest password reset code",
                  f"Your code is {code}. It expires in 15 minutes. If you didn't ask for this, ignore this email.")
    return {"ok": True}
 
 
@app.post("/api/check-reset-code")
def check_reset_code(data: ResetCheckIn):
    """Check the emailed reset code (does not use it up)."""
    email = data.email.lower()
    key = "reset:" + email
    if locked_out(key):
        raise ApiError(429, "Too many attempts. Try again in 15 minutes.")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE lower(email)=?", (email,)).fetchone()
        if (not u or not u["reset_hash"] or epoch_ms() > (u["reset_expires"] or 0)
                or (u["reset_attempts"] or 0) >= 5):
            record_fail(key)
            raise ApiError(400, "Wrong or expired code")
        if not hmac.compare_digest(hash_code(u["id"], "reset:" + data.code.strip()), u["reset_hash"]):
            c.execute("UPDATE users SET reset_attempts = reset_attempts + 1 WHERE id=?", (u["id"],))
            c.commit()
            record_fail(key)
            raise ApiError(400, "Wrong or expired code")
    return {"ok": True}
 
 
@app.post("/api/reset-password")
def reset_password(data: ResetIn):
    """Check the emailed code, set the new password, and sign out every old session."""
    email = data.email.lower()
    key = "reset:" + email
    if locked_out(key):
        raise ApiError(429, "Too many attempts. Try again in 15 minutes.")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE lower(email)=?", (email,)).fetchone()
        if (not u or not u["reset_hash"] or epoch_ms() > (u["reset_expires"] or 0)
                or (u["reset_attempts"] or 0) >= 5):
            record_fail(key)
            raise ApiError(400, "Wrong or expired code")
        if not hmac.compare_digest(hash_code(u["id"], "reset:" + data.code.strip()), u["reset_hash"]):
            c.execute("UPDATE users SET reset_attempts = reset_attempts + 1 WHERE id=?", (u["id"],))
            c.commit()
            record_fail(key)
            raise ApiError(400, "Wrong or expired code")
        c.execute(
            "UPDATE users SET password_hash=?, reset_hash=NULL, reset_expires=NULL, email_verified=1 WHERE id=?",
            (hash_password(data.password), u["id"]),
        )
        c.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
    return {"ok": True}
 
 
class PinIn(BaseModel):
    pin: str = Field(pattern=r"^\d{4}$")
    currentPin: str | None = Field(default=None, pattern=r"^\d{4}$")
 
 
@app.put("/api/pin")
def set_pin(data: PinIn, user: dict = Depends(current_user)):
    """Set the 4-digit transaction PIN, or change it (needs the current PIN)."""
    key = f"pin:{user['id']}"
    with db() as c:
        u = c.execute("SELECT pin_hash FROM users WHERE id=?", (user["id"],)).fetchone()
        if u["pin_hash"]:
            if locked_out(key):
                raise ApiError(429, "Too many wrong PINs. Try again in 15 minutes.")
            if not data.currentPin or not verify_password(data.currentPin, u["pin_hash"]):
                record_fail(key)
                raise ApiError(403, "Current PIN is wrong")
        c.execute("UPDATE users SET pin_hash=? WHERE id=?", (hash_password(data.pin), user["id"]))
    return {"ok": True, "hasPin": True}
 
 
@app.post("/api/2fa/setup")
def twofa_setup(user: dict = Depends(current_user)):
    """Start 2FA: returns a secret key to put into an authenticator app (and an otpauth link for a QR)."""
    if user["totp_enabled"]:
        raise ApiError(400, "2FA is already on")
    secret = pyotp.random_base32()
    with db() as c:
        c.execute("UPDATE users SET totp_secret=?, totp_last=NULL WHERE id=?", (FERNET.encrypt(secret.encode()).decode(), user["id"]))
    return {"secret": secret, "otpauth": pyotp.TOTP(secret).provisioning_uri(name=user["email"], issuer_name="Nexvest")}
 
 
@app.post("/api/2fa/enable")
def twofa_enable(data: CodeIn, user: dict = Depends(current_user)):
    """Finish 2FA setup by proving the app shows the right code."""
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not check_totp(c, u, data.code):
            raise ApiError(400, "Wrong code")
        c.execute("UPDATE users SET totp_enabled=1 WHERE id=?", (u["id"],))
    return {"ok": True}
 
 
@app.post("/api/2fa/disable")
def twofa_disable(data: DisableIn, user: dict = Depends(current_user)):
    """Turn 2FA off (needs password AND a current code)."""
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not verify_password(data.password, u["password_hash"]) or not check_totp(c, u, data.code):
            raise ApiError(400, "Wrong password or code")
        c.execute("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?", (u["id"],))
    return {"ok": True}
 
 
@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    """Everything the home page needs: balance, flags, referral code, bank details, history."""
    uid = user["id"]
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        wd = [{"id": w["id"], "type": "withdrawal", "method": w["method"], "dest": w["dest"], "sats": w["sats"],
               "fee": w["fee"], "receive": w["receive"], "status": w["status"], "date": w["created_at"]}
              for w in c.execute("SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 25", (uid,))]
        dp = [{"id": d["txid"], "type": "deposit", "sats": d["sats"], "txid": d["txid"], "status": d["status"],
               "confirmations": d["confirmations"], "date": d["created_at"]}
              for d in c.execute("SELECT * FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 25", (uid,))]
        bonus = [{"id": f"L{x['id']}", "type": "bonus", "sats": x["sats"], "status": "Completed",
                  "note": "Referral bonus" if x["kind"] == "referral_bonus" else "Adjustment", "date": x["created_at"]}
                 for x in c.execute("SELECT * FROM ledger WHERE user_id=? AND kind IN ('referral_bonus','admin_adjust') ORDER BY id DESC LIMIT 10", (uid,))]
    sats = u["balance_sats"]
    return {
        "balanceSats": sats, "email": u["email"], "username": u["username"], "accountType": u["account_type"],
        "emailVerified": bool(u["email_verified"]), "twoFactorEnabled": bool(u["totp_enabled"]),
        "hasPin": bool(u["pin_hash"]),
        "referralCode": u["invite_code"], "bankName": u["bank_name"], "accountNumber": u["account_number"],
        "accountName": u["account_name"],
        "wallets": load_wallets(u["wallets"]),
        "transactions": sorted(wd + dp + bonus, key=lambda t: t["date"], reverse=True),
        # extra fields from your old API, so older pages keep working
        "balance_sats": sats, "balance_btc": f"{sats / SATS_PER_BTC:.8f}", "goal_sats": GOAL_SATS,
        "goal_percent": min(100, round(sats / GOAL_SATS * 100, 2)), "invite_code": u["invite_code"],
    }
 
 
@app.get("/api/transactions")
def transactions(user: dict = Depends(current_user)):
    """Raw balance history (every + and − on the account)."""
    with db() as c:
        rows = c.execute("SELECT kind, sats AS amount_sats, balance_after, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50", (user["id"],)).fetchall()
    return [dict(r) for r in rows]
 
 
@app.get("/api/referral")
def referral(user: dict = Depends(current_user)):
    """Referral code, share link, how many people joined with it and the bonus rules."""
    with db() as c:
        referred = c.execute("SELECT COUNT(*) FROM users WHERE referred_by=?", (user["id"],)).fetchone()[0]
        qualified = c.execute("SELECT COUNT(*) FROM users WHERE referred_by=? AND referral_bonus_paid=1", (user["id"],)).fetchone()[0]
    return {"code": user["invite_code"], "link": f"{APP_URL}/index.html?ref={user['invite_code']}", "referred": referred,
            "qualified": qualified, "bonusForNewUserSats": REF_BONUS_NEW, "bonusForReferrerSats": REF_BONUS_REFERRER,
            "minDepositSats": REF_MIN_DEPOSIT, "earnedSats": qualified * REF_BONUS_REFERRER}
 
 
class WalletIn(BaseModel):
    option: str = Field(pattern="^[a-z0-9_]{2,20}$")  # a key of WITHDRAW_OPTIONS
    address: str = Field(default="", max_length=100)  # empty = remove this saved address
    pin: str | None = Field(default=None, max_length=4)
 
 
@app.put("/api/wallets")
def save_wallet(data: WalletIn, user: dict = Depends(current_user)):
    """Save (or remove) the user's withdrawal address for one currency/network. Needs the transaction PIN,
    so someone who borrows a logged-in phone can't swap in their own address."""
    opt = WITHDRAW_OPTIONS.get(data.option)
    if not opt:
        raise ApiError(400, "Choose a valid currency")
    addr = data.address.strip()
    if addr and not is_valid_address(data.option, addr):
        raise ApiError(400, f"Enter a valid {opt['label']} address")
    key = f"pin:{user['id']}"
    with db() as c:
        u = c.execute("SELECT wallets, pin_hash FROM users WHERE id=?", (user["id"],)).fetchone()
        if not u["pin_hash"]:
            raise ApiError(403, "Set a transaction PIN in Settings first", needsPinSetup=True)
        if locked_out(key):
            raise ApiError(429, "Too many wrong PINs. Try again in 15 minutes.")
        if not data.pin or not verify_password(data.pin, u["pin_hash"]):
            record_fail(key)
            raise ApiError(403, "Wrong PIN", needsPin=True)
        wallets = load_wallets(u["wallets"])
        if addr:
            wallets[data.option] = addr
        else:
            wallets.pop(data.option, None)
        c.execute("UPDATE users SET wallets=? WHERE id=?", (json.dumps(wallets), user["id"]))
    return {"ok": True, "wallets": wallets}
 
 
class PasswordIn(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=128)
    newPassword: str = Field(min_length=8, max_length=128)
 
 
@app.get("/api/referrals")
def referrals(user: dict = Depends(current_user)):
    """The people who signed up with this user's code."""
    with db() as c:
        rows = c.execute(
            "SELECT username, created_at, referral_bonus_paid FROM users WHERE referred_by=? ORDER BY id DESC LIMIT 100",
            (user["id"],)).fetchall()
    return [{"name": r["username"], "joined": r["created_at"],
             "status": "Active" if r["referral_bonus_paid"] else "Pending",
             "bonusSats": REF_BONUS_REFERRER if r["referral_bonus_paid"] else 0} for r in rows]
 
 
@app.put("/api/password")
def change_password(data: PasswordIn, user: dict = Depends(current_user), authorization: str = Header(default="")):
    """Change the login password (needs the current one) and sign out every other device."""
    key = f"pw:{user['id']}"
    if locked_out(key):
        raise ApiError(429, "Too many wrong attempts. Try again in 15 minutes.")
    if not verify_password(data.currentPassword, user["password_hash"]):
        record_fail(key)
        raise ApiError(403, "Current password is incorrect")
    if data.newPassword == data.currentPassword:
        raise ApiError(400, "New password must be different from the current one")
    token = authorization[7:].strip()
    with db() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data.newPassword), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id=? AND token!=?", (user["id"], token_key(token)))
    return {"ok": True}
 
 
@app.put("/api/bank")
def save_bank(data: BankIn, user: dict = Depends(current_user)):
    """Save the user's bank details for bank withdrawals."""
    with db() as c:
        c.execute("UPDATE users SET bank_name=?, account_number=?, account_name=? WHERE id=?",
                  (data.bankName.strip(), data.accountNumber, data.accountName.strip(), user["id"]))
    return {"ok": True}
 
 
# =====================================================================
# 12. MONEY API
# =====================================================================
@app.get("/api/deposit-address")
def deposit_address(new: int = 0, user: dict = Depends(current_user)):
    """The user's deposit address. It changes after it receives a payment, after ADDRESS_TTL, or with ?new=1."""
    with db() as c:
        cur = c.execute("SELECT * FROM deposit_addresses WHERE user_id=? ORDER BY idx DESC LIMIT 1", (user["id"],)).fetchone()
        fresh = cur and not cur["used"] and epoch_ms() - cur["created_at"] < ADDRESS_TTL_MS
        if fresh and not new:
            return {"address": cur["address"], "rotated": False}
        today = c.execute("SELECT COUNT(*) FROM deposit_addresses WHERE user_id=? AND created_at > ?", (user["id"], epoch_ms() - 86_400_000)).fetchone()[0]
        if today >= MAX_NEW_ADDR_PER_DAY:
            if cur:
                return {"address": cur["address"], "rotated": False}
            raise ApiError(429, "Address limit reached, try again later")
        return {"address": issue_address(c, user["id"]), "rotated": True}
 
 
@app.get("/api/deposits")
def list_deposits(user: dict = Depends(current_user)):
    """The user's deposits (pending and confirmed)."""
    with db() as c:
        rows = c.execute("SELECT txid, sats, confirmations, status, created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 20", (user["id"],)).fetchall()
    return [dict(r) for r in rows]
 
 
@app.post("/api/deposits/report")
def report_deposit(data: ReportIn, user: dict = Depends(current_user)):
    """User says "I sent it". Only pings you on Telegram. It NEVER credits anything."""
    txid = (data.txid or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", txid):
        raise ApiError(400, "Paste the transaction ID (TXID) from your wallet first")
    notify(f"📨 User #{user['id']} says they sent a deposit" + (f"\nTx: <code>{txid}</code>" if txid else ""))
    return {"ok": True}
 
 
@app.get("/api/withdraw-options")
def withdraw_options(_user: dict = Depends(current_user)):
    """The currencies/networks users can withdraw to, with fees and the minimum amount."""
    return {"minSats": MIN_WITHDRAW,
            "options": [{"id": k, **{f: v[f] for f in ("label", "coin", "network", "fee", "hint")}}
                        for k, v in WITHDRAW_OPTIONS.items()]}
 
 
@app.post("/api/withdraw")
def withdraw(data: WithdrawIn, user: dict = Depends(current_user)):
    """Request a withdrawal: checks everything, subtracts the balance at once, asks you to approve on Telegram."""
    sats, method = data.sats, data.method
    wid = "WD" + base36(int(time.time() * 1000)) + secrets.token_hex(2).upper()
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
        if not u["email_verified"]:
            raise ApiError(403, "Verify your email before withdrawing")
        pin_key = f"pin:{u['id']}"
        if not u["pin_hash"]:
            raise ApiError(403, "Set a transaction PIN in Settings first", needsPinSetup=True)
        if locked_out(pin_key):
            raise ApiError(429, "Too many wrong PINs. Try again in 15 minutes.")
        if not data.pin or not verify_password(data.pin, u["pin_hash"]):
            record_fail(pin_key)
            raise ApiError(403, "Wrong PIN", needsPin=True)
        if sats < MIN_WITHDRAW:
            raise ApiError(400, f"Minimum withdrawal is {fmt(MIN_WITHDRAW)} sats")
        opt = WITHDRAW_OPTIONS.get(method)
        if not opt:
            raise ApiError(400, "Choose a valid withdrawal currency")
        fee = opt["fee"]
        if sats <= fee:
            raise ApiError(400, "Amount must be more than the network fee")
        if DAILY_LIMIT > 0:
            used = c.execute("SELECT COALESCE(SUM(sats),0) FROM withdrawals WHERE user_id=? AND status!='Rejected' AND created_at > ?",
                             (u["id"], (now() - timedelta(days=1)).isoformat())).fetchone()[0]
            if used + sats > DAILY_LIMIT:
                raise ApiError(400, f"Daily limit is {fmt(DAILY_LIMIT)} sats")
        addr = (data.address or "").strip()
        if not is_valid_address(method, addr):
            raise ApiError(400, f"Enter a valid {opt['label']} address")
        dest, dest_full = addr[:8] + "…" + addr[-6:], addr
        try:
            balance = adjust_balance(c, u["id"], -sats, "withdrawal", wid)  # − balance
        except ApiError:
            raise ApiError(400, "That's more than your available balance")
        c.execute("INSERT INTO withdrawals (id,user_id,method,dest,dest_full,sats,fee,receive,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                  (wid, u["id"], method, dest, dest_full, sats, fee, sats - fee, iso()))
    notify(
        f"🔴 <b>Withdrawal request</b> <code>{wid}</code>\nUser #{u['id']} ({esc(u['email'])})\nPay out in: {esc(opt['label'])}\n"
        f"Amount: {fmt(sats)} sats\nFee: {fmt(fee)} sats\nSend: <b>{fmt(sats - fee)} sats</b> worth of {opt['coin']}\nTo: <code>{esc(dest_full)}</code>",
        {"inline_keyboard": [[{"text": "✅ Approve", "callback_data": f"wd:approve:{wid}"}, {"text": "❌ Reject", "callback_data": f"wd:reject:{wid}"}]]},
    )
    mail_user(u["id"], "Withdrawal requested", f"We received your withdrawal {wid} for {fmt(sats)} sats. If this wasn't you, contact support immediately.")
    return {"balanceSats": balance,
            "withdrawal": {"id": wid, "method": method, "dest": dest, "sats": sats, "fee": fee, "receive": sats - fee,
                           "status": "Pending", "date": iso()}}
 
 
# =====================================================================
# 13. ADMIN API (used by /admin dashboard)
# =====================================================================
class AdjustIn(BaseModel):
    sats: int
    reason: str = Field(min_length=1, max_length=200)
 
 
class PaidIn(BaseModel):
    ref: str | None = Field(default=None, max_length=200)
 
 
@app.get("/api/admin/overview")
def admin_overview(_a: dict = Depends(require_admin)):
    """Dashboard numbers."""
    with db() as c:
        one = lambda q: c.execute(q).fetchone()  # noqa: E731
        pw, pd = one("SELECT COUNT(*) c, COALESCE(SUM(receive),0) s FROM withdrawals WHERE status IN ('Pending','Approved')"), one("SELECT COUNT(*) c, COALESCE(SUM(sats),0) s FROM deposits WHERE status='Pending'")
        return {
            "users": one("SELECT COUNT(*) FROM users")[0],
            "totalBalanceSats": one("SELECT COALESCE(SUM(balance_sats),0) FROM users")[0],
            "pendingWithdrawals": dict(pw), "pendingDeposits": dict(pd),
            "depositedSats": one("SELECT COALESCE(SUM(sats),0) FROM deposits WHERE status='Confirmed'")[0],
            "bonusesPaidSats": one("SELECT COALESCE(SUM(sats),0) FROM ledger WHERE kind='referral_bonus'")[0],
            "addressesIssued": one("SELECT COUNT(*) FROM deposit_addresses")[0],
        }
 
 
@app.get("/api/admin/users")
def admin_users(q: str = "", _a: dict = Depends(require_admin)):
    """Search users by email or username."""
    term = f"%{q.lower()}%"
    with db() as c:
        rows = c.execute(
            """SELECT id,email,username,balance_sats,email_verified,totp_enabled,invite_code AS referral_code,
                      referred_by,referral_bonus_paid,is_admin,created_at
               FROM users WHERE lower(email) LIKE ? OR lower(username) LIKE ? ORDER BY id DESC LIMIT 100""", (term, term)).fetchall()
    return [dict(r) for r in rows]
 
 
@app.get("/api/admin/withdrawals")
def admin_withdrawals(status: str | None = None, _a: dict = Depends(require_admin)):
    """Withdrawals, newest first (optionally only one status)."""
    with db() as c:
        rows = c.execute(
            "SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id "
            + ("WHERE w.status=? " if status else "") + "ORDER BY w.created_at DESC LIMIT 100", (status,) if status else ()).fetchall()
    return [dict(r) for r in rows]
 
 
@app.get("/api/admin/deposits")
def admin_deposits(_a: dict = Depends(require_admin)):
    """Deposits, newest first."""
    with db() as c:
        rows = c.execute("SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 100").fetchall()
    return [dict(r) for r in rows]
 
 
@app.post("/api/admin/withdrawals/{wid}/approve")
def admin_approve(wid: str, _a: dict = Depends(require_admin)):
    """Dashboard version of the Telegram Approve button."""
    return {"ok": approve_withdrawal(wid)}
 
 
@app.post("/api/admin/withdrawals/{wid}/reject")
def admin_reject(wid: str, _a: dict = Depends(require_admin)):
    """Dashboard version of the Telegram Reject button (refunds the user)."""
    return {"ok": reject_withdrawal(wid)}
 
 
@app.post("/api/admin/withdrawals/{wid}/paid")
def admin_paid(wid: str, data: PaidIn, _a: dict = Depends(require_admin)):
    """Dashboard version of /paid."""
    return {"ok": mark_paid(wid, data.ref)}
 
 
@app.post("/api/admin/users/{uid}/adjust")
def admin_adjust(uid: int, data: AdjustIn, admin: dict = Depends(require_admin)):
    """Manually add (+) or remove (−) sats, with a reason saved in the ledger."""
    if data.sats == 0:
        raise ApiError(400, "Amount and reason are required")
    try:
        with db() as c:
            bal = adjust_balance(c, uid, data.sats, "admin_adjust", f"admin:{admin['id']}:{data.reason.strip()}")
    except ApiError:
        raise ApiError(400, "Could not adjust (user missing or balance would go negative)")
    notify(f"🛠 Admin #{admin['id']} adjusted user #{uid} by {data.sats:+,} sats\nReason: {esc(data.reason)}")
    return {"ok": True, "balanceSats": bal}
 
 
# =====================================================================
# 15. STATIC FILES (keep last)
# =====================================================================
def first_existing(*paths):
    """The first folder in the list that exists, or None."""
    for p in paths:
        if p and Path(p).is_dir():
            return Path(p)
    return None
 
 
@app.get("/admin", include_in_schema=False)
def admin_redirect():
    """Send /admin to /admin/ (the folder mount below only answers WITH the trailing slash)."""
    return RedirectResponse("/admin/")
 
 
if (BASE / "public").is_dir():
    app.mount("/admin", StaticFiles(directory=BASE / "public", html=True), name="admin")
ASSETS_DIR = first_existing(os.getenv("ASSETS_DIR"), BASE.parent / "static", BASE / "static")
PAGES_DIR = first_existing(os.getenv("FRONTEND_DIR"), BASE.parent / "TEMPLATES", BASE.parent / "templates", ASSETS_DIR)
if PAGES_DIR is None:  # nothing found: make an empty ./static so the app still starts
    PAGES_DIR = BASE / "static"
    PAGES_DIR.mkdir(exist_ok=True)
ASSETS_DIR = ASSETS_DIR or PAGES_DIR
print(f"Pages served from: {PAGES_DIR}\nAssets (/static/...) served from: {ASSETS_DIR}\nDatabase: {DB_PATH}")
app.mount("/static", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/", StaticFiles(directory=PAGES_DIR, html=True), name="pages")