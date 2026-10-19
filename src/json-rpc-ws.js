export class JsonRpcWsClient {
  constructor(url, { timeoutMs = 15000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.socket = null;
    this.connected = false;
    this.connectingPromise = null;
  }

  async connect() {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectingPromise) return await this.connectingPromise;
    if (typeof WebSocket === "undefined") {
      throw new Error("Node WebSocket global indisponivel; use Node >= 22/24");
    }

    this.connectingPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`WS connect timeout: ${this.url}`));
      }, this.timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        resolve();
      });

      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", () => this.handleClose());
      socket.addEventListener("error", () => {
        if (!this.connected) {
          clearTimeout(timer);
          reject(new Error(`WS connect error: ${this.url}`));
        }
      });
    });
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message) return;
    if (message.method === "eth_subscription") {
      const subscriptionId = message.params?.subscription;
      const callback = this.subscriptions.get(subscriptionId);
      if (callback) callback(message.params?.result);
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

  handleClose() {
    this.connected = false;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`WS closed while waiting for request ${id}`));
    }
    this.pending.clear();
    this.subscriptions.clear();
  }

  async request(method, params = [], timeoutMs = this.timeoutMs) {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(payload);
    });
  }

  async subscribe(name, params = [], callback = () => {}) {
    const subscriptionId = await this.request("eth_subscribe", [name, ...params]);
    this.subscriptions.set(subscriptionId, callback);
    return subscriptionId;
  }

  async unsubscribe(subscriptionId) {
    this.subscriptions.delete(subscriptionId);
    return await this.request("eth_unsubscribe", [subscriptionId]);
  }

  close() {
    if (this.socket) this.socket.close();
  }
}

export function hexToNumber(hex) {
  return Number(BigInt(hex));
}

export function numberToHex(value) {
  return `0x${Number(value).toString(16)}`;
}

export async function getBlockNumber(rpc) {
  return hexToNumber(await rpc.request("eth_blockNumber"));
}

export async function getBlockByNumber(rpc, blockNumber) {
  return await rpc.request("eth_getBlockByNumber", [numberToHex(blockNumber), false]);
}

export async function findBlockAtOrAfterTimestamp(rpc, targetTimestamp, low, high) {
  let lo = Number(low);
  let hi = Number(high);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await getBlockByNumber(rpc, mid);
    const ts = hexToNumber(block.timestamp);
    if (ts < targetTimestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
