// Bloktra: filter parser.
//
// Converts Adblock Plus / uBlock Origin style filter lists (and hosts files)
// into Chrome declarativeNetRequest rules plus a compact cosmetic data set.
// This module is shared: the service worker imports it at runtime (for your
// own filters and custom subscriptions) and tools/build.mjs imports it in Node
// to compile the bundled lists into static rulesets.

const RESOURCE_TYPES = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  ping: "ping",
  beacon: "ping",
  media: "media",
  font: "font",
  websocket: "websocket",
  other: "other",
  webtransport: "webtransport",
  webbundle: "webbundle",
  document: "main_frame",
  doc: "main_frame"
};

const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "media", "websocket", "webtransport",
  "webbundle", "other"
];

// Options that change nothing for us and can be dropped safely.
const IGNORED_OPTIONS = new Set(["~popup", "~document", "~doc", "stealth", "~stealth"]);

// Options that make a filter impossible to express faithfully in DNR.
const UNSUPPORTED_OPTIONS = new Set([
  "popup", "popunder", "csp", "redirect", "redirect-rule", "rewrite", "replace",
  "permissions", "header", "removeheader", "urltransform", "uritransform",
  "cname", "empty", "mp4", "inline-script", "inline-font", "sitekey",
  "genericblock", "strict1p", "strict3p", "strict-first-party",
  "strict-third-party", "ipaddress", "jsonprune", "network", "hls", "webrtc",
  "content", "extension", "jsinject", "urlblock", "app", "cookie", "referrerpolicy"
]);

const COSMETIC_EXCEPTION_OPTIONS = {
  elemhide: "elemHide",
  ehide: "elemHide",
  generichide: "genericHide",
  ghide: "genericHide",
  specifichide: "specificHide",
  shide: "specificHide"
};

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;
const ENTITY_RE = /^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+\.\*$/;
const HOSTS_LINE_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+(.+)$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const PARAM_NAME_RE = /^[\w.\-[\]]+$/;

// Procedural (non-CSS) operators the content script knows how to run.
const PROCEDURAL_OPS = [":has-text(", ":-abp-contains(", ":contains(", ":upward(", ":remove()"];
// Operators we can't run. Filters using them are skipped.
const UNSUPPORTED_COSMETIC = [
  ":-abp-properties(", ":matches-css(", ":matches-css-before(", ":matches-css-after(",
  ":xpath(", ":min-text-length(", ":watch-attr(", ":matches-path(", ":matches-attr(",
  ":matches-prop(", ":matches-media(", ":others(", ":style(", ":remove-attr(",
  ":remove-class(", ":nth-ancestor(", ":if(", ":if-not(", ":-abp-has-text(", ":shadow"
];

export const PRIORITY = {
  block: 1,
  allow: 1, // allow beats block at equal priority (DNR action precedence)
  importantBlock: 2,
  importantAllow: 3,
  userOffset: 3, // your own filters always beat list filters
  siteAllowlist: 1000,
  pauseAll: 2000
};

export function emptyCosmetic() {
  return {
    generic: {},           // ".class" / "#id" token → selectors (only injected when the token exists on the page)
    high: [],              // generic selectors that can't be keyed, always injected
    specific: {},          // host → selectors
    exceptions: {},        // host → selectors that must NOT be hidden there
    genericExceptions: [], // selectors disabled everywhere
    procedural: {},        // host → procedural selectors (:has-text, :upward …)
    genericHide: [],       // hosts where generic cosmetic filters are off
    elemHide: [],          // hosts where all cosmetic filtering is off
    specificHide: []       // hosts where site-specific cosmetic filters are off
  };
}

/**
 * Parse filter-list text.
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.allowRegex=true]   Keep /regex/ network filters.
 * @param {boolean} [opts.bareDomains=false] Treat a bare "example.com" line as ||example.com^.
 * @param {number}  [opts.priorityOffset=0]  Added to every rule's priority.
 * @returns {{rules: object[], cosmetic: object, blockedDomains: string[], stats: object}}
 */
