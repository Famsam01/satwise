"""Look inside the database (secrets are hidden).
 
    python show_db.py            list every table with its columns and number of rows
    python show_db.py users      show the newest 20 rows of one table
    python show_db.py withdrawals
"""
import os
import sqlite3
import sys
from pathlib import Path
 
from dotenv import load_dotenv
 
BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")
DB = os.getenv("NEXVEST_DB") or str(BASE / "nexvest.db")
HIDDEN = {"password_hash", "totp_secret", "verify_hash", "token"}
 
if not Path(DB).exists():
    sys.exit(f"No database at {DB} yet. Start the server once (uvicorn main:app) and it will be created.")
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
tables = [r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
print("Database:", DB)
 
if len(sys.argv) < 2:
    for t in tables:
        cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({t})")]
        n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"\n{t}  ({n} rows)\n  columns: {', '.join(cols)}")
elif sys.argv[1] in tables:
    t = sys.argv[1]
    rows = conn.execute(f"SELECT * FROM {t} ORDER BY rowid DESC LIMIT 20").fetchall()
    print(f"\n{t}: newest {len(rows)} rows")
    for r in rows:
        print("-" * 60)
        for k in r.keys():
            v = "(hidden)" if k in HIDDEN and r[k] else r[k]
            print(f"  {k}: {v}")
else:
    print("No such table. Tables are:", ", ".join(tables))