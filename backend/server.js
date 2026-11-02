require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { authenticator } = require("otplib");
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { BIP32Factory } = require("bip32");
const bs58check = require("bs58check");

authenticator.options = { window: 1 }; // accept the previous/next 30s code (clock drift)
const bip32 = BIP32Factory(ecc);

/* ===================== CONFIG ===================== */
const E = process.env;
const PORT = E.PORT || 3000;
const JWT_SECRET = E.JWT_SECRET;
if (!JWT_SECRET) throw new Error("Set JWT_SECRET in .env");
const ENC_KEY = crypto
  .createHash("sha256")
  .update(E.ENC_KEY || JWT_SECRET)
  .digest();
const APP_URL = E.APP_URL || "http://localhost:5500";
const MEMPOOL_API = E.MEMPOOL_API || "https://mempool.space/api";
const num = (v, d) => (v === undefined || v === "" || isNaN(+v) ? d : +v);
const CONFIRMATIONS = num(E.CONFIRMATIONS, 2);
const MIN_DEPOSIT = num(E.MIN_DEPOSIT_SATS, 10000);
const MIN_WITHDRAW = num(E.MIN_WITHDRAW_SATS, 10000);
const BTC_FEE = num(E.BTC_WITHDRAW_FEE_SATS, 1500);
const BANK_FEE = 0;
const ADDRESS_TTL = num(E.ADDRESS_TTL_HOURS, 24) * 3600e3;
const MAX_NEW_ADDR_DAY = num(E.MAX_NEW_ADDRESSES_PER_DAY, 10);
const WATCH_DAYS = num(E.WATCH_DAYS, 30);
const REQUIRE_2FA = E.REQUIRE_2FA_FOR_WITHDRAW === "true";
const DAILY_LIMIT = num(E.DAILY_WITHDRAW_LIMIT_SATS, 0);
const REF_BONUS_NEW = num(E.REFERRAL_BONUS_NEW_USER_SATS, 0);
const REF_BONUS_REFERRER = num(E.REFERRAL_BONUS_REFERRER_SATS, 0);
const REF_MIN_DEPOSIT = num(E.REFERRAL_MIN_DEPOSIT_SATS, MIN_DEPOSIT);
const fmt = (n) => Number(n).toLocaleString("en-US");
const h = (s) =>
  String(s).replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================== DATABASE ===================== */
const db = new Database("nexvest.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  balance_sats INTEGER NOT NULL DEFAULT 0 CHECK (balance_sats >= 0),
  bank_name TEXT, account_number TEXT, account_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, user_id INTEGER UNIQUE); -- legacy v1 pool, still watched
CREATE TABLE IF NOT EXISTS deposit_addresses (
  address TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  idx INTEGER UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hd_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_index INTEGER NOT NULL);
INSERT OR IGNORE INTO hd_state (id, next_index) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  txid TEXT NOT NULL, vout INTEGER NOT NULL,
  address TEXT NOT NULL,
  sats INTEGER NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (txid, vout)
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  dest TEXT NOT NULL,
  dest_full TEXT NOT NULL,
  sats INTEGER NOT NULL, fee INTEGER NOT NULL, receive INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',
  txid TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref TEXT NOT NULL,
  sats INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);
// Non-destructive upgrade: add new columns to an existing v1 database.
const addCol = (t, c, def) => {
  if (
    !db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .some((x) => x.name === c)
  )
    db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
};
[
  ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
  ["verify_hash", "TEXT"],
  ["verify_expires", "INTEGER"],
  ["verify_sent_at", "INTEGER"],
  ["verify_attempts", "INTEGER NOT NULL DEFAULT 0"],
  ["totp_secret", "TEXT"],
  ["totp_enabled", "INTEGER NOT NULL DEFAULT 0"],
  ["totp_last", "TEXT"],
  ["is_admin", "INTEGER NOT NULL DEFAULT 0"],
  ["referral_code", "TEXT"],
  ["referred_by", "INTEGER"],
  ["referral_bonus_paid", "INTEGER NOT NULL DEFAULT 0"],
].forEach(([c, d]) => addCol("users", c, d));
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_refcode ON users(referral_code)",
);

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newRefCode = () =>
  Array.from(crypto.randomBytes(8), (x) => ALPHA[x % ALPHA.length]).join("");
db.prepare("SELECT id FROM users WHERE referral_code IS NULL")
  .all()
  .forEach((u) =>
    db
      .prepare("UPDATE users SET referral_code=? WHERE id=?")
      .run(newRefCode(), u.id),
  );

