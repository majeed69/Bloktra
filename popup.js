const $ = id => document.getElementById(id);
const fmt = n => (n || 0).toLocaleString();

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || "Bloktra didn’t respond.");
  return res.result;
}

let tab = null;
let state = null;
let busy = false;

function showError(e) {
  $("error").hidden = false;
  $("error").textContent = e.message || String(e);
}

function render(d) {
  state = d;
  const siteOn = d.enabled && !d.siteAllowed;

  document.body.classList.toggle("off", !siteOn);
  document.body.classList.toggle("paused-all", !d.enabled);
  $("pausedBanner").hidden = d.enabled;

  $("globalPower").title = d.enabled ? "Pause Bloktra everywhere" : "Resume Bloktra";
  $("globalPower").setAttribute("aria-label", $("globalPower").title);

  const supported = d.supported;
  $("siteCard").hidden = !supported;
  $("countCard").hidden = !supported;
  $("domainsCard").hidden = !supported;
  $("unsupported").hidden = supported;
  $("pick").disabled = !supported || !siteOn;

  if (supported) {
    $("host").textContent = d.site;
    $("host").title = d.host;
    $("stateText").textContent = !d.enabled
      ? "Paused everywhere"
      : d.siteAllowed ? "Paused on this site" : "Protected";
    $("sitePower").setAttribute("aria-checked", String(siteOn));
    $("sitePower").disabled = !d.enabled;
    $("sitePower").title = d.siteAllowed ? "Turn protection back on for this site" : "Pause protection on this site";

    const p = d.page;
    $("pageBlocked").textContent = fmt(p.blocked);
    $("pageAds").textContent = fmt(p.ads);
    $("pageTrackers").textContent = fmt(p.trackers);
    $("pageHidden").textContent = fmt(p.hidden);
    const total = p.ads + p.trackers;
    $("segAds").style.width = total ? `${(p.ads / total) * 100}%` : "0";
    $("segTrackers").style.width = total ? `${(p.trackers / total) * 100}%` : "0";

    renderDomains(p.domains);
  }

  $("totalBlocked").textContent = fmt(d.totals.blocked);
  const today = d.totals.today;
  $("today").textContent = today ? `${fmt(today.ads + today.trackers)} today` : "";
}

function renderDomains(domains) {
  const entries = Object.entries(domains || {}).sort((a, b) => b[1].n - a[1].n);
  $("domainCount").textContent = entries.length;
  const list = $("domainList");
  const key = JSON.stringify(entries);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.textContent = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing blocked yet";
    list.append(li);
    return;
  }
  for (const [host, info] of entries) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = `dot ${info.k}`;
    dot.title = info.k === "trackers" ? "Tracker" : "Ad";
    const name = document.createElement("span");
    name.className = "d";
    name.textContent = host;
    name.title = host;
    const n = document.createElement("span");
    n.className = "n num";
    n.textContent = fmt(info.n);
    li.append(dot, name, n);
    list.append(li);
  }
}

async function refresh() {
  try {
    render(await send("popup", { tabId: tab.id }));
  } catch (e) {
    showError(e);
  }
}

$("sitePower").addEventListener("click", async () => {
  if (busy || !state) return;
  busy = true;
  try {
    await send("site:toggle", { host: state.host, allowed: !state.siteAllowed });
    await refresh();
    $("reloadBanner").hidden = false;
  } catch (e) {
    showError(e);
  } finally {
    busy = false;
  }
});

async function setGlobal(enabled) {
  try {
    await send("settings:set", { key: "enabled", value: enabled });
    await refresh();
    if (state.supported) $("reloadBanner").hidden = false;
  } catch (e) {
    showError(e);
  }
}

$("globalPower").addEventListener("click", () => setGlobal(!state?.enabled));
$("resumeAll").addEventListener("click", () => setGlobal(true));

$("reload").addEventListener("click", () => {
  chrome.tabs.reload(tab.id);
  window.close();
});

$("pick").addEventListener("click", async () => {
  try {
    await send("picker:start", { tabId: tab.id });
    window.close();
  } catch (e) {
    showError(e);
  }
});

$("openDashboard").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$("filters").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html#filters") });
  window.close();
});

(async () => {
  // ?tabId= lets you open the popup in a normal tab for debugging.
  const forced = Number(new URLSearchParams(location.search).get("tabId"));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await refresh();
  setInterval(refresh, 1000); // live counts while the popup is open
})();
