const form = document.querySelector("#waitlist");
const button = form.querySelector('button[type="submit"]');
const status = form.querySelector(".waitlist-status");

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (button.disabled) return;
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  status.textContent = "Joining the waitlist…";
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error("Waitlist unavailable");
    status.textContent = "You’re on the waitlist.";
    form.reset();
  } catch {
    status.textContent = "Couldn’t join the waitlist. Try again in a moment.";
  } finally {
    button.disabled = false;
  }
});