/** The ONLY way balances change. Balance + ledger row are written together or not at all. */
const adjustBalance = db.transaction((userId, delta, type, ref) => {
  const r = db
    .prepare("UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?")
    .run(delta, userId);
  if (!r.changes) throw new Error("NO_USER");
  const { balance_sats } = db
    .prepare("SELECT balance_sats FROM users WHERE id = ?")
    .get(userId);
  db.prepare(
    "INSERT INTO ledger (user_id,type,ref,sats,balance_after) VALUES (?,?,?,?,?)",
  ).run(userId, type, ref, delta, balance_sats);
  return balance_sats;
});

/* ===================== HELPERS: crypto, mail, telegram ===================== */
const enc = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
};
const dec = (s) => {
  const [iv, tag, ct] = s.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
};
const hashCode = (uid, code) =>
  crypto
    .createHash("sha256")
    .update(`${uid}:${code}:${JWT_SECRET}`)
    .digest("hex");
const safeEq = (a, b) =>
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const mailer = E.SMTP_URL ? nodemailer.createTransport(E.SMTP_URL) : null;
async function sendMail(to, subject, text) {
  if (!mailer)
    return console.log(`[DEV EMAIL] to=${to} | ${subject} | ${text}`);
  try {
    await mailer.sendMail({
      from: E.MAIL_FROM || "Nexvest <no-reply@localhost>",
      to,
      subject,
      text,
    });
  } catch (e) {
    console.error("mail error:", e.message);
  }
}
const mailUser = (uid, subject, text) => {
  const u = db.prepare("SELECT email FROM users WHERE id=?").get(uid);
  if (u) sendMail(u.email, subject, text);
};

async function tg(method, body) {
  if (!E.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return await r.json();
  } catch (e) {
    console.error("telegram error", e.message);
    return null;
  }
}
const notify = (text, reply_markup) =>
  tg("sendMessage", {
    chat_id: E.TELEGRAM_ADMIN_CHAT_ID,
    text,
    parse_mode: "HTML",
    reply_markup,
  });

/* ===================== 2FA (TOTP) ===================== */
function checkTotp(user, code) {
  if (!user.totp_secret) return false;
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c) || c === user.totp_last) return false; // blocks re-using the same code
  if (!authenticator.check(c, dec(user.totp_secret))) return false;
  db.prepare("UPDATE users SET totp_last=? WHERE id=?").run(c, user.id);
  return true;
}

/* ===================== ROTATING ADDRESSES (HD, watch-only) ===================== */
let CHAIN = null;
if (E.HD_XPUB) {
  const raw = Buffer.from(bs58check.decode(E.HD_XPUB));
  Buffer.from("0488b21e", "hex").copy(raw, 0); // zpub/ypub -> xpub so bip32 can read it
  CHAIN = bip32.fromBase58(bs58check.encode(raw)).derive(0); // external chain m/.../0
} else console.warn("HD_XPUB not set: deposit addresses are disabled.");

const deriveAddress = (i) =>
  bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(CHAIN.derive(i).publicKey),
    network: bitcoin.networks.bitcoin,
  }).address;

const issueAddress = db.transaction((userId) => {
  const { next_index } = db
    .prepare("SELECT next_index FROM hd_state WHERE id=1")
    .get();
  db.prepare("UPDATE hd_state SET next_index=next_index+1 WHERE id=1").run();
  const address = deriveAddress(next_index);
  db.prepare(
    "INSERT INTO deposit_addresses (address,user_id,idx,created_at) VALUES (?,?,?,?)",
  ).run(address, userId, next_index, Date.now());
  return address;
});

/* ===================== REFERRAL BONUS ===================== */
// Pays once: when a referred user has a verified email AND a confirmed deposit >= REF_MIN_DEPOSIT.
function tryReferralBonus(userId) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!u || !u.referred_by || u.referral_bonus_paid || !u.email_verified)
    return;
  if (
    !db
      .prepare(
        "SELECT 1 FROM deposits WHERE user_id=? AND status='Confirmed' AND sats>=?",
      )
      .get(userId, REF_MIN_DEPOSIT)
  )
    return;
  let paid = false;
  db.transaction(() => {
    if (
      !db
        .prepare(
          "UPDATE users SET referral_bonus_paid=1 WHERE id=? AND referral_bonus_paid=0",
        )
        .run(userId).changes
    )
      return;
    if (REF_BONUS_NEW > 0)
      adjustBalance(userId, REF_BONUS_NEW, "referral_bonus", "ref:" + userId);
    if (REF_BONUS_REFERRER > 0)
      adjustBalance(
        u.referred_by,
        REF_BONUS_REFERRER,
        "referral_bonus",
        "ref:" + userId,
      );
    paid = true;
  })();
  if (paid) {
    notify(
      `🎁 <b>Referral bonus paid</b>\nNew user #${userId}: +${fmt(REF_BONUS_NEW)} sats\nReferrer #${u.referred_by}: +${fmt(REF_BONUS_REFERRER)} sats`,
    );
    if (REF_BONUS_NEW > 0)
      mailUser(
        userId,
        "You received a referral bonus",
        `${fmt(REF_BONUS_NEW)} sats were added to your balance.`,
      );
  }
}

