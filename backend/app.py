
 
"""Nexvest backend: Flask + PostgreSQL (Supabase).
 
Start (from the backend folder, with the venv active):
    python app.py                                   (development, no auto-reloader)
    gunicorn -w 1 --threads 8 -b 0.0.0.0:${PORT:-8000} app:app   (server: ONE worker, several threads)
 
IMPORTANT: always run ONE worker process. The deposit watcher, Telegram bot and the
login/rate-limit counters live inside the process. Use --threads for concurrency instead.
 
Frontend files (login.html, home.html, *.css, *.js) go in ./static
Admin dashboard files (index.html, admin.js) go in ./public  ->  open /admin
 
Sections of this file
  1. Config          5. Telegram bot        9. Withdrawal actions     13. Admin API
  2. Database        6. (unused)           10. Deposit watcher        14. Background jobs
  3. Errors+security 7. Rotating addresses 11. Auth + account API     15. Static files
  4. Email           8. Referral bonus     12. Money API
"""
import atexit
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import smtplib
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import unquote, urlparse
 
import httpx
import psycopg
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS
from psycopg import errors as pg_errors
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, EmailStr, Field, ValidationError
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

import logging
logging.basicConfig(level=logging.INFO)
logging.getLogger("psycopg.pool").setLevel(logging.INFO)
 
BASE = Path(__file__).resolve().parent   # the folder this file lives in, so paths work anywhere
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
 
 
# Supabase: dashboard -> Connect -> copy the "Session pooler" string (works over IPv4, port 5432).
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError("Set DATABASE_URL in your .env file (your Supabase Postgres connection string).")
DB_POOL_MAX = env_int("DB_POOL_MAX", 12)  # keep >= gunicorn --threads + 2 background threads
SECRET_KEY = os.getenv("JWT_SECRET", "")
if not SECRET_KEY:
    raise RuntimeError("Set JWT_SECRET in your .env file (any long random text).")
 
APP_URL = os.getenv("APP_URL", "https://satwise.onrender.com").rstrip("/")
CORS_ORIGIN = os.getenv("CORS_ORIGIN", "https://satwise.onrender.com")
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
# Force override the connection parameters if running inside production platform clusters
if not DATABASE_URL or DATABASE_URL.startswith("sqlite"):
    # Check if an alternative global target is defined by the server environment variables
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///app.db")

if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)



class Row(dict):
    """One result row: row["name"] like a dict, and row[0] by position."""
 
    __slots__ = ()
 
    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)
 
 
def row_factory(cursor):
    names = [col.name for col in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))
 
_conn_kwargs = {
    "row_factory": row_factory,
    "prepare_threshold": None,   # works with Supabase's transaction pooler too
    "connect_timeout": 10,       # fail fast so the REAL error shows in the logs
    "keepalives": 1,             # stop the pooler silently dropping idle connections
    "keepalives_idle": 30,
    "keepalives_interval": 10,
    "keepalives_count": 3,
}
if "sslmode=" not in DATABASE_URL and not any(h in DATABASE_URL for h in ("localhost", "127.0.0.1")):
    _conn_kwargs["sslmode"] = "require"
 
pool = ConnectionPool(
    conninfo=DATABASE_URL, min_size=0, max_size=DB_POOL_MAX, kwargs=_conn_kwargs,
    open=False, timeout=20, max_lifetime=300, max_idle=20,
    check=ConnectionPool.check_connection,
)
 
 
class Conn:
    """Thin wrapper so the SQL below can keep using ? placeholders (psycopg wants %s)."""
 
    def __init__(self, raw):
        self._raw = raw
 
    def execute(self, sql: str, params=()):
        return self._raw.execute(sql.replace("?", "%s"), params or None)
 
    def commit(self) -> None:
        self._raw.commit()
 
 
