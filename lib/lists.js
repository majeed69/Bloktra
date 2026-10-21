// Bloktra: catalog of bundled filter lists.
// Each list is compiled by tools/build.mjs into rulesets/<id>.json (network)
// and cosmetic/<id>.json (element hiding). `sources` are tried in order.

const UASSETS = "https://raw.githubusercontent.com/uBlockOrigin/uAssets/gh-pages/thirdparties";

export const LISTS = [
  {
    id: "easylist",
    name: "EasyList",
    group: "ads",
    description: "The most widely used ad blocking list.",
    homepage: "https://easylist.to/",
    category: "ads",
    enabled: true,
    sources: ["https://easylist.to/easylist/easylist.txt", `${UASSETS}/easylist.txt`]
  },
  {
    id: "easyprivacy",
    name: "EasyPrivacy",
    group: "privacy",
    description: "Blocks trackers, analytics and fingerprinting scripts.",
    homepage: "https://easylist.to/",
    category: "trackers",
    enabled: true,
    sources: ["https://easylist.to/easylist/easyprivacy.txt", `${UASSETS}/easyprivacy.txt`]
  },
  {
    id: "peterlowe",
    name: "Peter Lowe’s Blocklist",
    group: "ads",
    description: "A compact list of ad and tracking servers.",
    homepage: "https://pgl.yoyo.org/adservers/",
    category: "ads",
    enabled: true,
    sources: [
      "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext",
      "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/thirdparties/pgl.yoyo.org/as/serverlist"
    ]
  },
  {
    id: "d3host",
    name: "Turtlecute d3host",
    group: "ads",
    description: "Small list of popular ad, analytics and OEM telemetry hosts.",
    homepage: "https://adblock.turtlecute.org/",
    category: "ads",
    enabled: true,
    local: "d3host.adblock",
    sources: ["https://adblock.turtlecute.org/d3host.adblock"]
  },
  {
    id: "cookies",
    name: "Cookie Notices",
    group: "annoyances",
    description: "Hides cookie consent banners and pop-ups (EasyList Cookie).",
    homepage: "https://easylist.to/",
    category: "ads",
    enabled: false,
    sources: ["https://secure.fanboy.co.nz/fanboy-cookiemonster.txt", `${UASSETS}/easylist-cookies.txt`]
  },
  {
    id: "annoyances",
    name: "Annoyances",
    group: "annoyances",
    description: "Newsletter pop-ups, “open in app” banners and other clutter.",
    homepage: "https://easylist.to/",
    category: "ads",
    enabled: false,
    sources: ["https://secure.fanboy.co.nz/fanboy-annoyance.txt", `${UASSETS}/easylist-annoyances.txt`]
  },
  {
    id: "stevenblack",
    name: "StevenBlack Unified Hosts",
    group: "privacy",
    description: "Large hosts file of ad, tracking and malware domains. Stricter.",
    homepage: "https://github.com/StevenBlack/hosts",
    category: "trackers",
    enabled: false,
    sources: ["https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"]
  },
  {
    id: "urlcleaner",
    name: "Clean tracking links",
    group: "privacy",
    description: "Removes utm_*, fbclid, gclid and similar tracking parameters from links.",
    homepage: "",
    category: "trackers",
    enabled: true,
    builtin: true
  }
];

export const GROUPS = {
  ads: "Ads",
  privacy: "Privacy",
  annoyances: "Annoyances"
};

// Query parameters stripped by the "Clean tracking links" ruleset.
export const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "utm_name", "utm_cid", "utm_reader", "utm_referrer", "utm_social", "utm_brand",
  "utm_viz_id", "utm_pubreferrer", "utm_swu",
  "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "twclid",
  "ttclid", "li_fat_id", "igshid", "igsh", "yclid", "ysclid", "mc_cid", "mc_eid",
  "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsCtaTracking", "mkt_tok",
  "oly_anon_id", "oly_enc_id", "rb_clickid", "s_cid", "vero_conv", "vero_id",
  "wickedid", "_openstat", "ga_source", "ga_medium", "ga_campaign", "ga_content",
  "ga_term", "epik", "srsltid", "si_source"
];
