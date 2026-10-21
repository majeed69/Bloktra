// Bloktra: element picker. Injected on demand (popup button, context menu or
// Alt+Shift+E). Hover to highlight, click to select, then save a cosmetic
// filter for this site.

(() => {
  if (globalThis.__bloktraPicker) {
    globalThis.__bloktraPicker.focus();
    return;
  }

  const host = document.createElement("bloktra-picker");
  const root = host.attachShadow({ mode: "closed" });
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;

  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .box { position: fixed; pointer-events: none; border-radius: 4px; transition: all .06s ease-out; }
      .hover { background: rgba(47, 143, 98, .18); outline: 2px solid #2f8f62; }
      .match { background: rgba(214, 69, 69, .22); outline: 2px solid #d64545; }
      .panel {
        position: fixed; right: 16px; bottom: 16px; width: 340px; pointer-events: auto;
        background: ${dark ? "#1b1d20" : "#ffffff"}; color: ${dark ? "#e8e8e6" : "#1c1d1f"};
        border: 1px solid ${dark ? "#2c2f33" : "#e4e4e0"}; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.22); padding: 14px; font-size: 13px;
      }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .title { font-weight: 650; font-size: 14px; display: flex; gap: 8px; align-items: center; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #2f8f62; }
      .hint { color: ${dark ? "#9a9c9f" : "#6b6d70"}; font-size: 12px; line-height: 1.45; }
      textarea {
        width: 100%; min-height: 58px; resize: vertical; margin: 8px 0 6px; padding: 8px 10px;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        background: ${dark ? "#121315" : "#f6f6f3"}; color: inherit;
        border: 1px solid ${dark ? "#2c2f33" : "#e4e4e0"}; border-radius: 8px; outline: none;
      }
      textarea:focus { border-color: #2f8f62; }
      .row { display: flex; gap: 6px; align-items: center; }
      .grow { flex: 1; }
      button {
        appearance: none; border: 1px solid ${dark ? "#2c2f33" : "#e4e4e0"}; background: transparent; color: inherit;
        border-radius: 8px; padding: 7px 10px; font-size: 12px; font-weight: 550; cursor: pointer;
      }
      button:hover { background: ${dark ? "#25282c" : "#f1f1ee"}; }
      button.primary { background: #2f8f62; border-color: #2f8f62; color: #fff; }
      button.primary:hover { background: #287a54; }
      button:disabled { opacity: .45; cursor: default; }
      .x { border: 0; padding: 4px 8px; font-size: 16px; line-height: 1; }
      .count { font-variant-numeric: tabular-nums; }
      .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: none;
        background: #1c1d1f; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
    </style>
    <div class="box hover" hidden></div>
    <div class="matches"></div>
    <div class="panel" role="dialog" aria-label="Hide an element">
      <div class="head">
        <div class="title"><span class="dot"></span>Hide an element</div>
        <button class="x" data-act="cancel" title="Close (Esc)">×</button>
      </div>
      <div class="hint" data-hint>Hover over the page and click the element you want to hide.</div>
      <div data-editor hidden>
        <textarea spellcheck="false" aria-label="CSS selector"></textarea>
        <div class="row" style="margin-bottom:10px">
          <span class="hint grow count" data-count></span>
          <button data-act="up" title="Select the surrounding element">Bigger</button>
          <button data-act="down" title="Go back to a smaller element">Smaller</button>
        </div>
        <div class="row">
          <button data-act="repick" class="grow">Pick again</button>
          <button data-act="create" class="primary grow">Hide element</button>
        </div>
      </div>
    </div>`;

  const $ = sel => root.querySelector(sel);
  const hoverBox = $(".box.hover");
  const matchLayer = $(".matches");
  const editor = $("[data-editor]");
  const hint = $("[data-hint]");
  const textarea = $("textarea");
  const countEl = $("[data-count]");

  let picking = true;
  let selected = null;
  const trail = []; // elements walked through with "Bigger"

  (document.documentElement || document.body).appendChild(host);

  // ─────────────────────── selector generation ───────────────────────

  const BAD_CLASS = /^(?:active|hover|focus|focused|selected|open|show|visible|hidden|is-|has-|js-)|\d{4,}|^[a-z0-9]{12,}$|[_-][a-z0-9]{5,}[A-Z]/;
  const goodId = id => id && !/\d{3,}|^[0-9]|:/.test(id) && id.length < 40;
  const goodClass = c => c && c.length < 40 && !BAD_CLASS.test(c);

  function uniqueSelectorFor(el) {
    if (goodId(el.id)) {
      const s = `#${CSS.escape(el.id)}`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur !== el && goodId(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let part = cur.localName;
      const classes = [...cur.classList].filter(goodClass).slice(0, 2);
      if (classes.length) part += classes.map(c => `.${CSS.escape(c)}`).join("");
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.localName === cur.localName);
        let matching;
        try { matching = [...parent.children].filter(c => c.matches(part)); } catch { matching = []; }
        if (matching.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch { /* keep walking */ }
      if (cur === document.body) break;
      cur = parent;
    }
    return parts.join(" > ");
  }

  // ─────────────────────── drawing ───────────────────────

  function place(box, el) {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`
    });
  }

  function matchesOf(sel) {
    try {
      return [...document.querySelectorAll(sel)].filter(e => e !== host);
    } catch {
      return null;
    }
  }

  function renderMatches() {
    matchLayer.textContent = "";
    const sel = textarea.value.trim();
    const found = sel ? matchesOf(sel) : [];
    const create = $('[data-act="create"]');
    if (found === null) {
      countEl.textContent = "Invalid selector";
      create.disabled = true;
      return;
    }
    countEl.textContent = found.length === 1 ? "Matches 1 element" : `Matches ${found.length} elements`;
    create.disabled = !found.length;
    for (const el of found.slice(0, 60)) {
      const b = document.createElement("div");
      b.className = "box match";
      place(b, el);
      matchLayer.appendChild(b);
    }
  }

  function select(el) {
    selected = el;
    picking = false;
    hoverBox.hidden = true;
    hint.hidden = true;
    editor.hidden = false;
    textarea.value = uniqueSelectorFor(el);
    renderMatches();
  }

  // ─────────────────────── events ───────────────────────

  const isOurs = e => e.composedPath().includes(host);

  function onMove(e) {
    if (!picking || isOurs(e)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el === document.documentElement || el === document.body) {
      hoverBox.hidden = true;
      return;
    }
    hoverBox.hidden = false;
    place(hoverBox, el);
  }

  function onClick(e) {
    if (isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host && el !== document.documentElement && el !== document.body) {
      trail.length = 0;
      select(el);
    }
  }

  function swallow(e) {
    if (!isOurs(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const onScroll = () => (picking ? (hoverBox.hidden = true) : renderMatches());

  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("mousedown", swallow, true);
  addEventListener("mouseup", swallow, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", onScroll, true);
  addEventListener("resize", onScroll, true);

  textarea.addEventListener("input", renderMatches);

  root.addEventListener("click", async e => {
    const act = e.target.closest?.("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "cancel") close();
    if (act === "repick") {
      picking = true;
      editor.hidden = true;
      hint.hidden = false;
      matchLayer.textContent = "";
    }
    if (act === "up" && selected?.parentElement && selected.parentElement !== document.body) {
      trail.push(selected);
      selected = selected.parentElement;
      textarea.value = uniqueSelectorFor(selected);
      renderMatches();
    }
    if (act === "down" && trail.length) {
      selected = trail.pop();
      textarea.value = uniqueSelectorFor(selected);
      renderMatches();
    }
    if (act === "create") create();
  });

  async function create() {
    const sel = textarea.value.trim().replace(/\s*\n\s*/g, " ");
    const found = matchesOf(sel);
    if (!sel || !found?.length) return;
    const filter = `${location.hostname.replace(/^www\./, "")}##${sel}`;
    found.forEach(el => el.style.setProperty("display", "none", "important"));
    const res = await chrome.runtime.sendMessage({ type: "picker:create", filter }).catch(() => null);
    close();
    toast(res?.ok ? "Hidden. You can undo this in Dashboard › My filters." : "Couldn’t save the filter.");
  }

  function toast(text) {
    const t = document.createElement("bloktra-toast");
    const sr = t.attachShadow({ mode: "closed" });
    sr.innerHTML = `<style>:host{all:initial;position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%)}
      div{font:13px system-ui,sans-serif;background:#1c1d1f;color:#fff;padding:10px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25)}</style><div></div>`;
    sr.querySelector("div").textContent = text;
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function close() {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousedown", swallow, true);
    removeEventListener("mouseup", swallow, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll, true);
    removeEventListener("resize", onScroll, true);
    host.remove();
    delete globalThis.__bloktraPicker;
  }

  globalThis.__bloktraPicker = { focus: () => textarea.focus() };

  // Started from the context menu? Pre-select the right-clicked element.
  const ctxInfo = globalThis.__bloktraContextTarget;
  const ctx = ctxInfo && Date.now() - ctxInfo.t < 15000 ? ctxInfo.el : null;
  if (ctx && ctx.isConnected && ctx !== document.body && ctx !== document.documentElement) {
    delete globalThis.__bloktraContextTarget;
    select(ctx.nodeType === 1 ? ctx : ctx.parentElement);
  }
})();
