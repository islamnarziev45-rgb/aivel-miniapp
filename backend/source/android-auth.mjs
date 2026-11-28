import { createHash, randomBytes } from "node:crypto";

const pairingLifetime = 5 * 60 * 1000;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (value) => createHash("sha256").update(value).digest("base64url");

export function createAndroidAuth({ clock = Date.now, maxPairings = 1000, maxSessions = 10000 } = {}) {
  const pairings = new Map();
  const sessions = new Map();

  function prune(entries) {
    const now = clock();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function getValid(entries, key) {
    const entry = entries.get(key);
    if (entry && entry.expiresAt > clock()) return entry;
    entries.delete(key);
    return null;
  }

  return {
    startPairing(verifierHash) {
      if (typeof verifierHash !== "string" || !tokenPattern.test(verifierHash)) return null;
      prune(pairings);
      if (pairings.size >= maxPairings) return null;
      const pairingId = randomBytes(32).toString("base64url");
      pairings.set(pairingId, { verifierHash, customer: null, expiresAt: clock() + pairingLifetime });
      return { pairingId, expiresIn: pairingLifetime / 1000 };
    },

    // Call only after the customer approves the pairing in an authenticated Telegram session.
    approvePairing(pairingId, authenticatedCustomer) {
      const customer = String(authenticatedCustomer);
      if (!/^[1-9]\d{0,15}$/.test(customer)) return false;
      const pairing = getValid(pairings, pairingId);
      if (!pairing || pairing.customer !== null) return false;
      pairing.customer = customer;
      return true;
    },

    redeemPairing(pairingId, verifier) {
      if (typeof verifier !== "string" || !tokenPattern.test(verifier)) return null;
      const pairing = getValid(pairings, pairingId);
      if (!pairing?.customer || digest(verifier) !== pairing.verifierHash) return null;
      prune(sessions);
      if (sessions.size >= maxSessions) return null;
      pairings.delete(pairingId);
      const token = randomBytes(32).toString("base64url");
      sessions.set(digest(token), { customer: pairing.customer, expiresAt: clock() + sessionLifetime });
      return { token, expiresIn: sessionLifetime / 1000 };
    },

    authenticate(token) {
      if (typeof token !== "string" || !tokenPattern.test(token)) return null;
      return getValid(sessions, digest(token))?.customer ?? null;
    },

    revoke(token) {
      if (typeof token === "string" && tokenPattern.test(token)) sessions.delete(digest(token));
    },
  };
}

