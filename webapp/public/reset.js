const { $, api, status } = window.Brew;
const token = new URLSearchParams(location.search).get("token") || "";

(async () => {
  try {
    await api(`/api/password/reset/${encodeURIComponent(token || "none")}`);
    $("#reset-form").classList.remove("hidden");
    $("#password").focus();
  } catch (ex) {
    status($("#reset-problem"), ex.message, false);
  }
})();

$("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reset-error");
  err.classList.add("hidden");
  if ($("#password").value !== $("#password2").value) return status(err, "The two passwords don't match.", false);
  try {
    await api("/api/password/reset", { token, password: $("#password").value });
    location.href = "/";
  } catch (ex) {
    status(err, ex.message, false);
  }
});
