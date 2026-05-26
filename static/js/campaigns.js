"use strict";

let campData = {};
let currentRange = 7;
let settingsOpen = false;

const PLATFORM_LABELS = {
  meta:     "Meta Ads",
  google:   "Google Ads",
  amazon:   "Amazon Ads",
  flipkart: "Flipkart Ads",
};

const PLATFORM_ORDER = ["meta", "google", "amazon", "flipkart"];

const CREDENTIALS_META = [
  {
    id: "meta", label: "Meta Ads",
    guide: "developers.facebook.com → My Apps → Create App → Marketing API → System Users → Generate token (ads_read)",
    fields: [
      { key: "access_token",  label: "Access Token",  type: "password", ph: "System user access token with ads_read scope" },
      { key: "ad_account_id", label: "Ad Account ID", type: "text",     ph: "act_XXXXXXXXXX (from Business Manager → Ad Accounts)" },
    ],
  },
  {
    id: "google", label: "Google Ads",
    guide: "console.cloud.google.com → Enable Google Ads API → Create OAuth 2.0 credentials → ads.google.com → Tools → API Center for developer token",
    fields: [
      { key: "developer_token", label: "Developer Token",   type: "password", ph: "From ads.google.com → Tools → API Center (takes 1–3 days)" },
      { key: "client_id",       label: "OAuth Client ID",   type: "text",     ph: "From Google Cloud Console → OAuth 2.0 Client IDs" },
      { key: "client_secret",   label: "OAuth Client Secret", type: "password", ph: "Same page as Client ID" },
      { key: "refresh_token",   label: "Refresh Token",     type: "password", ph: "Generated via OAuth Playground or google-auth-oauthlib" },
      { key: "customer_id",     label: "Customer ID",       type: "text",     ph: "10-digit Google Ads account ID (no dashes)" },
    ],
  },
  {
    id: "amazon", label: "Amazon Ads",
    guide: "advertising.amazon.com → Developer Console → Register as developer → Create LWA app → Run one-time OAuth flow for refresh token",
    fields: [
      { key: "client_id",      label: "LWA Client ID",     type: "text",     ph: "From LWA app in Amazon Developer Console" },
      { key: "client_secret",  label: "LWA Client Secret", type: "password", ph: "From the same LWA app page" },
      { key: "refresh_token",  label: "Refresh Token",     type: "password", ph: "From one-time OAuth authorization flow" },
      { key: "profile_id",     label: "Profile ID",        type: "text",     ph: "From GET /v2/profiles — your advertiser profile ID" },
      { key: "region",         label: "Region",            type: "text",     ph: "na · eu · fe" },
    ],
  },
  {
    id: "flipkart", label: "Flipkart Ads",
    guide: "Flipkart Seller Hub → Settings → API Access → Generate API Key",
    fields: [
      { key: "api_key",   label: "API Key",   type: "password", ph: "From Flipkart Seller Hub → Settings → API Access" },
      { key: "seller_id", label: "Seller ID", type: "text",     ph: "From Flipkart Seller Hub → Profile" },
    ],
  },
];

// ── Utilities ──────────────────────────────────────────────────────────────

const fmt = (n) =>
  typeof n === "number"
    ? "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })
    : "—";

function showToast(msg, duration = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), duration);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) { window.location.href = "/login"; return {}; }
  return res.json();
}

// ── Skeleton loaders ──────────────────────────────────────────────────────

function renderSkeletons() {
  return PLATFORM_ORDER.map((p) => `
    <div class="skel-card">
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;">
        <span class="platform-badge platform-${p}">${PLATFORM_LABELS[p]}</span>
      </div>
      <div class="skeleton" style="height:48px;border-radius:8px;margin-bottom:.75rem;"></div>
      <div class="skeleton" style="height:80px;border-radius:8px;"></div>
    </div>`
  ).join("");
}

// ── Platform rendering ─────────────────────────────────────────────────────