/* ===================== WITHDRAWAL STATE CHANGES (used by Telegram AND admin dashboard) ===================== */
const approveWithdrawal = (id) =>
  db
    .prepare(
      "UPDATE withdrawals SET status='Approved' WHERE id=? AND status='Pending'",
    )
    .run(id).changes > 0;

const rejectWithdrawal = db.transaction((id) => {
  const w = db.prepare("SELECT * FROM withdrawals WHERE id=?").get(id);
  if (!w || w.status !== "Pending") return false;
  db.prepare("UPDATE withdrawals SET status='Rejected' WHERE id=?").run(id);
  adjustBalance(w.user_id, w.sats, "refund", id); // give the money back
  mailUser(
    w.user_id,
    "Withdrawal rejected",
    `Your withdrawal ${id} was rejected and ${fmt(w.sats)} sats were returned to your balance.`,
  );
  return true;
});

function markPaid(id, ref) {
  const r = db
    .prepare(
      "UPDATE withdrawals SET status='Completed', txid=? WHERE id=? AND status='Approved'",
    )
    .run(ref || null, id);
  if (r.changes) {
    const w = db
      .prepare("SELECT user_id,receive FROM withdrawals WHERE id=?")
      .get(id);
    mailUser(
      w.user_id,
      "Withdrawal sent",
      `Your withdrawal ${id} (${fmt(w.receive)} sats) has been sent.${ref ? " Reference: " + ref : ""}`,
    );
  }
  return r.changes > 0;
}

