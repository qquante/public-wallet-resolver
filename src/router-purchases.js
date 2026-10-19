import {
  GMGN_FOURMEME_ROUTERS,
  GMGN_FOURMEME_ROUTER_SELECTORS
} from "./constants.js";
import { hexToNumber, numberToHex } from "./json-rpc-ws.js";

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

export function decodeTopicAddress(topic) {
  const text = String(topic || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) return null;
  return `0x${text.slice(26)}`;
}

export function isRouterTx(tx, {
  routers = GMGN_FOURMEME_ROUTERS,
  selectors = GMGN_FOURMEME_ROUTER_SELECTORS
} = {}) {
  const routerSet = new Set(routers.map((address) => String(address).toLowerCase()));
  const selectorSet = new Set(selectors.map((selector) => String(selector).toLowerCase()));
  const to = String(tx?.to || "").toLowerCase();
  const selector = String(tx?.input || "").slice(0, 10).toLowerCase();
  return routerSet.has(to) && selectorSet.has(selector);
}

export function extractRouterPurchaseEvent(tx, receipt, options = {}) {
  if (!tx || !receipt || String(receipt.status || "").toLowerCase() !== "0x1") return null;
  if (!isRouterTx(tx, options)) return null;

  const account = String(tx.from || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(account)) return null;

  const routerSet = new Set(
    (options.routers || GMGN_FOURMEME_ROUTERS).map((address) => String(address).toLowerCase())
  );
  const transferLogs = (receipt.logs || []).filter((log) => {
    const topic0 = String(log.topics?.[0] || "").toLowerCase();
    const to = decodeTopicAddress(log.topics?.[2]);
    const address = String(log.address || "").toLowerCase();
    return (
      topic0 === ERC20_TRANSFER_TOPIC &&
      to === account &&
      address !== WBNB_ADDRESS &&
      !routerSet.has(address)
    );
  });
  if (transferLogs.length === 0) return null;

  const tokenTransfer =
    transferLogs.find((log) => String(log.address || "").toLowerCase().endsWith("4444")) ||
    transferLogs[0];
  const blockNumber = hexToNumber(tx.blockNumber || receipt.blockNumber);
  const logIndex = hexToNumber(tokenTransfer.logIndex);
  const txHash = String(tx.hash || receipt.transactionHash || "").toLowerCase();

  return {
    purchaseKey: `router:${blockNumber}:${logIndex}:${txHash}`,
    blockNumber,
    logIndex,
    txHash,
    token: String(tokenTransfer.address).toLowerCase(),
    account,
    source: "gmgn_router_tx"
  };
}

export async function scanRouterPurchaseEvents({
  rpcs,
  fromBlock,
  toBlock,
  routers = GMGN_FOURMEME_ROUTERS,
  selectors = GMGN_FOURMEME_ROUTER_SELECTORS,
  chunkBlocks = 1000,
  concurrency = 28,
  onEvents = () => ({ inserted: 0, anchorsCreated: 0, windowRows: 0 }),
  onProgress = () => {}
}) {
  const clients = (rpcs || []).filter(Boolean);
  if (clients.length === 0) throw new Error("scanRouterPurchaseEvents exige ao menos um RPC");

  let cursor = fromBlock;
  const summary = {
    chunks: 0,
    blocks: 0,
    transactions: 0,
    router_txs: 0,
    purchases: 0
  };

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + chunkBlocks - 1);
    const events = [];
    let nextBlock = cursor;
    let chunkBlocksDone = 0;
    let chunkTransactions = 0;
    let chunkRouterTxs = 0;

    async function worker(slot) {
      const client = clients[slot % clients.length];
      while (true) {
        const blockNumber = nextBlock;
        nextBlock += 1;
        if (blockNumber > end) return;

        const block = await client.request("eth_getBlockByNumber", [numberToHex(blockNumber), true], 30000);
        const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
        chunkBlocksDone += 1;
        chunkTransactions += transactions.length;

        for (const tx of transactions) {
          if (!isRouterTx(tx, { routers, selectors })) continue;
          chunkRouterTxs += 1;
          const receipt = await client.request("eth_getTransactionReceipt", [tx.hash], 15000);
          const event = extractRouterPurchaseEvent(tx, receipt, { routers, selectors });
          if (event) events.push(event);
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.max(1, Number(concurrency) || 1) }, (_, slot) => worker(slot))
    );
    events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    const ingest = events.length > 0 ? onEvents(events) : { inserted: 0, anchorsCreated: 0, windowRows: 0 };

    summary.chunks += 1;
    summary.blocks += chunkBlocksDone;
    summary.transactions += chunkTransactions;
    summary.router_txs += chunkRouterTxs;
    summary.purchases += events.length;
    await onProgress({
      fromBlock: cursor,
      toBlock: end,
      blocks: chunkBlocksDone,
      transactions: chunkTransactions,
      routerTxs: chunkRouterTxs,
      purchases: events.length,
      ingest
    });
    cursor = end + 1;
  }

  return summary;
}
