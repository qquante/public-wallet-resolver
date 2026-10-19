export function gmgnPageSyncFunction() {
  return async function syncGmgnWallets(args) {
    const {
      chain,
      groupId,
      desired,
      remove,
      dryRun,
      batchSize,
      requestDelayMs,
      reloadAfterSync,
      fetchRanking,
      rankingLimit
    } = args;

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function findJwtInValue(value, depth = 0) {
      if (!value || depth > 3) return null;
      if (typeof value === "string") {
        const bearer = value.match(/Bearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (bearer) return bearer[0].replace(/^Bearer\s+/, "");
        const jwt = value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (jwt) return jwt[0];
        try {
          return findJwtInValue(JSON.parse(value), depth + 1);
        } catch {
          return null;
        }
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findJwtInValue(item, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (typeof value === "object") {
        for (const item of Object.values(value)) {
          const found = findJwtInValue(item, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }

    function findAuthToken() {
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i += 1) {
          const key = storage.key(i);
          const found = findJwtInValue(storage.getItem(key));
          if (found) return found;
        }
      }
      return null;
    }

    function authState() {
      const token = findAuthToken();
      const hasSidCookie = document.cookie.split(";").some((item) => item.trim().startsWith("sid="));
      const bodyText = document.body?.innerText || "";
      return {
        ok: Boolean(token || hasSidCookie),
        hasAuthToken: Boolean(token),
        hasSidCookie,
        bodySaysLoggedOut: bodyText.includes("You are not logged in to GMGN") || /\bLog In\b/.test(bodyText)
      };
    }

    function commonParams() {
      const params = new URLSearchParams();
      const wanted = [
        "device_id",
        "fp_did",
        "client_id",
        "from_app",
        "app_ver",
        "tz_name",
        "tz_offset",
        "app_lang",
        "os",
        "worker"
      ];

      const resources = performance.getEntriesByType("resource").slice().reverse();
      for (const entry of resources) {
        let url;
        try {
          url = new URL(entry.name);
        } catch {
          continue;
        }
        if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) continue;
        for (const key of wanted) {
          if (!params.has(key) && url.searchParams.has(key)) {
            params.set(key, url.searchParams.get(key));
          }
        }
        if (wanted.every((key) => params.has(key))) break;
      }

      if (!params.has("device_id")) params.set("device_id", crypto.randomUUID());
      if (!params.has("fp_did")) params.set("fp_did", "unknown");
      if (!params.has("client_id")) params.set("client_id", "gmgn_web");
      if (!params.has("from_app")) params.set("from_app", "gmgn");
      if (!params.has("app_ver")) params.set("app_ver", "web");
      if (!params.has("tz_name")) params.set("tz_name", Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo");
      if (!params.has("tz_offset")) params.set("tz_offset", String(-new Date().getTimezoneOffset() * 60));
      if (!params.has("app_lang")) params.set("app_lang", navigator.language || "en-US");
      if (!params.has("os")) params.set("os", "web");
      if (!params.has("worker")) params.set("worker", "0");
      return params;
    }

    async function postJson(path, body) {
      if (dryRun) return { ok: true, status: 0, json: { dryRun: true } };
      const url = `${path}?${commonParams().toString()}`;
      const headers = {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json"
      };
      const token = findAuthToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      return { ok: response.ok, status: response.status, json };
    }

    async function getJson(path, query = {}) {
      const params = commonParams();
      for (const [key, value] of Object.entries(query)) {
        params.set(key, String(value));
      }
      const headers = {
        accept: "application/json, text/plain, */*"
      };
      const token = findAuthToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${path}?${params.toString()}`, {
        method: "GET",
        credentials: "include",
        headers
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      return { ok: response.ok, status: response.status, json };
    }

    const auth = authState();
    const results = [];
    let ranking = null;
    if (fetchRanking) {
      ranking = await getJson("/api/v1/activity/s12/ladder_tournament_rank", {
        chain,
        rank_type: "TOTAL_RANK",
        order_by: "rank",
        direction: "desc",
        limit: rankingLimit || 30
      });
    }

    if (auth.ok) {
      for (let i = 0; i < desired.length; i += batchSize) {
        const batch = desired.slice(i, i + batchSize);
        const body = {
          network: chain,
          address: batch.map((wallet) => wallet.address),
          chain,
          wallet_addresses: batch.map((wallet) => wallet.address),
          remark_addresses: batch.map((wallet) => [wallet.address, wallet.name, "", ""]),
          needCode: true,
          needError: true,
          batch_import_keep_group: true
        };
        if (groupId) body.group_ids = [groupId];
        const response = await postJson("/api/v1/follow/follow_wallet", body);
        results.push({ action: "follow_wallet", count: batch.length, status: response.status, ok: response.ok, json: response.json });
        if (requestDelayMs) await sleep(requestDelayMs);
      }

      for (const wallet of remove) {
        const response = await postJson("/api/v1/follow/unfollow_wallet", {
          network: chain,
          address: wallet.address,
          chain,
          remark_addresses: [],
          wallet_addresses: [wallet.address]
        });
        results.push({ action: "unfollow_wallet", address: wallet.address, status: response.status, ok: response.ok, json: response.json });
        if (requestDelayMs) await sleep(requestDelayMs);
      }
    }

    if (auth.ok && !dryRun && reloadAfterSync && results.every((item) => item.ok && item.json?.code === 0)) {
      setTimeout(() => location.reload(), 250);
    }

    return {
      href: location.href,
      desired: desired.length,
      remove: remove.length,
      dryRun,
      hasAuthToken: auth.hasAuthToken,
      auth,
      authLost: !auth.ok,
      ranking,
      results
    };
  };
}
