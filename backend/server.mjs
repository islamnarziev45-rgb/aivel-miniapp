import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { openSubscriptions, planAmounts } from "./source/subscriptions.mjs";
import { createMarzbanClient } from "./source/marzban.mjs";
import { createPlategaClient } from "./source/platega.mjs";

const env = process.env;
const port = Number(env.AIVEL_API_PORT || 8080);
const host = env.AIVEL_API_HOST || "127.0.0.1";
const miniAppOrigin = env.AIVEL_MINIAPP_ORIGIN;
const botToken = env.AIVEL_BOT_TOKEN;
const databasePath = env.AIVEL_DB || "/data/aivel.sqlite";
const callbackPath = env.AIVEL_PLATEGA_CALLBACK_PATH || "/platega/callback";
const authMaxAgeSeconds = Number(env.AIVEL_TELEGRAM_AUTH_MAX_AGE || 86400);

if (!miniAppOrigin || !botToken) throw new Error("Set AIVEL_MINIAPP_ORIGIN and AIVEL_BOT_TOKEN");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid AIVEL_API_PORT");
const allowedOrigin = new URL(miniAppOrigin);
if (allowedOrigin.protocol !== "https:" || allowedOrigin.pathname !== "/" || allowedOrigin.search || allowedOrigin.hash) {
  throw new Error("AIVEL_MINIAPP_ORIGIN must be an HTTPS origin without a path");
}

const subscriptions = openSubscriptions(databasePath);
const connectHandoffs = new Map();
const connectHandoffTtlMs = 30 * 60 * 1000;
const marzban = createMarzbanClient({
  apiOrigin: env.AIVEL_MARZBAN_API || env.AIVEL_MARZBAN_API_ORIGIN || "http://127.0.0.1:8000",
  username: env.AIVEL_MARZBAN_USER || env.AIVEL_MARZBAN_USERNAME,
  password: env.AIVEL_MARZBAN_PASSWORD,
  inbound: env.AIVEL_MARZBAN_INBOUND,
  subscriptionOrigin: env.AIVEL_SUBSCRIPTION_ORIGIN
});
const platega = createPlategaClient({
  merchantId: env.AIVEL_PLATEGA_MERCHANT_ID,
  secret: env.AIVEL_PLATEGA_SECRET
});

function safeEqualHex(left, right) {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateTelegramInitData(raw) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 8192) throw new Error("invalid_telegram_data");
  const params = new URLSearchParams(raw);
  const hashes = params.getAll("hash");
  if (hashes.length !== 1) throw new Error("invalid_telegram_data");
  const hash = hashes[0];
  const entries = [...params.entries()].filter(([key]) => key !== "hash");
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("invalid_telegram_data");
  const checkString = entries.map(([key, value]) => `${key}=${value}`).sort().join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = createHmac("sha256", secretKey).update(checkString).digest("hex");
  if (!safeEqualHex(hash, calculated)) throw new Error("invalid_telegram_data");
  const authDates = params.getAll("auth_date");
  if (authDates.length !== 1 || !/^\d+$/.test(authDates[0])) throw new Error("invalid_telegram_data");
  const authDate = Number(authDates[0]);
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age < -60 || age > authMaxAgeSeconds) throw new Error("invalid_telegram_data");
  let user;
  try { user = JSON.parse(params.get("user") || ""); } catch { throw new Error("invalid_telegram_data"); }
  if (!user || !Number.isSafeInteger(user.id) || user.id < 1) throw new Error("invalid_telegram_data");
  return { id: String(user.id), startParam: params.get("start_param") || "" };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_json"); }
}

function createConnectHandoff(subscriptionUrl) {
  for (const [token, item] of connectHandoffs) {
    if (item.expiresAt <= Date.now()) connectHandoffs.delete(token);
  }
  while (connectHandoffs.size >= 5000) {
    connectHandoffs.delete(connectHandoffs.keys().next().value);
  }
  const url = new URL(subscriptionUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_subscription_link");
  const token = randomBytes(32).toString("base64url");
  connectHandoffs.set(token, { subscriptionUrl: url.href, expiresAt: Date.now() + connectHandoffTtlMs });
  return token;
}

function redeemConnectHandoff(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const item = connectHandoffs.get(token);
  connectHandoffs.delete(token);
  if (!item || item.expiresAt <= Date.now()) return null;
  const encoded = encodeURIComponent(item.subscriptionUrl);
  return {
    links: {
      Happ: "happ://add/" + item.subscriptionUrl,
      INCY: "incy://add/" + item.subscriptionUrl,
      v2RayTun: "v2raytun://import/" + encoded
    }
  };
}

function corsHeaders(origin) {
  if (origin !== allowedOrigin.origin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin.origin,
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
}

function verifyOrigin(request) {
  const origin = request.headers.origin;
  if (origin !== allowedOrigin.origin) throw new Error("miniapp_origin_denied");
  return origin;
}

function authenticate(request) {
  return validateTelegramInitData(request.headers["x-telegram-init-data"]);
}

function isBotAuthorized(request) {
  const supplied = request.headers["x-aivel-bot-token"];
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(botToken);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function hideTrialButton(customer) {
  const saved = subscriptions.getBotMenu(customer);
  if (!saved) return false;
  let markup;
  try { markup = JSON.parse(saved.markup); } catch { return false; }
  if (!Array.isArray(markup?.inline_keyboard)) return false;
  const filtered = markup.inline_keyboard.filter(row => !row.some(button => {
    const text = String(button?.text || "");
    const url = String(button?.web_app?.url || "");
    return /бесплатный старт/i.test(text) || /[?&]startapp=trial(?:&|$)/i.test(url);
  }));
  if (filtered.length === markup.inline_keyboard.length) return true;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: saved.chat_id,
        message_id: saved.message_id,
        reply_markup: { inline_keyboard: filtered }
      }),
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) return false;
    subscriptions.updateBotMenuMarkup(customer, { inline_keyboard: filtered });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: "trial_menu_update_failed", category: error?.name || "error" }));
    return false;
  }
}

