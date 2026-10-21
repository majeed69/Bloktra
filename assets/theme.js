// Apply the saved theme before first paint ("auto" follows the system).
try {
  chrome.storage.local.get("settings").then(({ settings }) => {
    const theme = settings?.theme;
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  });
} catch { /* not in extension context */ }
