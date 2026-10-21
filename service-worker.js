// Bloktra: background service worker.
//
// Responsibilities
//   • network blocking: toggles the bundled static rulesets and compiles your
//     own filters, allowlist and custom subscriptions into dynamic rules
//   • counting: watches requests that were blocked (ERR_BLOCKED_BY_CLIENT),
//     splits them into ads / trackers, keeps per-tab and all-time stats
//   • cosmetic filtering: answers the content script with the selectors that
//     apply to each frame and injects them as a user-origin stylesheet
//   • element picker, context menu, keyboard shortcut, list updates

import { parseFilterList, mergeCosmetic, countCosmetic, PRIORITY } from "./lib/filter-parser.js";
import { LISTS } from "./lib/lists.js";

const DNR = chrome.declarativeNetRequest;
const UPDATE_ALARM = "bloktra-update-subscriptions";
const MAX_DYNAMIC = DNR.MAX_NUMBER_OF_DYNAMIC_RULES ?? 30000;
const MAX_REGEX = DNR.MAX_NUMBER_OF_REGEX_RULES ?? 1000;
const MAX_UNSAFE = DNR.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES ?? 5000;

const DEFAULT_SETTINGS = {
  enabled: true,
  cosmetic: true,
  badge: true,
  contextMenu: true,
  theme: "auto"
};

const DEFAULT_USER_FILTERS = `! Your own filters. One per line. Lines starting with ! are comments.
!
! Block a domain everywhere:     ||ads.example.com^
! Block a path on one site:      /banner/*$domain=example.com
! Never block something:         @@||cdn.example.com^
! Hide an element on a site:     example.com##.sponsored-box
! Hide an element everywhere:    ##.cookie-popup
! Hide by text:                  example.com##div.post:has-text(Promoted)
`;

// ─────────────────────────────── storage ───────────────────────────────

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function setSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

async function getListStates() {
  const { lists = {} } = await chrome.storage.local.get("lists");
  const out = {};
  for (const l of LISTS) out[l.id] = lists[l.id] ?? l.enabled;
  return out;
}

async function getAllowlist() {
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  return allowlist;
}

async function getSubscriptions() {
  const { subscriptions = [] } = await chrome.storage.local.get("subscriptions");
  return subscriptions;
}

// ─────────────────────────────── helpers ───────────────────────────────

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

const siteKey = host => host.replace(/^www\./, "");

function suffixes(host) {
  const out = [];
  let h = host;
  while (h) {
    out.push(h);
    const i = h.indexOf(".");
    if (i === -1) break;
    h = h.slice(i + 1);
  }
  return out;
}

// "news.example.co.uk" → ["news.example.co.uk", …, "example.*", "news.example.*"]
function hostCandidates(host) {
  const out = suffixes(host);
  const labels = host.split(".");
  for (let j = labels.length - 1; j >= 1; j--) {
    if (labels.length - j > 2) break;
    for (let k = 0; k < j; k++) out.push(`${labels.slice(k, j).join(".")}.*`);
  }
  return out;
}

function matchesHostList(host, list) {
  if (!host || !list.length) return false;
  const set = list instanceof Set ? list : new Set(list);
  return hostCandidates(host).some(h => set.has(h));
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ───────────────────────────── network rules ─────────────────────────────

async function syncStaticRulesets() {
  const settings = await getSettings();
  const states = await getListStates();
  const enable = [];
  const disable = [];
  for (const l of LISTS) {
    (settings.enabled && states[l.id] ? enable : disable).push(l.id);
  }
  await DNR.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
}

async function compileUserFilters(text) {
  const parsed = parseFilterList(text, { allowRegex: true, bareDomains: true, priorityOffset: PRIORITY.userOffset });

  // Validate regex rules with Chrome's own RE2 engine.
  const rules = [];
  for (const r of parsed.rules) {
    if (r.condition.regexFilter) {
      const res = await DNR.isRegexSupported({
        regex: r.condition.regexFilter,
        isCaseSensitive: !!r.condition.isUrlFilterCaseSensitive
      });
      if (!res.isSupported) continue;
    }
    rules.push(r);
  }

  // Find lines we couldn't understand so the dashboard can point at them.
  const unsupported = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("!")) continue;
    if (parseFilterList(line, { allowRegex: true, bareDomains: true }).stats.skipped) unsupported.push(line);
    if (unsupported.length >= 50) break;
  }

  return {
    rules,
    cosmetic: parsed.cosmetic,
    stats: {
      network: rules.reduce((n, r) => n + (r.condition.requestDomains?.length || 1), 0),
      cosmetic: countCosmetic(parsed.cosmetic),
      unsupported
    }
  };
}

