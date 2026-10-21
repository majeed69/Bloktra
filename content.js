// Bloktra: cosmetic filtering content script (runs in every frame).
//
// 1. Asks the service worker which selectors apply to this site; the worker
//    injects them as a user stylesheet that pages can't override.
// 2. Watches the page for class names / ids and asks for the matching
//    generic selectors, so only relevant generic rules are ever injected.
// 3. Runs procedural filters (:has-text, :upward, :remove …).
// 4. Counts hidden elements and reports them for the popup.

(() => {
  if (globalThis.__bloktraContent) return;
  globalThis.__bloktraContent = true;

  // Remember the right-clicked element for "Hide this element…".
  document.addEventListener("contextmenu", e => {
    globalThis.__bloktraContextTarget = { el: e.target, t: Date.now() };
  }, true);

  const send = (type, data = {}) =>
    chrome.runtime.sendMessage({ type, ...data })
      .then(r => (r && r.ok ? r.result : null))
      .catch(() => null);

  const pageUrl = /^https?:/.test(location.protocol)
    ? location.href
    : (self.origin && self.origin !== "null" ? `${self.origin}/` : "");
  if (!pageUrl) return;

  const hideSelectors = new Set();
  const seenTokens = new Set();
  const pendingTokens = new Set();
  const counted = new WeakSet();
  let hiddenCount = 0;
  let reportedCount = 0;
  let procedural = [];
  let genericOn = false;
  let observer = null;

  // ─────────────────────────── generic tokens ───────────────────────────

  function collect(el) {
    if (el.id) {
      const t = `#${el.id}`;
      if (!seenTokens.has(t)) pendingTokens.add(t);
    }
    const cl = el.classList;
    if (cl) {
      for (let i = 0; i < cl.length; i++) {
        const t = `.${cl[i]}`;
        if (!seenTokens.has(t)) pendingTokens.add(t);
      }
    }
  }

  function collectTree(root) {
    if (root.nodeType !== 1) return;
    collect(root);
    const all = root.querySelectorAll("[id],[class]");
    for (let i = 0; i < all.length; i++) collect(all[i]);
  }

  let tokenTimer = 0;
  function scheduleTokens() {
    if (tokenTimer || !pendingTokens.size) return;
    tokenTimer = setTimeout(flushTokens, seenTokens.size ? 60 : 0);
  }

  async function flushTokens() {
    tokenTimer = 0;
    if (!pendingTokens.size) return;
    const tokens = [...pendingTokens];
    pendingTokens.clear();
    tokens.forEach(t => seenTokens.add(t));
    const res = await send("cosmetic:tokens", { url: pageUrl, tokens });
    if (res?.selectors?.length) {
      res.selectors.forEach(s => hideSelectors.add(s));
      scheduleWork();
    }
  }

  // ─────────────────────────── procedural ───────────────────────────

  const OP_RE = /^:(has-text|-abp-contains|contains|upward|remove|has|-abp-has)\(/;
  const PROC_INSIDE = /:(has-text|-abp-contains|contains|upward|remove)\(/;

  function readArg(s, start) {
    // s[start] is just after "(", return [arg, indexAfterClosingParen]
    let depth = 1;
    let quote = "";
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") { i++; continue; }
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return [s.slice(start, i), i + 1];
    }
    return null;
  }

  function textMatcher(arg) {
    const m = arg.match(/^\/(.+)\/([imsu]*)$/);
    if (m) {
      try { return new RegExp(m[1], m[2]); } catch { return null; }
    }
    const text = arg.replace(/^(['"])(.*)\1$/, "$2");
    return { test: s => s.includes(text) };
  }

  function parseProcedural(src, relative = false) {
    const tasks = [];
    let css = "";
    let depthB = 0;
    let quote = "";
    let remove = false;

    const flushCss = () => {
      const sel = css.trim() ? css : "";
      css = "";
      if (!tasks.length) {
        tasks.push({ type: "css", sel: sel || "*", relative });
      } else if (sel) {
        tasks.push(/^[\s>+~]/.test(sel) ? { type: "spath", sel } : { type: "matches", sel });
      }
    };

    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote) { css += c; if (c === quote) quote = ""; continue; }
      if (c === "\\") { css += c + (src[i + 1] || ""); i++; continue; }
      if (c === '"' || c === "'") { quote = c; css += c; continue; }
      if (c === "[") depthB++;
      if (c === "]") depthB--;
      if (c === ":" && depthB === 0) {
        const m = src.slice(i).match(OP_RE);
        if (m) {
          const name = m[1];
          const got = readArg(src, i + m[0].length);
          if (!got) return null;
          const [arg, next] = got;
          if ((name === "has" || name === "-abp-has") && !PROC_INSIDE.test(arg)) {
            css += `:has(${arg})`;
            i = next - 1;
            continue;
          }
          flushCss();
          if (name === "has" || name === "-abp-has") {
            const inner = parseProcedural(arg.trim(), true);
            if (!inner) return null;
            tasks.push({ type: "has", inner });
          } else if (name === "upward") {
            const n = Number(arg);
            tasks.push(Number.isInteger(n) && n > 0 ? { type: "upward", n } : { type: "closest", sel: arg });
          } else if (name === "remove") {
            remove = true;
          } else {
            const re = textMatcher(arg);
            if (!re) return null;
            tasks.push({ type: "text", re });
          }
          i = next - 1;
          continue;
        }
      }
      css += c;
    }
    flushCss();
    return { tasks, remove };
  }

  function runTasks(tasks, root) {
    let nodes = [];
    const [first, ...rest] = tasks;
    try {
      if (first.relative) {
        const sel = /^[>+~]/.test(first.sel.trim()) ? `:scope ${first.sel}` : `:scope ${first.sel}`;
        nodes = [...root.querySelectorAll(sel)];
      } else {
        nodes = [...root.querySelectorAll(first.sel)];
      }
      for (const t of rest) {
        if (!nodes.length) break;
        switch (t.type) {
          case "text":
            nodes = nodes.filter(n => t.re.test(n.textContent));
            break;
          case "upward":
            nodes = [...new Set(nodes.map(n => {
              let p = n;
              for (let k = 0; k < t.n && p; k++) p = p.parentElement;
              return p;
            }).filter(Boolean))];
            break;
          case "closest":
            nodes = [...new Set(nodes.map(n => n.parentElement?.closest(t.sel)).filter(Boolean))];
            break;
          case "has":
            nodes = nodes.filter(n => runTasks(t.inner.tasks, n).length > 0);
            break;
          case "spath":
            nodes = [...new Set(nodes.flatMap(n => [...n.querySelectorAll(`:scope${t.sel}`)]))];
            break;
          case "matches":
            nodes = nodes.filter(n => n.matches(t.sel));
            break;
        }
      }
    } catch {
      return [];
    }
    return nodes;
  }

  function applyProcedural() {
    for (const p of procedural) {
      for (const el of runTasks(p.tasks, document)) {
        if (el === document.documentElement || el === document.body) continue;
        if (p.remove) {
          el.remove();
          hiddenCount++;
        } else if (!counted.has(el)) {
          el.style.setProperty("display", "none", "important");
          counted.add(el);
          hiddenCount++;
        }
      }
    }
  }

  // ─────────────────────────── counting ───────────────────────────

  const validity = new Map();
  function isValid(sel) {
    let ok = validity.get(sel);
    if (ok === undefined) {
      try {
        document.createDocumentFragment().querySelector(sel);
        ok = true;
      } catch {
        ok = false;
      }
      validity.set(sel, ok);
    }
    return ok;
  }

  function countHidden() {
    const list = [...hideSelectors].filter(isValid);
    for (let i = 0; i < list.length; i += 300) {
      let found;
      try {
        found = document.querySelectorAll(list.slice(i, i + 300).join(","));
      } catch {
        continue;
      }
      for (const el of found) {
        if (!counted.has(el)) {
          counted.add(el);
          hiddenCount++;
        }
      }
    }
  }

  function report() {
    if (hiddenCount !== reportedCount) {
      reportedCount = hiddenCount;
      send("cosmetic:hidden", { count: hiddenCount });
    }
  }

  // Throttled work loop: procedural filters + counting.
  let workTimer = 0;
  let lastWork = 0;
  function scheduleWork() {
    if (workTimer) return;
    const wait = Math.max(0, 400 - (Date.now() - lastWork));
    workTimer = setTimeout(() => {
      const run = () => {
        workTimer = 0;
        lastWork = Date.now();
        if (procedural.length) applyProcedural();
        countHidden();
        report();
      };
      if ("requestIdleCallback" in self) requestIdleCallback(run, { timeout: 800 });
      else run();
    }, wait);
  }

  // ─────────────────────────── start ───────────────────────────

  function onMutations(records) {
    for (const r of records) {
      if (r.type === "attributes") {
        if (genericOn) collect(r.target);
      } else if (genericOn) {
        for (const n of r.addedNodes) if (n.nodeType === 1) collectTree(n);
      }
    }
    if (genericOn) scheduleTokens();
    scheduleWork();
  }

  async function start() {
    const res = await send("cosmetic:init", { url: pageUrl });
    if (!res?.active) return;

    res.selectors.forEach(s => hideSelectors.add(s));
    procedural = res.procedural.map(s => parseProcedural(s)).filter(Boolean);
    genericOn = res.generic;

    observer = new MutationObserver(onMutations);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: genericOn,
      attributeFilter: genericOn ? ["class", "id"] : undefined
    });

    const initial = () => {
      if (genericOn && document.documentElement) {
        collectTree(document.documentElement);
        scheduleTokens();
      }
      scheduleWork();
    };
    initial();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initial, { once: true });
    }
    addEventListener("load", scheduleWork, { once: true });
  }

  start();
})();
