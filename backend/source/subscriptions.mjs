import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const daySeconds = 24 * 60 * 60;
export const planAmounts = { 30: 8000, 90: 19000, 180: 39000 };
export const legacyPlanAmounts = { 30: 19900, 90: 54900, 180: 109900 };

export function openSubscriptions(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS subscriptions (
      customer TEXT PRIMARY KEY,
      credential TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      paid_until INTEGER,
      paid_plan_days INTEGER NOT NULL DEFAULT 30,
      access_kind TEXT NOT NULL DEFAULT 'paid',
      data_limit INTEGER NOT NULL DEFAULT 0,
      trial_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trials (
      customer TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS referrals (
      invited_customer TEXT PRIMARY KEY,
      referrer_customer TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      bonus_applied INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      payment_id TEXT UNIQUE,
      duration_days INTEGER NOT NULL DEFAULT 30,
      provider_transaction_id TEXT UNIQUE,
      payment_method INTEGER NOT NULL DEFAULT 2
    );
  `);
  try {
    const subscriptionColumns = db.prepare("PRAGMA table_info(subscriptions)").all().map(column => column.name);
    if (!subscriptionColumns.includes("paid_until")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN paid_until INTEGER");
    }
    if (!subscriptionColumns.includes("paid_plan_days")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN paid_plan_days INTEGER NOT NULL DEFAULT 30");
    }
    if (!subscriptionColumns.includes("access_kind")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN access_kind TEXT NOT NULL DEFAULT 'paid'");
    }
    if (!subscriptionColumns.includes("data_limit")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN data_limit INTEGER NOT NULL DEFAULT 0");
    }
    if (!subscriptionColumns.includes("trial_used")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0");
    }
    const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
    if (!orderColumns.includes("duration_days")) {
      db.exec("ALTER TABLE orders ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 30");
    }
    if (!orderColumns.includes("provider_transaction_id")) {
      db.exec("ALTER TABLE orders ADD COLUMN provider_transaction_id TEXT");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_transaction_id ON orders(provider_transaction_id)");
    }
    if (!orderColumns.includes("payment_method")) {
      db.exec("ALTER TABLE orders ADD COLUMN payment_method INTEGER NOT NULL DEFAULT 2");
    }
    db.exec(`UPDATE subscriptions SET access_kind = 'trial', data_limit = 5368709120, trial_used = 1
      WHERE paid_plan_days = 2 AND paid_until IS NULL
      AND customer IN (SELECT customer FROM trials)`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const lookup = db.prepare("SELECT * FROM subscriptions WHERE customer = ?");
  const activeAt = db.prepare(
    "SELECT customer, credential, expires_at FROM subscriptions WHERE expires_at > ? ORDER BY expires_at"
  );
  const lookupOrder = db.prepare("SELECT * FROM orders WHERE id = ?");
  const lookupLatestOrder = db.prepare("SELECT * FROM orders WHERE customer = ? ORDER BY rowid DESC LIMIT 1");
  const lookupTrial = db.prepare("SELECT started_at FROM trials WHERE customer = ?");
  const lookupReferral = db.prepare("SELECT * FROM referrals WHERE invited_customer = ?");
  const referralStats = db.prepare(`
    SELECT COUNT(*) AS invited_count,
      COALESCE(SUM(CASE WHEN bonus_applied = 1 THEN 3 ELSE 0 END), 0) AS earned_days
    FROM referrals WHERE referrer_customer = ?
  `);
  const insertReferral = db.prepare("INSERT OR IGNORE INTO referrals (invited_customer, referrer_customer, created_at) VALUES (?, ?, ?)");
  const markReferralRewarded = db.prepare("UPDATE referrals SET paid_at = ?, bonus_applied = 1 WHERE invited_customer = ? AND bonus_applied = 0");
  const insertTrial = db.prepare("INSERT INTO trials (customer, started_at) VALUES (?, ?)");
  const lookupProviderOrder = db.prepare("SELECT * FROM orders WHERE provider_transaction_id = ?");
  const bindProvider = db.prepare("UPDATE orders SET provider_transaction_id = ? WHERE id = ? AND provider_transaction_id IS NULL");
  const deleteOrder = db.prepare("DELETE FROM orders WHERE id = ? AND provider_transaction_id IS NULL AND payment_id IS NULL");
  const insertOrder = db.prepare(
    "INSERT INTO orders (id, customer, currency, amount, duration_days, payment_method) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const markPaid = db.prepare("UPDATE orders SET payment_id = ? WHERE id = ?");
  const upsert = db.prepare(`
    INSERT INTO subscriptions (customer, credential, expires_at, paid_until, paid_plan_days, access_kind, data_limit, trial_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(customer) DO UPDATE SET
      expires_at = excluded.expires_at, paid_until = excluded.paid_until,
      paid_plan_days = excluded.paid_plan_days, access_kind = excluded.access_kind,
      data_limit = excluded.data_limit, trial_used = MAX(subscriptions.trial_used, excluded.trial_used)
  `);

  return {
    createOrder(customer, currency, amount, durationDays = 30, paymentMethod = 2) {
      if (!Number.isInteger(durationDays) || !Object.hasOwn(planAmounts, durationDays) ||
          (currency !== "RUB" || amount !== planAmounts[durationDays]) || ![2, 10].includes(Number(paymentMethod))) {
        throw new Error("Invalid plan or amount");
      }
      const id = randomUUID();
      insertOrder.run(id, String(customer), currency, amount, durationDays, Number(paymentMethod));
      return id;
    },
    bindProviderTransaction(orderId, transactionId) {
      if (!transactionId) throw new Error("Missing provider transaction ID");
      const result = bindProvider.run(transactionId, orderId);
      if (Number(result.changes) !== 1) {
        const existing = lookupOrder.get(orderId);
        if (existing?.provider_transaction_id !== transactionId) throw new Error("Order already bound to another transaction");
      }
    },
    getOrder(orderId) {
      return lookupOrder.get(orderId);
    },
    getLatestOrder(customer) {
      return lookupLatestOrder.get(String(customer));
    },
    getOrderByProviderTransaction(transactionId) {
      return lookupProviderOrder.get(transactionId);
    },
    abandonOrder(orderId) {
      deleteOrder.run(orderId);
    },
    registerReferral(invitedCustomer, referrerCustomer, now = Date.now() / 1000) {
      const invited = String(invitedCustomer);
      const referrer = String(referrerCustomer);
      if (!/^[1-9]\d{0,15}$/.test(invited) || !/^[1-9]\d{0,15}$/.test(referrer) || invited === referrer) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = lookup.get(invited);
        if (previous?.paid_until || (previous?.access_kind === "paid" && previous.expires_at > now)) {
          db.exec("COMMIT");
          return false;
        }
        const result = insertReferral.run(invited, referrer, Math.floor(now));
        db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    getReferralStats(customer) {
      const row = referralStats.get(String(customer));
      return {
        invited_count: Number(row?.invited_count ?? 0),
        earned_days: Number(row?.earned_days ?? 0)
      };
    },
    // Only call this after the payment provider's confirmation has been authenticated.
    confirmPayment({ orderId, customer, currency, amount, paymentId }, now = Date.now() / 1000, expectedDuration) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const account = String(customer);
        const order = lookupOrder.get(orderId);
        if (!paymentId || !order || order.customer !== account ||
            order.currency !== currency || order.amount !== amount ||
            (expectedDuration !== undefined && order.duration_days !== expectedDuration)) {
          throw new Error("Payment does not match the order");
        }
        const previous = lookup.get(account);
        if (order.payment_id !== null) {
          if (order.payment_id !== paymentId) throw new Error("Order is already paid");
        } else {
          const paidUntil = Math.max(Math.floor(now), previous?.paid_until ?? previous?.expires_at ?? 0)
            + order.duration_days * daySeconds;
          const expires = paidUntil;
          markPaid.run(paymentId, orderId);
          upsert.run(account, previous?.credential ?? randomUUID(), Math.min(expires, paidUntil), paidUntil,
            order.duration_days, "paid", 0, previous?.trial_used ?? 0);
          const referral = lookupReferral.get(account);
          if (referral && !referral.bonus_applied) {
            const referrer = lookup.get(referral.referrer_customer);
            const bonusUntil = Math.max(Math.floor(now), referrer?.paid_until ?? referrer?.expires_at ?? 0) + 3 * daySeconds;
            upsert.run(referral.referrer_customer, referrer?.credential ?? randomUUID(), bonusUntil, bonusUntil,
              3, "paid", 0, referrer?.trial_used ?? 0);
            markReferralRewarded.run(Math.floor(now), account);
          }
        }
        const subscription = lookup.get(account);
        const referral = lookupReferral.get(account);
        const referralBonus = referral?.bonus_applied ? lookup.get(referral.referrer_customer) : null;
        db.exec("COMMIT");
        return { subscription, referralBonus };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    startTrial(customer, now = Date.now() / 1000) {
      const account = String(customer);
      const startedAt = Math.floor(now);
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = lookup.get(account);
        const priorTrial = lookupTrial.get(account);
        if (priorTrial) {
          if (previous && previous.expires_at > startedAt) {
            db.exec("COMMIT");
            return { row: previous, created: false };
          }
          throw new Error("Trial already used");
        }
        if (previous && (previous.paid_until || previous.expires_at > startedAt)) {
          throw new Error("Trial unavailable for an existing subscription");
        }
        const expiry = startedAt + 2 * daySeconds;
        insertTrial.run(account, startedAt);
        upsert.run(account, previous?.credential ?? randomUUID(), expiry, null, 2,
          "trial", 5 * 1024 ** 3, 1);
        const row = lookup.get(account);
        db.exec("COMMIT");
        return { row, created: true };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    get(customer) {
      return lookup.get(String(customer));
    },
    listActive(now = Date.now() / 1000) {
      return activeAt.all(Math.floor(now));
    },
    close() {
      db.close();
    }
  };
}

