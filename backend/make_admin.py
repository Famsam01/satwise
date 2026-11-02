
"""Create an admin account, or turn an existing account into one.
 
Usage (from the backend folder, venv active):
    python make_admin.py you@email.com
 
 - If the email already has an account, it is promoted to admin.
 - If not, you are asked to type a password and the account is created.
The password is typed here once. It is never saved in a file, only as a scrambled hash in the database.
"""
import getpass
import re
import secrets
import sys
from pathlib import Path
 
sys.path.insert(0, str(Path(__file__).resolve().parent))
from main import db, hash_password, init_db, iso, new_invite_code  # noqa: E402  (loads your .env and database)
 
 
def main() -> None:
    if len(sys.argv) < 2 or "@" not in sys.argv[1]:
        print("Usage: python make_admin.py you@email.com")
        return
    email = sys.argv[1].strip().lower()
    init_db()  # adds any missing columns (like is_admin) to an older database first
    with db() as c:
        row = c.execute("SELECT id FROM users WHERE lower(email)=?", (email,)).fetchone()
        if row:
            c.execute("UPDATE users SET is_admin=1, email_verified=1, "
                      "account_type=CASE WHEN account_type='admin' THEN 'individual' ELSE account_type END WHERE id=?", (row["id"],))
            print(f"{email} is now an admin. Sign in at /admin with your usual password.")
            return
        password = getpass.getpass("Choose an admin password (8+ characters): ")
        if len(password) < 8 or password != getpass.getpass("Type it again: "):
            print("Passwords must match and be at least 8 characters. Nothing was created.")
            return
        base = re.sub(r"[^A-Za-z0-9_.]", "", email.split("@")[0])[:14] or "admin"
        username = base
        while c.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            username = base + str(secrets.randbelow(9000) + 1000)
        c.execute(
            """INSERT INTO users (username,email,phone,account_type,password_hash,invite_code,created_at,email_verified,is_admin)
               VALUES (?,?,?,?,?,?,?,1,1)""",
            (username, email, "", "individual", hash_password(password), new_invite_code(c), iso()),
        )
        print(f"Admin account created for {email}. Sign in at /admin and set up 2FA.")
 
 
if __name__ == "__main__":
    main()
 