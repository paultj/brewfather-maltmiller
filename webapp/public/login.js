document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("login-error");
  err.classList.add("hidden");
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("password").value }),
  });
  if (res.ok) {
    location.href = "/";
  } else {
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || "Sign-in failed.";
    err.classList.remove("hidden");
  }
});
