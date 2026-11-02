
"""Switch OFF two-factor authentication (2FA) for one account, or for everybody.
 
    python reset_2fa.py you@email.com      one account (use this if you lost your authenticator app)
    python reset_2fa.py --all              every account
 
After this, those accounts sign in with just email + password. They can turn 2FA on again any time.
(The admin dashboard still asks admins to set 2FA up again unless ADMIN_REQUIRES_2FA=false in .env.)
"""
import os
import sqlite3
import sys
from pathlib import Path
 
from dotenv import load_dotenv
 
BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")
DB = os.getenv("NEXVEST_DB") or str(BASE / "nexvest.db")
 
if len(sys.argv) < 2:
    sys.exit(__doc__)
if not Path(DB).exists():
    sys.exit(f"No database at {DB}.")
 
with sqlite3.connect(DB) as conn:
    if sys.argv[1] == "--all":
        n = conn.execute("SELECT COUNT(*) FROM users WHERE totp_enabled=1 OR totp_secret IS NOT NULL").fetchone()[0]
        if input(f"Switch off 2FA for {n} account(s)? Type YES: ").strip() != "YES":
            sys.exit("Cancelled. Nothing was changed.")
        conn.execute("UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=NULL")
        print(f"Done. 2FA is off for {n} account(s).")
    else:
        email = sys.argv[1].strip().lower()
        cur = conn.execute("UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_last=NULL WHERE lower(email)=?", (email,))
        print(f"Done. 2FA is off for {email}." if cur.rowcount else "No user with that email.")
 