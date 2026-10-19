import dns from "node:dns/promises";
import net from "node:net";

function shouldRetryWithResolvedHost(response, body, url) {
  return (
    response.status === 500 &&
    body.includes("Host header is specified") &&
    url.hostname !== "localhost" &&
    net.isIP(url.hostname) === 0
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Chrome CDP ${url.pathname} falhou: HTTP ${response.status}: ${body.slice(0, 120)}`);
  }
  return JSON.parse(body);
}

async function fetchCdpJson(path, cdpUrl) {
  const url = new URL(path, cdpUrl);
  const response = await fetch(url);
  const body = await response.text();
  if (response.ok) return JSON.parse(body);

  if (shouldRetryWithResolvedHost(response, body, url)) {
    const { address } = await dns.lookup(url.hostname, { family: 4 });
    const ipUrl = new URL(url);
    ipUrl.hostname = address;
    return await fetchJson(ipUrl);
  }

  throw new Error(`Chrome CDP ${path} falhou: HTTP ${response.status}: ${body.slice(0, 120)}`);
}

export async function listCdpPages(cdpUrl) {
  return await fetchCdpJson("/json", cdpUrl);
}

export async function findGmgnPage(cdpUrl) {
  const pages = await listCdpPages(cdpUrl);
  const page = pages.find((item) => item.type === "page" && String(item.url || "").includes("gmgn.ai"));
  if (!page) {
    throw new Error(`Nenhuma aba gmgn.ai encontrada em ${cdpUrl}`);
  }
  if (!page.webSocketDebuggerUrl) {
    throw new Error("Aba GMGN sem webSocketDebuggerUrl");
  }
  return page;
}

export class CdpClient {
  constructor(webSocketDebuggerUrl, { timeoutMs = 30000 } = {}) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Timeout conectando ao Chrome CDP"));
      }, this.timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", () => this.rejectAll("Chrome CDP fechou a conexao"));
      socket.addEventListener("error", () => {
        if (!this.socket) {
          clearTimeout(timer);
          reject(new Error("Erro conectando ao Chrome CDP"));
        }
      });
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(reason) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason}: request ${id}`));
    }
    this.pending.clear();
  }

  async send(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(payload);
    });
  }

  async evaluate(functionSource, args = {}, timeoutMs = this.timeoutMs) {
    const expression = `(${functionSource})(${JSON.stringify(args)})`;
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true
      },
      timeoutMs
    );
    if (result.exceptionDetails) {
      throw new Error(`Chrome evaluate exception: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  }

  close() {
    if (this.socket) this.socket.close();
  }
}