/* ===================== TELEGRAM BOT ===================== */
async function telegramPoll() {
  if (!E.TELEGRAM_BOT_TOKEN) return console.log("Telegram disabled (no token)");
  let offset = 0;
  for (;;) {
    const res = await tg("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["callback_query", "message"],
    });
    if (!res || !res.ok) {
      await sleep(5000);
      continue;
    }
    for (const u of res.result) {
      offset = u.update_id + 1;
      try {
        await handleUpdate(u);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
async function handleUpdate(u) {
  const admin = String(E.TELEGRAM_ADMIN_CHAT_ID);
  if (u.callback_query) {
    const q = u.callback_query;
    if (String(q.from.id) !== admin)
      return tg("answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Not allowed",
      });
    const [, action, id] = q.data.split(":");
    let ok = false,
      suffix = "";
    if (action === "approve") {
      ok = approveWithdrawal(id);
      suffix = `\n\n✅ APPROVED. Send the funds, then reply:\n/paid ${id} <txid or bank ref>`;
    }
    if (action === "reject") {
      ok = rejectWithdrawal(id);
      suffix = "\n\n❌ REJECTED and refunded";
    }
    if (ok)
      await tg("editMessageText", {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        text: q.message.text + suffix,
      });
    return tg("answerCallbackQuery", {
      callback_query_id: q.id,
      text: ok ? "Done" : "Already handled",
    });
  }
  const m = u.message;
  if (m && m.text && String(m.chat.id) === admin) {
    const [cmd, id, ...rest] = m.text.trim().split(/\s+/);
    if (cmd === "/paid" && id)
      return notify(
        markPaid(id, rest.join(" "))
          ? `💸 ${h(id)} marked Completed.`
          : `Nothing to update for ${h(id)} (must be Approved first).`,
      );
    if (cmd === "/stats") {
      const s = db
        .prepare(
          "SELECT COUNT(*) c, COALESCE(SUM(balance_sats),0) t FROM users",
        )
        .get();
      return notify(`Users: ${s.c}\nTotal user balances: ${fmt(s.t)} sats`);
    }
  }
}

/* ===================== DEPOSIT WATCHER ===================== */
// Fresh addresses are checked every minute; older ones every 10th minute (until WATCH_DAYS).
let watching = false,
  cycle = 0;
async function checkDeposits() {
  if (watching) return;
  watching = true;
  cycle++;
  try {
    const now = Date.now();
    const rows = db
      .prepare(
        `
      SELECT address,user_id FROM deposit_addresses WHERE created_at > ?
      UNION SELECT address,user_id FROM deposit_addresses WHERE ? = 1 AND created_at > ?
      UNION SELECT address,user_id FROM deposits WHERE status='Pending'
      UNION SELECT address,user_id FROM addresses WHERE user_id IS NOT NULL
    `,
      )
      .all(
        now - 24 * 3600e3,
        cycle % 10 === 0 ? 1 : 0,
        now - WATCH_DAYS * 86400e3,
      );
    if (!rows.length) return;
    const tip = +(await (
      await fetch(`${MEMPOOL_API}/blocks/tip/height`)
    ).text());

    for (const { address, user_id } of rows) {
      const resp = await fetch(`${MEMPOOL_API}/address/${address}/txs`);
      if (!resp.ok) {
        await sleep(300);
        continue;
      }
      const txs = await resp.json();
      for (const tx of Array.isArray(txs) ? txs : []) {
        const conf =
          tx.status && tx.status.confirmed
            ? tip - tx.status.block_height + 1
            : 0;
        tx.vout.forEach((o, vout) => {
          if (o.scriptpubkey_address !== address) return;
          let d = db
            .prepare("SELECT * FROM deposits WHERE txid=? AND vout=?")
            .get(tx.txid, vout);
          if (!d) {
            const below = o.value < MIN_DEPOSIT;
            db.prepare(
              "INSERT INTO deposits (user_id,txid,vout,address,sats,confirmations,status) VALUES (?,?,?,?,?,?,?)",
            ).run(
              user_id,
              tx.txid,
              vout,
              address,
              o.value,
              conf,
              below ? "Rejected" : "Pending",
            );
            db.prepare(
              "UPDATE deposit_addresses SET used=1 WHERE address=?",
            ).run(address); // next visit gets a fresh address
            notify(
              `🟡 <b>Deposit detected</b>\nUser #${user_id}\n${fmt(o.value)} sats\nTx: <code>${tx.txid}</code>` +
                (below ? "\n⚠️ Below minimum, will not be credited." : ""),
            );
            d = db
              .prepare("SELECT * FROM deposits WHERE txid=? AND vout=?")
              .get(tx.txid, vout);
          }
          if (d.status !== "Pending") return;
          if (conf >= CONFIRMATIONS) {
            let credited = false;
            db.transaction(() => {
              if (
                db
                  .prepare(
                    "UPDATE deposits SET status='Confirmed', confirmations=? WHERE id=? AND status='Pending'",
                  )
                  .run(conf, d.id).changes
              ) {
                adjustBalance(user_id, d.sats, "deposit", `${tx.txid}:${vout}`); // + balance
                credited = true;
              }
            })();
            if (credited) {
              notify(
                `✅ <b>Deposit credited</b>\nUser #${user_id}\n+${fmt(d.sats)} sats\nTx: <code>${tx.txid}</code>`,
              );
              mailUser(
                user_id,
                "Deposit confirmed",
                `${fmt(d.sats)} sats were added to your balance.`,
              );
              tryReferralBonus(user_id);
            }
          } else if (conf !== d.confirmations)
            db.prepare("UPDATE deposits SET confirmations=? WHERE id=?").run(
              conf,
              d.id,
            );
        });
      }
      await sleep(150); // be polite to the public API
    }
  } catch (e) {
    console.error("deposit watcher:", e.message);
  } finally {
    watching = false;
  }
}

/* ===================== API SETUP ===================== */
const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: E.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "50kb" }));

const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(req.ip, arr);
  if (arr.length > 120)
    return res.status(429).json({ error: "Too many requests" });
  next();
});

const sign = (id) => jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" });
function auth(req, res, next) {
  try {
    req.uid = jwt.verify(
      (req.headers.authorization || "").replace("Bearer ", ""),
      JWT_SECRET,
    ).id;
    next();
  } catch (e) {
    res.status(401).json({ error: "Not signed in" });
  }
}
function adminOnly(req, res, next) {
  const u = db
    .prepare("SELECT is_admin,totp_enabled FROM users WHERE id=?")
    .get(req.uid);
  if (!u || !u.is_admin) return res.status(403).json({ error: "Admins only" });
  if (!u.totp_enabled)
    return res
      .status(403)
      .json({ error: "Enable 2FA on this admin account first", need2fa: true });
  next();
}
const isBtcAddress = (a) =>
  /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a);