async function syncDynamicRules() {
  const settings = await getSettings();
  const existing = await DNR.getDynamicRules();
  const groups = [];

  if (settings.enabled) {
    const allowlist = await getAllowlist();
    if (allowlist.length) {
      groups.push({
        name: "allowlist",
        rules: [{
          priority: PRIORITY.siteAllowlist,
          action: { type: "allowAllRequests" },
          condition: { requestDomains: allowlist, resourceTypes: ["main_frame", "sub_frame"] }
        }]
      });
    }

    const { userCompiled } = await chrome.storage.local.get("userCompiled");
    if (userCompiled?.rules?.length) groups.push({ name: "My filters", rules: userCompiled.rules });

    for (const sub of await getSubscriptions()) {
      if (!sub.enabled) continue;
      const key = `sub:${sub.id}`;
      const data = (await chrome.storage.local.get(key))[key];
      if (data?.rules?.length) groups.push({ name: sub.title || sub.url, rules: data.rules });
    }
  }

  // Respect Chrome's dynamic rule limits.
  const addRules = [];
  const warnings = [];
  let regex = 0;
  let unsafe = 0;
  for (const g of groups) {
    let dropped = 0;
    for (const r of g.rules) {
      if (addRules.length >= MAX_DYNAMIC) { dropped++; continue; }
      if (r.condition.regexFilter && ++regex > MAX_REGEX) { dropped++; continue; }
      if (r.action.type === "redirect" && ++unsafe > MAX_UNSAFE) { dropped++; continue; }
      addRules.push({ ...r, id: addRules.length + 1 });
    }
    if (dropped) warnings.push(`${g.name}: ${dropped} rules skipped (Chrome rule limit).`);
  }

  try {
    await DNR.updateDynamicRules({ removeRuleIds: existing.map(r => r.id), addRules });
  } catch (error) {
    // One bad rule rejects the whole batch, so fall back to the allowlist only.
    warnings.push(`Some custom rules were rejected by Chrome: ${error.message}`);
    const safe = groups.find(g => g.name === "allowlist")?.rules.map((r, i) => ({ ...r, id: i + 1 })) || [];
    await DNR.updateDynamicRules({ removeRuleIds: (await DNR.getDynamicRules()).map(r => r.id), addRules: safe });
  }

  await chrome.storage.local.set({ ruleWarnings: warnings });
  return { installed: addRules.length, warnings };
}

async function syncAll() {
  await syncStaticRulesets();
  await syncDynamicRules();
  invalidateCosmetic();
  await refreshActionIcons();
}

// ──────────────────────────── subscriptions ────────────────────────────

