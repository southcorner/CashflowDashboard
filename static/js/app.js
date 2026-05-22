"use strict";

// ── State ──────────────────────────────────────────────────────────────────
let state = { data: {}, settings: {}, audit: [] };
let charts = {};

// ── Utilities ──────────────────────────────────────────────────────────────
const fmt = (n) =>
  typeof n === "number"
    ? "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })
    : n ?? "—";

const fmtSigned = (n) => {
  if (typeof n !== "number") return "—";
  const s = "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return n < 0 ? `-${s}` : s;
};

function showToast(msg, duration = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), duration);
}

function showMsg(elId, text, type = "success") {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

function sortedDates(data) {
  return Object.keys(data).sort();
}

function filterByDays(data, days) {
  if (!days) return data;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(data).filter(([d]) => d >= cutoffStr));
}

function filterByRange(data, start, end) {
  return Object.fromEntries(
    Object.entries(data).filter(([d]) => (!start || d >= start) && (!end || d <= end))
  );
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadAll() {
  const [data, settings, audit] = await Promise.all([
    api("/api/data"),
    api("/api/settings"),
    api("/api/audit"),
  ]);
  state.data = data;
  state.settings = settings;
  state.audit = audit;
}

// ── Navigation ─────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      const tab = item.dataset.tab;
      document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      item.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
      if (tab === "dashboard") renderDashboard();
      if (tab === "entry") renderEntryForm();
      if (tab === "reports") renderReports();
      if (tab === "settings") renderSettings();
      if (tab === "audit") renderAudit();
    });
  });
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function renderDashboard() {
  const days = parseInt(document.getElementById("dashFilter").value, 10);
  const filtered = filterByDays(state.data, days);
  const dates = sortedDates(filtered);
  const today = dates[dates.length - 1];
  const todayRow = today ? filtered[today] : {};
  const prevDate = dates[dates.length - 2];
  const prevRow = prevDate ? filtered[prevDate] : {};

  // KPIs
  const totalIncoming = dates.reduce((s, d) => s + (filtered[d].incoming || 0), 0);
  const totalOutgoing = dates.reduce((s, d) => s + (filtered[d].outgoing || 0), 0);
  const totalCogs = dates.reduce((s, d) => s + (filtered[d].cogs || 0), 0);
  const totalOutstanding = Object.values(todayRow.outstanding || {}).reduce((s, v) => s + v, 0);
  const totalSales = dates.reduce((s, d) => s + Object.values(filtered[d].sales || {}).reduce((a, b) => a + b, 0), 0);
  const netCashflow = totalIncoming - totalOutgoing;
  const latestBal = today
    ? (todayRow.starting_balance || 0) + (todayRow.incoming || 0) - (todayRow.outgoing || 0)
    : 0;

  const prevBal = prevDate
    ? (prevRow.starting_balance || 0) + (prevRow.incoming || 0) - (prevRow.outgoing || 0)
    : null;
  const balChange = prevBal !== null ? latestBal - prevBal : null;

  const kpis = [
    {
      label: "Current Balance",
      value: fmt(latestBal),
      sub: today ? `as of ${today}` : "no data",
      change: balChange,
      color: "var(--accent)",
    },
    {
      label: "Total Incoming",
      value: fmt(totalIncoming),
      sub: days ? `last ${days} days` : "all time",
      color: "var(--green)",
    },
    {
      label: "Total Outgoing",
      value: fmt(totalOutgoing),
      sub: "expenses",
      color: "var(--red)",
    },
    {
      label: "Total Outstanding",
      value: fmt(totalOutstanding),
      sub: "from AMZ, FK, Offline",
      color: "var(--orange)",
    },
    {
      label: "Total Sales",
      value: fmt(totalSales),
      sub: "across all channels",
      color: "var(--purple)",
    },
  ];

  // Add custom column KPI if defined
  const customCols = state.settings.custom_columns || [];
  if (customCols.length && today && todayRow.custom) {
    const col = customCols[0];
    const val = todayRow.custom[col.name];
    kpis.push({
      label: col.name,
      value: typeof val === "number" ? fmt(val) : String(val ?? "—"),
      sub: `today (${today})`,
      color: "var(--accent2)",
    });
  }

  const grid = document.getElementById("kpiGrid");
  grid.innerHTML = kpis
    .map(
      (k) => `
    <div class="kpi-card" style="--accent-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value">${k.value}</div>
      <div class="kpi-sub">${k.sub || ""}</div>
      ${
        k.change !== undefined && k.change !== null
          ? `<div class="kpi-change ${k.change >= 0 ? "up" : "down"}">
               ${k.change >= 0 ? "▲" : "▼"} ${fmt(Math.abs(k.change))} vs prev day
             </div>`
          : ""
      }
    </div>`
    )
    .join("");

  document.getElementById("lastUpdated").textContent =
    today ? `Last entry: ${today}` : "No data yet — enter your first record.";

  renderCharts(filtered, dates);
}