const failed = new Map(); // login lockout: 5 failures / 15 min per email
const lockedOut = (k) => {
  const a = (failed.get(k) || []).filter((t) => Date.now() - t < 900000);
  failed.set(k, a);
  return a.length >= 5;
};
const recordFail = (k) => {
  lockedOut(k);
  failed.get(k).push(Date.now());
};

/* ===================== AUTH + EMAIL VERIFICATION ===================== */
function issueVerification(userId, email) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  db.prepare(
    "UPDATE users SET verify_hash=?, verify_expires=?, verify_sent_at=?, verify_attempts=0 WHERE id=?",
  ).run(hashCode(userId, code), Date.now() + 15 * 60000, Date.now(), userId);
  sendMail(
    email,
    "Your Nexvest verification code",
    `Your code is ${code}. It expires in 15 minutes. If you didn't sign up, ignore this email.`,
  );
}

app.post("/api/register", (req, res) => {
  const { email, password, ref } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || "") || (password || "").length < 8)
    return res
      .status(400)
      .json({ error: "Valid email and 8+ character password required" });
  let referrer = null;
  if (ref) {
    referrer = db
      .prepare("SELECT id FROM users WHERE referral_code=?")
      .get(String(ref).trim().toUpperCase());
    if (!referrer)
      return res.status(400).json({ error: "That referral code is not valid" });
  }
  const lower = email.toLowerCase();
  for (let i = 0; i < 5; i++) {
    try {
      const id = db
        .prepare(
          "INSERT INTO users (email,pass_hash,referral_code,referred_by) VALUES (?,?,?,?)",
        )
        .run(
          lower,
          bcrypt.hashSync(password, 10),
          newRefCode(),
          referrer ? referrer.id : null,
        ).lastInsertRowid;
      issueVerification(id, lower);
      if (referrer)
        notify(`👥 New signup #${id} via referral from user #${referrer.id}`);
      return res.json({ token: sign(id), emailVerified: false });
    } catch (e) {
      if (/users\.email/.test(e.message))
        return res.status(409).json({ error: "Email already registered" });
      if (!/referral_code/.test(e.message)) {
        console.error(e);
        break;
      }
    }
  }
  res.status(500).json({ error: "Could not create account" });
});

app.post("/api/login", (req, res) => {
  const { email, password, code } = req.body || {};
  const key = String(email || "").toLowerCase();
  if (lockedOut(key))
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again in 15 minutes." });
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(key);
  if (!u || !bcrypt.compareSync(password || "", u.pass_hash)) {
    recordFail(key);
    return res.status(401).json({ error: "Wrong email or password" });
  }
  if (u.totp_enabled) {
    if (!code)
      return res
        .status(401)
        .json({ error: "Enter your 2FA code", needs2fa: true });
    if (!checkTotp(u, code)) {
      recordFail(key);
      return res.status(401).json({ error: "Wrong 2FA code", needs2fa: true });
    }
  }
  res.json({ token: sign(u.id), emailVerified: !!u.email_verified });
});

app.post("/api/verify-email", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  if (u.email_verified) return res.json({ ok: true });
  if (!u.verify_hash || Date.now() > u.verify_expires)
    return res.status(400).json({ error: "Code expired. Request a new one." });
  if (u.verify_attempts >= 5)
    return res
      .status(429)
      .json({ error: "Too many wrong codes. Request a new one." });
  const c = String((req.body || {}).code || "").trim();
  if (!safeEq(hashCode(u.id, c), u.verify_hash)) {
    db.prepare(
      "UPDATE users SET verify_attempts=verify_attempts+1 WHERE id=?",
    ).run(u.id);
    return res.status(400).json({ error: "Wrong code" });
  }
  db.prepare(
    "UPDATE users SET email_verified=1, verify_hash=NULL WHERE id=?",
  ).run(u.id);
  tryReferralBonus(u.id);
  res.json({ ok: true });
});

app.post("/api/resend-verification", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  if (u.email_verified) return res.json({ ok: true });
  if (u.verify_sent_at && Date.now() - u.verify_sent_at < 60000)
    return res
      .status(429)
      .json({ error: "Wait a minute before requesting another code" });
  issueVerification(u.id, u.email);
  res.json({ ok: true });
});