function bindReferral(customer, startParam) {
  const match = /^ref_([1-9]\d{0,15})$/.exec(startParam);
  if (match) subscriptions.registerReferral(customer, match[1]);
}

function statsFor(customer) {
  return subscriptions.getReferralStats(customer);
}

async function describe(customer, startParam = "") {
  bindReferral(customer, startParam);
  let row = subscriptions.get(customer);
  const now = Math.floor(Date.now() / 1000);
  let active = Boolean(row && row.expires_at > now);
  let panelAccess = null;
  if (active && row.access_kind === "trial") {
    panelAccess = await marzban.getAccess(row);
    if (!panelAccess.status) {
      const link = await marzban.sync(row);
      panelAccess = await marzban.getAccess(row);
      panelAccess.link = link;
    }
    const limitReached = Number(row.data_limit || 0) > 0 &&
      Number(panelAccess.usedTraffic || 0) >= Number(row.data_limit);
    if (panelAccess.status !== "active" || limitReached) {
      await marzban.expireTrial(row).catch(() => null);
      row = subscriptions.expireTrial(customer, now);
      active = false;
      panelAccess = null;
    } else {
      const link = await marzban.sync(row);
      panelAccess = await marzban.getAccess(row);
      const usedLimitAfterSync = Number(row.data_limit || 0) > 0 &&
        Number(panelAccess.usedTraffic || 0) >= Number(row.data_limit);
      if (panelAccess.status !== "active" || usedLimitAfterSync) {
        await marzban.expireTrial(row).catch(() => null);
        row = subscriptions.expireTrial(customer, now);
        active = false;
        panelAccess = null;
      } else {
        panelAccess.link = link;
      }
    }
  } else if (active) {
    const link = await marzban.sync(row);
    panelAccess = await marzban.getAccess(row);
    panelAccess.link = link;
  }
  const trialAvailable = subscriptions.canStartTrial(customer, now);
  if (!trialAvailable) await hideTrialButton(customer);
  const referrals = statsFor(customer);
  return {
    status: active ? "active" : "expired",
    access_type: row?.access_kind || null,
    trial_available: trialAvailable,
    remaining_seconds: active ? row.expires_at - now : 0,
    subscription_url: panelAccess?.link || null,
    data_limit: row?.data_limit ?? 0,
    used_traffic: panelAccess?.usedTraffic ?? 0,
    referral: referrals
  };
}

function amountMatches(transaction, order) {
  const details = transaction?.paymentDetails;
  if (!details || details.currency !== order.currency || !Number.isFinite(Number(details.amount))) return false;
  return Math.round(Number(details.amount) * 100) === order.amount;
}

async function confirmCallback(callback) {
  const transactionId = callback?.transactionId || callback?.transaction_id || callback?.id;
  if (typeof transactionId !== "string" || !transactionId) throw new Error("invalid_callback");
  const transaction = await platega.getTransaction(transactionId);
  if (transaction.id !== transactionId) throw new Error("invalid_callback");
  if (transaction.status !== "CONFIRMED") return { received: true, confirmed: false };
  const order = subscriptions.getOrderByProviderTransaction(transactionId);
  if (!order || transaction.payload !== order.id || !amountMatches(transaction, order)) throw new Error("invalid_callback");
  const result = subscriptions.confirmPayment({
    orderId: order.id,
    customer: order.customer,
    currency: order.currency,
    amount: order.amount,
    paymentId: transaction.id
  }, Date.now() / 1000, order.duration_days);
  await marzban.sync(result.subscription);
  if (result.referralBonus) await marzban.sync(result.referralBonus);
  return { received: true, confirmed: true };
}

