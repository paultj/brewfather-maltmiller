// Token usage and estimated cost per chat turn and per Brewfather push, and
// the numbers for the admin page.
import { getDb, now } from "./db.js";

// US dollars per million tokens (Anthropic API list prices, November 2026).
// Cache writes (5-minute) cost 1.25x input. Unknown models are priced at the
// Opus 5 rate so the estimate errs high.
export const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const FALLBACK_PRICE = { input: 5, output: 25, cacheRead: 0.5 };

export function priceFor(model) {
  const m = String(model || "");
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => m === k || m.startsWith(`${k}-`));
  return key ? PRICES[key] : FALLBACK_PRICE;
}

function tokensOf(u) {
  return {
    input: Number(u?.input_tokens) || 0,
    output: Number(u?.output_tokens) || 0,
    cacheRead: Number(u?.cache_read_input_tokens) || 0,
    cacheWrite: Number(u?.cache_creation_input_tokens) || 0,
  };
}

export function costUsd(model, t) {
  const p = priceFor(model);
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.input * 1.25) / 1e6;
}

/**
 * Token counts and cost for one API response. When a server-side fallback
 * ran, usage.iterations lists each model's share; price each at its model.
 */
export function responseUsage(response) {
  const usage = response?.usage || {};
  const parts = Array.isArray(usage.iterations) ? usage.iterations.filter((it) => it && it.model && "input_tokens" in it) : [];
  const entries = parts.length ? parts.map((it) => ({ model: it.model, t: tokensOf(it) })) : [{ model: response?.model || "", t: tokensOf(usage) }];
  const total = { model: response?.model || entries[0].model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const { model, t } of entries) {
    total.input += t.input;
    total.output += t.output;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
    total.cost += costUsd(model, t);
  }
  return total;
}