/* ===================== 2FA ROUTES ===================== */
app.post("/api/2fa/setup", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  if (u.totp_enabled)
    return res.status(400).json({ error: "2FA is already on" });
  const secret = authenticator.generateSecret();
  db.prepare("UPDATE users SET totp_secret=?, totp_last=NULL WHERE id=?").run(
    enc(secret),
    u.id,
  );
  res.json({
    secret,
    otpauth: authenticator.keyuri(u.email, "Nexvest", secret),
  }); // render otpauth as a QR on the page
});
app.post("/api/2fa/enable", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  if (!checkTotp(u, (req.body || {}).code))
    return res.status(400).json({ error: "Wrong code" });
  db.prepare("UPDATE users SET totp_enabled=1 WHERE id=?").run(u.id);
  res.json({ ok: true });
});
app.post("/api/2fa/disable", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  const { password, code } = req.body || {};
  if (!bcrypt.compareSync(password || "", u.pass_hash) || !checkTotp(u, code))
    return res.status(400).json({ error: "Wrong password or code" });
  db.prepare(
    "UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?",
  ).run(u.id);
  res.json({ ok: true });
});

/* ===================== USER DATA ===================== */
app.get("/api/me", auth, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);
  const wd = db
    .prepare(
      "SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC LIMIT 25",
    )
    .all(u.id)
    .map((w) => ({
      id: w.id,
      type: "withdrawal",
      method: w.method,
      dest: w.dest,
      sats: w.sats,
      status: w.status,
      date: w.created_at + "Z",
    }));
  const dp = db
    .prepare(
      "SELECT * FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 25",
    )
    .all(u.id)
    .map((d) => ({
      id: d.txid,
      type: "deposit",
      sats: d.sats,
      txid: d.txid,
      status: d.status,
      confirmations: d.confirmations,
      date: d.created_at + "Z",
    }));
  const bonus = db
    .prepare(
      "SELECT * FROM ledger WHERE user_id=? AND type IN ('referral_bonus','admin_adjust') ORDER BY id DESC LIMIT 10",
    )
    .all(u.id)
    .map((l) => ({
      id: "L" + l.id,
      type: "bonus",
      sats: l.sats,
      status: "Completed",
      note: l.type === "referral_bonus" ? "Referral bonus" : "Adjustment",
      date: l.created_at + "Z",
    }));
  res.json({
    balanceSats: u.balance_sats,
    email: u.email,
    emailVerified: !!u.email_verified,
    twoFactorEnabled: !!u.totp_enabled,
    referralCode: u.referral_code,
    bankName: u.bank_name,
    accountNumber: u.account_number,
    accountName: u.account_name,
    transactions: [...wd, ...dp, ...bonus].sort((a, b) =>
      b.date.localeCompare(a.date),
    ),
  });
});

app.get("/api/referral", auth, (req, res) => {
  const u = db
    .prepare("SELECT referral_code FROM users WHERE id=?")
    .get(req.uid);
  const referred = db
    .prepare("SELECT COUNT(*) c FROM users WHERE referred_by=?")
    .get(req.uid).c;
  const qualified = db
    .prepare(
      "SELECT COUNT(*) c FROM users WHERE referred_by=? AND referral_bonus_paid=1",
    )
    .get(req.uid).c;
  res.json({
    code: u.referral_code,
    link: `${APP_URL}/signup.html?ref=${u.referral_code}`,
    referred,
    qualified,
    bonusForNewUserSats: REF_BONUS_NEW,
    bonusForReferrerSats: REF_BONUS_REFERRER,
    minDepositSats: REF_MIN_DEPOSIT,
    earnedSats: qualified * REF_BONUS_REFERRER,
  });
});

app.put("/api/bank", auth, (req, res) => {
  const { bankName, accountNumber, accountName } = req.body || {};
  if (!bankName || !/^\d{6,20}$/.test(accountNumber || "") || !accountName)
    return res
      .status(400)
      .json({ error: "Enter bank name, account number and account name" });
  db.prepare(
    "UPDATE users SET bank_name=?,account_number=?,account_name=? WHERE id=?",
  ).run(bankName, accountNumber, accountName, req.uid);
  res.json({ ok: true });
});

