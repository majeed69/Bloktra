import { GROUPS } from "../lib/lists.js";

const $ = id => document.getElementById(id);
const fmt = n => (n || 0).toLocaleString();
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null));
  return node;
};

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || "Bloktra didn’t respond.");
  return res.result;
}

let data = null;
let rangeDays = 30;

// ─────────────────────────── toast ───────────────────────────

let toastTimer;
function toast(text, error = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("err", error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const run = fn => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    toast(e.message, true);
  }
};

// ─────────────────────────── routing ───────────────────────────

function route() {
  const page = (location.hash || "#overview").slice(1);
  const valid = ["overview", "lists", "filters", "allowlist", "settings"].includes(page) ? page : "overview";
  document.querySelectorAll(".page").forEach(p => (p.hidden = p.id !== `page-${valid}`));
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.dataset.page === valid));
  if (valid === "overview" && data) renderChart();
}

addEventListener("hashchange", route);

// ─────────────────────────── overview ───────────────────────────

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderOverview() {
  const s = data.stats;
  $("since").textContent = `Since ${new Date(s.since).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
  $("statBlocked").textContent = fmt(s.blocked);
  $("statAds").textContent = fmt(s.ads);
  $("statTrackers").textContent = fmt(s.trackers);
  $("statHidden").textContent = fmt(s.hidden);
  const today = s.days[dayKey(new Date())];
  $("statToday").textContent = today ? `${fmt(today.ads + today.trackers)} today` : "Nothing yet today";
  const pct = n => (s.blocked ? `${Math.round((n / s.blocked) * 100)}% of blocked` : "");
  $("statAdsPct").textContent = pct(s.ads);
  $("statTrackersPct").textContent = pct(s.trackers);

  const list = $("topDomains");
  list.textContent = "";
  const top = Object.entries(s.domains).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  if (!top.length) {
    list.append(el("li", { className: "empty-state" }, "Browse a little and blocked domains will show up here."));
  }
  const max = top[0]?.[1].n || 1;
  for (const [host, info] of top) {
    const fill = el("div", { className: `fill ${info.k}` });
    fill.style.width = `${Math.max(3, (info.n / max) * 100)}%`;
    list.append(el("li", {},
      el("div", { className: "name" }, el("span", { className: `dot ${info.k}`, title: info.k === "trackers" ? "Tracker" : "Ad" }), el("span", { title: host }, host)),
      el("div", { className: "track" }, fill),
      el("div", { className: "count num" }, fmt(info.n))
    ));
  }
  renderChart();
}

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

function renderChart() {
  const box = $("chart");
  const width = box.clientWidth;
  if (!width) return;
  const height = 220;
  const pad = { top: 8, right: 4, bottom: 24, left: 40 };
  const days = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const v = data.stats.days[dayKey(d)] || { ads: 0, trackers: 0, hidden: 0 };
    days.push({ date: d, ...v });
  }
  const peak = Math.max(...days.map(d => d.ads + d.trackers));
  const max = niceMax(peak);
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const step = innerW / days.length;
  const barW = Math.max(4, Math.min(28, step * 0.62));
  const y = v => pad.top + innerH - (v / max) * innerH;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Blocked requests per day, last ${rangeDays} days`);
  const mk = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };

  const grid = mk("g", { class: "grid" });
  const axis = mk("g", { class: "axis" });
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = Math.round(y(v)) + 0.5;
    mk("line", { x1: pad.left, x2: width - pad.right, y1: yy, y2: yy }, grid);
    const t = mk("text", { x: pad.left - 8, y: yy + 4, "text-anchor": "end" }, axis);
    t.textContent = v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : v;
  }

  const labelEvery = rangeDays <= 7 ? 1 : 5;
  const roundTop = (x, top, w, h, r) => {
    r = Math.min(r, h, w / 2);
    return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  };

  days.forEach((d, i) => {
    const cx = pad.left + step * i + step / 2;
    const x = cx - barW / 2;
    const col = mk("g", { class: "col" });
    mk("rect", { class: "hit", x: pad.left + step * i, y: pad.top, width: step, height: innerH, rx: 6 }, col);
    const base = y(0);
    const adsH = base - y(d.ads);
    const trH = base - y(d.trackers);
    const gap = adsH > 0 && trH > 0 ? 2 : 0;
    if (adsH > 0) {
      const top = base - adsH;
      if (trH > 0) mk("rect", { class: "ads", x, y: top, width: barW, height: adsH }, col);
      else mk("path", { class: "ads", d: roundTop(x, top, barW, adsH, 4) }, col);
    }
    if (trH > 0) {
      const top = base - adsH - gap - trH;
      mk("path", { class: "trackers", d: roundTop(x, top, barW, trH, 4) }, col);
    }
    if (i % labelEvery === (rangeDays - 1) % labelEvery) {
      const t = mk("text", { x: cx, y: height - 6, "text-anchor": "middle" }, axis);
      t.textContent = d.date.toLocaleDateString(undefined, rangeDays <= 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
    }
    col.addEventListener("mouseenter", () => showTip(col, d, cx));
    col.addEventListener("mouseleave", hideTip);
  });

  if (!peak) {
    const t = mk("text", { class: "empty", x: pad.left + innerW / 2, y: pad.top + innerH / 2, "text-anchor": "middle" });
    t.textContent = "No blocked requests in this period yet";
  }

  box.replaceChildren(svg);
}

