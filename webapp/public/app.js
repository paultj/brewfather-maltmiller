// Recipe chat + review screen. The conversation lives in this browser tab
// only (sessionStorage); nothing is saved on the server.

const STORE_KEY = "brew-recipe-maker:v1";
const state = { history: [], log: [], recipe: null, pushed: null, edits: [], busy: false };

const $ = (sel) => document.querySelector(sel);
const chatLog = $("#chat-log");
const input = $("#chat-input");
const review = $("#review");

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ history: state.history, log: state.log, recipe: state.recipe, pushed: state.pushed, edits: state.edits }));
  } catch {
    // storage full or blocked; the session just won't survive a reload
  }
}

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (saved) Object.assign(state, saved);
  } catch {
    // ignore
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("Signed out");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

// ---------- Chat ----------

function addMessage(role, text, { persist = true } = {}) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  if (persist) {
    state.log.push({ role, text });
    save();
  }
  return div;
}

function renderLog() {
  for (const m of state.log) addMessage(m.role, m.text, { persist: false });
}

async function send(text) {
  if (state.busy) return;
  state.busy = true;
  $("#send").disabled = true;

  // Tell Claude about edits made on the review screen since its last reply.
  const outgoing = state.edits.length ? `(Note: on the review screen I ${state.edits.join("; ")}.)\n\n${text}` : text;

  addMessage("user", text);
  input.value = "";
  const thinking = addMessage("thinking", "Designing… this can take up to a minute.", { persist: false });

  try {
    const data = await api("/api/chat", { history: state.history, text: outgoing });
    thinking.remove();
    state.history = data.history;
    state.edits = [];
    if (data.inventoryWarning) addMessage("system", data.inventoryWarning);
    if (data.reply) addMessage("assistant", data.reply);
    if (data.recipe) {
      state.recipe = data.recipe;
      state.pushed = null;
      renderReview();
    }
    save();
  } catch (err) {
    thinking.remove();
    addMessage("error", err.message);
  } finally {
    state.busy = false;
    $("#send").disabled = false;
    input.focus();
  }
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) send(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});

$("#new-chat").addEventListener("click", () => {
  if (state.log.length && !confirmReset()) return;
  Object.assign(state, { history: [], log: [], recipe: null, pushed: null, edits: [] });
  save();
  location.reload();
});

function confirmReset() {
  return window.confirm("Start a new recipe? This clears the current conversation.");
}

$("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  try { sessionStorage.removeItem(STORE_KEY); } catch {}
  location.href = "/login";
});

// ---------- Review ----------

// Approximate SRM -> sRGB for the colour swatch.
const SRM_COLOURS = ["#FFE699", "#FFE699", "#FFD878", "#FFCA5A", "#FFBF42", "#FBB123", "#F8A600", "#F39C00", "#EA8F00", "#E58500", "#DE7C00", "#D77200", "#CF6900", "#CB6200", "#C35900", "#BB5100", "#B54C00", "#B04500", "#A63E00", "#A13700", "#9B3200", "#952D00", "#8E2900", "#882300", "#821E00", "#7B1A00", "#771900", "#701400", "#6A0E00", "#660D00", "#5E0B00", "#5A0A02", "#600903", "#520907", "#4C0505", "#470606", "#440607", "#3F0708", "#3B0607", "#3A070B", "#36080A"];
function srmColour(srm) {
  return SRM_COLOURS[Math.max(0, Math.min(SRM_COLOURS.length - 1, Math.round(srm)))];
}

const STOCK_LABEL = { in_stock: "In stock", partial: "Partly in stock", to_buy: "To buy" };
function stockBadge(stock) {
  if (!stock) return "";
  const have = stock.status !== "to_buy" ? ` · have ${stock.have} ${esc(stock.unit)}` : "";
  return `<span class="badge ${stock.status}">${STOCK_LABEL[stock.status]}${have}</span>`;
}

function fmt(n, dp = 2) {
  return Number(n).toLocaleString("en-GB", { maximumFractionDigits: dp });
}

