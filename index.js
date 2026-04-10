require('dotenv').config();
const fetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : require('node-fetch');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DECISION_INTERVAL_MS = 60 * 1000;
const EVAL_DELAY_MS = 10 * 60 * 1000;

const POLYMARKET_MARKETS_URL =
  'https://gamma-api.polymarket.com/markets?active=true&limit=20&order=volume&ascending=false';

async function fetchPolymarketMarkets() {
  const res = await fetch(POLYMARKET_MARKETS_URL);
  if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
  const markets = await res.json();
  if (!Array.isArray(markets)) return [];

  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const windowsHours = [24, 48, 7 * 24];

  const parsed = markets
    .map((m) => {
      const endMs = m.endDate ? Date.parse(m.endDate) : NaN;
      return Number.isFinite(endMs) ? { m, endMs } : null;
    })
    .filter((x) => x && x.endMs > now);

  for (const hours of windowsHours) {
    const horizon = now + hours * hourMs;
    const inWindow = parsed.filter((x) => x.endMs <= horizon);
    if (inWindow.length >= 5 || hours === 7 * 24) {
      return inWindow
        .sort((a, b) => a.endMs - b.endMs)
        .slice(0, 5)
        .map(({ m, endMs }) => ({
          ...m,
          endsAt: new Date(endMs).toISOString(),
        }));
    }
  }
  return [];
}

