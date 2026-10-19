export const BSC_CHAIN_ID_HEX = "0x38";
export const BSC_CHAIN_ID_DEC = 56;

export const CONTEST_START_BLOCK = 108512217;
export const CONTEST_START_TIMESTAMP = 1783389600;
export const CONTEST_START_ISO = "2026-07-07T02:00:00.000Z";
export const CONTEST_END_TIMESTAMP = 1784595600; // 2026-07-20 23:00 UTC-3

export const TOKEN_MANAGER2 = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
export const GMGN_FOURMEME_ROUTERS = ["0x1de460f363af910f51726def188f9004276bf4bc"];
export const GMGN_FOURMEME_ROUTER_SELECTORS = ["0x4d819a2a"];

export const EVENT_TOPICS = {
  TokenPurchase:
    "0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942",
  TokenSale:
    "0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19",
  TokenCreate:
    "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20"
};

export const TOPIC_TO_EVENT = Object.fromEntries(
  Object.entries(EVENT_TOPICS).map(([name, topic]) => [topic, name])
);

export const DEFAULT_REDIS_URL = "redis://localhost:6380/0";
export const DEFAULT_OUT_DIR = "data";
export const DEFAULT_GMGN_LIMIT = 30;
export const DEFAULT_MAX_RANK = 20;
export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_MIN_CHUNK_SIZE = 25;
export const DEFAULT_WATCH_INTERVAL_MS = 60 * 60 * 1000;
