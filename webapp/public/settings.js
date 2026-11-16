const $ = (id) => document.getElementById(id);
const FIELDS = ["brewfatherUserId", "model", "batchSizeL", "efficiencyPct", "boilTimeMin", "brewerNotes"];
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

async function load() {
  fill(await call("/api/settings"));
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
    const { counts } = await call("/api/settings/test-brewfather", {});
    out.className = "status ok";
    out.textContent = `Connected. In stock: ${counts.fermentables} fermentables, ${counts.hops} hops, ${counts.yeasts} yeasts, ${counts.miscs} misc. (Save first if you just changed the key.)`;
  } catch (err) {
    out.className = "status bad";
    out.textContent = err.message;
  }
});

load();