@contextmanager
def db():
    """Borrow a connection from the pool. Saves everything if the block finishes, undoes everything if it raises."""
    with pool.connection() as raw:
        yield Conn(raw)
 
 
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    account_type TEXT NOT NULL DEFAULT 'individual',
    password_hash TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    referred_by BIGINT REFERENCES users(id),
    balance_sats BIGINT NOT NULL DEFAULT 0 CHECK (balance_sats >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    reset_hash TEXT,
    reset_expires BIGINT,
    reset_sent_at BIGINT,
    reset_attempts INTEGER NOT NULL DEFAULT 0,
    pin_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    referral_bonus_paid INTEGER NOT NULL DEFAULT 0,
    bank_name TEXT,
    account_number TEXT,
    account_name TEXT,
    wallets TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_referred_by ON users (referred_by);
 
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
 
CREATE TABLE IF NOT EXISTS deposit_addresses (
    address TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    idx BIGINT UNIQUE NOT NULL,
    created_at BIGINT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deposit_addresses_user ON deposit_addresses (user_id, idx);
CREATE INDEX IF NOT EXISTS deposit_addresses_created ON deposit_addresses (created_at);
 
CREATE TABLE IF NOT EXISTS hd_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_index BIGINT NOT NULL
);
INSERT INTO hd_state (id, next_index) VALUES (1, 0) ON CONFLICT DO NOTHING;
 
CREATE TABLE IF NOT EXISTS deposits (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    txid TEXT NOT NULL,
    vout INTEGER NOT NULL,
    address TEXT NOT NULL,
    sats BIGINT NOT NULL,
    confirmations INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Pending',
    created_at TIMESTAMPTZ NOT NULL,
    confirmed_at TIMESTAMPTZ,
    UNIQUE (txid, vout)
);
CREATE INDEX IF NOT EXISTS deposits_user ON deposits (user_id, id);
CREATE INDEX IF NOT EXISTS deposits_status ON deposits (status);
 
CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    method TEXT NOT NULL,
    dest TEXT NOT NULL,
    dest_full TEXT NOT NULL,
    sats BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    receive BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending',
    txid TEXT,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS withdrawals_user ON withdrawals (user_id, created_at);
CREATE INDEX IF NOT EXISTS withdrawals_status ON withdrawals (status);
 
CREATE TABLE IF NOT EXISTS ledger (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    sats BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger (user_id, id);
 
-- Supabase exposes every table in the public schema through its REST API.
-- Row Level Security with NO policies blocks that API completely; this backend
-- connects as the database owner, which is not affected by RLS.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE hd_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger ENABLE ROW LEVEL SECURITY;
"""
 
 
def init_db() -> None:
    """Create all tables (safe to run on every start)."""
    with db() as c:
        c.execute("SELECT pg_advisory_xact_lock(7274001)")  # only one process builds the schema at a time
        c.execute(SCHEMA)
 
 
# =====================================================================
# 3. ERRORS + SECURITY HELPERS
# =====================================================================
class ApiError(Exception):
    """An error that is sent to the browser as {"error": "message", ...extra}."""
 
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra
 
 
def adjust_balance(conn, user_id: int, delta: int, kind: str, ref: str) -> int:
    """The ONLY function that changes a balance. Adds/subtracts sats and writes a ledger row.
    It refuses to take a balance below zero."""
    row = conn.execute(
        "UPDATE users SET balance_sats = balance_sats + ? WHERE id=? AND balance_sats + ? >= 0 RETURNING balance_sats",
        (delta, user_id, delta),
    ).fetchone()
    if row is None:
        raise ApiError(400, "Insufficient balance")
    bal = row["balance_sats"]
    conn.execute(
        "INSERT INTO ledger (user_id,kind,ref,sats,balance_after,created_at) VALUES (?,?,?,?,?,?)",
        (user_id, kind, ref, delta, bal, now()),
    )
    return bal
 
 
PBKDF2_ITERS = 600_000  # OWASP 2023 guidance for PBKDF2-HMAC-SHA256
 
 
def hash_password(password: str) -> str:
    """Scramble a password with a random salt (PBKDF2). Never store the real password.
    Stored as pbkdf2$iterations$salt$hash so the cost can be raised later."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERS)
    return f"pbkdf2${PBKDF2_ITERS}${salt.hex()}${digest.hex()}"
 
 
def verify_password(password: str, stored: str) -> bool:
    """Check a typed password against the stored scrambled one (also reads the old salt$hash format)."""
    try:
        parts = stored.split("$")
        if len(parts) == 4 and parts[0] == "pbkdf2":
            iters, salt_hex, digest_hex = int(parts[1]), parts[2], parts[3]
        elif len(parts) == 2:
            iters, (salt_hex, digest_hex) = 200_000, parts
        else:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), iters)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except ValueError:
        return False
 
 