async function updateSubscription(sub) {
  try {
    const res = await fetch(sub.url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error("Empty list");
    const parsed = parseFilterList(text, { allowRegex: false });
    const title = text.match(/^!\s*Title:\s*(.+)$/im)?.[1]?.trim();
    await chrome.storage.local.set({ [`sub:${sub.id}`]: { rules: parsed.rules, cosmetic: parsed.cosmetic } });
    Object.assign(sub, {
      title: title || sub.title || new URL(sub.url).hostname,
      updated: Date.now(),
      error: "",
      network: parsed.rules.reduce((n, r) => n + (r.condition.requestDomains?.length || 1), 0),
      cosmetic: countCosmetic(parsed.cosmetic)
    });
  } catch (e) {
    sub.error = e.message;
  }
  return sub;
}

async function updateAllSubscriptions() {
  const subs = await getSubscriptions();
  for (const sub of subs) if (sub.enabled) await updateSubscription(sub);
  await chrome.storage.local.set({ subscriptions: subs });
  await syncDynamicRules();
  invalidateCosmetic();
  return subs;
}

// ─────────────────────────────── cosmetic ───────────────────────────────

let cosmeticIndex = null;

function invalidateCosmetic() {
  cosmeticIndex = null;
}

function getCosmeticIndex() {
  if (!cosmeticIndex) cosmeticIndex = buildCosmeticIndex().catch(e => {
    cosmeticIndex = null;
    throw e;
  });
  return cosmeticIndex;
}

async function buildCosmeticIndex() {
  const states = await getListStates();
  const parts = [];
  await Promise.all(LISTS.filter(l => states[l.id] && !l.builtin).map(async l => {
    try {
      const res = await fetch(chrome.runtime.getURL(`cosmetic/${l.id}.json`));
      if (res.ok) parts.push(await res.json());
    } catch { /* list has no cosmetic data */ }
  }));

  const { userCompiled } = await chrome.storage.local.get("userCompiled");
  if (userCompiled?.cosmetic) parts.push(userCompiled.cosmetic);

  for (const sub of await getSubscriptions()) {
    if (!sub.enabled) continue;
    const key = `sub:${sub.id}`;
    const data = (await chrome.storage.local.get(key))[key];
    if (data?.cosmetic) parts.push(data.cosmetic);
  }

  const c = parts.length === 1 ? parts[0] : mergeCosmetic(parts);
  const genericExceptions = new Set(c.genericExceptions);
  return {
    generic: new Map(Object.entries(c.generic)),
    high: c.high.filter(s => !genericExceptions.has(s)),
    specific: c.specific,
    exceptions: c.exceptions,
    procedural: c.procedural,
    genericExceptions,
    genericHide: new Set(c.genericHide),
    elemHide: new Set(c.elemHide),
    specificHide: new Set(c.specificHide),
    hostCache: new Map()
  };
}

function hostCosmetic(index, host) {
  let entry = index.hostCache.get(host);
  if (entry) return entry;

  const candidates = hostCandidates(host);
  const exceptions = new Set(index.genericExceptions);
  for (const h of candidates) for (const s of index.exceptions[h] || []) exceptions.add(s);

  const specificHide = candidates.some(h => index.specificHide.has(h));
  const specific = [];
  const procedural = [];
  if (!specificHide) {
    for (const h of candidates) {
      for (const s of index.specific[h] || []) if (!exceptions.has(s)) specific.push(s);
      for (const s of index.procedural[h] || []) if (!exceptions.has(s)) procedural.push(s);
    }
  }

  const genericHide = candidates.some(h => index.genericHide.has(h));
  const high = genericHide ? [] : index.high.filter(s => !exceptions.has(s));

  entry = {
    disabled: candidates.some(h => index.elemHide.has(h)),
    generic: !genericHide,
    exceptions,
    selectors: [...new Set([...specific, ...high])],
    procedural: [...new Set(procedural)]
  };
  if (index.hostCache.size > 200) index.hostCache.clear();
  index.hostCache.set(host, entry);
  return entry;
}

function buildCss(selectors) {
  // :is() takes a forgiving selector list, so one unsupported selector won't
  // invalidate the rest of the group.
  const out = [];
  for (let i = 0; i < selectors.length; i += 400) {
    out.push(`:is(${selectors.slice(i, i + 400).join(",\n")}){display:none!important}`);
  }
  return out.join("\n");
}

async function injectCss(sender, selectors) {
  if (!selectors.length || !sender.tab) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      css: buildCss(selectors),
      origin: "USER"
    });
  } catch { /* frame went away */ }
}

async function isSiteActive(url, tabUrl) {
  const settings = await getSettings();
  if (!settings.enabled) return false;
  const allowlist = await getAllowlist();
  const top = hostOf(tabUrl || url);
  return !(matchesHostList(top, allowlist) || matchesHostList(hostOf(url), allowlist));
}

