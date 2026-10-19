import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MIN_CHUNK_SIZE,
  EVENT_TOPICS,
  GMGN_FOURMEME_ROUTERS,
  GMGN_FOURMEME_ROUTER_SELECTORS,
  TOKEN_MANAGER2,
  TOPIC_TO_EVENT
} from "./constants.js";
import { numberToHex, hexToNumber } from "./json-rpc-ws.js";

export function decodeAddressWord(dataHex, offset) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const start = offset * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) {
    throw new Error(`Data field curto para offset ${offset}`);
  }
  return `0x${word.slice(24).toLowerCase()}`;
}

export function decodeFourMemeLog(log) {
  const topic = String(log.topics?.[0] || "").toLowerCase();
  const eventName = TOPIC_TO_EVENT[topic];
  if (!eventName) return null;

  const blockNumber = hexToNumber(log.blockNumber);
  const logIndex = hexToNumber(log.logIndex);
  const txHash = String(log.transactionHash).toLowerCase();

  if (eventName === "TokenCreate") {
    return {
      eventName,
      blockNumber,
      logIndex,
      txHash,
      creator: decodeAddressWord(log.data, 0),
      token: decodeAddressWord(log.data, 1)
    };
  }

  return {
    eventName,
    blockNumber,
    logIndex,
    txHash,
    account: decodeAddressWord(log.data, 1),
    token: decodeAddressWord(log.data, 0)
  };
}

export function emptyAccountIndex() {
  return {
    version: 1,
    token_manager2: TOKEN_MANAGER2,
    scanned: {
      from_block: null,
      to_block: null,
      chunks: 0,
      logs: 0
    },
    router_scanned: {
      from_block: null,
      to_block: null,
      blocks: 0,
      transactions: 0,
      matched: 0
    },
    accounts: {},
    creators: {},
    senders: {},
    router_txs: {}
  };
}

function blankStats(wallet) {
  return {
    wallet,
    event_counts: {
      TokenPurchase: 0,
      TokenSale: 0,
      TokenCreate: 0,
      TransactionSender: 0,
      GmgnRouterTx: 0
    },
    first_seen_block: null,
    last_seen_block: null,
    first_tx: null,
    last_tx: null,
    token_samples: [],
    router_samples: [],
    selector_samples: []
  };
}

function updateStats(stats, event) {
  stats.event_counts[event.eventName] = (stats.event_counts[event.eventName] || 0) + 1;
  if (stats.first_seen_block == null || event.blockNumber < stats.first_seen_block) {
    stats.first_seen_block = event.blockNumber;
    stats.first_tx = event.txHash;
  }
  if (stats.last_seen_block == null || event.blockNumber > stats.last_seen_block) {
    stats.last_seen_block = event.blockNumber;
    stats.last_tx = event.txHash;
  }
  if (event.token && !stats.token_samples.includes(event.token) && stats.token_samples.length < 20) {
    stats.token_samples.push(event.token);
  }
  if (event.router && !stats.router_samples.includes(event.router) && stats.router_samples.length < 20) {
    stats.router_samples.push(event.router);
  }
  if (event.selector && !stats.selector_samples.includes(event.selector) && stats.selector_samples.length < 20) {
    stats.selector_samples.push(event.selector);
  }
}

export function mergeDecodedEvent(index, event) {
  if (!event) return;
  if (event.eventName === "TokenCreate") {
    const creator = event.creator.toLowerCase();
    index.creators[creator] ||= blankStats(creator);
    updateStats(index.creators[creator], event);
    return;
  }
  if (event.eventName === "TransactionSender") {
    const sender = event.sender.toLowerCase();
    index.senders ||= {};
    index.senders[sender] ||= blankStats(sender);
    updateStats(index.senders[sender], event);
    return;
  }
  if (event.eventName === "GmgnRouterTx") {
    const sender = event.sender.toLowerCase();
    index.router_txs ||= {};
    index.router_txs[sender] ||= blankStats(sender);
    updateStats(index.router_txs[sender], event);
    return;
  }

  const account = event.account.toLowerCase();
  index.accounts[account] ||= blankStats(account);
  updateStats(index.accounts[account], event);
}