function showTip(col, d, cx) {
  col.classList.add("hover");
  const tip = $("tooltip");
  tip.replaceChildren(
    el("div", { className: "t-date" }, d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })),
    el("div", { className: "t-row" }, el("span", { className: "dot ads" }), "Ads", el("b", { className: "num" }, fmt(d.ads))),
    el("div", { className: "t-row" }, el("span", { className: "dot trackers" }), "Trackers", el("b", { className: "num" }, fmt(d.trackers))),
    el("div", { className: "t-row" }, el("span", { className: "dot hidden" }), "Hidden", el("b", { className: "num" }, fmt(d.hidden)))
  );
  tip.hidden = false;
  const card = tip.parentElement.getBoundingClientRect();
  const chart = $("chart").getBoundingClientRect();
  const left = chart.left - card.left + cx;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(card.width - w - 12, Math.max(12, left - w / 2))}px`;
  tip.style.top = `${chart.top - card.top - 6}px`;
}

function hideTip() {
  document.querySelectorAll(".col.hover").forEach(c => c.classList.remove("hover"));
  $("tooltip").hidden = true;
}

$("range").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  rangeDays = Number(b.dataset.days);
  $("range").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  renderChart();
});

addEventListener("resize", () => data && renderChart());

// ─────────────────────────── lists ───────────────────────────

const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

function switchEl(checked, onChange, label) {
  const input = el("input", { type: "checkbox", checked });
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked, input));
  return el("span", { className: "switch" }, input, el("span"));
}

function renderLists() {
  const wrap = $("listGroups");
  wrap.textContent = "";
  let activeFilters = 0;

  for (const [group, title] of Object.entries(GROUPS)) {
    const lists = data.lists.filter(l => l.group === group);
    if (!lists.length) continue;
    wrap.append(el("div", { className: "group-title" }, title));
    const card = el("div", { className: "card list-card" });
    for (const l of lists) {
      if (l.on) activeFilters += l.meta.filters || 0;
      const name = el("div", { className: "name" }, l.name);
      if (l.homepage) {
        const a = el("a", { href: l.homepage, target: "_blank", rel: "noopener", title: "Homepage", innerHTML: LINK_ICON });
        a.addEventListener("click", e => e.stopPropagation());
        name.append(a);
      }
      const bits = [];
      if (l.builtin) bits.push("Built in");
      else {
        bits.push(`${fmt(l.meta.filters)} network filters`);
        if (l.meta.cosmetic) bits.push(`${fmt(l.meta.cosmetic)} cosmetic`);
        if (l.meta.version) bits.push(`updated ${l.meta.version.replace(/\s*\(.*\)$/, "").replace(/\s\d\d:\d\d.*$/, "")}`);
      }
      const sw = switchEl(l.on, run(async (on, input) => {
        input.disabled = true;
        try {
          await send("list:toggle", { id: l.id, enabled: on });
          l.on = on;
          renderListsPill();
          toast(`${l.name} ${on ? "enabled" : "disabled"}`);
        } catch (e) {
          input.checked = !on;
          throw e;
        } finally {
          input.disabled = false;
        }
      }), l.name);
      const row = el("label", { className: "list-row" },
        el("div", { className: "info" }, name, el("div", { className: "desc" }, l.description), el("div", { className: "meta num" }, bits.filter(Boolean).join(" · "))),
        sw);
      card.append(row);
    }
    wrap.append(card);
  }
  renderListsPill();
  renderSubs();
  $("builtNote").textContent = `Bundled lists compiled ${new Date(data.built).toLocaleDateString(undefined, { dateStyle: "medium" })}. They refresh with each Bloktra update. Run “npm run build” to recompile them yourself.`;
}

function renderListsPill() {
  let n = 0;
  for (const l of data.lists) if (l.on && !l.builtin) n += l.meta.filters || 0;
  for (const s of data.subscriptions) if (s.enabled) n += s.network || 0;
  n += data.userStats.network || 0;
  $("activeRules").textContent = `${fmt(n)} network filters active`;
}

function renderSubs() {
  const list = $("subList");
  list.textContent = "";
  if (!data.subscriptions.length) {
    list.append(el("li", { className: "empty" }, "No custom lists yet."));
    return;
  }
  for (const s of data.subscriptions) {
    const sub = s.error
      ? el("div", { className: "sub err" }, `Couldn’t update: ${s.error}`)
      : el("div", { className: "sub num" }, `${fmt(s.network)} network · ${fmt(s.cosmetic)} cosmetic · ${s.updated ? `updated ${new Date(s.updated).toLocaleString()}` : "never updated"}`);
    const remove = el("button", { className: "btn ghost danger", textContent: "Remove" });
    remove.addEventListener("click", run(async () => {
      data.subscriptions = await send("sub:remove", { id: s.id });
      renderSubs();
      renderListsPill();
      toast("List removed");
    }));
    list.append(el("li", {},
      el("div", { className: "info" }, el("div", { className: "title", title: s.url }, s.title || s.url), sub),
      remove,
      switchEl(s.enabled, run(async on => {
        data.subscriptions = await send("sub:toggle", { id: s.id, enabled: on });
        renderListsPill();
      }), s.title || s.url)
    ));
  }
}

$("subForm").addEventListener("submit", run(async e => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const sub = await send("sub:add", { url: $("subUrl").value });
    data.subscriptions.push(sub);
    $("subUrl").value = "";
    renderSubs();
    renderListsPill();
    toast(sub.error ? `Added, but the download failed: ${sub.error}` : `Subscribed to ${sub.title}`, !!sub.error);
  } finally {
    btn.disabled = false;
    btn.textContent = "Subscribe";
  }
}));

$("updateSubs").addEventListener("click", run(async () => {
  const btn = $("updateSubs");
  btn.disabled = true;
  try {
    data.subscriptions = await send("sub:update");
    renderSubs();
    renderListsPill();
    toast(data.subscriptions.length ? "Custom lists updated" : "No custom lists to update");
  } finally {
    btn.disabled = false;
  }
}));

// ─────────────────────────── my filters ───────────────────────────

const editor = $("userFilters");
let savedText = "";

function renderFilterStats(stats) {
  $("filterStats").textContent = `${fmt(stats.network)} network · ${fmt(stats.cosmetic)} cosmetic filters`;
  const box = $("unsupported");
  const bad = stats.unsupported || [];
  box.hidden = !bad.length;
  if (bad.length) {
    box.replaceChildren(
      `${bad.length === 1 ? "1 line isn’t" : `${bad.length} lines aren’t`} supported and will be ignored:`,
      el("code", {}, bad.slice(0, 8).join("\n") + (bad.length > 8 ? "\n…" : ""))
    );
  }
}

function renderFilters() {
  editor.value = data.userFilters;
  savedText = data.userFilters;
  $("saveFilters").disabled = true;
  renderFilterStats(data.userStats);
}

editor.addEventListener("input", () => {
  $("saveFilters").disabled = editor.value === savedText;
});

const saveFilters = run(async () => {
  if (editor.value === savedText) return;
  $("saveFilters").disabled = true;
  const stats = await send("filters:save", { text: editor.value });
  savedText = editor.value;
  data.userStats = stats;
  renderFilterStats(stats);
  renderListsPill();
  toast(stats.warnings?.length ? stats.warnings[0] : "Filters saved", !!stats.warnings?.length);
});

$("saveFilters").addEventListener("click", saveFilters);
addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && location.hash === "#filters") {
    e.preventDefault();
    saveFilters();
  }
});
addEventListener("beforeunload", e => {
  if (editor.value !== savedText) e.preventDefault();
});

// ─────────────────────────── allowlist ───────────────────────────

function renderAllowlist() {
  const list = $("allowList");
  list.textContent = "";
  if (!data.allowlist.length) {
    list.append(el("li", { className: "empty" }, "No sites yet. Pause Bloktra on a site from the popup, or add one here."));
    return;
  }
  for (const host of data.allowlist) {
    const remove = el("button", { className: "btn ghost danger", textContent: "Remove" });
    remove.addEventListener("click", run(async () => {
      data.allowlist = await send("allowlist:remove", { host });
      renderAllowlist();
      toast(`Bloktra is active on ${host} again`);
    }));
    list.append(el("li", {}, el("span", { className: "host" }, host), remove));
  }
}

$("allowForm").addEventListener("submit", run(async e => {
  e.preventDefault();
  data.allowlist = await send("allowlist:add", { host: $("allowHost").value });
  $("allowHost").value = "";
  renderAllowlist();
  toast("Site added");
}));

// ─────────────────────────── settings ───────────────────────────

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $("theme").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.theme === theme));
}

function renderSettings() {
  document.querySelectorAll("[data-setting]").forEach(input => {
    input.checked = !!data.settings[input.dataset.setting];
  });
  applyTheme(data.settings.theme);
  const status = $("sideStatus");
  status.classList.toggle("off", !data.settings.enabled);
  status.lastElementChild.textContent = data.settings.enabled ? "Protection on" : "Protection paused";
}

document.querySelectorAll("[data-setting]").forEach(input => {
  input.addEventListener("change", run(async () => {
    data.settings = await send("settings:set", { key: input.dataset.setting, value: input.checked });
    renderSettings();
  }));
});

$("theme").addEventListener("click", run(async e => {
  const b = e.target.closest("button");
  if (!b) return;
  data.settings = await send("settings:set", { key: "theme", value: b.dataset.theme });
  applyTheme(b.dataset.theme);
}));

$("exportBtn").addEventListener("click", run(async () => {
  const backup = await send("backup:export");
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `bloktra-backup-${dayKey(new Date())}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}));

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", run(async () => {
  const file = $("importFile").files[0];
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn’t valid JSON.");
  } finally {
    $("importFile").value = "";
  }
  await send("backup:import", { data: parsed });
  await load();
  toast("Backup restored");
}));

$("resetStats").addEventListener("click", run(async () => {
  if (!confirm("Reset all statistics? This can’t be undone.")) return;
  data.stats = await send("stats:reset");
  renderOverview();
  toast("Statistics reset");
}));

// ─────────────────────────── boot ───────────────────────────

async function load() {
  data = await send("dashboard");
  $("version").textContent = `Version ${data.version}`;
  renderOverview();
  renderLists();
  renderFilters();
  renderAllowlist();
  renderSettings();
  route();
}

load().catch(e => toast(e.message, true));

// Pick up changes made elsewhere (popup, element picker) when you come back.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !data) return;
  try {
    const fresh = await send("dashboard");
    const dirty = editor.value !== savedText;
    data = { ...fresh, userFilters: dirty ? data.userFilters : fresh.userFilters };
    renderOverview();
    renderLists();
    renderAllowlist();
    renderSettings();
    if (!dirty) renderFilters();
  } catch { /* ignore */ }
});

// Keep the overview live without disturbing anything being edited.
setInterval(async () => {
  if (document.hidden || location.hash && location.hash !== "#overview") return;
  try {
    const fresh = await send("dashboard");
    data.stats = fresh.stats;
    renderOverview();
  } catch { /* ignore */ }
}, 5000);