async function cosmeticInit(msg, sender) {
  const settings = await getSettings();
  const host = hostOf(msg.url);
  if (!host || !settings.enabled || !settings.cosmetic) return { active: false };
  if (!(await isSiteActive(msg.url, sender.tab?.url))) return { active: false };

  const index = await getCosmeticIndex();
  const hc = hostCosmetic(index, host);
  if (hc.disabled) return { active: false };

  await injectCss(sender, hc.selectors);
  return { active: true, generic: hc.generic, selectors: hc.selectors, procedural: hc.procedural };
}

async function cosmeticTokens(msg, sender) {
  const host = hostOf(msg.url);
  if (!host) return { selectors: [] };
  const index = await getCosmeticIndex();
  const hc = hostCosmetic(index, host);
  if (hc.disabled || !hc.generic) return { selectors: [] };

  const selectors = [];
  for (const token of msg.tokens) {
    const list = index.generic.get(token);
    if (!list) continue;
    for (const s of list) if (!hc.exceptions.has(s)) selectors.push(s);
  }
  await injectCss(sender, selectors);
  return { selectors };
}

// ──────────────────────────────── stats ────────────────────────────────

const tabs = new Map(); // tabId → per-page stats
let totals = null;
let trackerSet = null;
let restored = null;

function restoreState() {
  if (!restored) {
    restored = (async () => {
      const { tabStats = {} } = await chrome.storage.session.get("tabStats");
      for (const [id, t] of Object.entries(tabStats)) tabs.set(Number(id), t);
      const { stats } = await chrome.storage.local.get("stats");
      totals = stats || freshTotals();
    })();
  }
  return restored;
}

function freshTotals() {
  return { blocked: 0, ads: 0, trackers: 0, hidden: 0, since: Date.now(), days: {}, domains: {} };
}

async function loadTrackers() {
  if (!trackerSet) {
    trackerSet = (async () => {
      const res = await fetch(chrome.runtime.getURL("data/trackers.txt"));
      return new Set((await res.text()).split("\n"));
    })();
  }
  return trackerSet;
}

const TRACKER_HINT = /analytic|track|pixel|beacon|collect|telemetry|metrics|fingerprint|gtag|tagmanager|insight|\/log(?:ging)?[/?.]|\/event[s]?[/?]/i;

async function classify(host, url, type) {
  const set = await loadTrackers();
  if (type === "ping") return "trackers";
  for (const h of suffixes(host)) if (set.has(h)) return "trackers";
  try {
    if (TRACKER_HINT.test(new URL(url).pathname)) return "trackers";
  } catch { /* ignore */ }
  return "ads";
}

function tabEntry(tabId, url = "") {
  let t = tabs.get(tabId);
  if (!t) {
    t = { host: hostOf(url), blocked: 0, ads: 0, trackers: 0, hidden: 0, frames: {}, domains: {} };
    tabs.set(tabId, t);
  }
  return t;
}

const persistTabs = debounce(() => {
  chrome.storage.session.set({ tabStats: Object.fromEntries(tabs) }).catch(() => {});
}, 600);

const persistTotals = debounce(() => {
  if (!totals) return;
  // Keep the last 90 days and the 400 busiest domains.
  const days = Object.keys(totals.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 90))) delete totals.days[d];
  const domains = Object.entries(totals.domains);
  if (domains.length > 800) {
    totals.domains = Object.fromEntries(domains.sort((a, b) => b[1].n - a[1].n).slice(0, 400));
  }
  chrome.storage.local.set({ stats: totals }).catch(() => {});
}, 2000);

const badgeTimers = new Map();
function scheduleBadge(tabId) {
  if (badgeTimers.has(tabId)) return;
  badgeTimers.set(tabId, setTimeout(async () => {
    badgeTimers.delete(tabId);
    await updateBadge(tabId);
  }, 250));
}