export function mergeIndex(target, source) {
  for (const stats of Object.values(source.accounts || {})) {
    const wallet = stats.wallet.toLowerCase();
    target.accounts[wallet] ||= blankStats(wallet);
    mergeStats(target.accounts[wallet], stats);
  }
  for (const stats of Object.values(source.creators || {})) {
    const wallet = stats.wallet.toLowerCase();
    target.creators[wallet] ||= blankStats(wallet);
    mergeStats(target.creators[wallet], stats);
  }
  target.senders ||= {};
  for (const stats of Object.values(source.senders || {})) {
    const wallet = stats.wallet.toLowerCase();
    target.senders[wallet] ||= blankStats(wallet);
    mergeStats(target.senders[wallet], stats);
  }
  target.router_txs ||= {};
  for (const stats of Object.values(source.router_txs || {})) {
    const wallet = stats.wallet.toLowerCase();
    target.router_txs[wallet] ||= blankStats(wallet);
    mergeStats(target.router_txs[wallet], stats);
  }
  target.scanned.from_block = minNullable(target.scanned.from_block, source.scanned.from_block);
  target.scanned.to_block = maxNullable(target.scanned.to_block, source.scanned.to_block);
  target.scanned.chunks += source.scanned.chunks || 0;
  target.scanned.logs += source.scanned.logs || 0;
  target.router_scanned ||= emptyAccountIndex().router_scanned;
  if (source.router_scanned) {
    target.router_scanned.from_block = minNullable(
      target.router_scanned.from_block,
      source.router_scanned.from_block
    );
    target.router_scanned.to_block = maxNullable(target.router_scanned.to_block, source.router_scanned.to_block);
    target.router_scanned.blocks += source.router_scanned.blocks || 0;
    target.router_scanned.transactions += source.router_scanned.transactions || 0;
    target.router_scanned.matched += source.router_scanned.matched || 0;
  }
}

function minNullable(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxNullable(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

function mergeStats(target, source) {
  for (const [eventName, count] of Object.entries(source.event_counts || {})) {
    target.event_counts[eventName] = (target.event_counts[eventName] || 0) + count;
  }
  if (target.first_seen_block == null || source.first_seen_block < target.first_seen_block) {
    target.first_seen_block = source.first_seen_block;
    target.first_tx = source.first_tx;
  }
  if (target.last_seen_block == null || source.last_seen_block > target.last_seen_block) {
    target.last_seen_block = source.last_seen_block;
    target.last_tx = source.last_tx;
  }
  for (const token of source.token_samples || []) {
    if (!target.token_samples.includes(token) && target.token_samples.length < 20) {
      target.token_samples.push(token);
    }
  }
  for (const router of source.router_samples || []) {
    if (!target.router_samples.includes(router) && target.router_samples.length < 20) {
      target.router_samples.push(router);
    }
  }
  for (const selector of source.selector_samples || []) {
    if (!target.selector_samples.includes(selector) && target.selector_samples.length < 20) {
      target.selector_samples.push(selector);
    }
  }
}

export async function scanFourMemeEvents({
  rpc,
  fromBlock,
  toBlock,
  chunkSize = DEFAULT_CHUNK_SIZE,
  minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
  includeTransactionSenders = false,
  onProgress = () => {}
}) {
  const index = emptyAccountIndex();
  index.scanned.from_block = fromBlock;
  index.scanned.to_block = toBlock;

  let cursor = fromBlock;
  let span = chunkSize;
  const topics = [[EVENT_TOPICS.TokenPurchase, EVENT_TOPICS.TokenSale, EVENT_TOPICS.TokenCreate]];

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + span - 1);
    try {
      const logs = await rpc.request(
        "eth_getLogs",
        [
          {
            address: TOKEN_MANAGER2,
            fromBlock: numberToHex(cursor),
            toBlock: numberToHex(end),
            topics
          }
        ],
        30000
      );

      for (const log of logs) {
        mergeDecodedEvent(index, decodeFourMemeLog(log));
      }
      if (includeTransactionSenders) {
        await mergeTransactionSenders({ rpc, index, logs });
      }
      index.scanned.chunks += 1;
      index.scanned.logs += logs.length;
      onProgress({ fromBlock: cursor, toBlock: end, logs: logs.length, span });
      cursor = end + 1;
      if (span < chunkSize) span = Math.min(chunkSize, span * 2);
    } catch (error) {
      if (span <= minChunkSize) {
        throw new Error(`eth_getLogs falhou em ${cursor}-${end}: ${error.message}`);
      }
      span = Math.max(minChunkSize, Math.floor(span / 2));
    }
  }

  return index;
}

