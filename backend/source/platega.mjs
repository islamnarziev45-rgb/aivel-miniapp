import { createHash, timingSafeEqual } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest();
const equalSecret = (provided, expected) => timingSafeEqual(digest(String(provided ?? "")), digest(String(expected ?? "")));

export function createPlategaClient({ merchantId, secret, publicOrigin }) {
  if (!merchantId || !secret) throw new Error("Set Platega credentials");
  return {
    isCallbackAuthorized(headers) {
      return equalSecret(headers["x-merchantid"], merchantId) &&
        equalSecret(headers["x-secret"], secret);
    },
    async getTransaction(transactionId) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 12000);
      try {
        const url = "https://app.platega.io/transaction/" + encodeURIComponent(transactionId);
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-MerchantId": merchantId, "X-Secret": secret },
          signal: abort.signal
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.id !== transactionId || typeof result.status !== "string") {
          throw new Error("Platega could not check transaction");
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    async createPayment({ orderId, telegramId, amountKopecks, durationDays, paymentMethod = 2 }) {
      if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0 || ![2, 11].includes(Number(paymentMethod))) throw new Error("Invalid amount or payment method");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 12000);
      try {
        const response = await fetch("https://app.platega.io/transaction/process", {
          method: "POST",
          headers: {
            "X-MerchantId": merchantId,
            "X-Secret": secret,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            paymentMethod: Number(paymentMethod),
            paymentDetails: { amount: amountKopecks / 100, currency: "RUB" },
            description: `AIVEL VPN — ${durationDays} дней`,
            payload: orderId,
            metadata: {
              userId: telegramId,
              user_email: `${telegramId}@telegram.org`
            }
          }),
          signal: abort.signal
        });
        const result = await response.json().catch(() => ({}));
        const providerCode = [result?.code, result?.errorCode, result?.error]
          .find(value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value));
        if (!response.ok) {
          const code = providerCode ? `, code=${providerCode}` : "";
          throw new Error(`Platega create request failed: HTTP ${response.status}, method=${Number(paymentMethod)}${code}`);
        }
        if (typeof result.transactionId !== "string" ||
            typeof result.redirect !== "string" || result.status !== "PENDING") {
          throw new Error(`Platega create response invalid: HTTP ${response.status}, method=${Number(paymentMethod)}`);
        }
        const checkout = new URL(result.redirect);
        if (checkout.protocol !== "https:") throw new Error("Invalid Platega checkout URL");
        return {
          transactionId: result.transactionId,
          paymentUrl: checkout.href,
          expiresIn: typeof result.expiresIn === "string" ? result.expiresIn : ""
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

