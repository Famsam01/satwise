import sqlite3

conn = sqlite3.connect("nexvest.db")
cursor = conn.cursor()

# Get the exact columns available in your table
cursor.execute("PRAGMA table_info(users);")
columns = [col[1] for col in cursor.fetchall()]

updates = ["account_type = 'admin'"]

# Dynamically turn off any 2FA columns that exist in your database schema
if "two_factor_secret" in columns:
    updates.append("two_factor_secret = NULL")
if "two_factor_enabled" in columns:
    updates.append("two_factor_enabled = 0")
if "is_2fa_enabled" in columns:
    updates.append("is_2fa_enabled = 0")
if "two_factor_verified" in columns:
    updates.append("two_factor_verified = 1") # Tells the system 2FA is already satisfied

query = f"UPDATE users SET {', '.join(updates)} WHERE lower(email) = ?;"
cursor.execute(query, ("abdulawwalforex@gmail.com",))
conn.commit()

print(f"Database updated! 2FA flags disabled for your account. Rows changed: {cursor.rowcount}")