async function mergeTransactionSenders({ rpc, index, logs }) {
  const byHash = new Map();
  for (const log of logs) {
    const hash = String(log.transactionHash || "").toLowerCase();
    if (!hash || byHash.has(hash)) continue;
    byHash.set(hash, {
      txHash: hash,
      blockNumber: hexToNumber(log.blockNumber),
      logIndex: hexToNumber(log.logIndex)
    });
  }

  for (const evidence of byHash.values()) {
    const tx = await rpc.request("eth_getTransactionByHash", [evidence.txHash], 15000);
    if (!tx?.from) continue;
    mergeDecodedEvent(index, {
      eventName: "TransactionSender",
      sender: String(tx.from).toLowerCase(),
      blockNumber: evidence.blockNumber,
      logIndex: evidence.logIndex,
      txHash: evidence.txHash
    });
  }
}

export async function scanGmgnRouterTransactions({
  rpc,
  rpcs = null,
  fromBlock,
  toBlock,
  routers = GMGN_FOURMEME_ROUTERS,
  selectors = GMGN_FOURMEME_ROUTER_SELECTORS,
  candidateMasks = null,
  concurrency = 12,
  progressEvery = 500,
  onProgress = () => {}
}) {
  const clients = (rpcs && rpcs.length ? rpcs : [rpc]).filter(Boolean);
  if (clients.length === 0) throw new Error("scanGmgnRouterTransactions exige ao menos um RPC");

  const index = emptyAccountIndex();
  index.router_scanned.from_block = fromBlock;
  index.router_scanned.to_block = toBlock;

  const routerSet = new Set(routers.map((address) => String(address).toLowerCase()));
  const selectorSet = new Set(selectors.map((selector) => String(selector).toLowerCase()));
  const parsedCandidateMasks = (candidateMasks || []).map(parseCandidateMask);
  const workerCount = Math.max(1, Number(concurrency) || 1);
  let cursor = fromBlock;
  let completed = 0;

  async function worker(slot) {
    const client = clients[slot % clients.length];
    while (true) {
      const blockNumber = cursor;
      cursor += 1;
      if (blockNumber > toBlock) return;

      const block = await client.request("eth_getBlockByNumber", [numberToHex(blockNumber), true], 30000);
      const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
      index.router_scanned.blocks += 1;
      index.router_scanned.transactions += transactions.length;

      for (const tx of transactions) {
        const to = String(tx.to || "").toLowerCase();
        if (!routerSet.has(to)) continue;
        const selector = String(tx.input || "").slice(0, 10).toLowerCase();
        if (!selectorSet.has(selector)) continue;
        const sender = String(tx.from || "").toLowerCase();
        if (parsedCandidateMasks.length > 0 && !matchesCandidateMask(sender, parsedCandidateMasks)) continue;

        const receipt = await client.request("eth_getTransactionReceipt", [tx.hash], 15000);
        if (String(receipt?.status || "").toLowerCase() !== "0x1") continue;

        index.router_scanned.matched += 1;
        mergeDecodedEvent(index, {
          eventName: "GmgnRouterTx",
          sender,
          router: to,
          selector,
          blockNumber,
          logIndex: tx.transactionIndex ? hexToNumber(tx.transactionIndex) : 0,
          txHash: String(tx.hash || "").toLowerCase()
        });
      }

      completed += 1;
      if (progressEvery > 0 && completed % progressEvery === 0) {
        onProgress({
          fromBlock,
          toBlock,
          blockNumber,
          blocks: completed,
          transactions: index.router_scanned.transactions,
          matched: index.router_scanned.matched
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, slot) => worker(slot)));
  return index;
}

function parseCandidateMask(mask) {
  const text = String(mask || "").toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(text)) return { type: "full", address: text };
  const match = text.match(/^(0x[0-9a-f]+)\.\.\.([0-9a-f]+)$/);
  if (!match) throw new Error(`Mascara de candidato invalida: ${mask}`);
  return { type: "masked", prefix: match[1], suffix: match[2] };
}

function matchesCandidateMask(address, masks) {
  return masks.some((mask) => {
    if (mask.type === "full") return address === mask.address;
    return address.startsWith(mask.prefix) && address.endsWith(mask.suffix);
  });
}