export function parseFilterList(text, opts = {}) {
  const { allowRegex = true, bareDomains = false, priorityOffset = 0 } = opts;
  const stats = { lines: 0, network: 0, cosmetic: 0, skipped: 0, comments: 0 };
  const cosmetic = emptyCosmetic();
  const network = [];
  const blockedDomains = new Set();
  const cosmeticSets = {
    genericExceptions: new Set(),
    genericHide: new Set(),
    elemHide: new Set(),
    specificHide: new Set()
  };

  const lines = text.split(/\r?\n/);

  // uBO's $badfilter disables another filter with the same text.
  const badFilters = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.includes("badfilter") && !line.startsWith("!")) {
      const m = line.match(/^(.*)\$(.*)$/);
      if (m) {
        const options = m[2].split(",").filter(o => o !== "badfilter");
        badFilters.add(options.length ? `${m[1]}$${options.join(",")}` : m[1]);
      }
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    stats.lines++;

    if (!line || line.startsWith("!") || line.startsWith("[") || (line.startsWith("#") && !/^#[@?$%]?#/.test(line))) {
      stats.comments++;
      continue;
    }

    if (badFilters.has(line) || line.endsWith("$badfilter") || line.includes(",badfilter")) {
      stats.skipped++;
      continue;
    }

    // hosts file entry: "0.0.0.0 ads.example.com"
    const hosts = line.match(HOSTS_LINE_RE);
    if (hosts) {
      let any = false;
      for (const token of hosts[1].split(/\s+/)) {
        if (token.startsWith("#")) break;
        const host = token.toLowerCase().replace(/\.$/, "");
        if (HOST_RE.test(host) && !["localhost", "localhost.localdomain", "broadcasthost", "local", "0.0.0.0"].includes(host)) {
          network.push({ kind: "domain", action: "block", host, sig: "", priority: PRIORITY.block });
          blockedDomains.add(host);
          any = true;
        }
      }
      any ? stats.network++ : stats.skipped++;
      continue;
    }

    // Cosmetic filters: domains##selector, domains#@#selector, domains#?#selector
    const cos = splitCosmetic(line);
    if (cos) {
      parseCosmetic(cos, cosmetic, cosmeticSets) ? stats.cosmetic++ : stats.skipped++;
      continue;
    }

    if (bareDomains && HOST_RE.test(line.toLowerCase())) {
      const host = line.toLowerCase();
      network.push({ kind: "domain", action: "block", host, sig: "", priority: PRIORITY.block });
      blockedDomains.add(host);
      stats.network++;
      continue;
    }

    const parsed = parseNetwork(line, { allowRegex, cosmeticSets });
    if (parsed === "cosmetic-only") {
      stats.network++;
    } else if (parsed) {
      network.push(parsed);
      if (parsed.kind === "domain" && parsed.action === "block") blockedDomains.add(parsed.host);
      stats.network++;
    } else {
      stats.skipped++;
    }
  }

  // Finalise cosmetic sets → arrays, apply generic exceptions locally.
  cosmetic.genericExceptions = [...cosmeticSets.genericExceptions];
  cosmetic.genericHide = [...cosmeticSets.genericHide];
  cosmetic.elemHide = [...cosmeticSets.elemHide];
  cosmetic.specificHide = [...cosmeticSets.specificHide];
  if (cosmeticSets.genericExceptions.size) {
    const ex = cosmeticSets.genericExceptions;
    cosmetic.high = cosmetic.high.filter(s => !ex.has(s));
    for (const key of Object.keys(cosmetic.generic)) {
      cosmetic.generic[key] = cosmetic.generic[key].filter(s => !ex.has(s));
      if (!cosmetic.generic[key].length) delete cosmetic.generic[key];
    }
  }
  dedupeCosmetic(cosmetic);

  const rules = buildRules(network, priorityOffset);
  return { rules, cosmetic, blockedDomains: [...blockedDomains], stats };
}

// ───────────────────────────── network ──────────────────────────────

