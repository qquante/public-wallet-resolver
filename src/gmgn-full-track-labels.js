const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

function parseArgs(argv) {
  const args = {
    cdpUrl: process.env.CHROME_CDP_URL || DEFAULT_CDP_URL
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cdp" || arg === "--cdp-url") {
      args.cdpUrl = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function buildPatchSource() {
  return `
(() => {
  const STYLE_ID = "gmgn-full-track-labels-style";
  const OBSERVER_KEY = "__gmgnFullTrackLabelsObserver";
  const css = \`
    body.gmgn-full-track-labels [class~="truncate"][class*="font-medium"],
    body.gmgn-full-track-labels .virtual-list-container [class~="truncate"],
    body.gmgn-full-track-labels [class~="line-clamp-1"][class*="font-medium"] {
      max-width: none !important;
      width: auto !important;
      min-width: max-content !important;
      overflow: visible !important;
      text-overflow: clip !important;
      white-space: nowrap !important;
      -webkit-line-clamp: unset !important;
      display: inline-block !important;
    }
    body.gmgn-full-track-labels .virtual-list-container [class*="overflow-x-hidden"]:has([class~="truncate"]),
    body.gmgn-full-track-labels [class*="overflow-x-hidden"]:has([class~="truncate"][class*="font-medium"]) {
      overflow: visible !important;
      min-width: max-content !important;
      width: auto !important;
      max-width: none !important;
      margin-right: 8px !important;
      flex-shrink: 0 !important;
    }
    body.gmgn-full-track-labels .virtual-list-container a,
    body.gmgn-full-track-labels .virtual-list-container [class*="text-[13px]"] {
      overflow: visible !important;
    }
  \`;

  function install() {
    if (!document.head || !document.body) return { ok: false, reason: "document_not_ready" };
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = css;
    document.body.classList.add("gmgn-full-track-labels");
    const touched = applyTitles();
    if (window[OBSERVER_KEY]) window[OBSERVER_KEY].disconnect();
    const observer = new MutationObserver(() => applyTitles());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window[OBSERVER_KEY] = observer;
    return { ok: true, touched };
  }

  function applyTitles() {
    let touched = 0;
    document.querySelectorAll('[class~="truncate"], [class~="line-clamp-1"]').forEach((el) => {
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ");
      if (/GMGN-|SIDE|S\\d{2}|P\\d{2}/.test(text)) {
        el.setAttribute("title", text);
        touched += 1;
      }
    });
    return touched;
  }

  const result = install();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  }
  return {
    ...result,
    href: location.href,
    styleInstalled: !!document.getElementById(STYLE_ID),
    bodyClass: !!document.body?.classList.contains("gmgn-full-track-labels")
  };
})()
`;
}

async function selectGmgnPage(cdpUrl) {
  const pages = await fetch(new URL("/json/list", cdpUrl)).then((response) => response.json());
  const page = pages.find((item) => {
    const url = String(item.url || "");
    return (
      url.startsWith("https://gmgn.ai/") &&
      !url.includes("/_next/static/workers/") &&
      item.webSocketDebuggerUrl
    );
  });
  if (!page) {
    throw new Error(`Nenhuma aba GMGN encontrada em ${cdpUrl}`);
  }
  return page;
}

function createCdpClient(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
  };
  return {
    async open() {
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
    },
    request(method, params = {}) {
      const request = { id: ++id, method, params };
      ws.send(JSON.stringify(request));
      return new Promise((resolve, reject) => pending.set(request.id, { resolve, reject }));
    },
    close() {
      ws.close();
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const page = await selectGmgnPage(args.cdpUrl);
  const client = createCdpClient(page.webSocketDebuggerUrl);
  await client.open();
  const source = buildPatchSource();
  await client.request("Page.enable");
  await client.request("Page.addScriptToEvaluateOnNewDocument", { source });
  const result = await client.request("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true
  });
  client.close();
  console.log(
    JSON.stringify(
      {
        page: { title: page.title, url: page.url },
        result: result.result?.value || null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[gmgn-full-track-labels] ${error.stack || error.message}`);
  process.exitCode = 1;
});