function renderCharts(data, dates) {
  const COLORS = {
    green: "#10b981",
    red: "#ef4444",
    orange: "#f59e0b",
    accent: "#6366f1",
    accent2: "#06b6d4",
  };

  const channelPalette = [
    "#6366f1","#06b6d4","#10b981","#f59e0b","#a855f7","#ef4444",
    "#ec4899","#84cc16","#14b8a6","#f97316",
  ];

  function destroyChart(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  // ── Cashflow line chart ──
  destroyChart("cashflow");
  const cfCtx = document.getElementById("cashflowChart").getContext("2d");
  charts["cashflow"] = new Chart(cfCtx, {
    type: "line",
    data: {
      labels: dates,
      datasets: [
        {
          label: "Incoming",
          data: dates.map((d) => data[d].incoming || 0),
          borderColor: COLORS.green,
          backgroundColor: "rgba(16,185,129,0.08)",
          tension: 0.3,
          fill: true,
          pointRadius: 3,
        },
        {
          label: "Outgoing",
          data: dates.map((d) => data[d].outgoing || 0),
          borderColor: COLORS.red,
          backgroundColor: "rgba(239,68,68,0.08)",
          tension: 0.3,
          fill: true,
          pointRadius: 3,
        },
        {
          label: "COGS",
          data: dates.map((d) => data[d].cogs || 0),
          borderColor: COLORS.orange,
          backgroundColor: "rgba(245,158,11,0.06)",
          tension: 0.3,
          fill: false,
          pointRadius: 3,
          borderDash: [4, 4],
        },
      ],
    },
    options: chartOptions("₹"),
  });

  // ── Outstanding doughnut ──
  destroyChart("outstanding");
  const outCtx = document.getElementById("outstandingChart").getContext("2d");
  const outChannels = state.settings.outstanding_channels || [];
  const latestDate = dates[dates.length - 1];
  const latestOutstanding = latestDate ? (data[latestDate].outstanding || {}) : {};
  charts["outstanding"] = new Chart(outCtx, {
    type: "doughnut",
    data: {
      labels: outChannels,
      datasets: [{
        data: outChannels.map((c) => latestOutstanding[c] || 0),
        backgroundColor: channelPalette,
        borderWidth: 1,
        borderColor: "#111827",
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { color: "#94a3b8", boxWidth: 12, font: { size: 12 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ₹${ctx.raw.toLocaleString("en-IN")}` } },
      },
    },
  });

  // ── Sales bar chart ──
  destroyChart("sales");
  const salesCtx = document.getElementById("salesChart").getContext("2d");
  const salesChannels = state.settings.sales_channels || [];
  charts["sales"] = new Chart(salesCtx, {
    type: "bar",
    data: {
      labels: dates,
      datasets: salesChannels.map((ch, i) => ({
        label: ch,
        data: dates.map((d) => (data[d].sales || {})[ch] || 0),
        backgroundColor: channelPalette[i % channelPalette.length] + "cc",
        borderRadius: 4,
      })),
    },
    options: { ...chartOptions("₹"), scales: { x: xScale(), y: yScale("₹"), ...chartOptions("₹").scales } },
  });

  // ── Running balance line ──
  destroyChart("balance");
  const balCtx = document.getElementById("balanceChart").getContext("2d");
  let runBal = 0;
  const balData = dates.map((d) => {
    const r = data[d];
    const endBal = (r.starting_balance || runBal) + (r.incoming || 0) - (r.outgoing || 0);
    runBal = endBal;
    return endBal;
  });
  charts["balance"] = new Chart(balCtx, {
    type: "line",
    data: {
      labels: dates,
      datasets: [{
        label: "Balance",
        data: balData,
        borderColor: COLORS.accent2,
        backgroundColor: "rgba(6,182,212,0.1)",
        tension: 0.3,
        fill: true,
        pointRadius: 3,
      }],
    },
    options: chartOptions("₹"),
  });
}

function chartOptions(prefix = "") {
  const gridColor = "rgba(255,255,255,0.05)";
  const tickColor = "#64748b";
  return {
    responsive: true,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#1a2236",
        borderColor: "#1f2d45",
        borderWidth: 1,
        titleColor: "#e2e8f0",
        bodyColor: "#94a3b8",
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label}: ${prefix}${ctx.raw.toLocaleString("en-IN")}`,
        },
      },
    },
    scales: {
      x: xScale(),
      y: yScale(prefix),
    },
  };
}
function xScale() {
  return {
    grid: { color: "rgba(255,255,255,0.04)" },
    ticks: { color: "#64748b", maxTicksLimit: 12, font: { size: 11 } },
  };
}
function yScale(prefix) {
  return {
    grid: { color: "rgba(255,255,255,0.04)" },
    ticks: {
      color: "#64748b",
      font: { size: 11 },
      callback: (v) => `${prefix}${v.toLocaleString("en-IN")}`,
    },
  };
}

// ── Data Entry Form ────────────────────────────────────────────────────────
function renderEntryForm() {
  const salesFields = document.getElementById("salesFields");
  const outstandingFields = document.getElementById("outstandingFields");
  const channels = state.settings.sales_channels || [];
  const outChannels = state.settings.outstanding_channels || [];

  salesFields.innerHTML = channels
    .map(
      (ch) => `
    <div class="form-group">
      <label>${ch} Sales (₹)</label>
      <input type="number" name="sales_${ch}" step="0.01" placeholder="0" />
    </div>`
    )
    .join("");

  outstandingFields.innerHTML = outChannels
    .map(
      (ch) => `
    <div class="form-group">
      <label>${ch} Outstanding (₹)</label>
      <input type="number" name="outstanding_${ch}" step="0.01" placeholder="0" />
    </div>`
    )
    .join("");

  // Set today's date as default
  const dateInput = document.getElementById("entryDate");
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
}

function collectEntryForm() {
  const form = document.getElementById("entryForm");
  const fd = new FormData(form);
  const channels = state.settings.sales_channels || [];
  const outChannels = state.settings.outstanding_channels || [];

  const sales = {};
  channels.forEach((ch) => { sales[ch] = parseFloat(fd.get(`sales_${ch}`) || 0); });

  const outstanding = {};
  outChannels.forEach((ch) => { outstanding[ch] = parseFloat(fd.get(`outstanding_${ch}`) || 0); });

  return {
    date: fd.get("date"),
    starting_balance: parseFloat(fd.get("starting_balance") || 0),
    incoming: parseFloat(fd.get("incoming") || 0),
    outgoing: parseFloat(fd.get("outgoing") || 0),
    cogs: parseFloat(fd.get("cogs") || 0),
    notes: fd.get("notes") || "",
    sales,
    outstanding,
  };
}

// ── Reports ────────────────────────────────────────────────────────────────
function renderReports() {
  const start = document.getElementById("reportStart").value;
  const end = document.getElementById("reportEnd").value;
  const lifetime = document.getElementById("lifetimeToggle").checked;

  const filtered = lifetime ? state.data : filterByRange(state.data, start, end);
  const dates = sortedDates(filtered);

  const salesChs = state.settings.sales_channels || [];
  const outChs = state.settings.outstanding_channels || [];
  const custCols = state.settings.custom_columns || [];

  // Summary bar
  const totalIn = dates.reduce((s, d) => s + (filtered[d].incoming || 0), 0);
  const totalOut = dates.reduce((s, d) => s + (filtered[d].outgoing || 0), 0);
  const totalCogs = dates.reduce((s, d) => s + (filtered[d].cogs || 0), 0);
  const totalSales = dates.reduce((s, d) => s + Object.values(filtered[d].sales || {}).reduce((a, b) => a + b, 0), 0);

  document.getElementById("reportSummary").innerHTML = `
    <div class="summary-item">Entries <strong>${dates.length}</strong></div>
    <div class="summary-item">Total Incoming <strong>${fmt(totalIn)}</strong></div>
    <div class="summary-item">Total Outgoing <strong>${fmt(totalOut)}</strong></div>
    <div class="summary-item">Total COGS <strong>${fmt(totalCogs)}</strong></div>
    <div class="summary-item">Net Cashflow <strong style="color:${totalIn - totalOut >= 0 ? "var(--green)" : "var(--red)"}">${fmtSigned(totalIn - totalOut)}</strong></div>
    <div class="summary-item">Total Sales <strong>${fmt(totalSales)}</strong></div>
  `;

  // Table headers
  const head = document.getElementById("reportHead");
  head.innerHTML = `<tr>
    <th>Date</th>
    <th class="num">Starting Bal</th>
    <th class="num">Incoming</th>
    <th class="num">Outgoing</th>
    <th class="num">COGS</th>
    ${salesChs.map((c) => `<th class="num">${c}</th>`).join("")}
    <th class="num">Total Sales</th>
    ${outChs.map((c) => `<th class="num">${c} O/S</th>`).join("")}
    <th class="num">Total O/S</th>
    ${custCols.map((c) => `<th class="num">${c.name}</th>`).join("")}
    <th>Notes</th>
    <th></th>
  </tr>`;

  // Table body
  const body = document.getElementById("reportBody");
  if (!dates.length) {
    body.innerHTML = `<tr><td colspan="99" style="text-align:center;padding:2rem;color:var(--text-muted)">No data for selected period.</td></tr>`;
    return;
  }

  body.innerHTML = dates
    .reverse()
    .map((date) => {
      const r = filtered[date];
      const sales = r.sales || {};
      const outstanding = r.outstanding || {};
      const custom = r.custom || {};
      const totalSalesRow = Object.values(sales).reduce((a, b) => a + b, 0);
      const totalOsRow = Object.values(outstanding).reduce((a, b) => a + b, 0);
      const net = (r.incoming || 0) - (r.outgoing || 0);

      return `<tr>
        <td class="date-cell">${date}</td>
        <td class="num">${fmt(r.starting_balance)}</td>
        <td class="num positive">${fmt(r.incoming)}</td>
        <td class="num negative">${fmt(r.outgoing)}</td>
        <td class="num">${fmt(r.cogs)}</td>
        ${salesChs.map((c) => `<td class="num">${fmt(sales[c] || 0)}</td>`).join("")}
        <td class="num"><strong>${fmt(totalSalesRow)}</strong></td>
        ${outChs.map((c) => `<td class="num">${fmt(outstanding[c] || 0)}</td>`).join("")}
        <td class="num">${fmt(totalOsRow)}</td>
        ${custCols.map((c) => {
          const v = custom[c.name];
          return `<td class="num ${typeof v === "number" ? (v >= 0 ? "positive" : "negative") : ""}">${fmt(v)}</td>`;
        }).join("")}
        <td>${r.notes || ""}</td>
        <td>
          <button class="btn-icon" title="Delete" onclick="openDeleteModal('${date}')">✕</button>
        </td>
      </tr>`;
    })
    .join("");
}

// ── Settings ───────────────────────────────────────────────────────────────
function renderSettings() {
  const s = state.settings;
  renderTagList("salesChannelTags", s.sales_channels || [], "sales");
  renderTagList("outstandingChannelTags", s.outstanding_channels || [], "outstanding");
  renderCustomCols(s.custom_columns || []);
}

function renderTagList(containerId, items, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = items
    .map(
      (item) => `
    <span class="tag">
      ${item}
      <button class="btn-icon" onclick="removeChannel('${type}','${item}')" style="padding:0;font-size:11px;">✕</button>
    </span>`
    )
    .join("");
}

function renderCustomCols(cols) {
  const container = document.getElementById("customColsList");
  container.innerHTML = cols
    .map(
      (col, i) => `
    <div class="custom-col-item">
      <span class="col-name">${col.name}</span>
      <span class="col-formula">${col.formula}</span>
      <button class="btn-icon" onclick="removeCustomCol(${i})">✕</button>
    </div>`
    )
    .join("");
}

async function saveSettings() {
  const res = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(state.settings),
  });
  if (res.success) {
    showToast("Settings saved.");
    await loadAll();
  }
}

window.removeChannel = async function (type, name) {
  if (type === "sales") {
    state.settings.sales_channels = state.settings.sales_channels.filter((c) => c !== name);
  } else {
    state.settings.outstanding_channels = state.settings.outstanding_channels.filter((c) => c !== name);
  }
  await saveSettings();
  renderSettings();
};

window.removeCustomCol = async function (idx) {
  state.settings.custom_columns.splice(idx, 1);
  await saveSettings();
  renderSettings();
};

// ── Audit Log ──────────────────────────────────────────────────────────────
function renderAudit() {
  const body = document.getElementById("auditBody");
  const entries = [...state.audit].reverse();
  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">No audit entries yet.</td></tr>`;
    return;
  }
  body.innerHTML = entries
    .map(
      (e) => `
    <tr>
      <td>${new Date(e.timestamp).toLocaleString("en-IN")}</td>
      <td><span style="color:${e.action.includes("delete") ? "var(--red)" : "var(--orange)"}">${e.action}</span></td>
      <td class="date-cell">${e.date}</td>
      <td class="num">${fmt(e.original?.starting_balance)}</td>
      <td class="num positive">${fmt(e.original?.incoming)}</td>
      <td class="num negative">${fmt(e.original?.outgoing)}</td>
      <td class="num">${fmt(e.original?.cogs)}</td>
      <td>${e.original?.notes || ""}</td>
    </tr>`
    )
    .join("");
}

// ── Delete modal ───────────────────────────────────────────────────────────
let deleteDateTarget = null;

window.openDeleteModal = function (date) {
  deleteDateTarget = date;
  document.getElementById("deleteDate").textContent = date;
  document.getElementById("deletePassword").value = "";
  document.getElementById("deleteMsg").classList.add("hidden");
  document.getElementById("deleteModal").classList.remove("hidden");
};

// ── Event wiring ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadAll();
  initNav();
  renderDashboard();

  // Dashboard filter
  document.getElementById("dashFilter").addEventListener("change", renderDashboard);

  // Entry form submit
  document.getElementById("entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = collectEntryForm();
    if (!payload.date) { showMsg("entryMsg", "Please select a date.", "error"); return; }
    const res = await api("/api/data", { method: "POST", body: JSON.stringify(payload) });
    if (res.success) {
      showMsg("entryMsg", `Entry for ${payload.date} saved successfully.`, "success");
      await loadAll();
    } else {
      showMsg("entryMsg", res.error || "Failed to save.", "error");
    }
  });

  // Clear form
  document.getElementById("clearFormBtn").addEventListener("click", () => {
    document.getElementById("entryForm").reset();
    document.getElementById("entryDate").value = new Date().toISOString().slice(0, 10);
  });

  // Reports: lifetime toggle
  document.getElementById("lifetimeToggle").addEventListener("change", (e) => {
    document.getElementById("reportStart").disabled = e.target.checked;
    document.getElementById("reportEnd").disabled = e.target.checked;
    renderReports();
  });
  document.getElementById("reportStart").addEventListener("change", renderReports);
  document.getElementById("reportEnd").addEventListener("change", renderReports);

  // Set default report date range (last 30 days)
  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  document.getElementById("reportEnd").value = today;
  document.getElementById("reportStart").value = d30.toISOString().slice(0, 10);

  // Export
  document.getElementById("exportBtn").addEventListener("click", () => {
    const start = document.getElementById("reportStart").value;
    const end = document.getElementById("reportEnd").value;
    const lifetime = document.getElementById("lifetimeToggle").checked;
    let url = "/api/export";
    if (!lifetime) url += `?start=${start}&end=${end}`;
    window.location.href = url;
  });

  // Settings: add sales channel
  document.getElementById("addSalesChannelBtn").addEventListener("click", async () => {
    const input = document.getElementById("newSalesChannel");
    const name = input.value.trim();
    if (!name) return;
    if (state.settings.sales_channels.includes(name)) { showToast("Channel already exists."); return; }
    state.settings.sales_channels.push(name);
    input.value = "";
    await saveSettings();
    renderSettings();
  });

  // Settings: add outstanding channel
  document.getElementById("addOutstandingChannelBtn").addEventListener("click", async () => {
    const input = document.getElementById("newOutstandingChannel");
    const name = input.value.trim();
    if (!name) return;
    if (state.settings.outstanding_channels.includes(name)) { showToast("Channel already exists."); return; }
    state.settings.outstanding_channels.push(name);
    input.value = "";
    await saveSettings();
    renderSettings();
  });

  // Settings: add custom column
  document.getElementById("addCustomColBtn").addEventListener("click", async () => {
    const name = document.getElementById("newColName").value.trim();
    const formula = document.getElementById("newColFormula").value.trim();
    if (!name || !formula) { showToast("Name and formula are required."); return; }
    state.settings.custom_columns = state.settings.custom_columns || [];
    state.settings.custom_columns.push({ name, formula });
    document.getElementById("newColName").value = "";
    document.getElementById("newColFormula").value = "";
    await saveSettings();
    renderSettings();
  });

  // Settings: update password
  document.getElementById("savePasswordBtn").addEventListener("click", async () => {
    const np = document.getElementById("newPassword").value;
    const cp = document.getElementById("confirmPassword").value;
    if (!np) { showMsg("passwordMsg", "Enter a new password.", "error"); return; }
    if (np !== cp) { showMsg("passwordMsg", "Passwords do not match.", "error"); return; }
    state.settings.delete_password = np;
    await saveSettings();
    document.getElementById("newPassword").value = "";
    document.getElementById("confirmPassword").value = "";
    showMsg("passwordMsg", "Password updated.", "success");
  });

  // Import Excel
  document.getElementById("importBtn").addEventListener("click", () => {
    document.getElementById("importFile").click();
  });
  document.getElementById("importFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/import", { method: "POST", body: fd }).then((r) => r.json());
    await loadAll();
    if (res.imported !== undefined) {
      showToast(`Imported ${res.imported} rows.${res.errors?.length ? ` (${res.errors.length} errors)` : ""}`);
    } else {
      showToast(res.error || "Import failed.");
    }
    e.target.value = "";
  });

  // Delete modal
  document.getElementById("deleteCancelBtn").addEventListener("click", () => {
    document.getElementById("deleteModal").classList.add("hidden");
  });
  document.getElementById("deleteConfirmBtn").addEventListener("click", async () => {
    const pwd = document.getElementById("deletePassword").value;
    const res = await api(`/api/data/${deleteDateTarget}`, {
      method: "DELETE",
      body: JSON.stringify({ password: pwd }),
    });
    if (res.success) {
      document.getElementById("deleteModal").classList.add("hidden");
      showToast(`Entry for ${deleteDateTarget} deleted.`);
      await loadAll();
      renderReports();
    } else {
      showMsg("deleteMsg", res.error || "Failed.", "error");
    }
  });
  document.getElementById("deleteModal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("deleteModal")) {
      document.getElementById("deleteModal").classList.add("hidden");
    }
  });

  // Enter key on settings inputs
  document.getElementById("newSalesChannel").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("addSalesChannelBtn").click();
  });
  document.getElementById("newOutstandingChannel").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("addOutstandingChannelBtn").click();
  });
});
