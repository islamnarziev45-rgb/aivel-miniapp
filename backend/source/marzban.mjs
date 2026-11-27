export function createMarzbanClient({
  apiOrigin = "http://127.0.0.1:8000", username, password, inbound, subscriptionOrigin,
  fetchPanel = fetch
}) {
  const api = new URL(apiOrigin);
  const publicOrigin = new URL(subscriptionOrigin);
  const localHttp = api.protocol === "http:" && api.hostname === "127.0.0.1";
  if ((!localHttp && api.protocol !== "https:") || api.username || api.password ||
      api.pathname !== "/" || api.search || api.hash || !username || !password || !inbound) {
    throw new Error("Configure the Marzban address, credentials and VLESS inbound");
  }
  if (publicOrigin.protocol !== "https:" || publicOrigin.username || publicOrigin.password ||
      publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) {
    throw new Error("Expected the public HTTPS origin for Marzban subscriptions");
  }

  function request(path, options) {
    return fetchPanel(new URL(path, api), {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
  }

  let login;
  function getToken() {
    login ??= (async () => {
      const response = await request("/api/admin/token", {
        method: "POST",
        body: new URLSearchParams({ username, password })
      });
      if (!response.ok) throw new Error(`Marzban login returned HTTP ${response.status}`);
      const { access_token: token } = await response.json();
      if (typeof token !== "string" || !token) throw new Error("Marzban did not return a token");
      return token;
    })().catch(error => {
      login = undefined;
      throw error;
    });
    return login;
  }

  async function authorizedRequest(path, method = "GET", body) {
    const send = async pendingToken => request(path, {
      method,
      headers: { Authorization: `Bearer ${await pendingToken}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    const pendingToken = getToken();
    const response = await send(pendingToken);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    if (login === pendingToken) login = undefined;
    return send(getToken());
  }

  async function checked(response) {
    if (!response.ok) throw new Error(`Marzban returned HTTP ${response.status}`);
    return response.json();
  }

  function assertOwner(user, name, credential) {
    if (user.username !== name || user.proxies?.vless?.id !== credential) {
      throw new Error("Marzban account belongs to a different subscription");
    }
  }

  function accountName({ customer, credential }) {
    if (!/^[1-9]\d{0,15}$/.test(customer) ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(credential)) {
      throw new Error("Invalid subscription");
    }
    return `aivel_tg_${customer}`;
  }

  function access(user) {
    const expire = Number.isSafeInteger(user.expire) && user.expire > 0 ? user.expire : null;
    const usedTraffic = Number.isSafeInteger(user.used_traffic) && user.used_traffic >= 0
      ? user.used_traffic : 0;
    const dataLimit = Number.isSafeInteger(user.data_limit) && user.data_limit >= 0
      ? user.data_limit : 0;
    if (!expire || !["active", "limited"].includes(user.status) ||
        typeof user.subscription_url !== "string" || !user.subscription_url) {
      return { expire, link: null, status: user.status, usedTraffic, dataLimit };
    }
    const link = new URL(user.subscription_url, publicOrigin);
    if (link.origin !== publicOrigin.origin || link.username || link.password ||
        link.hash || link.pathname === "/") {
      throw new Error("Marzban returned an unexpected subscription address");
    }
    return { expire, link: link.href, status: user.status, usedTraffic, dataLimit };
  }

  return {
    async getAccess(row) {
      const name = accountName(row);
      const response = await authorizedRequest(`/api/user/${name}`);
      if (response.status === 404) return { expire: null, link: null };
      const user = await checked(response);
      assertOwner(user, name, row.credential);
      return access(user);
    },
    async sync(row) {
      const name = accountName(row);
      const { credential, expires_at: expire } = row;
      if (!Number.isSafeInteger(expire) || expire <= 0) throw new Error("Invalid key expiry");
      const path = `/api/user/${name}`;
      const existing = await authorizedRequest(path);
      let user;
      if (existing.status === 404) {
        const created = await authorizedRequest("/api/user", "POST", {
          username: name, status: "active", expire,
          data_limit: row.data_limit ?? 0,
          data_limit_reset_strategy: "no_reset",
          proxies: { vless: { id: credential } },
          inbounds: { vless: [inbound] }
        });
        user = await checked(created.status === 409 ? await authorizedRequest(path) : created);
      } else {
        user = await checked(existing);
      }
      assertOwner(user, name, credential);
      if (user.status === "disabled") {
        throw new Error("Marzban account is suspended");
      }
      const dataLimit = row.data_limit ?? 0;
      const limitChanged = Number(user.data_limit ?? 0) !== dataLimit;
      const expiryChanged = user.expire < expire ||
        (user.expire === expire && user.status === "expired");
      if (expiryChanged || limitChanged || (user.status === "limited" && row.access_kind !== "trial")) {
        user = await checked(await authorizedRequest(path, "PUT", {
          status: "active", expire, data_limit: dataLimit,
          data_limit_reset_strategy: "no_reset"
        }));
        assertOwner(user, name, credential);
      }
      if (user.status !== "active" || !(user.expire >= expire)) {
        throw new Error("Marzban did not return an active subscription");
      }
      return access(user).link;
    }
  };
}