function parseNetwork(line, { allowRegex, cosmeticSets }) {
  let text = line;
  let exception = false;

  if (text.startsWith("@@")) {
    exception = true;
    text = text.slice(2);
  }

  // Split off $options (the last $ that isn't part of a regex body).
  let pattern = text;
  let optionText = "";
  const dollar = findOptionsDollar(text);
  if (dollar !== -1) {
    pattern = text.slice(0, dollar);
    optionText = text.slice(dollar + 1);
  }

  const condition = {};
  const types = new Set();
  const notTypes = new Set();
  let important = false;
  let removeParam = null;
  let allTypes = false;
  const cosmeticFlags = [];

  if (optionText) {
    for (const rawOpt of splitOptions(optionText)) {
      const opt = rawOpt.trim();
      if (!opt) continue;
      const eq = opt.indexOf("=");
      const name = (eq === -1 ? opt : opt.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? "" : opt.slice(eq + 1);
      const negated = name.startsWith("~");
      const bare = negated ? name.slice(1) : name;

      if (IGNORED_OPTIONS.has(name)) continue;
      if (UNSUPPORTED_OPTIONS.has(bare)) return null;

      if (COSMETIC_EXCEPTION_OPTIONS[bare] && !negated) {
        if (!exception) return null;
        cosmeticFlags.push(COSMETIC_EXCEPTION_OPTIONS[bare]);
        continue;
      }

      if (RESOURCE_TYPES[bare]) {
        (negated ? notTypes : types).add(RESOURCE_TYPES[bare]);
        if (bare === "document" || bare === "doc") {
          if (!negated) {
            types.add("main_frame");
            if (exception) cosmeticFlags.push("elemHide");
          }
        }
        continue;
      }

      switch (bare) {
        case "all":
          allTypes = true;
          break;
        case "third-party":
        case "3p":
          condition.domainType = negated ? "firstParty" : "thirdParty";
          break;
        case "first-party":
        case "1p":
          condition.domainType = negated ? "thirdParty" : "firstParty";
          break;
        case "match-case":
          condition.isUrlFilterCaseSensitive = !negated;
          break;
        case "important":
          important = true;
          break;
        case "domain":
        case "from": {
          const d = parseDomainList(value, "|");
          if (!d) return null;
          if (d.include.length) condition.initiatorDomains = d.include;
          if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
          break;
        }
        case "to": {
          const d = parseDomainList(value, "|");
          if (!d) return null;
          if (d.include.length) condition.requestDomains = d.include;
          if (d.exclude.length) condition.excludedRequestDomains = d.exclude;
          break;
        }
        case "denyallow": {
          const d = parseDomainList(value, "|");
          if (!d || d.exclude.length) return null;
          condition.excludedRequestDomains = d.include;
          break;
        }
        case "method": {
          const inc = [];
          const exc = [];
          for (const m of value.toLowerCase().split("|")) {
            if (!m) continue;
            if (m.startsWith("~")) exc.push(m.slice(1));
            else inc.push(m);
          }
          if (inc.length) condition.requestMethods = inc;
          if (exc.length) condition.excludedRequestMethods = exc;
          break;
        }
        case "removeparam":
        case "queryprune":
          if (exception || negated || !value || !PARAM_NAME_RE.test(value)) return null;
          removeParam = value;
          break;
        default:
          return null; // unknown option, skip rather than over-block
      }
    }
  }

  // Cosmetic-only exception, e.g. @@||example.com^$generichide
  if (cosmeticFlags.length) {
    const hosts = [];
    const host = pattern.match(/^\|\|([a-z0-9.-]+)\^?\|?$/i);
    if (host) hosts.push(host[1].toLowerCase());
    if (condition.initiatorDomains) hosts.push(...condition.initiatorDomains);
    for (const flag of cosmeticFlags) {
      for (const h of hosts) cosmeticSets[flag].add(h);
    }
    // $document exceptions also need a network allow rule; the others don't.
    if (!types.has("main_frame")) return hosts.length ? "cosmetic-only" : null;
  }

  // Resource types
  if (allTypes) {
    ALL_TYPES.forEach(t => types.add(t));
  }
  if (types.size) {
    for (const t of notTypes) types.delete(t);
    if (!types.size) return null;
  }

  let action;
  if (removeParam) {
    action = "removeparam";
    if (!types.size) ["main_frame", "sub_frame", "xmlhttprequest"].forEach(t => types.add(t));
  } else if (exception && types.has("main_frame")) {
    action = "allowAllRequests";
    if (condition.initiatorDomains && !pattern.replace(/[*|]/g, "")) {
      condition.requestDomains = condition.initiatorDomains;
      delete condition.initiatorDomains;
    }
    types.clear();
    types.add("main_frame");
    types.add("sub_frame");
  } else {
    action = exception ? "allow" : "block";
  }

  if (types.size) condition.resourceTypes = [...types].sort();
  else if (notTypes.size) condition.excludedResourceTypes = [...notTypes].sort();

  // Pattern → urlFilter / regexFilter
  let isRegex = false;
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    if (!allowRegex) return null;
    const body = pattern.slice(1, -1);
    if (!PRINTABLE_ASCII.test(body)) return null;
    try {
      new RegExp(body);
    } catch {
      return null;
    }
    // DNR uses RE2, so reject constructs it can't handle.
    if (/\(\?[=!<]|\\[1-9]/.test(body)) return null;
    condition.regexFilter = body;
    isRegex = true;
  } else {
    let p = pattern;
    if (p.startsWith("*")) p = p.replace(/^\*+/, "");
    if (p.endsWith("*") && !p.endsWith("\\*")) p = p.replace(/\*+$/, "");
    if (p === "|" || p === "||") p = "";
    if (p) {
      if (!PRINTABLE_ASCII.test(p)) return null;
      if (p.startsWith("||*")) p = p.slice(3);
      // '|' is only legal as an anchor at the start or end.
      const inner = p.replace(/^\|\|?/, "").replace(/\|$/, "");
      if (inner.includes("|")) return null;
      if (!inner) return null;
      if (!condition.isUrlFilterCaseSensitive) p = p.toLowerCase();
    }

    // Pure domain filter → compressible into requestDomains.
    const dm = p.match(/^\|\|([a-z0-9._-]+)\^\|?$/);
    if (dm && HOST_RE.test(dm[1]) && !condition.requestDomains && !condition.excludedRequestDomains && action !== "removeparam") {
      const { isUrlFilterCaseSensitive, ...rest } = condition;
      return {
        kind: "domain",
        action,
        host: dm[1],
        sig: JSON.stringify(rest),
        condition: rest,
        priority: priorityFor(action, important)
      };
    }

    if (p) condition.urlFilter = p;
  }

  if (action === "removeparam") {
    // Only fire when the parameter is present, so we never redirect to the same URL.
    if (!condition.urlFilter && !condition.regexFilter) condition.urlFilter = `${removeParam.toLowerCase()}=`;
  }

  // Refuse unconstrained filters ("*" with no options), they'd block everything.
  const constrained =
    condition.urlFilter || condition.regexFilter || condition.initiatorDomains ||
    condition.requestDomains || condition.excludedInitiatorDomains && condition.domainType;
  if (!constrained && action !== "allowAllRequests") return null;
  if (!constrained && action === "allowAllRequests" && !condition.initiatorDomains) return null;

  return {
    kind: isRegex ? "regex" : "url",
    action,
    condition,
    removeParam,
    priority: priorityFor(action, important)
  };
}

function priorityFor(action, important) {
  if (action === "allow" || action === "allowAllRequests") return important ? PRIORITY.importantAllow : PRIORITY.allow;
  return important ? PRIORITY.importantBlock : PRIORITY.block;
}

function findOptionsDollar(text) {
  // Regex filters may contain '$', so look for "$" after the closing slash.
  if (text.startsWith("/")) {
    const close = text.lastIndexOf("/");
    if (close > 0) {
      const after = text.indexOf("$", close);
      return after;
    }
  }
  return text.lastIndexOf("$");
}

function splitOptions(text) {
  // Commas inside a regex value (e.g. removeparam=/a,b/) are rare; simple split.
  return text.split(",");
}

function parseDomainList(value, sep) {
  const include = [];
  const exclude = [];
  for (let d of value.toLowerCase().split(sep)) {
    d = d.trim();
    if (!d) continue;
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    if (!HOST_RE.test(d)) {
      // Entities (example.*) and regex domains aren't supported by DNR.
      if (neg) continue;
      continue;
    }
    (neg ? exclude : include).push(d);
  }
  if (!include.length && !exclude.length) return null;
  // If every positive domain was unusable, the filter would become too broad.
  if (!include.length && value.split(sep).some(d => d.trim() && !d.trim().startsWith("~"))) return null;
  return { include, exclude };
}

// Turn parsed entries into DNR rules (without ids).
function buildRules(entries, priorityOffset) {
  const rules = [];
  const seen = new Set();
  const groups = new Map(); // domain rules grouped by identical options

  for (const e of entries) {
    if (e.kind === "domain") {
      const key = `${e.action}|${e.priority}|${e.sig}`;
      let g = groups.get(key);
      if (!g) {
        g = { action: e.action, priority: e.priority, condition: e.condition || {}, hosts: new Set() };
        groups.set(key, g);
      }
      g.hosts.add(e.host);
      continue;
    }
    const rule = {
      priority: e.priority + priorityOffset,
      action: actionFor(e),
      condition: e.condition
    };
    const key = JSON.stringify(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }

  const CHUNK = 2500;
  for (const g of groups.values()) {
    // Drop hosts already covered by a parent domain in the same group.
    const hosts = [...g.hosts].filter(h => {
      let i = h.indexOf(".");
      while (i !== -1) {
        const parent = h.slice(i + 1);
        if (parent.includes(".") && g.hosts.has(parent)) return false;
        i = h.indexOf(".", i + 1);
      }
      return true;
    }).sort();
    for (let i = 0; i < hosts.length; i += CHUNK) {
      rules.push({
        priority: g.priority + priorityOffset,
        action: { type: g.action },
        condition: { ...g.condition, requestDomains: hosts.slice(i, i + CHUNK) }
      });
    }
  }

  return rules;
}

function actionFor(e) {
  if (e.action === "removeparam") {
    return { type: "redirect", redirect: { transform: { queryTransform: { removeParams: [e.removeParam] } } } };
  }
  return { type: e.action };
}

// ───────────────────────────── cosmetic ─────────────────────────────

function splitCosmetic(line) {
  const m = line.match(/^([^#\s/|^$]*?)(##|#@#|#\?#|#@\?#|#\$#|#@\$#|#%#|#@%#|#\$\?#|#@\$\?#)(.+)$/);
  if (!m) return null;
  const domains = m[1];
  if (domains && !/^[a-z0-9.,~*_-]+$/i.test(domains)) return null;
  return { domains: domains.toLowerCase(), sep: m[2], body: m[3].trim() };
}

function parseCosmetic({ domains, sep, body }, out, sets) {
  // Scriptlets, snippets, HTML filters and CSS injection aren't supported.
  if (sep.includes("$") || sep.includes("%")) return false;
  if (body.startsWith("+js(") || body.startsWith("^") || body.includes("{")) return false;

  const exception = sep.includes("@");
  let selector = normaliseSelector(body);
  if (!selector) return false;

  const { include, exclude } = splitCosmeticDomains(domains);
  const procedural = isProcedural(selector);

  if (procedural) {
    if (!include.length) return false; // generic procedural filters are too costly
    if (exception) {
      for (const d of include) push(out.exceptions, d, selector);
      return true;
    }
    for (const d of include) push(out.procedural, d, selector);
    for (const d of exclude) push(out.exceptions, d, selector);
    return true;
  }

  if (exception) {
    if (!include.length) sets.genericExceptions.add(selector);
    for (const d of include) push(out.exceptions, d, selector);
    return true;
  }

  if (!include.length) {
    addGeneric(out, selector);
    for (const d of exclude) push(out.exceptions, d, selector);
    return true;
  }

  for (const d of include) push(out.specific, d, selector);
  for (const d of exclude) push(out.exceptions, d, selector);
  return true;
}

function splitCosmeticDomains(domains) {
  const include = [];
  const exclude = [];
  for (let d of domains.split(",")) {
    d = d.trim();
    if (!d) continue;
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    if (!(HOST_RE.test(d) || ENTITY_RE.test(d))) continue;
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

function normaliseSelector(sel) {
  let s = sel.trim();
  if (!s || s.length > 1000) return null;
  // ABP spells native :has() as :-abp-has()
  s = s.replace(/:-abp-has\(/g, ":has(");
  for (const op of UNSUPPORTED_COSMETIC) {
    if (s.includes(op)) return null;
  }
  if (/[{}]/.test(s) || /^[>+~]/.test(s)) return null;
  if (!balanced(s)) return null;
  return s;
}

export function isProcedural(selector) {
  return PROCEDURAL_OPS.some(op => selector.includes(op));
}

function balanced(s) {
  let paren = 0;
  let bracket = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    if (paren < 0 || bracket < 0) return false;
  }
  return paren === 0 && bracket === 0 && !quote;
}

function addGeneric(out, selector) {
  const key = genericKey(selector);
  if (key) push(out.generic, key, selector);
  else out.high.push(selector);
}

/**
 * Pick a ".class" or "#id" from the right-most compound selector. An element
 * can only match the selector if it carries that class/id, so the content
 * script only needs these selectors when the token is present on the page.
 */
export function genericKey(selector) {
  if (splitTopLevel(selector, ",").length > 1) return null;
  const compounds = splitCompounds(selector);
  const last = compounds[compounds.length - 1] || "";
  // Remove [...] and (...) contents so we only see the compound's own tokens.
  let flat = "";
  let depthP = 0;
  let depthB = 0;
  let quote = "";
  for (let i = 0; i < last.length; i++) {
    const c = last[i];
    if (c === "\\") return null; // escaped identifiers, don't bother keying
    if (quote) { if (c === quote) quote = ""; continue; }
    if (depthB && (c === '"' || c === "'")) { quote = c; continue; }
    if (c === "[") { depthB++; continue; }
    if (c === "]") { depthB--; continue; }
    if (c === "(") { depthP++; continue; }
    if (c === ")") { depthP--; continue; }
    if (!depthB && !depthP) flat += c;
  }
  const id = flat.match(/#([a-zA-Z_-][\w-]*)/);
  if (id) return `#${id[1]}`;
  const cls = flat.match(/\.([a-zA-Z_-][\w-]*)/);
  if (cls) return `.${cls[1]}`;
  return null;
}

function splitTopLevel(s, sepChar) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sepChar && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function splitCompounds(s) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { cur += c + (s[i + 1] || ""); i++; continue; }
    if (quote) { cur += c; if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (depth === 0 && (c === " " || c === ">" || c === "+" || c === "~")) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function push(map, key, value) {
  (map[key] ??= []).push(value);
}

function dedupeCosmetic(c) {
  c.high = [...new Set(c.high)];
  for (const field of ["generic", "specific", "exceptions", "procedural"]) {
    for (const k of Object.keys(c[field])) c[field][k] = [...new Set(c[field][k])];
  }
}

/** Merge several cosmetic data sets (from different lists) into one. */
export function mergeCosmetic(list) {
  const out = emptyCosmetic();
  const sets = { genericExceptions: new Set(), genericHide: new Set(), elemHide: new Set(), specificHide: new Set() };
  for (const c of list) {
    if (!c) continue;
    for (const field of ["generic", "specific", "exceptions", "procedural"]) {
      for (const [k, v] of Object.entries(c[field] || {})) {
        const target = (out[field][k] ??= []);
        for (const s of v) target.push(s);
      }
    }
    for (const s of c.high || []) out.high.push(s);
    for (const f of Object.keys(sets)) for (const v of c[f] || []) sets[f].add(v);
  }
  for (const f of Object.keys(sets)) out[f] = [...sets[f]];
  dedupeCosmetic(out);
  return out;
}

export function countCosmetic(c) {
  let n = c.high.length;
  for (const field of ["generic", "specific", "procedural"]) {
    for (const v of Object.values(c[field])) n += v.length;
  }
  return n;
}

export { ALL_TYPES, HOST_RE };
