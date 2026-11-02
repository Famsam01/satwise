
"""Put fresh random secrets into your .env file (JWT_SECRET and ENC_KEY).
 
    python new_secrets.py
 
The secrets are made on YOUR computer and written straight into .env. They are never printed or sent anywhere.
Run it again any time you want to rotate them.
"""
import os
import re
import secrets
import sqlite3
import sys
from pathlib import Path
 
from dotenv import load_dotenv
 
BASE = Path(__file__).resolve().parent
ENV = BASE / ".env"
if not ENV.exists():
    sys.exit(f"No .env file found in {BASE}. Create it first (copy env-local-template.txt and rename it to .env).")
load_dotenv(ENV)
DB = os.getenv("NEXVEST_DB") or str(BASE / "nexvest.db")
 
# Changing ENC_KEY makes already-saved 2FA secrets unreadable. Count who would be affected.
affected = 0
if Path(DB).exists():
    try:
        with sqlite3.connect(DB) as conn:
            affected = conn.execute("SELECT COUNT(*) FROM users WHERE totp_enabled=1").fetchone()[0]
    except sqlite3.OperationalError:
        pass
 
print("This replaces JWT_SECRET and ENC_KEY in your .env with new random values.")
print("- Emailed verification codes that are still waiting will stop working (users just press Resend).")
if affected:
    print(f"- {affected} account(s) have 2FA on. Their 2FA will be switched OFF so nobody gets locked out; they can turn it on again.")
if input("Type YES to continue: ").strip() != "YES":
    sys.exit("Cancelled. Nothing was changed.")
 
text = ENV.read_text(encoding="utf-8")
for key in ("JWT_SECRET", "ENC_KEY"):
    value = secrets.token_hex(32)
    pattern = re.compile(rf"^{key}=.*$", re.M)
    if pattern.search(text):
        text = pattern.sub(lambda _m, k=key, v=value: f"{k}={v}", text)
    else:
        text += f"\n{key}={value}\n"
ENV.write_text(text, encoding="utf-8")
 
if affected:
    with sqlite3.connect(DB) as conn:
        conn.execute("UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=NULL WHERE totp_enabled=1")
print("Done. Restart the server (Ctrl+C, then run uvicorn again) so it uses the new secrets.")
 