/* ===================== DEPOSIT ADDRESS (rotates) ===================== */
// A user keeps the same address only until it is used once, or ADDRESS_TTL passes. ?new=1 forces a fresh one.
// Old addresses keep being watched, so a late payment to an old address is still credited.
app.get("/api/deposit-address", auth, (req, res) => {
  if (!CHAIN)
    return res.status(503).json({ error: "Deposits are not configured" });
  const cur = db
    .prepare(
      "SELECT * FROM deposit_addresses WHERE user_id=? ORDER BY idx DESC LIMIT 1",
    )
    .get(req.uid);
  const fresh = cur && !cur.used && Date.now() - cur.created_at < ADDRESS_TTL;
  if (fresh && req.query.new !== "1")
    return res.json({ address: cur.address, rotated: false });
  const today = db
    .prepare(
      "SELECT COUNT(*) c FROM deposit_addresses WHERE user_id=? AND created_at > ?",
    )
    .get(req.uid, Date.now() - 86400e3).c;
  if (today >= MAX_NEW_ADDR_DAY) {
    if (cur) return res.json({ address: cur.address, rotated: false });
    return res
      .status(429)
      .json({ error: "Address limit reached, try again later" });
  }
  res.json({ address: issueAddress(req.uid), rotated: true });
});

app.post("/api/deposits/report", auth, (req, res) => {
  const txid = String((req.body || {}).txid || "").trim();
  if (txid && !/^[0-9a-fA-F]{64}$/.test(txid))
    return res.status(400).json({ error: "Invalid transaction ID" });
  notify(
    `📨 User #${req.uid} says they sent a deposit${txid ? `\nTx: <code>${txid}</code>` : ""}`,
  );
  res.json({ ok: true });
});

/* ===================== WITHDRAW ===================== */
app.post("/api/withdraw", auth, (req, res) => {
  const { method, address, code } = req.body || {};
  const sats = Math.floor(Number((req.body || {}).sats));
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.uid);

  if (!u.email_verified)
    return res
      .status(403)
      .json({ error: "Verify your email before withdrawing" });
  if (REQUIRE_2FA && !u.totp_enabled)
    return res
      .status(403)
      .json({ error: "Turn on 2FA to withdraw", need2faSetup: true });
  if (u.totp_enabled && !checkTotp(u, code))
    return res
      .status(403)
      .json({ error: "Enter a valid 2FA code", needs2fa: true });

  if (!["bank", "btc"].includes(method))
    return res.status(400).json({ error: "Invalid method" });
  if (!Number.isFinite(sats) || sats < MIN_WITHDRAW)
    return res
      .status(400)
      .json({ error: `Minimum withdrawal is ${fmt(MIN_WITHDRAW)} sats` });
  const fee = method === "btc" ? BTC_FEE : BANK_FEE;
  if (sats <= fee)
    return res
      .status(400)
      .json({ error: "Amount must be more than the network fee" });
  if (DAILY_LIMIT > 0) {
    const used = db
      .prepare(
        "SELECT COALESCE(SUM(sats),0) s FROM withdrawals WHERE user_id=? AND status!='Rejected' AND created_at > datetime('now','-1 day')",
      )
      .get(u.id).s;
    if (used + sats > DAILY_LIMIT)
      return res
        .status(400)
        .json({ error: `Daily limit is ${fmt(DAILY_LIMIT)} sats` });
  }

  let dest, destFull;
  if (method === "btc") {
    const a = String(address || "").trim();
    if (!isBtcAddress(a))
      return res.status(400).json({ error: "Enter a valid Bitcoin address" });
    dest = a.slice(0, 8) + "…" + a.slice(-6);
    destFull = a;
  } else {
    if (!u.bank_name || !u.account_number || !u.account_name)
      return res.status(400).json({ error: "Add your bank details first" });
    dest = `${u.bank_name} · ${"•".repeat(Math.max(u.account_number.length - 4, 0))}${u.account_number.slice(-4)}`;
    destFull = `${u.bank_name} | ${u.account_name} | ${u.account_number}`;
  }

  const id =
    "WD" +
    Date.now().toString(36).toUpperCase() +
    crypto.randomBytes(2).toString("hex").toUpperCase();
  try {
    db.transaction(() => {
      if (
        db.prepare("SELECT balance_sats FROM users WHERE id=?").get(u.id)
          .balance_sats < sats
      )
        throw new Error("INSUFFICIENT");
      adjustBalance(u.id, -sats, "withdrawal", id); // − balance
      db.prepare(
        "INSERT INTO withdrawals (id,user_id,method,dest,dest_full,sats,fee,receive) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, u.id, method, dest, destFull, sats, fee, sats - fee);
    })();
  } catch (e) {
    if (e.message === "INSUFFICIENT")
      return res
        .status(400)
        .json({ error: "That's more than your available balance" });
    console.error(e);
    return res.status(500).json({ error: "Something went wrong" });
  }
  notify(
    `🔴 <b>Withdrawal request</b> <code>${id}</code>\nUser #${u.id} (${h(u.email)})\nMethod: ${method}\nAmount: ${fmt(sats)} sats\nFee: ${fmt(fee)} sats\nSend: <b>${fmt(sats - fee)} sats</b>\nTo: <code>${h(destFull)}</code>`,
    {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `wd:approve:${id}` },
          { text: "❌ Reject", callback_data: `wd:reject:${id}` },
        ],
      ],
    },
  );
  mailUser(
    u.id,
    "Withdrawal requested",
    `We received your withdrawal ${id} for ${fmt(sats)} sats. If this wasn't you, contact support immediately.`,
  );
  res.json({
    balanceSats: db
      .prepare("SELECT balance_sats FROM users WHERE id=?")
      .get(u.id).balance_sats,
    withdrawal: {
      id,
      method,
      dest,
      sats,
      fee,
      receive: sats - fee,
      status: "Pending",
      date: new Date().toISOString(),
    },
  });
});

