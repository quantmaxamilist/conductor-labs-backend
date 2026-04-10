require('dotenv').config();
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

let latestPrice = null;
let priceHistory = [];
let agentStats = {
  chatgpt: { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  claude:  { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  gemini:  { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
  grok:    { pnl: 0, wins: 0, total: 0, streak: 0, streakDir: 'W', lastAction: null },
};
let recentDecisions = [];

async function fetchBTCPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
    const data = await res.json();
    const price = parseFloat(data.price);
    latestPrice = price;
    priceHistory.push({ price, time: Date.now() });
    if (priceHistory.length > 30) priceHistory.shift();
    console.log(`[Conductor Labs] BTC price: $${price.toFixed(2)}`);
    return price;
  } catch (err) {
    console.error('[Conductor Labs] Price fetch failed:', err.message);
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`[Conductor Labs] Backend engine running on port ${PORT}`);
  await fetchBTCPrice();
  await runDecisionLoop();
  setInterval(runDecisionLoop, DECISION_INTERVAL_MS);
});
