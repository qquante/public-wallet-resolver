import { BSC_CHAIN_ID_DEC, DEFAULT_REDIS_URL } from "./constants.js";
import { redisGet } from "./redis.js";

function latencyValue(node, key) {
  const value = node?.latency_ms?.[key];
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

export function selectBscNodes(nodes) {
  return nodes
    .filter((node) => {
      return (
        node &&
        node.healthy === true &&
        node.coerente === true &&
        node.chainId === BSC_CHAIN_ID_DEC &&
        node.ws_url
      );
    })
    .sort((a, b) => {
      const p50 = latencyValue(a, "p50") - latencyValue(b, "p50");
      if (p50 !== 0) return p50;
      return latencyValue(a, "p99") - latencyValue(b, "p99");
    });
}

export async function loadBscNodes({ redisUrl = DEFAULT_REDIS_URL, explicitRpcUrls = [] } = {}) {
  if (explicitRpcUrls.length > 0) {
    return explicitRpcUrls.map((url, index) => ({
      endpoint: `explicit-${index + 1}`,
      ws_url: url,
      healthy: true,
      coerente: true,
      chainId: BSC_CHAIN_ID_DEC,
      latency_ms: { p50: index, p99: index }
    }));
  }

  const raw = await redisGet(redisUrl, "rpc:best:bsc");
  const parsed = JSON.parse(raw || "[]");
  const nodes = selectBscNodes(parsed);
  if (nodes.length === 0) {
    throw new Error("Nenhum node BSC WS saudavel encontrado em rpc:best:bsc");
  }
  return nodes;
}

