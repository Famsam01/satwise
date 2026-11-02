import sqlite3
conn = sqlite3.connect("nexvest.db")
cur = conn.execute("SELECT id, username, email FROM users;")
print("Registered users:", cur.fetchall())
