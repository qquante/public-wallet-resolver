#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OUT_DIR } from "./constants.js";
import { buildContestLinksDashboard, buildContestSidesDashboard } from "./dashboard-data.js";

const outDir = process.env.OUT_DIR || DEFAULT_OUT_DIR;
const port = Number(process.env.DASHBOARD_PORT || 8788);
const jsonCache = new Map();

async function readJson(name, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.join(outDir, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readJsonCached(name, fallback = null) {
  const file = path.join(outDir, name);
  try {
    const stat = await fs.stat(file);
    const cached = jsonCache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    jsonCache.set(name, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendJson(res, value) {
  send(res, 200, "application/json; charset=utf-8", `${JSON.stringify(value, null, 2)}\n`);
}

function html() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GMGN S12 Ranking Monitor</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080a0d;
      --panel: #10151b;
      --line: #27313d;
      --text: #e7edf4;
      --muted: #8fa0b2;
      --green: #4ade80;
      --red: #fb7185;
      --yellow: #facc15;
      --blue: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    header {
      border-bottom: 1px solid var(--line);
      padding: 18px 22px;
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      background: #0c1015;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .meta { color: var(--muted); font-size: 13px; display: flex; gap: 14px; flex-wrap: wrap; }
    main { padding: 18px 22px 28px; }
    .quick {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .panel {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 14px;
      min-height: 96px;
    }
    .panel h2 { margin: 0 0 10px; font-size: 14px; color: var(--muted); font-weight: 600; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #0b1117;
      font-size: 13px;
      font-weight: 700;
    }
    .up { color: var(--green); }
    .down { color: var(--red); }
    .same { color: var(--muted); }
    .unknown { color: var(--yellow); }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      background: #0b0f14;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 9px;
      font-size: 13px;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #10151b;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .rank { width: 72px; }
    .wallet { width: 340px; }
    .status { width: 170px; }
    .movement { width: 120px; font-weight: 800; }
    .num { font-variant-numeric: tabular-nums; }
    .empty { color: var(--muted); font-size: 13px; }
    .banner {
      display: none;
      border: 1px solid #7f1d1d;
      background: #2b1115;
      color: #fecdd3;
      border-radius: 8px;
      padding: 11px 13px;
      margin-bottom: 14px;
      font-size: 14px;
      font-weight: 700;
    }
    .section-head {
      margin: 24px 0 12px;
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 14px;
      flex-wrap: wrap;
    }
    .section-head h2 { margin: 0; font-size: 18px; }
    .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    input[type="search"] {
      width: min(420px, 80vw);
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0b1117;
      color: var(--text);
      padding: 7px 10px;
      font: inherit;
      outline: none;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .metric {
      border: 1px solid var(--line);
      background: #0b0f14;
      border-radius: 8px;
      padding: 12px;
    }
    .metric .label { color: var(--muted); font-size: 12px; font-weight: 700; }
    .metric .value { margin-top: 6px; font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .contest-group { border-top: 1px solid var(--line); padding: 16px 0 4px; }
    .group-header {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: start;
      margin-bottom: 10px;
    }
    .group-title { font-size: 16px; font-weight: 800; }
    .group-title a, .candidate a, .txlinks a { color: var(--blue); text-decoration: none; }
    .group-title a:hover, .candidate a:hover, .txlinks a:hover { text-decoration: underline; }
    .group-stats { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      background: #0b1117;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border-radius: 999px;
      padding: 2px 6px;
      background: #172033;
      color: #bfdbfe;
      font-size: 11px;
      margin: 2px 3px 0 0;
    }
    .subtle { color: var(--muted); font-size: 12px; }
    .candidate { width: 250px; }
    .wide { width: 290px; }
    .money { color: #bbf7d0; }
    .bad { color: var(--red); }
    .link-table th, .link-table td { vertical-align: top; white-space: normal; }
    .link-table td { line-height: 1.35; }
    .txlinks { display: flex; gap: 8px; flex-wrap: wrap; }
    .class-very_strong_side { color: #facc15; }
    .class-strong_side { color: #4ade80; }
    .class-possible_side { color: #93c5fd; }
    .class-broad_flow { color: #fb7185; }
    .class-observed { color: var(--muted); }
    @media (max-width: 900px) {
      .quick { grid-template-columns: 1fr; }
      .summary-grid { grid-template-columns: 1fr 1fr; }
      main { padding: 12px; }
      header { align-items: start; flex-direction: column; }
      .wallet { width: 180px; }
      .group-header { flex-direction: column; }
    }
    @media (max-width: 620px) {
      .summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>GMGN S12 BSC Ranking Monitor</h1>
      <div class="meta" id="meta">carregando...</div>
    </div>
    <div class="meta"><span>auto-refresh 30s</span><span id="status">offline</span></div>
  </header>
  <main>
    <div class="banner" id="authBanner"></div>
    <section class="quick" id="quick"></section>
    <table>
      <thead>
        <tr>
          <th class="rank">Rank</th>
          <th>Nick</th>
          <th class="wallet">Wallet</th>
          <th class="status">Status</th>
          <th class="movement">60 min</th>
          <th class="movement">4 horas</th>
          <th class="movement">24 horas</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <section>
      <div class="section-head">
        <div>
          <h2>Side-wallets lucrativas por wallet do contest</h2>
          <div class="subtle" id="sideMeta">carregando side scores...</div>
        </div>
        <div class="controls">
          <input id="sideSearch" type="search" placeholder="buscar rank, side wallet, classe ou tag">
        </div>
      </div>
      <div class="summary-grid" id="sideSummary"></div>
      <div id="contestSides"></div>
    </section>
    <section>
      <div class="section-head">
        <div>
          <h2>Wallets suspeitas >= 2 BNB por wallet do contest</h2>
          <div class="subtle" id="linkMeta">carregando enriquecimento...</div>
        </div>
        <div class="controls">
          <input id="linkSearch" type="search" placeholder="buscar rank, wallet, nome ou tag">
        </div>
      </div>
      <div class="summary-grid" id="linkSummary"></div>
      <div id="contestLinks"></div>
    </section>
  </main>
  <script>
    const windows = [["60m", "60 min"], ["4h", "4 horas"], ["24h", "24 horas"]];
    let latestLinks = null;
    let latestSides = null;

    function cls(move) {
      if (!move || move.delta == null) return "unknown";
      if (move.delta > 0) return "up";
      if (move.delta < 0) return "down";
      return "same";
    }

    function cell(move) {
      if (!move) return "<span class='unknown'>?</span>";
      return "<span class='" + cls(move) + "' title='rank anterior: " + (move.previous_rank ?? "?") + "'>" + move.label + "</span>";
    }

    function chip(label) {
      const kind = label.includes("+") ? "up" : label.includes("-") ? "down" : "same";
      return "<span class='chip " + kind + "'>" + label + "</span>";
    }

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[ch]);
    }

    function shortAddr(value) {
      const text = String(value || "");
      return text.length > 14 ? text.slice(0, 6) + "..." + text.slice(-4) : text;
    }

    function num(value, digits = 2) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "-";
      return n.toLocaleString("en-US", { maximumFractionDigits: digits });
    }

    function money(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "-";
      const sign = n < 0 ? "-" : "";
      const abs = Math.abs(n);
      if (abs >= 1_000_000) return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
      if (abs >= 1_000) return sign + "$" + (abs / 1_000).toFixed(1) + "K";
      return sign + "$" + abs.toFixed(2);
    }

    function pct(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "-";
      return (n * 100).toFixed(2) + "%";
    }

    function matchesSearch(group, wallet, search) {
      if (!search) return true;
      const haystack = [
        group.contest.rank,
        group.contest.wallet,
        group.contest.masked_address,
        wallet.wallet,
        wallet.name,
        wallet.twitter_username,
        wallet.tags?.join(" "),
        wallet.related_ranks?.join(" ")
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    }

    function renderMetric(label, value) {
      return "<div class='metric'><div class='label'>" + esc(label) + "</div><div class='value'>" + esc(value) + "</div></div>";
    }

    function renderContestLinks() {
      if (!latestLinks) return;
      const search = (document.getElementById("linkSearch")?.value || "").trim().toLowerCase();
      const summary = latestLinks.summary || {};
      const checkpoint = latestLinks.source?.enrichment_checkpoint || {};
      document.getElementById("linkMeta").textContent = [
        "enrichment: " + (latestLinks.source?.enrichment_generated_at || "-"),
        "block: " + (checkpoint.latest_block || "-"),
        "GMGN OK ultimo ciclo: " + (checkpoint.gmgn_endpoint_tasks_ok ?? "-") + "/" + (checkpoint.gmgn_endpoint_tasks_attempted ?? "-")
      ].join(" | ");
      document.getElementById("linkSummary").innerHTML = [
        renderMetric("suspeitas >= " + (summary.min_bnb_balance || "2") + " BNB", num(summary.high_balance_wallets, 0)),
        renderMetric("GMGN completo", num(summary.wallets_with_complete_gmgn, 0)),
        renderMetric("vinculos rank-wallet", num(summary.rank_memberships, 0)),
        renderMetric("pendente GMGN", num(checkpoint.pending_gmgn_endpoints, 0))
      ].join("");

      document.getElementById("contestLinks").innerHTML = (latestLinks.groups || []).map(group => {
        const rows = (group.wallets || []).filter(wallet => matchesSearch(group, wallet, search));
        if (search && rows.length === 0) return "";
        const contestLink = group.contest.wallet
          ? "<a href='https://gmgn.ai/bsc/address/" + esc(group.contest.wallet) + "' target='_blank' rel='noreferrer'>" + esc(shortAddr(group.contest.wallet)) + "</a>"
          : esc(group.contest.masked_address || "-");
        const body = rows.length
          ? rows.map(wallet => renderLinkedWalletRow(wallet)).join("")
          : "<tr><td colspan='7' class='empty'>sem suspeita >= 2 BNB vinculada ate agora</td></tr>";
        return "<section class='contest-group'>" +
          "<div class='group-header'>" +
            "<div><div class='group-title'>Rank " + esc(group.contest.rank) + " - " + contestLink + "</div>" +
            "<div class='subtle'>" + esc(group.contest.status || "-") + " | GMGN balance $" + esc(num(group.contest.gmgn?.balance, 2)) + " | PnL " + esc(pct(group.contest.gmgn?.pnl)) + "</div></div>" +
            "<div class='group-stats'>" +
              "<span class='pill'>" + esc(rows.length) + "/" + esc(group.stats.linked_wallets) + " wallets</span>" +
              "<span class='pill'>" + esc(group.stats.complete_gmgn) + " GMGN completas</span>" +
              "<span class='pill'>" + esc(num(group.stats.total_balance_bnb, 2)) + " BNB soma</span>" +
              "<span class='pill'>top " + esc(num(group.stats.top_balance_bnb, 2)) + " BNB</span>" +
            "</div>" +
          "</div>" +
          "<table class='link-table'><thead><tr>" +
            "<th class='candidate'>Suspeita</th><th>BNB</th><th class='wide'>GMGN</th><th>PnL</th><th>Atividade</th><th>Vinculo</th><th>Tx</th>" +
          "</tr></thead><tbody>" + body + "</tbody></table>" +
        "</section>";
      }).join("");
    }

    function matchesSideSearch(group, wallet, search) {
      if (!search) return true;
      const haystack = [
        group.contest_rank,
        group.contest_wallet,
        wallet.candidate_wallet,
        wallet.classification,
        wallet.name,
        wallet.tags?.join(" "),
        wallet.also_follows_ranks?.join(" ")
      ].join(" ").toLowerCase();
      return haystack.includes(search);
    }

    function renderContestSides() {
      if (!latestSides) return;
      const search = (document.getElementById("sideSearch")?.value || "").trim().toLowerCase();
      const summary = latestSides.summary || {};
      const checkpoint = latestSides.source?.side_checkpoint || {};
      document.getElementById("sideMeta").textContent = [
        "side scores: " + (latestSides.source?.side_generated_at || "-"),
        "side_rows: " + (checkpoint.side_rows || "-"),
        "filtro: profit 30d >= $" + num(summary.min_realized_profit_30d, 0),
        "limit/grupo: " + (summary.limit_per_contest || "-")
      ].join(" | ");
      document.getElementById("sideSummary").innerHTML = [
        renderMetric("side lucrativas", num(summary.shown_side_wallets, 0)),
        renderMetric("very strong", num(summary.very_strong_side, 0)),
        renderMetric("strong", num(summary.strong_side, 0)),
        renderMetric(">= " + (summary.min_bnb_balance || "2") + " BNB", num(summary.high_balance_matched, 0))
      ].join("");

      document.getElementById("contestSides").innerHTML = (latestSides.groups || []).map(group => {
        const rows = (group.side_wallets || []).filter(wallet => matchesSideSearch(group, wallet, search));
        if (search && rows.length === 0) return "";
        const contestLink = group.contest_wallet
          ? "<a href='https://gmgn.ai/bsc/address/" + esc(group.contest_wallet) + "' target='_blank' rel='noreferrer'>" + esc(shortAddr(group.contest_wallet)) + "</a>"
          : "-";
        const body = rows.length
          ? rows.map(wallet => renderSideWalletRow(wallet)).join("")
          : "<tr><td colspan='8' class='empty'>sem side-wallet candidata nesse filtro</td></tr>";
        return "<section class='contest-group'>" +
          "<div class='group-header'>" +
            "<div><div class='group-title'>Rank " + esc(group.contest_rank) + " - " + contestLink + "</div>" +
            "<div class='subtle'>anchors da contest: " + esc(group.anchor_windows_total) + "</div></div>" +
            "<div class='group-stats'>" +
              "<span class='pill'>" + esc(rows.length) + "/" + esc(group.stats.shown_side_wallets) + " sides</span>" +
              "<span class='pill'>VS " + esc(group.stats.very_strong_side) + "</span>" +
              "<span class='pill'>S " + esc(group.stats.strong_side) + "</span>" +
              "<span class='pill'>HB " + esc(group.stats.high_balance) + "</span>" +
            "</div>" +
          "</div>" +
          "<table class='link-table'><thead><tr>" +
            "<th class='candidate'>Side wallet</th><th>Classe</th><th>Profit 30d</th><th>Follow</th><th>Entrada <=</th><th>Ranges</th><th>Pos/delay</th><th>Tx</th>" +
          "</tr></thead><tbody>" + body + "</tbody></table>" +
        "</section>";
      }).join("");
    }

    function renderSideWalletRow(wallet) {
      const tags = (wallet.tags || []).map(tag => "<span class='tag'>" + esc(tag) + "</span>").join("");
      const gmgn = wallet.gmgn_url
        ? "<a href='" + esc(wallet.gmgn_url) + "' target='_blank' rel='noreferrer'>" + esc(shortAddr(wallet.candidate_wallet)) + "</a>"
        : esc(shortAddr(wallet.candidate_wallet));
      const tx = "<div class='txlinks'>" +
        (wallet.first_tx ? "<a href='https://bscscan.com/tx/" + esc(wallet.first_tx) + "' target='_blank' rel='noreferrer'>first</a>" : "") +
        (wallet.last_tx ? "<a href='https://bscscan.com/tx/" + esc(wallet.last_tx) + "' target='_blank' rel='noreferrer'>last</a>" : "") +
        "</div>";
      return "<tr>" +
        "<td class='candidate'><div>" + gmgn + "</div><div class='subtle'>" + esc(wallet.name || "") + "</div>" + tags + "</td>" +
        "<td><div class='class-" + esc(wallet.classification) + "'>" + esc(wallet.classification) + "</div><div class='subtle'>score " + esc(num(wallet.side_score, 1)) + "</div></td>" +
        "<td><div class='money'>" + esc(money(wallet.realized_profit_30d)) + "</div><div class='subtle'>30d " + esc(pct(wallet.pnl_30d)) + "</div><div class='subtle'>" + (wallet.high_balance ? esc(num(wallet.balance_bnb_num, 4)) + " BNB" : "sem filtro BNB") + "</div></td>" +
        "<td><div>" + esc(num(wallet.follow_windows, 0)) + "/" + esc(num(wallet.anchor_windows_total, 0)) + " windows</div><div class='subtle'>" + esc(pct(wallet.follow_rate)) + " | spec " + esc(pct(wallet.specificity_score)) + "</div><div class='subtle'>ranks " + esc((wallet.also_follows_ranks || []).join("|")) + "</div></td>" +
        "<td><div>10: " + esc(num(wallet.entries_le_10, 0)) + " | 15: " + esc(num(wallet.entries_le_15, 0)) + "</div><div>50: " + esc(num(wallet.entries_le_50, 0)) + " | 100: " + esc(num(wallet.entries_le_100, 0)) + "</div><div>200: " + esc(num(wallet.entries_le_200, 0)) + " | 300: " + esc(num(wallet.entries_le_300, 0)) + "</div></td>" +
        "<td><div>1-10: " + esc(num(wallet.bucket_1_10, 0)) + " | 11-15: " + esc(num(wallet.bucket_11_15, 0)) + "</div><div>16-50: " + esc(num(wallet.bucket_16_50, 0)) + " | 51-100: " + esc(num(wallet.bucket_51_100, 0)) + "</div><div>101-200: " + esc(num(wallet.bucket_101_200, 0)) + " | 201-300: " + esc(num(wallet.bucket_201_300, 0)) + "</div></td>" +
        "<td><div>pos avg/med/min " + esc(num(wallet.avg_position, 1)) + "/" + esc(num(wallet.median_position, 1)) + "/" + esc(num(wallet.min_position, 0)) + "</div><div class='subtle'>delay avg/med " + esc(num(wallet.avg_block_delay, 1)) + "/" + esc(num(wallet.median_block_delay, 1)) + " blocos</div><div class='subtle'>tokens " + esc(num(wallet.distinct_tokens, 0)) + " | raw " + esc(num(wallet.raw_appearances, 0)) + "</div></td>" +
        "<td>" + tx + "</td>" +
      "</tr>";
    }

    function renderLinkedWalletRow(wallet) {
      const tags = (wallet.tags || []).map(tag => "<span class='tag'>" + esc(tag) + "</span>").join("");
      const pnlClass = Number(wallet.realized_profit) < 0 ? "bad" : "money";
      const gmgn = wallet.gmgn_url
        ? "<a href='" + esc(wallet.gmgn_url) + "' target='_blank' rel='noreferrer'>" + esc(shortAddr(wallet.wallet)) + "</a>"
        : esc(shortAddr(wallet.wallet));
      const tx = "<div class='txlinks'>" +
        (wallet.first_tx ? "<a href='https://bscscan.com/tx/" + esc(wallet.first_tx) + "' target='_blank' rel='noreferrer'>first</a>" : "") +
        (wallet.last_tx ? "<a href='https://bscscan.com/tx/" + esc(wallet.last_tx) + "' target='_blank' rel='noreferrer'>last</a>" : "") +
        "</div>";
      return "<tr>" +
        "<td class='candidate'><div>" + gmgn + "</div><div class='subtle'>" + esc(wallet.name || wallet.twitter_username || "") + "</div>" + tags + "</td>" +
        "<td class='num'>" + esc(num(wallet.balance_bnb_num, 4)) + "</td>" +
        "<td><div>valor " + esc(money(wallet.total_value)) + "</div><div class='subtle'>buy/sell all " + esc(num(wallet.buy_all, 0)) + "/" + esc(num(wallet.sell_all, 0)) + "</div><div class='subtle'>" + (wallet.complete_gmgn ? "GMGN completo" : "GMGN parcial") + "</div></td>" +
        "<td><div class='" + pnlClass + "'>" + esc(money(wallet.realized_profit)) + "</div><div class='subtle'>PnL " + esc(pct(wallet.pnl)) + " | 7d " + esc(pct(wallet.pnl_7d)) + "</div></td>" +
        "<td><div>7d " + esc(num(wallet.buy_7d, 0)) + "/" + esc(num(wallet.sell_7d, 0)) + "</div><div class='subtle'>acts " + esc(num(wallet.activity_count, 0)) + "</div></td>" +
        "<td><div>" + esc(num(wallet.distinct_tokens_after_contest, 0)) + " tokens | " + esc(num(wallet.total_windows_seen, 0)) + " windows</div><div class='subtle'>pos min/avg " + esc(num(wallet.min_position, 0)) + "/" + esc(num(wallet.avg_position, 1)) + " | delay " + esc(num(wallet.avg_block_delay, 1)) + " blocos</div></td>" +
        "<td>" + tx + "</td>" +
      "</tr>";
    }

    async function load() {
      const [res, syncRes, linksRes, sidesRes] = await Promise.all([
        fetch("/api/movement?ts=" + Date.now()),
        fetch("/api/browser-sync?ts=" + Date.now()),
        fetch("/api/contest-links?ts=" + Date.now()),
        fetch("/api/contest-sides?ts=" + Date.now())
      ]);
      const data = await res.json();
      const sync = await syncRes.json();
      const links = await linksRes.json();
      const sides = await sidesRes.json();
      document.getElementById("status").textContent = res.ok ? "online" : "erro";
      const banner = document.getElementById("authBanner");
      if (sync.auth_lost) {
        banner.style.display = "block";
        banner.textContent = "GMGN LOGIN LOST: faca login no Chrome isolado para o sync voltar a atualizar o Track da GMGN.";
      } else {
        banner.style.display = "none";
        banner.textContent = "";
      }
      document.getElementById("meta").innerHTML = [
        "movement: " + (data.updated_at || "-"),
        "gmgn_updated_at: " + (data.gmgn_updated_at || "-"),
        "gmgn_sync: " + (sync.updated_at || "-")
      ].map(x => "<span>" + x + "</span>").join("");

      document.getElementById("quick").innerHTML = windows.map(([key, label]) => {
        const quick = data.quick?.[key] || [];
        const summary = data.windows?.[key];
        const body = quick.length
          ? "<div class='chips'>" + quick.map(chip).join("") + "</div>"
          : "<div class='empty'>sem mudança detectada</div>";
        return "<div class='panel'><h2>" + label + " · +" + (summary?.up ?? 0) + " / -" + (summary?.down ?? 0) + "</h2>" + body + "</div>";
      }).join("");

      document.getElementById("rows").innerHTML = (data.rows || []).map(row => {
        const wallet = row.wallet || row.masked_address || "";
        return "<tr>" +
          "<td class='rank num'>" + row.rank + "</td>" +
          "<td>" + row.name + "</td>" +
          "<td class='wallet'>" + wallet + "</td>" +
          "<td class='status'>" + row.status + "</td>" +
          "<td class='movement num'>" + cell(row.movement?.["60m"]) + "</td>" +
          "<td class='movement num'>" + cell(row.movement?.["4h"]) + "</td>" +
          "<td class='movement num'>" + cell(row.movement?.["24h"]) + "</td>" +
          "</tr>";
      }).join("");

      latestLinks = links;
      latestSides = sides;
      renderContestSides();
      renderContestLinks();
    }

    load().catch(error => {
      document.getElementById("status").textContent = "erro";
      document.getElementById("rows").innerHTML = "<tr><td colspan='7'>" + error.message + "</td></tr>";
    });
    document.addEventListener("input", event => {
      if (event.target?.id === "linkSearch") renderContestLinks();
      if (event.target?.id === "sideSearch") renderContestSides();
    });
    setInterval(load, 30000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/") {
      send(res, 200, "text/html; charset=utf-8", html());
      return;
    }
    if (url.pathname === "/api/movement") {
      sendJson(res, await readJson("rank-movement.json", { rows: [], quick: {}, windows: {} }));
      return;
    }
    if (url.pathname === "/api/wallets") {
      sendJson(res, await readJson("wallets.json", { wallets: [] }));
      return;
    }
    if (url.pathname === "/api/checkpoint") {
      sendJson(res, await readJson("checkpoint.json", {}));
      return;
    }
    if (url.pathname === "/api/browser-sync") {
      sendJson(res, await readJson("gmgn-browser-sync-state.json", {}));
      return;
    }
    if (url.pathname === "/api/contest-links") {
      const [walletsState, highBalanceState] = await Promise.all([
        readJsonCached("wallets.json", { wallets: [] }),
        readJsonCached("high-balance-linked-wallets.json", { wallets: [], checkpoint: {}, criteria: {} })
      ]);
      sendJson(res, buildContestLinksDashboard(walletsState, highBalanceState));
      return;
    }
    if (url.pathname === "/api/contest-sides") {
      const [sideState, highBalanceState] = await Promise.all([
        readJsonCached("contest-side-wallets.json", { groups: [], checkpoint: {}, criteria: {} }),
        readJsonCached("high-balance-linked-wallets.json", { wallets: [], checkpoint: {}, criteria: {} })
      ]);
      const minProfit = Number(url.searchParams.get("min_profit_30d") || 2000);
      sendJson(
        res,
        buildContestSidesDashboard(sideState, highBalanceState, {
          limitPerContest: Number(url.searchParams.get("limit_per_contest") || 50),
          profitableOnly: url.searchParams.get("all") !== "1",
          minRealizedProfit30d: Number.isFinite(minProfit) ? minProfit : 2000
        })
      );
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
  } catch (error) {
    send(res, 500, "text/plain; charset=utf-8", `${error.stack || error.message}\n`);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[dashboard] http://0.0.0.0:${port} outDir=${path.resolve(outDir)}`);
});
