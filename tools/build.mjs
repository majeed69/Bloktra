#!/usr/bin/env node
// Bloktra: compile the bundled filter lists into static DNR rulesets.
//
//   node tools/build.mjs              download the latest lists and rebuild
//   node tools/build.mjs --raw DIR    use DIR/<list-id>.txt instead of downloading
//
// Outputs:
//   rulesets/<id>.json   declarativeNetRequest static rules
//   cosmetic/<id>.json   element-hiding data used by the content script
//   data/trackers.txt    tracker domains (used to split counts into ads / trackers)
//   data/lists-meta.json rule counts and list versions shown in the dashboard
//   manifest.json        declarative_net_request.rule_resources is rewritten

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFilterList } from "../lib/filter-parser.js";
import { LISTS, TRACKING_PARAMS } from "../lib/lists.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const rawDir = args.includes("--raw") ? path.resolve(args[args.indexOf("--raw") + 1]) : null;

async function fetchText(list) {
  if (rawDir && existsSync(path.join(rawDir, `${list.id}.txt`))) {
    return readFile(path.join(rawDir, `${list.id}.txt`), "utf8");
  }
  if (list.local && existsSync(path.join(ROOT, list.local))) {
    return readFile(path.join(ROOT, list.local), "utf8");
  }
  let lastError;
  for (const url of list.sources) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length < 500) throw new Error("response too small");
      return text;
    } catch (e) {
      lastError = e;
      console.warn(`  ! ${url}: ${e.message}`);
    }
  }
  throw new Error(`Could not download ${list.id}: ${lastError?.message}`);
}

function listVersion(text) {
  const m =
    text.match(/^!\s*(?:Last modified|Updated On|Version):\s*(.+)$/im) ||
    text.match(/^#\s*(?:last updated|Date):\s*(.+)$/im);
  return m ? m[1].trim() : "";
}

// d3host groups hosts by section; analytics / tracker sections count as trackers.
function d3hostTrackers(text) {
  const out = [];
  let tracking = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^!=+\s*(.+?)\s*=+$/);
    if (section) {
      tracking = /analytic|tracker/i.test(section[1]);
      continue;
    }
    const m = line.match(/^\|\|([a-z0-9.-]+)\^$/i);
    if (tracking && m) out.push(m[1].toLowerCase());
  }
  return out;
}

function urlCleanerRules() {
  // Chrome caps each regex's compiled size, so match the parameters in small
  // groups; every rule strips all of them in a single redirect.
  const escaped = TRACKING_PARAMS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const rules = [];
  for (let i = 0; i < escaped.length; i += 10) {
    rules.push({
      id: rules.length + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { transform: { queryTransform: { removeParams: TRACKING_PARAMS } } }
      },
      condition: {
        regexFilter: `[?&](?:${escaped.slice(i, i + 10).join("|")})=`,
        isUrlFilterCaseSensitive: true,
        resourceTypes: ["main_frame", "sub_frame"]
      }
    });
  }
  return rules;
}

async function main() {
  await mkdir(path.join(ROOT, "rulesets"), { recursive: true });
  await mkdir(path.join(ROOT, "cosmetic"), { recursive: true });
  await mkdir(path.join(ROOT, "data"), { recursive: true });

  const meta = { built: new Date().toISOString(), lists: {} };
  const trackers = new Set();
  let total = 0;
  let totalDefault = 0;

  for (const list of LISTS) {
    let rules;
    let cosmeticCount = 0;
    let version = "";

    if (list.id === "urlcleaner") {
      rules = urlCleanerRules();
    } else {
      process.stdout.write(`• ${list.name} … `);
      const text = await fetchText(list);
      version = listVersion(text);
      const parsed = parseFilterList(text, { allowRegex: false });
      rules = parsed.rules.map((r, i) => ({ id: i + 1, ...r }));

      const c = parsed.cosmetic;
      cosmeticCount =
        c.high.length +
        Object.values(c.generic).reduce((n, v) => n + v.length, 0) +
        Object.values(c.specific).reduce((n, v) => n + v.length, 0) +
        Object.values(c.procedural).reduce((n, v) => n + v.length, 0);
      await writeFile(path.join(ROOT, "cosmetic", `${list.id}.json`), JSON.stringify(c));

      if (list.category === "trackers" && list.id !== "stevenblack") {
        parsed.blockedDomains.forEach(d => trackers.add(d));
      }
      if (list.id === "d3host") d3hostTrackers(text).forEach(d => trackers.add(d));

      const domains = parsed.blockedDomains.length;
      console.log(`${rules.length.toLocaleString()} rules (${domains.toLocaleString()} domains), ${cosmeticCount.toLocaleString()} cosmetic, ${parsed.stats.skipped.toLocaleString()} skipped`);
    }

    await writeFile(path.join(ROOT, "rulesets", `${list.id}.json`), JSON.stringify(rules));
    const domainCount = rules.reduce((n, r) => n + (r.condition.requestDomains?.length || 1), 0);
    meta.lists[list.id] = { rules: rules.length, filters: domainCount, cosmetic: cosmeticCount, version };
    total += rules.length;
    if (list.enabled) totalDefault += rules.length;
  }

  await writeFile(path.join(ROOT, "data", "trackers.txt"), [...trackers].sort().join("\n"));
  await writeFile(path.join(ROOT, "data", "lists-meta.json"), JSON.stringify(meta, null, 2));

  // Keep manifest rule_resources in sync with the catalog.
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.declarative_net_request = {
    rule_resources: LISTS.map(l => ({ id: l.id, enabled: l.enabled, path: `rulesets/${l.id}.json` }))
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nDone. ${total.toLocaleString()} rules total, ${totalDefault.toLocaleString()} enabled by default. ${trackers.size.toLocaleString()} tracker domains.`);
  if (totalDefault > 30000) console.warn("⚠ Default rulesets exceed Chrome's guaranteed 30,000 static rules.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
