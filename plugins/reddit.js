const { getLang } = require("../lib/utils/language");
const config = require("../config");
const settingsStore = require("../lib/utils/settingsStore");
const {
  fetchJson,
  fetchBuffer,
  classifyError,
  replyKeyFor,
  safeLog,
} = require("../lib/utils/http");

/**
 * Reddit plugin. The anonymous .json endpoints answer 403, so it uses the OAuth
 * "client credentials" flow (an app of type "script" on reddit.com/prefs/apps):
 * set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.
 *
 *   .reddit r/memes          hot posts of a subreddit
 *   .reddit r/memes cats     search inside a subreddit
 *   .reddit cats             search in r/all
 */

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
const WEB_BASE = "https://www.reddit.com";
const USER_AGENT = "nodejs:open-whatsapp-bot:v1.0 (WhatsApp bot; https://github.com/Starland9/OpenWhatsappBot)";

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_WEB_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "np.reddit.com"]);
// The only hosts we download images from (the post URL is user-generated content)
const MEDIA_HOSTS = new Set(["i.redd.it", "preview.redd.it", "i.imgur.com"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

const LISTING_LIMIT = 25;
const SHOWN_POSTS = 5;
const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_LENGTH = 200;

let tokenCache = null; // { value, expiresAt }
let tokenRequest = null;

// New credentials from the panel: the cached token belongs to the old ones
settingsStore.onChange(["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"], () => {
  tokenCache = null;
});

function hasKeys() {
  return !!(config.REDDIT_CLIENT_ID && config.REDDIT_CLIENT_SECRET);
}

async function requestToken() {
  const credentials = Buffer.from(
    `${config.REDDIT_CLIENT_ID}:${config.REDDIT_CLIENT_SECRET}`
  ).toString("base64");

  let auth;
  try {
    auth = await fetchJson(TOKEN_URL, {
      method: "POST",
      data: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      timeoutMs: 15000,
    });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) err.code = "REDDIT_BAD_CREDENTIALS";
    throw err;
  }

  if (!auth || !auth.access_token) {
    // Reddit answers 200 {"error": "invalid_grant"} for some bad setups
    const err = new Error("Reddit returned no access token");
    err.code = "REDDIT_BAD_CREDENTIALS";
    throw err;
  }

  tokenCache = {
    value: auth.access_token,
    expiresAt: Date.now() + (Number(auth.expires_in) || 3600) * 1000,
  };
  return tokenCache.value;
}

/** Cached until shortly before it expires; concurrent calls share one request */
async function getToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
  if (!tokenRequest) {
    tokenRequest = requestToken().finally(() => {
      tokenRequest = null;
    });
  }
  return await tokenRequest;
}

async function fetchListing(path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    try {
      return await fetchJson(`${API_BASE}${path}`, {
        params: { ...params, raw_json: 1 },
        headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
        timeoutMs: 15000,
      });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401 && attempt === 0) {
        tokenCache = null; // expired or revoked: ask for a new one
        continue;
      }
      if (status === 404 || status === 403) {
        const notFound = new Error("Subreddit not found");
        notFound.code = "SUBREDDIT_NOT_FOUND";
        throw notFound;
      }
      throw err;
    }
  }
  throw new Error("Reddit rejected the access token");
}

/**
 * "r/memes cats" -> { subreddit: "memes", search: "cats" }; "cats" -> { subreddit: "all", search: "cats" }.
 * `invalid` is true when a subreddit was given but its name is not valid.
 */
