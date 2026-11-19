const { $, api, status } = window.Brew;

function show(id) {
  for (const f of ["#login-form", "#forgot-form", "#setup-form"]) $(f).classList.toggle("hidden", f !== id);
  $(id).querySelector("input")?.focus();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.classList.add("hidden");
  try {
    await api("/api/login", { email: $("#email").value, password: $("#password").value });
    location.href = "/";
  } catch (ex) {
    status(err, ex.message, false);
  }
});

$("#show-forgot").addEventListener("click", () => {
  $("#forgot-email").value = $("#email").value;
  show("#forgot-form");
});
$("#back-to-login").addEventListener("click", () => show("#login-form"));

$("#forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#forgot-result");
  try {
    const r = await api("/api/password/forgot", { email: $("#forgot-email").value });
    status(out, r.message, r.mail);
  } catch (ex) {
    status(out, ex.message, false);
  }
});

$("#setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#setup-error");
  err.classList.add("hidden");
  try {
    await api("/api/setup", { setupPassword: $("#setup-password").value, email: $("#setup-email").value, password: $("#setup-new").value });
    location.href = "/admin.html";
  } catch (ex) {
    status(err, ex.message, false);
  }
});

(async () => {
  try {
    const s = await api("/api/auth/status");
    show(s.setupNeeded ? "#setup-form" : "#login-form");
  } catch {
    show("#login-form");
  }
})();