/** Add up the usage of several responses (one chat turn can make several requests). */
export function sumUsage(list) {
  const out = { model: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
  for (const u of list) {
    out.model = u.model || out.model;
    out.input += u.input;
    out.output += u.output;
    out.cacheRead += u.cacheRead;
    out.cacheWrite += u.cacheWrite;
    out.cost += u.cost;
    out.requests += 1;
  }
  return out;
}

export function cleanConversationId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

export function recordChat(userId, conversationId, u, { at = now(), keyOwner = "user" } = {}) {
  getDb()
    .prepare(
      `INSERT INTO usage (user_id, at, kind, conversation_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, key_owner)
       VALUES (?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, at, cleanConversationId(conversationId), u.model || "", u.input, u.output, u.cacheRead, u.cacheWrite, u.cost, keyOwner);
}

export function recordPush(userId, conversationId, { recipeName = "", brewfatherId = "", created = true, at = now() } = {}) {
  getDb()
    .prepare(`INSERT INTO usage (user_id, at, kind, conversation_id, recipe_name, brewfather_id, created) VALUES (?, ?, 'push', ?, ?, ?, ?)`)
    .run(userId, at, cleanConversationId(conversationId), String(recipeName).slice(0, 200), String(brewfatherId).slice(0, 100), created ? 1 : 0);
}

const month = (iso) => iso.slice(0, 7);

/**
 * Admin metrics.
 * - Cost per user per month: total cost in a month / users who chatted that month.
 * - Cost per pushed recipe: chat cost of the conversations that led to a new
 *   Brewfather recipe / the number of new recipes they produced. Updates of
 *   an already-pushed recipe don't count as a new recipe; their chat cost does
 *   count towards that recipe.
 * - Recipes started: conversations (each "New recipe" in the app is one).
 */
export function metrics({ months = 12 } = {}) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - (months - 1));
  const sinceIso = since.toISOString().slice(0, 7);
  const rows = getDb()
    .prepare(
      `SELECT u.user_id, u.at, u.kind, u.conversation_id, u.cost_usd, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.created, u.key_owner, us.email
       FROM usage u JOIN users us ON us.id = u.user_id WHERE substr(u.at, 1, 7) >= ? ORDER BY u.at`,
    )
    .all(sinceIso);

  const byMonth = new Map();
  const userMonths = new Set();
  const conv = new Map(); // conversation key -> { cost, created, month, user }
  const perUser = new Map();
  const thisMonth = month(now());

  for (const r of rows) {
    const m = month(r.at);
    if (!byMonth.has(m)) byMonth.set(m, { month: m, users: new Set(), turns: 0, conversations: new Set(), created: 0, updated: 0, cost: 0, tokens: 0 });
    const b = byMonth.get(m);
    if (!perUser.has(r.user_id))
      perUser.set(r.user_id, { userId: r.user_id, email: r.email, costMonth: 0, costTotal: 0, conversationsMonth: 0, createdMonth: 0, createdTotal: 0, convs: new Set() });
    const pu = perUser.get(r.user_id);
    // Chats with no conversation id (older browser tabs) count as one each.
    const ckey = `${r.user_id}:${r.conversation_id || `turn-${r.at}`}`;
    if (!conv.has(ckey)) conv.set(ckey, { cost: 0, created: 0, month: m, userId: r.user_id });
    const c = conv.get(ckey);

    if (r.kind === "chat") {
      b.users.add(r.user_id);
      b.turns += 1;
      b.conversations.add(ckey);
      b.cost += r.cost_usd;
      b.tokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      userMonths.add(`${r.user_id}:${m}`);
      c.cost += r.cost_usd;
      pu.costTotal += r.cost_usd;
      if (m === thisMonth) {
        pu.costMonth += r.cost_usd;
        if (!pu.convs.has(ckey)) {
          pu.convs.add(ckey);
          pu.conversationsMonth += 1;
        }
      }
    } else if (r.kind === "push") {
      if (r.created) {
        b.created += 1;
        c.created += 1;
        pu.createdTotal += 1;
        if (m === thisMonth) pu.createdMonth += 1;
      } else b.updated += 1;
    }
  }

  // Cost per pushed recipe, by the month the conversation started.
  const pushedCost = new Map();
  for (const c of conv.values()) {
    if (!c.created) continue;
    const p = pushedCost.get(c.month) || { cost: 0, recipes: 0 };
    p.cost += c.cost;
    p.recipes += c.created;
    pushedCost.set(c.month, p);
  }

  const monthsOut = [...byMonth.values()]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((b) => {
      const p = pushedCost.get(b.month);
      return {
        month: b.month,
        activeUsers: b.users.size,
        chatTurns: b.turns,
        recipesStarted: b.conversations.size,
        recipesPushed: b.created,
        recipeUpdates: b.updated,
        tokens: b.tokens,
        costUsd: b.cost,
        costPerUserUsd: b.users.size ? b.cost / b.users.size : null,
        costPerStartedUsd: b.conversations.size ? b.cost / b.conversations.size : null,
        costPerPushedUsd: p?.recipes ? p.cost / p.recipes : null,
      };
    });

  const totalCost = monthsOut.reduce((s, m) => s + m.costUsd, 0);
  const allPushed = [...pushedCost.values()].reduce((a, p) => ({ cost: a.cost + p.cost, recipes: a.recipes + p.recipes }), { cost: 0, recipes: 0 });
  const totalConversations = monthsOut.reduce((s, m) => s + m.recipesStarted, 0);
  const totalTurns = monthsOut.reduce((s, m) => s + m.chatTurns, 0);

  return {
    since: sinceIso,
    summary: {
      costUsd: totalCost,
      costPerUserMonthUsd: userMonths.size ? totalCost / userMonths.size : null,
      costPerPushedUsd: allPushed.recipes ? allPushed.cost / allPushed.recipes : null,
      costPerStartedUsd: totalConversations ? totalCost / totalConversations : null,
      costPerTurnUsd: totalTurns ? totalCost / totalTurns : null,
      recipesStartedPerUserMonth: userMonths.size ? totalConversations / userMonths.size : null,
      recipesPushed: allPushed.recipes,
    },
    months: monthsOut,
    users: [...perUser.values()].map(({ convs, ...u }) => u),
  };
}

/** One user's own usage this month and overall (for their Settings page). */
export function userUsage(userId) {
  const m = month(now());
  const q = (where, ...args) =>
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COUNT(DISTINCT CASE WHEN kind = 'chat' THEN conversation_id END) AS started,
                COALESCE(SUM(CASE WHEN kind = 'push' AND created = 1 THEN 1 ELSE 0 END), 0) AS pushed,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM usage WHERE user_id = ? ${where}`,
      )
      .get(userId, ...args);
  return { month: q("AND substr(at, 1, 7) = ?", m), total: q("") };
}