function hopWhen(h) {
  if (h.use === "Dry Hop") return `Dry hop day ${fmt(h.dry_hop_day, 0)}, ${fmt(h.dry_hop_duration_days, 0)} days`;
  if (h.use === "Whirlpool") return `Whirlpool ${fmt(h.time_min, 0)} min @ ${fmt(h.temp_c, 0)}°C`;
  if (h.use === "First Wort") return "First wort";
  if (h.use === "Mash") return "Mash";
  return `Boil ${fmt(h.time_min, 0)} min`;
}

function shoppingList(r) {
  const items = [];
  for (const f of r.fermentables) if (f.stock?.status !== "in_stock") items.push(`${f.name}: ${fmt(f.amount_kg - (f.stock?.have || 0))} kg`);
  const seen = new Set();
  for (const h of r.hops) {
    const key = h.name.trim().toLowerCase();
    if (h.stock?.status === "in_stock" || seen.has(key)) continue;
    seen.add(key);
    const total = r.hops.filter((x) => x.name.trim().toLowerCase() === key).reduce((s, x) => s + x.amount_g, 0);
    items.push(`${h.name}: ${fmt(total - (h.stock?.have || 0), 0)} g`);
  }
  for (const y of r.yeasts) if (y.stock?.status !== "in_stock") items.push(`${y.laboratory ? y.laboratory + " " : ""}${y.name}: ${fmt(y.amount)} ${y.unit}`);
  for (const m of r.miscs) if (m.stock?.status !== "in_stock") items.push(`${m.name}: ${fmt(m.amount)} ${m.unit}`);
  return items;
}