function formatBadge(n) {
  if (!n) return "";
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.floor(n / 1000)}k`;
}

async function updateBadge(tabId) {
  const settings = await getSettings();
  const t = tabs.get(tabId);
  try {
    await chrome.action.setBadgeText({ tabId, text: settings.badge && settings.enabled ? formatBadge(t?.blocked || 0) : "" });
  } catch { /* tab closed */ }
}

function bumpDay(field, n = 1) {
  const key = todayKey();
  const day = (totals.days[key] ??= { ads: 0, trackers: 0, hidden: 0 });
  day[field] += n;
}

async function onBlocked(details) {
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT" || details.tabId < 0) return;
  await restoreState();
  const host = hostOf(details.url);
  if (!host) return;
  const kind = await classify(host, details.url, details.type);

  const t = tabEntry(details.tabId, details.type === "main_frame" ? details.url : "");
  t.blocked++;
  t[kind]++;
  const d = (t.domains[host] ??= { n: 0, k: kind });
  d.n++;

  totals.blocked++;
  totals[kind]++;
  bumpDay(kind);
  const td = (totals.domains[host] ??= { n: 0, k: kind });
  td.n++;

  persistTabs();
  persistTotals();
  scheduleBadge(details.tabId);
}

async function onMainFrame(details) {
  if (details.tabId < 0 || details.frameId !== 0) return;
  await restoreState();
  tabs.set(details.tabId, { host: hostOf(details.url), blocked: 0, ads: 0, trackers: 0, hidden: 0, frames: {}, domains: {} });
  persistTabs();
}

async function onHidden(msg, sender) {
  if (!sender.tab) return;
  await restoreState();
  const t = tabEntry(sender.tab.id, sender.tab.url);
  const frameId = String(sender.frameId ?? 0);
  const prev = t.frames[frameId] || 0;
  const delta = Math.max(0, msg.count - prev);
  t.frames[frameId] = msg.count;
  t.hidden = Object.values(t.frames).reduce((a, b) => a + b, 0);
  if (delta) {
    totals.hidden += delta;
    bumpDay("hidden", delta);
    persistTotals();
  }
  persistTabs();
}

chrome.webRequest.onErrorOccurred.addListener(onBlocked, { urls: ["<all_urls>"] });
chrome.webRequest.onBeforeRequest.addListener(onMainFrame, { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] });

chrome.tabs.onRemoved.addListener(tabId => {
  tabs.delete(tabId);
  persistTabs();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" || info.url) {
    applyTabIcon(tabId, tab.url);
    scheduleBadge(tabId);
  }
});

// ───────────────────────────── action icon ─────────────────────────────

const ICON_ON = { 16: "/assets/icons/icon-16.png", 32: "/assets/icons/icon-32.png" };
const ICON_OFF = { 16: "/assets/icons/icon-off-16.png", 32: "/assets/icons/icon-off-32.png" };

async function applyTabIcon(tabId, url) {
  const settings = await getSettings();
  const active = settings.enabled && (!hostOf(url || "") || (await isSiteActive(url)));
  try {
    await chrome.action.setIcon({ tabId, path: active ? ICON_ON : ICON_OFF });
  } catch { /* tab gone */ }
}

async function refreshActionIcons() {
  const settings = await getSettings();
  await chrome.action.setIcon({ path: settings.enabled ? ICON_ON : ICON_OFF });
  await chrome.action.setBadgeBackgroundColor({ color: "#2f6f4f" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  for (const tab of await chrome.tabs.query({})) {
    await applyTabIcon(tab.id, tab.url);
    updateBadge(tab.id);
  }
}

// ──────────────────────────── element picker ────────────────────────────

async function startPicker(tabId, frameId = 0) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["picker.js"]
  });
}

async function addUserFilter(filter) {
  const { userFilters = DEFAULT_USER_FILTERS } = await chrome.storage.local.get("userFilters");
  const lines = userFilters.split("\n");
  if (!lines.includes(filter)) lines.push(filter);
  return saveUserFilters(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

async function saveUserFilters(text) {
  const compiled = await compileUserFilters(text);
  await chrome.storage.local.set({ userFilters: text, userCompiled: compiled });
  const result = await syncDynamicRules();
  invalidateCosmetic();
  return { ...compiled.stats, warnings: result.warnings };
}

function setupContextMenu(enabled) {
  chrome.contextMenus.removeAll(() => {
    if (!enabled) return;
    chrome.contextMenus.create({
      id: "bloktra-pick",
      title: "Hide this element…",
      contexts: ["page", "image", "link", "frame", "video", "audio"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "bloktra-pick" && tab?.id >= 0) startPicker(tab.id, info.frameId || 0).catch(() => {});
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "pick-element") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id >= 0) startPicker(tab.id).catch(() => {});
});

// ─────────────────────────────── messages ───────────────────────────────

async function popupData(tabId) {
  await restoreState();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = hostOf(tab?.url || "");
  const settings = await getSettings();
  const allowlist = await getAllowlist();
  const t = tabs.get(tabId) || { blocked: 0, ads: 0, trackers: 0, hidden: 0, domains: {} };
  return {
    host,
    site: siteKey(host),
    supported: !!host,
    enabled: settings.enabled,
    siteAllowed: matchesHostList(host, allowlist),
    page: { blocked: t.blocked, ads: t.ads, trackers: t.trackers, hidden: t.hidden, domains: t.domains },
    totals: { blocked: totals.blocked, hidden: totals.hidden, today: totals.days[todayKey()] || null }
  };
}

async function dashboardData() {
  await restoreState();
  const meta = await (await fetch(chrome.runtime.getURL("data/lists-meta.json"))).json();
  const states = await getListStates();
  const data = await chrome.storage.local.get(["userFilters", "userCompiled", "ruleWarnings"]);
  return {
    settings: await getSettings(),
    lists: LISTS.map(l => ({ ...l, sources: undefined, on: states[l.id], meta: meta.lists[l.id] || {} })),
    built: meta.built,
    allowlist: await getAllowlist(),
    subscriptions: await getSubscriptions(),
    userFilters: data.userFilters ?? DEFAULT_USER_FILTERS,
    userStats: data.userCompiled?.stats || { network: 0, cosmetic: 0, unsupported: [] },
    warnings: data.ruleWarnings || [],
    stats: totals,
    version: chrome.runtime.getManifest().version
  };
}

async function setAllowed(host, allowed) {
  const site = siteKey(host);
  let allowlist = await getAllowlist();
  if (allowed) {
    if (!allowlist.includes(site)) allowlist.push(site);
  } else {
    // Remove the site and any parent entry that covers it.
    const cands = new Set(suffixes(host).map(siteKey));
    allowlist = allowlist.filter(h => !cands.has(h));
  }
  await chrome.storage.local.set({ allowlist: allowlist.sort() });
  await syncDynamicRules();
  invalidateCosmetic();
  await refreshActionIcons();
  return allowlist;
}

function normaliseHost(input) {
  let s = String(input).trim().toLowerCase();
  if (!s) return "";
  try {
    if (s.includes("/")) s = new URL(s.includes("://") ? s : `https://${s}`).hostname;
  } catch {
    return "";
  }
  return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(s) ? siteKey(s) : "";
}