let latestPrice = null;
let priceHistory = [];
let agentStats = {
  chatgpt: { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  claude:  { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  gemini:  { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  grok:    { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
};
let recentDecisions = [];

function recordLatestPrice(price, source) {
  if (!Number.isFinite(price)) return false;
  latestPrice = price;
  priceHistory.push({ price, time: Date.now() });
  if (priceHistory.length > 30) priceHistory.shift();
  console.log(`[Conductor Labs] BTC price: $${price.toFixed(2)} (source: ${source})`);
  return true;
}

async function fetchBTCPrice() {
  const binanceUrl = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

  try {
    const res = await fetch(binanceUrl);
    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error(
        '[Conductor Labs] Binance: response is not valid JSON. status=%s body=%s',
        res.status,
        rawText.length > 2000 ? `${rawText.slice(0, 2000)}…` : rawText,
      );
      throw new Error('Binance JSON parse failed');
    }

    if (!res.ok) {
      console.error(
        '[Conductor Labs] Binance: HTTP error. status=%s body=%s',
        res.status,
        JSON.stringify(data),
      );
      throw new Error(`Binance HTTP ${res.status}`);
    }

    const price = parseFloat(data.price);
    if (!Number.isFinite(price)) {
      console.error('[Conductor Labs] Binance: price parse failed (NaN). Full response:', JSON.stringify(data));
      throw new Error('Binance invalid price');
    }

    recordLatestPrice(price, 'binance');
    return price;
  } catch (err) {
    console.error('[Conductor Labs] Binance failed:', err.message);
  }

  const coinbaseUrl = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
  try {
    const res = await fetch(coinbaseUrl);
    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error(
        '[Conductor Labs] Coinbase: response is not valid JSON. status=%s body=%s',
        res.status,
        rawText.length > 2000 ? `${rawText.slice(0, 2000)}…` : rawText,
      );
      return null;
    }

    if (!res.ok) {
      console.error(
        '[Conductor Labs] Coinbase: HTTP error. status=%s body=%s',
        res.status,
        JSON.stringify(data),
      );
      return null;
    }

    const amount = data.data && data.data.amount;
    const price = parseFloat(amount);
    if (!Number.isFinite(price)) {
      console.error('[Conductor Labs] Coinbase: price parse failed (NaN). Full response:', JSON.stringify(data));
      return null;
    }

    recordLatestPrice(price, 'coinbase');
    return price;
  } catch (err) {
    console.error('[Conductor Labs] Coinbase failed:', err.message);
    return null;
  }
}

function getPriceNMinutesAgo(minutes) {
  const targetTime = Date.now() - minutes * 60 * 1000;
  const closest = priceHistory.reduce((prev, curr) =>
    Math.abs(curr.time - targetTime) < Math.abs(prev.time - targetTime) ? curr : prev
  , priceHistory[0]);
  return closest ? closest.price : null;
}

function trendAgent(price) {
  const prev = getPriceNMinutesAgo(5);
  if (!prev) return 'HOLD';
  if (price > prev) return 'BUY';
  if (price < prev) return 'SELL';
  return 'HOLD';
}

function reversionAgent(price) {
  const prev = getPriceNMinutesAgo(5);
  if (!prev) return 'HOLD';
  const change = (price - prev) / prev;
  if (change < -0.005) return 'BUY';
  if (change > 0.005) return 'SELL';
  return 'HOLD';
}

function breakoutAgent(price) {
  if (priceHistory.length < 15) return 'HOLD';
  const window = priceHistory.slice(-15).map(p => p.price);
  const high = Math.max(...window);
  const low = Math.min(...window);
  if (price > high) return 'BUY';
  if (price < low) return 'SELL';
  return 'HOLD';
}

function chaosAgent() {
  const r = Math.random();
  if (r < 0.4) return 'BUY';
  if (r < 0.8) return 'SELL';
  return 'HOLD';
}

async function logDecision(agentId, action, price) {
  const { data, error } = await supabase
    .from('decisions')
    .insert({ agent_id: agentId, action, price })
    .select()
    .single();
  if (error) console.error('[Conductor Labs] Log error:', error.message);
  return data;
}

async function evaluateDecision(decisionId, entryPrice, action) {
  setTimeout(async () => {
    if (!latestPrice) return;
    const exitPrice = latestPrice;
    let pnl = 0;
    if (action === 'BUY') pnl = exitPrice - entryPrice;
    else if (action === 'SELL') pnl = entryPrice - exitPrice;
    const won = pnl > 0;

    await supabase
      .from('decisions')
      .update({ pnl: parseFloat(pnl.toFixed(2)), won })
      .eq('id', decisionId);
  }, EVAL_DELAY_MS);
}

function updateStats(agentId, won, pnl) {
  const s = agentStats[agentId];
  s.total++;
  if (won) {
    s.wins++;
    s.pnl += pnl;
    if (s.streakDir === 'W') s.streak++;
    else { s.streak = 1; s.streakDir = 'W'; }
  } else {
    s.pnl += pnl;
    if (s.streakDir === 'L') s.streak++;
    else { s.streak = 1; s.streakDir = 'L'; }
  }
}

async function runDecisionLoop() {
  const price = await fetchBTCPrice();
  if (!price) return;

  const decisions = {
    chatgpt: trendAgent(price),
    claude:  reversionAgent(price),
    gemini:  breakoutAgent(price),
    grok:    chaosAgent(),
  };

  console.log('[Conductor Labs] Decisions:', decisions);

  for (const [agentId, action] of Object.entries(decisions)) {
    agentStats[agentId].lastAction = action;
    const record = await logDecision(agentId, action, price);
    if (record && action !== 'HOLD') {
      evaluateDecision(record.id, price, action);
    }
    recentDecisions.unshift({
      agent: agentId,
      action,
      price: price.toFixed(2),
      time: new Date().toISOString(),
    });
  }

  if (recentDecisions.length > 50) recentDecisions = recentDecisions.slice(0, 50);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', price: latestPrice, time: new Date().toISOString() });
});

app.get('/state', (req, res) => {
  res.json({
    price: latestPrice,
    agents: agentStats,
    recentDecisions: recentDecisions.slice(0, 20),
    updatedAt: new Date().toISOString(),
  });
});

app.get('/decisions', async (req, res) => {
  const { data, error } = await supabase
    .from('decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/polymarket', async (req, res) => {
  try {
    const markets = await fetchPolymarketMarkets();
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`[Conductor Labs] Backend engine running on port ${PORT}`);
  await fetchBTCPrice();
  await runDecisionLoop();
  setInterval(runDecisionLoop, DECISION_INTERVAL_MS);
});