function renderReview() {
  const r = state.recipe;
  if (!r) return;
  const s = r.stats;
  const grainTotal = r.fermentables.reduce((sum, f) => sum + f.amount_kg, 0) || 1;
  const toBuy = shoppingList(r);

  review.innerHTML = `
    <div class="card">
      <div class="recipe-head">
        <div style="flex:1;min-width:240px">
          <input class="recipe-name-input" id="recipe-name" value="${esc(r.name)}" aria-label="Recipe name">
          <div class="style">${esc(r.style.name)} · BJCP ${esc(r.style.bjcp_code)}</div>
          <p class="desc">${esc(r.description)}</p>
        </div>
        <div class="push-box">
          <button id="push" class="btn primary" type="button">${state.pushed ? "Push again as a new recipe" : "Push to Brewfather"}</button>
          <div id="push-result" class="push-result ${state.pushed ? "ok" : ""}">${
            state.pushed ? `Pushed. <a href="${esc(state.pushed.url)}" target="_blank" rel="noopener">Open in Brewfather</a>` : "Review the recipe, then push it. You can keep chatting to change it."
          }</div>
        </div>
      </div>
      <div class="meta-row">
        <label>Batch <input type="number" id="batch-size" min="1" step="0.5" value="${esc(r.batch_size_l)}"> L</label>
        <span>Efficiency ${fmt(r.efficiency_pct, 0)}%</span>
        <span>Boil ${fmt(r.boil_time_min, 0)} min</span>
      </div>
    </div>

    <div class="card">
      <h3>Estimated stats</h3>
      <div class="stats">
        <div class="stat"><div class="label">OG</div><div class="value">${s.og.toFixed(3)}</div></div>
        <div class="stat"><div class="label">FG</div><div class="value">${s.fg.toFixed(3)}</div></div>
        <div class="stat"><div class="label">ABV</div><div class="value">${fmt(s.abv, 1)}%</div></div>
        <div class="stat"><div class="label">IBU</div><div class="value">${s.ibu}</div></div>
        <div class="stat"><div class="label">Colour</div><div class="value"><span class="swatch" style="background:${srmColour(s.srm)}"></span>${fmt(s.ebc, 0)} EBC</div></div>
      </div>
      <div class="hint" style="margin-top:8px">Calculated by this app (Tinseth IBU, Morey colour). Brewfather may show slightly different numbers.</div>
    </div>

    ${r.swaps?.length ? `
    <div class="card">
      <h3>Swaps from your stock</h3>
      <p class="sub" style="margin:-4px 0 10px">Optional. Apply one and Claude will update the recipe, adjusting amounts to keep it on target.</p>
      <div class="table-wrap"><table><tbody>${r.swaps.map((sw, i) => `
        <tr>
          <td><b>${esc(sw.replace)}</b> → <b>${esc(sw.with)}</b> <span class="badge in_stock">have ${fmt(sw.have)}${sw.unit ? " " + esc(sw.unit) : ""}</span>
            <div class="sub">${esc(sw.reason)}</div></td>
          <td class="num"><button class="btn small apply-swap" type="button" data-swap="${i}">Apply</button></td>
        </tr>`).join("")}
      </tbody></table></div>
    </div>` : ""}

    <div class="card">
      <h3>Fermentables · ${fmt(s.total_grain_kg)} kg</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Ingredient</th><th class="num">Amount</th><th class="num">%</th><th>Stock</th></tr></thead>
        <tbody>${r.fermentables.map((f) => `
          <tr>
            <td>${esc(f.name)}<div class="sub">${esc([f.supplier, f.type, `${fmt(f.color_lovibond, 1)}°L`].filter(Boolean).join(" · "))}</div></td>
            <td class="num">${fmt(f.amount_kg)} kg</td>
            <td class="num">${fmt((f.amount_kg / grainTotal) * 100, 0)}%</td>
            <td>${stockBadge(f.stock)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h3>Hops · ${fmt(s.total_hops_g, 0)} g</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Hop</th><th>When</th><th class="num">Amount</th><th class="num">AA</th><th>Stock</th></tr></thead>
        <tbody>${r.hops.map((h) => `
          <tr>
            <td>${esc(h.name)}<div class="sub">${esc(h.form)}</div></td>
            <td>${esc(hopWhen(h))}</td>
            <td class="num">${fmt(h.amount_g, 0)} g</td>
            <td class="num">${fmt(h.alpha_pct, 1)}%</td>
            <td>${stockBadge(h.stock)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3>Yeast</h3>
        <div class="table-wrap"><table><tbody>${r.yeasts.map((y) => `
          <tr>
            <td>${esc(y.name)}<div class="sub">${esc([y.laboratory, y.product_id, y.form, `${fmt(y.attenuation_pct, 0)}% attenuation`, `${fmt(y.min_temp_c, 0)}–${fmt(y.max_temp_c, 0)}°C`].filter(Boolean).join(" · "))}</div></td>
            <td class="num">${fmt(y.amount)} ${esc(y.unit)}</td>
            <td>${stockBadge(y.stock)}</td>
          </tr>`).join("")}
        </tbody></table></div>
      </div>
      <div class="card">
        <h3>Water &amp; additions</h3>
        ${r.miscs.length ? `<div class="table-wrap"><table><tbody>${r.miscs.map((m) => `
          <tr>
            <td>${esc(m.name)}<div class="sub">${esc(m.use)}${m.time_min ? ` · ${fmt(m.time_min, 0)} min` : ""}</div></td>
            <td class="num">${fmt(m.amount)} ${esc(m.unit)}</td>
            <td>${stockBadge(m.stock)}</td>
          </tr>`).join("")}</tbody></table></div>` : '<p class="sub">None</p>'}
        ${r.water_notes ? `<p class="sub" style="margin-top:10px">${esc(r.water_notes)}</p>` : ""}
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <h3>Mash</h3>
        <table><tbody>${r.mash_steps.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${fmt(m.temp_c, 1)}°C</td><td class="num">${fmt(m.time_min, 0)} min</td></tr>`).join("")}</tbody></table>
      </div>
      <div class="card">
        <h3>Fermentation</h3>
        <table><tbody>${r.fermentation_steps.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${fmt(f.temp_c, 1)}°C</td><td class="num">${fmt(f.days, 0)} days</td></tr>`).join("")}</tbody></table>
      </div>
    </div>

    ${r.notes ? `<div class="card notes"><h3>Brewing notes</h3><p>${esc(r.notes)}</p></div>` : ""}

    <div class="card">
      <h3>To buy</h3>
      ${toBuy.length ? `<ul class="shopping">${toBuy.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : '<p class="sub">Everything is in your Brewfather inventory.</p>'}
    </div>
  `;

  $("#push").addEventListener("click", push);
  review.querySelectorAll(".apply-swap").forEach((btn) =>
    btn.addEventListener("click", () => {
      const sw = state.recipe.swaps[Number(btn.dataset.swap)];
      if (!sw || state.busy) return;
      send(`Apply the swap: use ${sw.with} from my inventory instead of ${sw.replace}.`);
    }),
  );
  $("#recipe-name").addEventListener("change", (e) => {
    const name = e.target.value.trim();
    if (!name || name === state.recipe.name) return;
    state.recipe.name = name;
    state.edits.push(`renamed the recipe to "${name}"`);
    save();
  });
  $("#batch-size").addEventListener("change", (e) => rescale(Number(e.target.value)));
}

async function rescale(newSize) {
  const r = state.recipe;
  if (!Number.isFinite(newSize) || newSize <= 0 || newSize === r.batch_size_l) return;
  const k = newSize / r.batch_size_l;
  const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;
  const scaled = {
    ...r,
    batch_size_l: newSize,
    fermentables: r.fermentables.map((f) => ({ ...f, amount_kg: round(f.amount_kg * k, 3) })),
    hops: r.hops.map((h) => ({ ...h, amount_g: round(h.amount_g * k, 1) })),
    miscs: r.miscs.map((m) => ({ ...m, amount: round(m.amount * k, 2) })),
  };
  try {
    const data = await api("/api/recipe/calc", { recipe: scaled });
    state.edits.push(`scaled the batch from ${r.batch_size_l} L to ${newSize} L (fermentables, hops and additions scaled; yeast unchanged)`);
    state.recipe = data.recipe;
    state.pushed = null;
    save();
    renderReview();
  } catch (err) {
    addMessage("error", err.message);
  }
}

async function push() {
  const btn = $("#push");
  const out = $("#push-result");
  btn.disabled = true;
  out.className = "push-result";
  out.textContent = "Pushing to Brewfather…";
  try {
    const result = await api("/api/recipe/push", { recipe: state.recipe });
    state.pushed = result;
    save();
    btn.textContent = "Push again as a new recipe";
    out.className = "push-result ok";
    out.innerHTML = `Pushed${result.mock ? " (demo mode, nothing sent)" : ""}. <a href="${esc(result.url)}" target="_blank" rel="noopener">Open in Brewfather</a>`;
  } catch (err) {
    out.className = "push-result bad";
    const details = Array.isArray(err.details) ? ` ${err.details.map((d) => d.message || JSON.stringify(d)).join("; ")}` : err.details ? ` ${JSON.stringify(err.details)}` : "";
    out.textContent = err.message + details;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Start-up ----------

async function init() {
  restore();
  renderLog();
  if (state.recipe) renderReview();

  try {
    const settings = await api("/api/settings");
    if (settings.mock) $("#mock-pill").classList.remove("hidden");
    if (!settings.mock && !settings.anthropicApiKeyMasked) {
      addMessage("system", "Add your Anthropic API key in Settings before chatting.", { persist: false });
    }
    const { inventory } = await api("/api/inventory");
    if (inventory) {
      const n = Object.values(inventory).reduce((sum, list) => sum + list.length, 0);
      $("#inventory-pill").textContent = `${n} inventory items loaded`;
    } else {
      $("#inventory-pill").textContent = "No Brewfather inventory";
    }
  } catch (err) {
    $("#inventory-pill").textContent = "Inventory unavailable";
    $("#inventory-pill").title = err.message;
  }
  input.focus();
}

init();