function parseInput(input) {
  const text = String(input || "").trim();
  const [first = "", ...rest] = text.split(/\s+/);
  const search = rest.join(" ").slice(0, MAX_SEARCH_LENGTH);

  let candidate = null;
  const prefixed = first.match(/^\/?r\/([^/?#]*)/i);
  if (prefixed) {
    candidate = prefixed[1];
  } else if (/^https?:\/\//i.test(first)) {
    // a pasted subreddit link
    try {
      const url = new URL(first);
      const path = url.pathname.match(/^\/r\/([^/]*)/i);
      if (REDDIT_WEB_HOSTS.has(url.hostname.toLowerCase()) && path) candidate = path[1];
    } catch (e) {
      // not a link: searched as text
    }
  }

  if (candidate === null) return { subreddit: "all", search: text.slice(0, MAX_SEARCH_LENGTH), invalid: false };
  return { subreddit: candidate, search, invalid: !SUBREDDIT_RE.test(candidate) };
}

/** Direct image link of a post, only on the allowed hosts, or null */
function imageUrlOf(post) {
  let url;
  try {
    url = new URL(String(post.url_overridden_by_dest || post.url || ""));
  } catch (e) {
    return null;
  }
  if (url.protocol !== "https:" || !MEDIA_HOSTS.has(url.hostname.toLowerCase())) return null;
  // pathname has no query string: preview.redd.it/x.jpg?width=640 still ends in .jpg
  const ext = url.pathname.split(".").pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? url.href : null;
}

function formatPost(index, post) {
  let text = getLang(
    "plugins.reddit.post",
    index + 1,
    String(post.title || "").slice(0, 200),
    post.author || "[deleted]",
    post.ups ?? 0,
    post.num_comments ?? 0,
    `${WEB_BASE}${post.permalink || ""}`
  );
  // an external link (article, video...) next to the discussion link
  const external = post.is_self ? "" : String(post.url || "");
  if (external && !external.includes(post.permalink || "\u0000")) {
    text += `\n${getLang("plugins.reddit.link", external)}`;
  }
  return text;
}

module.exports = {
  // used by the key test of the panel (settings-catalog.md section 7): Reddit wants the same agent
  USER_AGENT,

  command: {
    pattern: "reddit",
    desc: getLang("plugins.reddit.desc"),
    type: "search",
  },

  async execute(message, argsString) {
    const input = (argsString || message.getQuotedText()).trim();

    if (!input) {
      return await message.reply(getLang("plugins.reddit.usage", config.PREFIX));
    }

    if (!hasKeys()) {
      return await message.reply(getLang("common.not_configured"));
    }

    const { subreddit, search, invalid } = parseInput(input);
    if (invalid) {
      return await message.reply(getLang("plugins.reddit.invalid_subreddit"));
    }

    try {
      await message.react("🔍");

      const data = search
        ? await fetchListing(`/r/${subreddit}/search`, {
            q: search,
            restrict_sr: 1,
            sort: "relevance",
            limit: LISTING_LIMIT,
          })
        : await fetchListing(`/r/${subreddit}/hot`, { limit: LISTING_LIMIT });

      const children = Array.isArray(data?.data?.children) ? data.data.children : [];
      const posts = children
        .filter((c) => c && c.kind === "t3" && c.data)
        .map((c) => c.data)
        .filter((p) => !p.over_18 && !p.stickied)
        .slice(0, SHOWN_POSTS);

      if (posts.length === 0) {
        await message.react("❌");
        return await message.reply(getLang("plugins.reddit.no_results"));
      }

      const header = getLang("plugins.reddit.header", subreddit);
      await message.reply(`${header}\n\n${posts.map((p, i) => formatPost(i, p)).join("\n\n")}`);

      // The first listed post that is a plain image on an allowed host
      const withImage = posts.find((p) => imageUrlOf(p));
      if (withImage) {
        try {
          const { buffer } = await fetchBuffer(imageUrlOf(withImage), {
            maxBytes: IMAGE_MAX_BYTES,
            timeoutMs: 20000,
          });
          await message.sendImage(
            buffer,
            `${String(withImage.title || "").slice(0, 200)}\n${WEB_BASE}${withImage.permalink || ""}`
          );
        } catch (err) {
          // the text with the links was already sent
          console.error("Reddit image error:", safeLog(err));
        }
      }

      await message.react("✅");
    } catch (err) {
      await message.react("❌");

      if (err?.code === "SUBREDDIT_NOT_FOUND") {
        return await message.reply(getLang("plugins.reddit.not_found"));
      }
      if (err?.code === "REDDIT_BAD_CREDENTIALS") {
        console.error("Reddit credentials rejected:", safeLog(err));
        return await message.reply(getLang("common.not_configured"));
      }

      const kind = classifyError(err, { hasKey: true });
      if (kind === "error") throw err;

      console.error("Reddit error:", safeLog(err));
      await message.reply(getLang(replyKeyFor(kind), config.MAX_UPLOAD));
    }
  },

  // exposed for tests
  parseInput,
  imageUrlOf,
};