async function handle(request, response) {
  const origin = request.headers.origin;
  if (request.method === "POST" && ["/bot/trial-status", "/bot/register-menu"].includes(request.url)) {
    if (!isBotAuthorized(request)) return json(response, 401, { error: "unauthorized" });
    try {
      const body = await readJson(request, 8192);
      const customer = String(body.telegram_id || "");
      if (!/^[1-9]\d{0,15}$/.test(customer)) return json(response, 400, { error: "invalid_telegram_id" });
      if (request.url === "/bot/trial-status") {
        const data = await describe(customer);
        return json(response, 200, { trial_available: data.trial_available });
      }
      const chatId = String(body.chat_id || "");
      const messageId = Number(body.message_id);
      const markup = body.reply_markup;
      if (chatId !== customer || !Number.isSafeInteger(messageId) || messageId < 1 ||
          !Array.isArray(markup?.inline_keyboard)) {
        return json(response, 400, { error: "invalid_menu" });
      }
      subscriptions.saveBotMenu(customer, chatId, messageId, markup);
      if (!subscriptions.canStartTrial(customer)) await hideTrialButton(customer);
      return json(response, 200, { ok: true });
    } catch (error) {
      console.warn(JSON.stringify({ event: "bot_internal_request_failed", category: error?.message || "error" }));
      return json(response, 400, { error: "invalid_request" });
    }
  }
  if (request.method === "OPTIONS") {
    if (origin !== allowedOrigin.origin) return json(response, 403, { error: "miniapp_origin_denied" });
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok" });
  if (request.method === "POST" && request.url === callbackPath) {
    if (!platega.isCallbackAuthorized(request.headers)) return json(response, 401, { error: "unauthorized" });
    try { return json(response, 200, await confirmCallback(await readJson(request))); }
    catch (error) {
      console.error(JSON.stringify({ event: "payment_callback_failed", category: error.message || "error" }));
      return json(response, 503, { error: "callback_failed" });
    }
  }
  let cors;
  try { cors = corsHeaders(verifyOrigin(request)); }
  catch { return json(response, 403, { error: "miniapp_origin_denied" }); }
  if (request.method !== "POST") return json(response, 404, { error: "not_found" }, cors);

  try {
    if (request.url === "/miniapp/subscription") {
      const body = await readJson(request);
      if (typeof body.handoff_token === "string") {
        const handoff = redeemConnectHandoff(body.handoff_token);
        return handoff
          ? json(response, 200, handoff, cors)
          : json(response, 410, { error: "handoff_expired" }, cors);
      }
      const telegram = authenticate(request);
      const data = await describe(telegram.id, telegram.startParam);
      if (data.status === "active" && data.subscription_url) {
        data.connect_handoff_token = createConnectHandoff(data.subscription_url);
      }
      return json(response, 200, data, cors);
    }

    let telegram;
    try { telegram = authenticate(request); }
    catch { return json(response, 401, { error: "invalid_telegram_data" }, cors); }
    if (request.url === "/miniapp/referral") {
      bindReferral(telegram.id, telegram.startParam);
      return json(response, 200, await describe(telegram.id, telegram.startParam), cors);
    }
    if (request.url === "/miniapp/trial") {
      bindReferral(telegram.id, telegram.startParam);
      const trial = subscriptions.startTrial(telegram.id);
      const link = await marzban.sync(trial.row);
      const data = await describe(telegram.id);
      if (data.status !== "active" || data.access_type !== "trial" || !data.subscription_url) {
        return json(response, 409, { error: "trial_not_available" }, cors);
      }
      data.subscription_url = link;
      return json(response, 200, data, cors);
    }
    if (request.url === "/miniapp/create-payment") {
      const body = await readJson(request);
      const durationDays = Number(body.duration_days);
      const paymentMethod = Number(body.payment_method ?? 2);
      const amountKopecks = planAmounts[durationDays];
      if (!Number.isInteger(durationDays) || !amountKopecks || ![2, 11].includes(paymentMethod)) {
        return json(response, 400, { error: "invalid_plan_or_payment_method" }, cors);
      }
      bindReferral(telegram.id, telegram.startParam);
      const orderId = subscriptions.createOrder(telegram.id, "RUB", amountKopecks, durationDays, paymentMethod);
      try {
        const payment = await platega.createPayment({
          orderId, telegramId: telegram.id, amountKopecks, durationDays, paymentMethod
        });
        subscriptions.bindProviderTransaction(orderId, payment.transactionId);
        return json(response, 200, {
          order_id: orderId,
          transaction_id: payment.transactionId,
          payment_url: payment.paymentUrl,
          expires_in: payment.expiresIn
        }, cors);
      } catch (error) {
        subscriptions.abandonOrder(orderId);
        throw error;
      }
    }
    return json(response, 404, { error: "not_found" }, cors);
  } catch (error) {
    const message = String(error?.message || "error");
    console.error(JSON.stringify({ event: "api_request_failed", route: request.url, category: message }));
    if (request.url === "/miniapp/trial" && /Trial already used|Trial unavailable for an existing subscription/.test(message)) {
      return json(response, 409, { error: "trial_not_available" }, cors);
    }
    if (message === "body_too_large") return json(response, 413, { error: message }, cors);
    if (message === "invalid_json") return json(response, 400, { error: message }, cors);
    return json(response, 502, { error: "service_unavailable" }, cors);
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(JSON.stringify({ event: "unhandled_api_error", category: error?.message || "error" }));
    if (!response.headersSent) json(response, 500, { error: "internal_error" });
    else response.destroy();
  });
});

server.listen(port, host, () => console.info(JSON.stringify({ event: "aivel_api_started", host, port })));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => { subscriptions.close(); process.exit(0); }));
}