const handlers = {
  // content script
  "cosmetic:init": cosmeticInit,
  "cosmetic:tokens": cosmeticTokens,
  "cosmetic:hidden": onHidden,
  "picker:create": msg => addUserFilter(msg.filter),

  // popup
  popup: msg => popupData(msg.tabId),
  "site:toggle": msg => setAllowed(msg.host, msg.allowed),
  "picker:start": msg => startPicker(msg.tabId).then(() => ({ ok: true })),

  // dashboard
  dashboard: () => dashboardData(),
  "settings:set": async msg => {
    const settings = await setSettings({ [msg.key]: msg.value });
    if (msg.key === "enabled") await syncAll();
    if (msg.key === "cosmetic") invalidateCosmetic();
    if (msg.key === "badge") await refreshActionIcons();
    if (msg.key === "contextMenu") setupContextMenu(msg.value);
    return settings;
  },
  "list:toggle": async msg => {
    const { lists = {} } = await chrome.storage.local.get("lists");
    lists[msg.id] = msg.enabled;
    await chrome.storage.local.set({ lists });
    await syncStaticRulesets();
    invalidateCosmetic();
    return getListStates();
  },
  "filters:save": msg => saveUserFilters(msg.text),
  "allowlist:add": async msg => {
    const host = normaliseHost(msg.host);
    if (!host) throw new Error("That doesn't look like a website address.");
    return setAllowed(host, true);
  },
  "allowlist:remove": msg => setAllowed(msg.host, false),
  "sub:add": async msg => {
    let url;
    try {
      url = new URL(msg.url.trim());
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      throw new Error("Enter a full http(s) URL to a filter list.");
    }
    const subs = await getSubscriptions();
    if (subs.some(s => s.url === url.href)) throw new Error("You're already subscribed to that list.");
    const sub = await updateSubscription({ id: crypto.randomUUID().slice(0, 8), url: url.href, enabled: true });
    subs.push(sub);
    await chrome.storage.local.set({ subscriptions: subs });
    await syncDynamicRules();
    invalidateCosmetic();
    return sub;
  },
  "sub:remove": async msg => {
    const subs = (await getSubscriptions()).filter(s => s.id !== msg.id);
    await chrome.storage.local.remove(`sub:${msg.id}`);
    await chrome.storage.local.set({ subscriptions: subs });
    await syncDynamicRules();
    invalidateCosmetic();
    return subs;
  },
  "sub:toggle": async msg => {
    const subs = await getSubscriptions();
    const sub = subs.find(s => s.id === msg.id);
    if (sub) sub.enabled = msg.enabled;
    await chrome.storage.local.set({ subscriptions: subs });
    await syncDynamicRules();
    invalidateCosmetic();
    return subs;
  },
  "sub:update": () => updateAllSubscriptions(),
  "stats:reset": async () => {
    await restoreState();
    totals = freshTotals();
    await chrome.storage.local.set({ stats: totals });
    return totals;
  },
  "backup:export": async () => {
    const data = await chrome.storage.local.get(["settings", "lists", "allowlist", "userFilters", "subscriptions"]);
    return { app: "bloktra", version: chrome.runtime.getManifest().version, exported: new Date().toISOString(), ...data };
  },
  "backup:import": async msg => {
    const d = msg.data;
    // "shield" is accepted so backups from the old name still restore.
    if (!d || !["bloktra", "shield"].includes(d.app)) throw new Error("This file isn't a Bloktra backup.");
    const patch = {};
    if (d.settings) patch.settings = { ...DEFAULT_SETTINGS, ...d.settings };
    if (d.lists) patch.lists = d.lists;
    if (Array.isArray(d.allowlist)) patch.allowlist = d.allowlist.map(normaliseHost).filter(Boolean);
    if (Array.isArray(d.subscriptions)) patch.subscriptions = d.subscriptions;
    await chrome.storage.local.set(patch);
    if (typeof d.userFilters === "string") await saveUserFilters(d.userFilters);
    await updateAllSubscriptions();
    await syncAll();
    setupContextMenu((await getSettings()).contextMenu);
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(result => sendResponse({ ok: true, result }))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

// ─────────────────────────────── lifecycle ───────────────────────────────

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === "install") {
    await chrome.storage.local.set({ userFilters: DEFAULT_USER_FILTERS, stats: freshTotals() });
  }
  // Migrate the old learning version's keys.
  await chrome.storage.local.remove(["cosmeticRules", "filterCount", "lastUpdated", "filterError", "enabled"]);

  const { userFilters } = await chrome.storage.local.get("userFilters");
  if (userFilters) await chrome.storage.local.set({ userCompiled: await compileUserFilters(userFilters) });

  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  setupContextMenu((await getSettings()).contextMenu);
  await syncAll();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 24 * 60 });
  await refreshActionIcons();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === UPDATE_ALARM) updateAllSubscriptions().catch(() => {});
});

restoreState();
