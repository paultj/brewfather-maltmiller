const $ = (id) => document.getElementById(id);
const FIELDS = ["brewfatherUserId", "equipmentRecipeId", "model", "batchSizeL", "efficiencyPct", "boilTimeMin", "brewerNotes"];
const SECRETS = ["anthropicApiKey", "brewfatherApiKey"];

async function call(path, body) {
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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fill(s) {
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? "";
  for (const k of SECRETS) {
    $(k).value = "";
    $(k).placeholder = s[`${k}Masked`] ? `Saved (${s[`${k}Masked`]})` : "Not set";
  }
}

async function loadRecipeOptions(selected) {
  const select = $("equipmentRecipeId");
  try {
    const { recipes } = await call("/api/brewfather/recipes");
    for (const r of recipes) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.equipment ? `${r.name} (equipment: ${r.equipment})` : r.name;
      select.appendChild(opt);
    }
  } catch {
    // No Brewfather credentials yet; only "Most recent recipe" is offered.
  }
  if (selected && ![...select.options].some((o) => o.value === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = `Saved recipe (${selected})`;
    select.appendChild(opt);
  }
  select.value = selected || "";
}

async function load() {
  const s = await call("/api/settings");
  fill(s);
  await loadRecipeOptions(s.equipmentRecipeId);
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const f of FIELDS) body[f] = $(f).value;
  for (const k of SECRETS) body[k] = $(k).value;
  const out = $("save-result");
  try {
    fill(await call("/api/settings", body));
    out.textContent = "Saved.";
  } catch (err) {
    out.textContent = err.message;
  }
  setTimeout(() => (out.textContent = ""), 4000);
});

$("test-bf").addEventListener("click", async () => {
  const out = $("test-result");
  out.className = "status";
  out.textContent = "Testing…";
  try {
    const { counts, equipment, water } = await call("/api/settings/test-brewfather", {});
    out.className = "status ok";
    const equip = equipment
      ? ` Equipment "${equipment.name}" (from recipe "${equipment.fromRecipe}"): efficiency ${equipment.efficiency ?? "?"}%, batch ${equipment.batchSize ?? "?"} L, boil ${equipment.boilTime ?? "?"} min.`
      : " No equipment found (no recipes in Brewfather yet), so the defaults below are used.";
    const wat = water ? ` Water: source "${water.source || "?"}"${water.target ? `, target "${water.target}"` : ""}.` : "";
    out.textContent = `Connected. In stock: ${counts.fermentables} fermentables, ${counts.hops} hops, ${counts.yeasts} yeasts, ${counts.miscs} misc.${equip}${wat} (Save first if you just changed a setting.)`;
  } catch (err) {
    out.className = "status bad";
    out.textContent = err.message;
  }
});

load();