function renderPlatforms(data) {
  document.getElementById("platforms").innerHTML =
    PLATFORM_ORDER.map((p) => renderPlatformCard(p, data[p] || { ok: false, error: "no_credentials" })).join("");
}

function renderPlatformCard(platform, pdata) {
  const label = PLATFORM_LABELS[platform];

  if (!pdata || !pdata.ok) {
    const noCreds = !pdata || pdata.error === "no_credentials";
    return `
      <div class="platform-card">
        <div class="platform-header">
          <span class="platform-badge platform-${platform}">${label}</span>
        </div>
        <div class="platform-empty ${noCreds ? "" : "platform-error"}">
          ${noCreds
            ? `<span class="empty-icon">🔑</span>No credentials — add them in
               <a href="#" onclick="openSettings();return false;">Platform Credentials</a> below`
            : `<span class="empty-icon">⚠</span>${escHtml(pdata.error || "Connection failed")}
               <button class="btn btn-outline btn-sm" style="margin-left:.75rem"
                 onclick="retryPlatform('${platform}')">Retry</button>`
          }
        </div>
      </div>`;
  }

  const t   = pdata.totals || {};
  const cam = pdata.campaigns || [];

  return `
    <div class="platform-card">
      <div class="platform-header">
        <span class="platform-badge platform-${platform}">${label}</span>
        <div class="platform-totals">
          <span class="ptotal"><span class="ptotal-label">Spend</span><strong>${fmt(t.spend)}</strong></span>
          <span class="ptotal"><span class="ptotal-label">Conv.</span><strong>${t.conversions ?? "—"}</strong></span>
          <span class="ptotal"><span class="ptotal-label">Revenue</span><strong>${fmt(t.revenue)}</strong></span>
          <span class="ptotal roas-badge"><span class="ptotal-label">ROAS</span><strong>${t.roas ? t.roas.toFixed(1) + "x" : "—"}</strong></span>
        </div>
      </div>
      ${cam.length === 0
        ? `<div class="platform-empty">No active campaigns found for this period.</div>`
        : `<div class="camp-table-wrap">
            <table class="camp-table">
              <thead><tr>
                <th>Campaign</th>
                <th class="num">Spend</th>
                <th class="num">Conv.</th>
                <th class="num">Revenue</th>
                <th class="num">ROAS</th>
              </tr></thead>
              <tbody>
                ${cam.map((c) => `<tr>
                  <td><span class="camp-name" title="${escHtml(c.name)}">${escHtml(c.name)}</span></td>
                  <td class="num">${fmt(c.spend)}</td>
                  <td class="num">${c.conversions}</td>
                  <td class="num">${fmt(c.revenue)}</td>
                  <td class="num roas-cell">${c.roas ? c.roas.toFixed(1) + "x" : "—"}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>`
      }
    </div>`;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Data fetching ──────────────────────────────────────────────────────────

async function loadCampaigns(range, forceRefresh = false) {
  document.getElementById("platforms").innerHTML = renderSkeletons();
  document.getElementById("lastRefreshed").textContent = "";

  let data;
  if (forceRefresh) {
    data = await api("/api/campaigns/refresh", {
      method: "POST",
      body: JSON.stringify({ range }),
    });
  } else {
    data = await api(`/api/campaigns/data?range=${range}`);
  }

  campData = data;
  renderPlatforms(data);

  const now = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("lastRefreshed").textContent = `Updated ${now}`;
}

window.retryPlatform = async function (platform) {
  const idx  = PLATFORM_ORDER.indexOf(platform);
  const card = document.querySelectorAll(".platform-card, .skel-card")[idx];
  if (card) {
    card.innerHTML = `<div class="skeleton" style="height:120px;border-radius:8px;"></div>`;
  }
  const res = await api("/api/campaigns/refresh", {
    method: "POST",
    body: JSON.stringify({ range: currentRange, platform }),
  });
  campData[platform] = res;
  renderPlatforms(campData);
};

// ── Settings / Credentials ─────────────────────────────────────────────────

window.openSettings = function () {
  settingsOpen = true;
  document.getElementById("settingsBody").style.display = "";
  document.getElementById("settingsToggle").textContent = "▾";
  document.getElementById("settingsPanel").scrollIntoView({ behavior: "smooth" });
};

window.toggleSettings = function () {
  settingsOpen = !settingsOpen;
  document.getElementById("settingsBody").style.display = settingsOpen ? "" : "none";
  document.getElementById("settingsToggle").textContent = settingsOpen ? "▾" : "▸";
};

function renderCredentialsForm(cfg) {
  return CREDENTIALS_META.map((p, idx) => `
    <div>
      ${idx > 0 ? '<hr style="border-color:var(--border);margin:1.25rem 0;">' : ""}
      <div class="cred-platform-title">${p.label}</div>
      <div class="cred-guide">📋 ${p.guide}</div>
      <div class="cred-fields">
        ${p.fields.map((f) => {
          const val = (cfg[p.id] || {})[f.key] || "";
          return `<div class="form-group">
            <label>${f.label}</label>
            <input type="${f.type}" class="cred-input"
              data-platform="${p.id}" data-key="${f.key}"
              value="${escHtml(val)}" placeholder="${escHtml(f.ph)}" autocomplete="off" />
          </div>`;
        }).join("")}
      </div>
      <div style="display:flex;align-items:center;gap:.625rem;margin-top:.75rem;">
        <button class="btn btn-outline btn-sm" onclick="testPlatform('${p.id}')">Test Connection</button>
        <span id="testResult_${p.id}" style="font-size:12px;"></span>
      </div>
    </div>`
  ).join("") + `
    <div style="display:flex;align-items:center;gap:.75rem;margin-top:1.5rem;
                padding-top:1rem;border-top:1px solid var(--border);">
      <button class="btn btn-primary btn-sm" id="saveCredsBtn">Save Credentials</button>
      <span id="saveCredsMsg" style="font-size:12px;color:var(--green);"></span>
    </div>`;
}

async function loadSettings() {
  const cfg = await api("/api/campaigns/settings");
  document.getElementById("settingsBody").innerHTML = renderCredentialsForm(cfg);
  document.getElementById("saveCredsBtn").addEventListener("click", saveCredentials);
}

async function saveCredentials() {
  const patch = {};
  document.querySelectorAll(".cred-input").forEach((inp) => {
    const p = inp.dataset.platform;
    const k = inp.dataset.key;
    if (!patch[p]) patch[p] = {};
    patch[p][k] = inp.value;
  });

  const res = await api("/api/campaigns/settings", {
    method: "POST",
    body: JSON.stringify(patch),
  });

  if (res.success) {
    const msg = document.getElementById("saveCredsMsg");
    msg.textContent = "✓ Saved";
    setTimeout(() => { msg.textContent = ""; }, 3000);
    await loadSettings();
  } else {
    showToast("Failed to save credentials.");
  }
}

window.testPlatform = async function (platform) {
  const el = document.getElementById(`testResult_${platform}`);
  el.style.color = "var(--text-muted)";
  el.textContent = "Testing…";

  const res = await api("/api/campaigns/refresh", {
    method: "POST",
    body: JSON.stringify({ range: currentRange, platform }),
  });

  if (res.ok) {
    el.style.color = "var(--green)";
    el.textContent = `✓ Connected — ${res.campaigns?.length ?? 0} active campaign(s)`;
    campData[platform] = res;
    renderPlatforms(campData);
  } else {
    el.style.color = "var(--red)";
    el.textContent = `✗ ${res.error || "Connection failed"}`;
  }
};

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all([
    loadCampaigns(currentRange),
    loadSettings(),
  ]);

  document.getElementById("rangeSelect").addEventListener("change", async (e) => {
    currentRange = parseInt(e.target.value, 10);
    await loadCampaigns(currentRange);
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await loadCampaigns(currentRange, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Refresh";
    }
  });
});