DUMMY_HASH = hash_password("not-a-real-password")  # lets login take the same time for unknown users
 
 
def token_key(token: str) -> str:
    """Sessions are stored as a hash of the token, so a stolen database can't be used to log in."""
    return hashlib.sha256(token.encode()).hexdigest()
 
 
def create_session(conn, user_id: int) -> str:
    """Make a login token (valid SESSION_DAYS days) and return it."""
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
        (token_key(token), user_id, now() + timedelta(days=SESSION_DAYS)),
    )
    return token
 
 
def new_invite_code(conn) -> str:
    """A unique 6-letter referral code for a new user."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if not conn.execute("SELECT 1 FROM users WHERE invite_code=?", (code,)).fetchone():
            return code
 
 
def bearer_token() -> str:
    """The login token from the 'Authorization: Bearer ...' header ('' if missing)."""
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""
 
 
def current_user() -> dict:
    """Who is calling? Reads the login token, returns the user or says 'not signed in'."""
    token = bearer_token()
    if not token:
        raise ApiError(401, "Not signed in")
    with db() as c:
        row = c.execute(
            "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=? AND s.expires_at > ?",
            (token_key(token), now()),
        ).fetchone()
    if not row:
        raise ApiError(401, "Session expired, please sign in again")
    return dict(row)
 
 
def require_admin() -> dict:
    """Only accounts with is_admin = 1 may use /api/admin/*.
    NOTE: the FastAPI version never actually checked this; the check is real here."""
    user = current_user()
    if not user["is_admin"]:
        raise ApiError(403, "Admin only")
    return user
 
 
def parse(model):
    """Read the JSON body into a validated pydantic model (same checks as before)."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}
    try:
        return model.model_validate(data)
    except ValidationError as e:
        err = e.errors()[0]
        field = str(err["loc"][-1]) if err.get("loc") else "input"
        nice = {"email": "Enter a valid email address.", "password": "Password must be at least 8 characters.",
                "sats": "Enter a valid amount.", "method": "Invalid method."}
        raise ApiError(422, nice.get(field, f"Invalid {field}.")) from None
 
 
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
 
 
# =====================================================================
# 5. TELEGRAM BOT
# =====================================================================
_stop = threading.Event()
 
 
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
                row = c.execute("SELECT COUNT(*) AS n, COALESCE(SUM(balance_sats),0)::bigint AS t FROM users").fetchone()
            notify(f"Users: {row['n']}\nTotal user balances: {fmt(row['t'])} sats")
 
 
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
    idx = conn.execute("UPDATE hd_state SET next_index = next_index + 1 WHERE id=1 RETURNING next_index - 1 AS idx").fetchone()["idx"]
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
    """Pay the referral bonus ONCE: needs a confirmed deposit >= REF_MIN_DEPOSIT.
    Returns True if a bonus was paid just now."""
    u = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not u or not u["referred_by"] or u["referral_bonus_paid"]:
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
                "INSERT INTO deposits (user_id,txid,vout,address,sats,confirmations,status,created_at) VALUES (?,?,?,?,?,?,?,?) "
                "ON CONFLICT (txid, vout) DO NOTHING",
                (user_id, txid, vout, address, sats, conf, "Rejected" if below else "Pending", now()),
            )
            c.execute("UPDATE deposit_addresses SET used=1 WHERE address=?", (address,))  # next visit gets a fresh address
            after.append(lambda: notify(f"🟡 <b>Deposit detected</b>\nUser #{user_id}\n{fmt(sats)} sats\nTx: <code>{txid}</code>" + ("\n⚠️ Below minimum, will not be credited." if below else "")))
            d = c.execute("SELECT * FROM deposits WHERE txid=? AND vout=?", (txid, vout)).fetchone()
        if d["status"] != "Pending":
            pass  # already Confirmed or Rejected: nothing more to do
        elif conf >= CONFIRMATIONS:
            if c.execute(
                "UPDATE deposits SET status='Confirmed', confirmations=?, confirmed_at=? WHERE id=? AND status='Pending'",
                (conf, now(), d["id"]),
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
        tip_resp = http.get(f"{MEMPOOL_API}/blocks/tip/height")
        tip_resp.raise_for_status()
        tip = int(tip_resp.text)
        for row in rows:
            try:  # one bad address/response must not stop the whole cycle
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
            except Exception as e:  # noqa: BLE001
                print(f"deposit watcher: {row['address']}: {e}")
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
class AppJSONProvider(DefaultJSONProvider):
    """Postgres returns datetimes and Decimals; send them as ISO text and plain numbers."""
 
    @staticmethod
    def default(o):
        if isinstance(o, Decimal):
            return int(o) if o == o.to_integral_value() else float(o)
        if isinstance(o, datetime):
            return o.astimezone(timezone.utc).isoformat()
        return DefaultJSONProvider.default(o)
 
 
app = Flask(__name__, static_folder=None)  # static files are served by the routes in section 15
app.json = AppJSONProvider(app)
app.json.sort_keys = False                 # keep JSON keys in the order we write them
app.config["MAX_CONTENT_LENGTH"] = 1_000_000
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # trust ONE proxy (nginx/caddy)
CORS(app, origins=[o.strip() for o in CORS_ORIGIN.split(",")])
 
_started = False
 
 
def startup() -> None:
    """Create tables, print the first deposit address, start the watcher and Telegram bot (once)."""
    global _started
    if _started:
        return
    _started = True
    pool.open(wait=True, timeout=30)  # fail early with a clear error if DATABASE_URL is wrong
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
 
 
atexit.register(_stop.set)
atexit.register(lambda: pool.close())
 
_hits: dict = {}
 
 
@app.before_request
def flood_guard():
    """Slow down floods (120 API calls/min per visitor)."""
    if request.path.startswith("/api"):
        ip = request.remote_addr or "?"
        t = time.time()
        arr = [x for x in _hits.get(ip, []) if t - x < 60]
        arr.append(t)
        _hits[ip] = arr
        if len(_hits) > 5000:
            _hits.clear()
        if len(arr) > 120:
            return jsonify({"error": "Too many requests"}), 429
 
 
@app.after_request
def lock_down_admin_page(response):
    """Basic security headers everywhere, and a strict content-security-policy for the admin page."""
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    if request.path.startswith("/admin"):
        response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
    return response
 
 
@app.errorhandler(ApiError)
def api_error_handler(exc: ApiError):
    """Turn ApiError into the {"error": "..."} JSON the website expects."""
    return jsonify({"error": exc.message, **exc.extra}), exc.status
 
 
@app.errorhandler(pg_errors.UniqueViolation)
def unique_violation_handler(exc):
    """Two people grabbing the same email/username at the same moment."""
    return jsonify({"error": "That email or username is already taken"}), 409
 
 
@app.errorhandler(psycopg.OperationalError)
def db_down_handler(exc):
    app.logger.error("database unavailable: %r | pool: %s", exc, pool.get_stats())
    return jsonify({"error": "Service busy, please try again in a moment"}), 503
 
 
@app.errorhandler(HTTPException)
def http_error_handler(exc: HTTPException):
    """Same JSON shape for 404, 405, 413 etc."""
    return jsonify({"error": exc.description}), exc.code
 
 
@app.errorhandler(Exception)
def unexpected_error_handler(exc: Exception):
    """Anything unexpected: log it, tell the browser something generic."""
    app.logger.exception("unhandled error: %s", exc)
    return jsonify({"error": "Server error"}), 500
 
 
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
    pin: str | None = Field(default=None, max_length=4)
 
 
def unique_username(conn, email: str) -> str:
    """Make a free username from the email, e.g. john.doe@x.com -> john.doe4821."""
    base = re.sub(r"[^A-Za-z0-9_.]", "", email.split("@")[0])[:14] or "user"
    while True:
        cand = base + str(secrets.randbelow(9000) + 1000)
        if not conn.execute("SELECT 1 FROM users WHERE lower(username)=lower(?)", (cand,)).fetchone():
            return cand
 
 
@app.post("/api/register")
@app.post("/api/signup")  # your old URL still works
def register():
    """Create an account (saved in the users table) and sign the user in straight away.
    The page then sends them to the home page (see "redirect" in the reply)."""
    data = parse(RegisterIn)
    ref = (data.ref or data.invite_code or "").strip().upper()
    email = data.email.lower()
    username = data.username
    if username and not re.fullmatch(r"[A-Za-z0-9_.]+", username):
        raise ApiError(422, "Username may only contain letters, numbers, _ and .")

    pw_hash = hash_password(data.password)

    with db() as c:
        referrer = None
        if ref:
            referrer = c.execute("SELECT id FROM users WHERE invite_code=?", (ref,)).fetchone()
            if not referrer:
                raise ApiError(400, "That referral code is not valid")
        if c.execute("SELECT 1 FROM users WHERE lower(email)=?", (email,)).fetchone():
            raise ApiError(409, "Email already registered")
        if username and c.execute("SELECT 1 FROM users WHERE lower(username)=lower(?)", (username,)).fetchone():
            raise ApiError(409, "Username already taken")
        username = username or unique_username(c, email)
        uid = c.execute(
            """INSERT INTO users (username,email,phone,account_type,password_hash,invite_code,referred_by,created_at)
               VALUES (?,?,?,?,?,?,?,?) RETURNING id""",
            (username, email, data.phone or "", data.account_type, hash_password(data.password),
             new_invite_code(c), referrer["id"] if referrer else None, now()),
        ).fetchone()["id"]
        token = create_session(c, uid)
    if referrer:
        notify(f"👥 New signup #{uid} via referral from user #{referrer['id']}")
    # emailVerified/twoFactorEnabled are always True/False now; they stay in the reply only so older pages don't break
    return {"token": token, "emailVerified": True, "redirect": "/home.html"}
 
 
@app.post("/api/login")
def login():
    """Sign in with email/username + password."""
    data = parse(LoginIn)
    ident = (data.identifier or data.email or "").strip().lower()
    if not ident:
        raise ApiError(400, "Enter your email and password")
    if locked_out(ident):
        raise ApiError(429, "Too many attempts. Try again in 15 minutes.")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE lower(email)=? OR lower(username)=?", (ident, ident)).fetchone()
        if not u:
            verify_password(data.password, DUMMY_HASH)  # same delay whether or not the account exists
        if not u or not verify_password(data.password, u["password_hash"]):
            record_fail(ident)
            raise ApiError(401, "Wrong email or password")
        token = create_session(c, u["id"])
    return {"token": token, "emailVerified": True, "redirect": "/home.html"}
 
 
@app.post("/api/logout")
def logout():
    """End this login session."""
    token = bearer_token()
    with db() as c:
        c.execute("DELETE FROM sessions WHERE token=?", (token_key(token),))
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
def forgot_password():
    """Email a 6-digit reset code. Always answers the same, so nobody can test which emails exist."""
    data = parse(ForgotIn)
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
def check_reset_code():
    """Check the emailed reset code (does not use it up)."""
    data = parse(ResetCheckIn)
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
def reset_password():
    """Check the emailed code, set the new password, and sign out every old session."""
    data = parse(ResetIn)
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
            "UPDATE users SET password_hash=?, reset_hash=NULL, reset_expires=NULL WHERE id=?",
            (hash_password(data.password), u["id"]),
        )
        c.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
    return {"ok": True}
 
 
class PinIn(BaseModel):
    pin: str = Field(pattern=r"^\d{4}$")
    currentPin: str | None = Field(default=None, pattern=r"^\d{4}$")
 
 
@app.put("/api/pin")
def set_pin():
    """Set the 4-digit transaction PIN, or change it (needs the current PIN)."""
    user = current_user()
    data = parse(PinIn)
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
 
 
@app.get("/api/me")
def me():
    """Everything the home page needs: balance, flags, referral code, bank details, history."""
    user = current_user()
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
        "emailVerified": True, "twoFactorEnabled": False,  # fixed values: both features were removed
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
def transactions():
    """Raw balance history (every + and − on the account)."""
    user = current_user()
    with db() as c:
        rows = c.execute("SELECT kind, sats AS amount_sats, balance_after, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50", (user["id"],)).fetchall()
    return jsonify([dict(r) for r in rows])
 
 
@app.get("/api/referral")
def referral():
    """Referral code, share link, how many people joined with it and the bonus rules."""
    user = current_user()
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
def save_wallet():
    """Save (or remove) the user's withdrawal address for one currency/network. Needs the transaction PIN,
    so someone who borrows a logged-in phone can't swap in their own address."""
    user = current_user()
    data = parse(WalletIn)
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
def referrals():
    """The people who signed up with this user's code."""
    user = current_user()
    with db() as c:
        rows = c.execute(
            "SELECT username, created_at, referral_bonus_paid FROM users WHERE referred_by=? ORDER BY id DESC LIMIT 100",
            (user["id"],)).fetchall()
    return jsonify([{"name": r["username"], "joined": r["created_at"],
                     "status": "Active" if r["referral_bonus_paid"] else "Pending",
                     "bonusSats": REF_BONUS_REFERRER if r["referral_bonus_paid"] else 0} for r in rows])
 
 
@app.put("/api/password")
def change_password():
    """Change the login password (needs the current one) and sign out every other device."""
    user = current_user()
    data = parse(PasswordIn)
    key = f"pw:{user['id']}"
    if locked_out(key):
        raise ApiError(429, "Too many wrong attempts. Try again in 15 minutes.")
    if not verify_password(data.currentPassword, user["password_hash"]):
        record_fail(key)
        raise ApiError(403, "Current password is incorrect")
    if data.newPassword == data.currentPassword:
        raise ApiError(400, "New password must be different from the current one")
    token = bearer_token()
    with db() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(data.newPassword), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id=? AND token!=?", (user["id"], token_key(token)))
    return {"ok": True}
 
 
@app.put("/api/bank")
def save_bank():
    """Save the user's bank details for bank withdrawals."""
    user = current_user()
    data = parse(BankIn)
    with db() as c:
        c.execute("UPDATE users SET bank_name=?, account_number=?, account_name=? WHERE id=?",
                  (data.bankName.strip(), data.accountNumber, data.accountName.strip(), user["id"]))
    return {"ok": True}
 
 
# =====================================================================
# 12. MONEY API
# =====================================================================
@app.get("/api/deposit-address")
def deposit_address():
    """The user's deposit address. It changes after it receives a payment, after ADDRESS_TTL, or with ?new=1."""
    user = current_user()
    new = request.args.get("new", 0, type=int)
    with db() as c:
        c.execute("SELECT id FROM users WHERE id=? FOR UPDATE", (user["id"],))
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
def list_deposits():
    """The user's deposits (pending and confirmed)."""
    user = current_user()
    with db() as c:
        rows = c.execute("SELECT txid, sats, confirmations, status, created_at FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 20", (user["id"],)).fetchall()
    return jsonify([dict(r) for r in rows])
 
 
@app.post("/api/deposits/report")
def report_deposit():
    """User says "I sent it". Only pings you on Telegram. It NEVER credits anything."""
    user = current_user()
    data = parse(ReportIn)
    txid = (data.txid or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", txid):
        raise ApiError(400, "Paste the transaction ID (TXID) from your wallet first")
    notify(f"📨 User #{user['id']} says they sent a deposit" + (f"\nTx: <code>{txid}</code>" if txid else ""))
    return {"ok": True}
 
 
@app.get("/api/withdraw-options")
def withdraw_options():
    """The currencies/networks users can withdraw to, with fees and the minimum amount."""
    current_user()
    return {"minSats": MIN_WITHDRAW,
            "options": [{"id": k, **{f: v[f] for f in ("label", "coin", "network", "fee", "hint")}}
                        for k, v in WITHDRAW_OPTIONS.items()]}
 
 
@app.post("/api/withdraw")
def withdraw():
    """Request a withdrawal: checks everything, subtracts the balance at once, asks you to approve on Telegram."""
    user = current_user()
    data = parse(WithdrawIn)
    sats, method = data.sats, data.method
    wid = "WD" + base36(int(time.time() * 1000)) + secrets.token_hex(2).upper()
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=? FOR UPDATE", (user["id"],)).fetchone()
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
            used = c.execute("SELECT COALESCE(SUM(sats),0)::bigint FROM withdrawals WHERE user_id=? AND status!='Rejected' AND created_at > ?",
                             (u["id"], now() - timedelta(days=1))).fetchone()[0]
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
                  (wid, u["id"], method, dest, dest_full, sats, fee, sats - fee, now()))
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
def admin_overview():
    """Dashboard numbers."""
    require_admin()
    with db() as c:
        one = lambda q: c.execute(q).fetchone()  # noqa: E731
        pw = one("SELECT COUNT(*) c, COALESCE(SUM(receive),0)::bigint s FROM withdrawals WHERE status IN ('Pending','Approved')")
        pd = one("SELECT COUNT(*) c, COALESCE(SUM(sats),0)::bigint s FROM deposits WHERE status='Pending'")
        return {
            "users": one("SELECT COUNT(*) FROM users")[0],
            "totalBalanceSats": one("SELECT COALESCE(SUM(balance_sats),0)::bigint FROM users")[0],
            "pendingWithdrawals": dict(pw), "pendingDeposits": dict(pd),
            "depositedSats": one("SELECT COALESCE(SUM(sats),0)::bigint FROM deposits WHERE status='Confirmed'")[0],
            "bonusesPaidSats": one("SELECT COALESCE(SUM(sats),0)::bigint FROM ledger WHERE kind='referral_bonus'")[0],
            "addressesIssued": one("SELECT COUNT(*) FROM deposit_addresses")[0],
        }
 
 
@app.get("/api/admin/users")
def admin_users():
    """Search users by email or username."""
    require_admin()
    term = f"%{request.args.get('q', '').lower()}%"
    with db() as c:
        rows = c.execute(
            """SELECT id,email,username,balance_sats,invite_code AS referral_code,
                      referred_by,referral_bonus_paid,is_admin,created_at
               FROM users WHERE lower(email) LIKE ? OR lower(username) LIKE ? ORDER BY id DESC LIMIT 100""", (term, term)).fetchall()
    return jsonify([dict(r) for r in rows])
 
 
@app.get("/api/admin/withdrawals")
def admin_withdrawals():
    """Withdrawals, newest first (optionally only one status)."""
    require_admin()
    status = request.args.get("status") or None
    with db() as c:
        rows = c.execute(
            "SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id "
            + ("WHERE w.status=? " if status else "") + "ORDER BY w.created_at DESC LIMIT 100", (status,) if status else ()).fetchall()
    return jsonify([dict(r) for r in rows])
 
 
@app.get("/api/admin/deposits")
def admin_deposits():
    """Deposits, newest first."""
    require_admin()
    with db() as c:
        rows = c.execute("SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 100").fetchall()
    return jsonify([dict(r) for r in rows])
 
 
@app.post("/api/admin/withdrawals/<wid>/approve")
def admin_approve(wid):
    """Dashboard version of the Telegram Approve button."""
    require_admin()
    return {"ok": approve_withdrawal(wid)}
 
 
@app.post("/api/admin/withdrawals/<wid>/reject")
def admin_reject(wid):
    """Dashboard version of the Telegram Reject button (refunds the user)."""
    require_admin()
    return {"ok": reject_withdrawal(wid)}
 
 
@app.post("/api/admin/withdrawals/<wid>/paid")
def admin_paid(wid):
    """Dashboard version of /paid."""
    require_admin()
    data = parse(PaidIn)
    return {"ok": mark_paid(wid, data.ref)}
 
 
@app.post("/api/admin/users/<int:uid>/adjust")
def admin_adjust(uid):
    """Manually add (+) or remove (−) sats, with a reason saved in the ledger."""
    admin = require_admin()
    data = parse(AdjustIn)
    if data.sats == 0:
        raise ApiError(400, "Amount and reason are required")
    try:
        with db() as c:
            bal = adjust_balance(c, uid, data.sats, "admin_adjust", f"admin:{admin['id']}:{data.reason.strip()}")
    except ApiError:
        raise ApiError(400, "Could not adjust (user missing or balance would go negative)")
    notify(f"🛠 Admin #{admin['id']} adjusted user #{uid} by {data.sats:+,} sats\nReason: {esc(data.reason)}")
    return {"ok": True, "balanceSats": bal}

@app.get("/api/health")
def health():
    import socket
    u = urlparse(DATABASE_URL)
    out = {"host": u.hostname, "port": u.port,
           "pooler_style_user": "." in (u.username or "")}
    t = time.time()
    try:
        out["dns"] = sorted({a[4][0] for a in socket.getaddrinfo(u.hostname, u.port or 5432)})[:4]
    except Exception as e:  # noqa: BLE001
        out["dns"] = repr(e)
    out["dns_s"] = round(time.time() - t, 2)
    t = time.time()
    try:
        with psycopg.connect(DATABASE_URL, connect_timeout=8, sslmode="require", prepare_threshold=None) as conn:
            conn.execute("SELECT 1")
        out["fresh_connect"] = "ok"
    except Exception as e:  # noqa: BLE001
        out["fresh_connect"] = repr(e)
    out["fresh_connect_s"] = round(time.time() - t, 2)
    out["pool"] = str(pool.get_stats())
    return out
# =====================================================================
# 15. STATIC FILES (keep last)
# =====================================================================
def first_existing(*paths):
    """The first folder in the list that exists, or None."""
    for p in paths:
        if p and Path(p).is_dir():
            return Path(p)
    return None
 
 
def serve_from(directory: Path, path: str):
    """Send a file from `directory`. An empty path or a folder gives its index.html."""
    if path == "" or (directory / path).is_dir():
        path = (Path(path) / "index.html").as_posix()
    return send_from_directory(str(directory), path)
 
 
ADMIN_DIR = BASE / "public"
if ADMIN_DIR.is_dir():
    @app.get("/admin")
    def admin_redirect():
        """Send /admin to /admin/ so the dashboard's relative links work."""
        return redirect("/admin/")
 
    @app.get("/admin/", defaults={"path": ""})
    @app.get("/admin/<path:path>")
    def admin_files(path):
        """The admin dashboard files (./public)."""
        return serve_from(ADMIN_DIR, path)
 
ASSETS_DIR = first_existing(os.getenv("ASSETS_DIR"), BASE.parent / "static", BASE / "static")
PAGES_DIR = first_existing(os.getenv("FRONTEND_DIR"), BASE.parent / "TEMPLATES", BASE.parent / "templates", ASSETS_DIR)
if PAGES_DIR is None:  # nothing found: make an empty ./static so the app still starts
    PAGES_DIR = BASE / "static"
    PAGES_DIR.mkdir(exist_ok=True)
ASSETS_DIR = ASSETS_DIR or PAGES_DIR
print(f"Pages served from: {PAGES_DIR}\nAssets (/static/...) served from: {ASSETS_DIR}\nDatabase: PostgreSQL")
 
 
@app.get("/static/<path:path>")
def asset_files(path):
    """CSS / JS / images (/static/...)."""
    return send_from_directory(str(ASSETS_DIR), path)
 
 
@app.get("/", defaults={"path": ""})
@app.get("/<path:path>")
def page_files(path):
    """The website pages (login.html, home.html, ...)."""
    return serve_from(PAGES_DIR, path)
 
 
startup()
 
if __name__ == "__main__":
    # use_reloader=False so the background jobs are not started twice
    app.run(host="127.0.0.1", port=env_int("PORT", 8000), debug=False, use_reloader=False, threaded=True)