export const DEFAULT_GMGN_ENDPOINT_SPECS = [
  { key: "smartmoney", type: "smartmoney" },
  { key: "common_stat", type: "common_stat" },
  { key: "profit_stat_all", type: "profit_stat", period: "all" },
  { key: "profit_stat_7d", type: "profit_stat", period: "7d" },
  { key: "activity_all_p1", type: "activity", page: 1 },
  { key: "holdings", type: "holdings" }
];

export function gmgnWalletEnrichmentFunction() {
  return async function fetchGmgnWalletEnrichment(args) {
    const { chain, tasks, activityLimit, requestDelayMs } = args;

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
        if (url.origin !== location.origin) continue;
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

    async function getJson(path, queryEntries = [], { includeCommonParams = true } = {}) {
      const params = includeCommonParams ? commonParams() : new URLSearchParams();
      for (const [key, value] of queryEntries) {
        params.append(key, String(value));
      }
      const query = params.toString();
      const headers = { accept: "application/json, text/plain, */*" };
      const token = findAuthToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${path}${query ? `?${query}` : ""}`, {
        method: "GET",
        credentials: "include",
        headers
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 1000) };
      }
      return { ok: response.ok, status: response.status, json };
    }

    async function runTask(task) {
      const wallet = String(task.wallet).toLowerCase();
      const endpointKey = task.endpoint_key;
      if (task.type === "smartmoney") {
        return await getJson(`/defi/quotation/v1/smartmoney/${chain}/walletNew/${wallet}`);
      }
      if (task.type === "common_stat") {
        return await getJson(`/api/v1/wallet_common_stat/${chain}/${wallet}`);
      }
      if (task.type === "profit_stat") {
        return await getJson(`/pf/api/v1/wallet/${chain}/${wallet}/profit_stat/${task.period || "all"}`);
      }
      if (task.type === "activity") {
        const query = [
          ["type", "buy"],
          ["type", "sell"],
          ["wallet", wallet],
          ["limit", activityLimit || 50],
          ["cost", 10]
        ];
        if (task.cursor) query.push(["cursor", task.cursor]);
        return await getJson(`/vas/api/v1/wallet_activity/${chain}`, query);
      }
      if (task.type === "holdings") {
        return await getJson(`/pf/api/v1/wallet/${chain}/${wallet}/holdings`, [
          ["limit", 50],
          ["order_by", "last_active_timestamp"],
          ["direction", "desc"],
          ["hide_small", "false"],
          ["sellout", "true"],
          ["hide_abnormal", "false"]
        ]);
      }
      return { ok: false, status: 0, json: { error: `endpoint desconhecido: ${endpointKey}` } };
    }

    const auth = authState();
    const results = [];
    for (const task of tasks) {
      const fetchedAtMs = Date.now();
      const fetchedAt = new Date(fetchedAtMs).toISOString();
      try {
        const response = await runTask(task);
        results.push({
          wallet: String(task.wallet).toLowerCase(),
          endpoint_key: task.endpoint_key,
          ok: response.ok,
          status: response.status,
          fetched_at_ms: fetchedAtMs,
          fetched_at: fetchedAt,
          payload: response.json
        });
      } catch (error) {
        results.push({
          wallet: String(task.wallet).toLowerCase(),
          endpoint_key: task.endpoint_key,
          ok: false,
          status: null,
          fetched_at_ms: fetchedAtMs,
          fetched_at: fetchedAt,
          payload: null,
          error: error.message
        });
      }
      if (requestDelayMs) await sleep(requestDelayMs);
    }

    return {
      href: location.href,
      auth,
      task_count: tasks.length,
      results
    };
  };
}