/* ===================== ADMIN API + DASHBOARD ===================== */
const admin = express.Router();
admin.use(auth, adminOnly);

admin.get("/overview", (req, res) => {
  const q = (s, ...a) => db.prepare(s).get(...a);
  res.json({
    users: q("SELECT COUNT(*) c FROM users").c,
    totalBalanceSats: q("SELECT COALESCE(SUM(balance_sats),0) s FROM users").s,
    pendingWithdrawals: q(
      "SELECT COUNT(*) c, COALESCE(SUM(receive),0) s FROM withdrawals WHERE status IN ('Pending','Approved')",
    ),
    pendingDeposits: q(
      "SELECT COUNT(*) c, COALESCE(SUM(sats),0) s FROM deposits WHERE status='Pending'",
    ),
    depositedSats: q(
      "SELECT COALESCE(SUM(sats),0) s FROM deposits WHERE status='Confirmed'",
    ).s,
    bonusesPaidSats: q(
      "SELECT COALESCE(SUM(sats),0) s FROM ledger WHERE type='referral_bonus'",
    ).s,
    addressesIssued: q("SELECT COUNT(*) c FROM deposit_addresses").c,
  });
});
admin.get("/users", (req, res) => {
  const term = "%" + String(req.query.q || "").toLowerCase() + "%";
  res.json(
    db
      .prepare(
        `SELECT id,email,balance_sats,email_verified,totp_enabled,referral_code,referred_by,referral_bonus_paid,is_admin,created_at
    FROM users WHERE email LIKE ? ORDER BY id DESC LIMIT 100`,
      )
      .all(term),
  );
});
admin.get("/withdrawals", (req, res) => {
  const st = req.query.status;
  res.json(
    db
      .prepare(
        `SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id
    ${st ? "WHERE w.status=?" : ""} ORDER BY w.created_at DESC LIMIT 100`,
      )
      .all(...(st ? [st] : [])),
  );
});
admin.get("/deposits", (req, res) => {
  res.json(
    db
      .prepare(
        "SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 100",
      )
      .all(),
  );
});
admin.post("/withdrawals/:id/approve", (req, res) =>
  res.json({ ok: approveWithdrawal(req.params.id) }),
);
admin.post("/withdrawals/:id/reject", (req, res) =>
  res.json({ ok: !!rejectWithdrawal(req.params.id) }),
);
admin.post("/withdrawals/:id/paid", (req, res) =>
  res.json({
    ok: markPaid(
      req.params.id,
      String((req.body || {}).ref || "").slice(0, 200),
    ),
  }),
);
admin.post("/users/:id/adjust", (req, res) => {
  const sats = Math.trunc(Number((req.body || {}).sats)),
    reason = String((req.body || {}).reason || "")
      .trim()
      .slice(0, 200);
  if (!sats || !reason)
    return res.status(400).json({ error: "Amount and reason are required" });
  try {
    const bal = adjustBalance(
      +req.params.id,
      sats,
      "admin_adjust",
      `admin:${req.uid}:${reason}`,
    );
    notify(
      `🛠 Admin #${req.uid} adjusted user #${req.params.id} by ${sats > 0 ? "+" : ""}${fmt(sats)} sats\nReason: ${h(reason)}`,
    );
    res.json({ ok: true, balanceSats: bal });
  } catch (e) {
    res
      .status(400)
      .json({
        error: "Could not adjust (user missing or balance would go negative)",
      });
  }
});
app.use("/api/admin", admin);

app.use(
  "/admin",
  (req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    next();
  },
  express.static(path.join(__dirname, "public")),
);

app.listen(PORT, () => {
  console.log("Nexvest backend on :" + PORT);
  setInterval(checkDeposits, 60000);
  checkDeposits();
  telegramPoll();
});
