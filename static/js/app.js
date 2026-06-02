"use strict";

// ── Auth context ───────────────────────────────────────────────────────────
const IS_ADMIN = document.body.dataset.isAdmin === "true";
const CURRENT_USER = document.body.dataset.username;

// ── State ──────────────────────────────────────────────────────────────────
let state = { data: {}, settings: {}, audit: [] };
const rpt = { sort: { col: null, dir: "asc" }, hidden: new Set(), filters: [] };
let charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

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
  if (res.status === 401) {
    window.location.href = "/login";
    return {};
  }
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

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const GAP_START_DATE = new Date(2026, 4, 23); // May 23 2026, local time

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

  // Add custom column KPIs (cumulative over the filtered period)
  const customCols = state.settings.custom_columns || [];
  customCols.forEach((col) => {
    const total = dates.reduce((s, d) => {
      const val = (filtered[d].custom || {})[col.name];
      return s + (typeof val === "number" ? val : 0);
    }, 0);
    kpis.push({
      label: col.name,
      value: fmt(total),
      sub: days ? `last ${days} days` : "all time",
      color: "var(--accent2)",
    });
  });

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

  renderCustomCharts(data, dates);
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

// ── Custom Charts ──────────────────────────────────────────────────────────

function getCustomFieldValue(row, fieldKey) {
  if (!row) return 0;
  switch (fieldKey) {
    case "incoming":          return row.incoming          || 0;
    case "outgoing":          return row.outgoing          || 0;
    case "cogs":              return row.cogs              || 0;
    case "vendor_payments":   return row.vendor_payments   || 0;
    case "starting_balance":  return row.starting_balance  || 0;
    case "total_sales":       return Object.values(row.sales       || {}).reduce((a,b)=>a+b, 0);
    case "total_outstanding": return Object.values(row.outstanding || {}).reduce((a,b)=>a+b, 0);
    default:
      if (fieldKey.startsWith("s:")) return (row.sales       || {})[fieldKey.slice(2)] || 0;
      if (fieldKey.startsWith("o:")) return (row.outstanding || {})[fieldKey.slice(2)] || 0;
      if (fieldKey.startsWith("c:")) return (row.custom      || {})[fieldKey.slice(2)] || 0;
      return 0;
  }
}

function buildCustomChartFieldOptions() {
  const salesCh = state.settings.sales_channels        || [];
  const outCh   = state.settings.outstanding_channels  || [];
  const custCol = state.settings.custom_columns        || [];
  return [
    { v: "incoming",          l: "Incoming"          },
    { v: "outgoing",          l: "Outgoing"          },
    { v: "cogs",              l: "COGS"              },
    { v: "vendor_payments",   l: "Vendor Payments"   },
    { v: "starting_balance",  l: "Starting Balance"  },
    { v: "total_sales",       l: "Total Sales"       },
    { v: "total_outstanding", l: "Total Outstanding" },
    ...salesCh.map(ch => ({ v: `s:${ch}`, l: `${ch} (Sales)`        })),
    ...outCh.map(ch   => ({ v: `o:${ch}`, l: `${ch} (Outstanding)` })),
    ...custCol.map(c  => ({ v: `c:${c.name}`, l: c.name             })),
  ].map(f => `<option value="${escHtml(f.v)}">${escHtml(f.l)}</option>`).join("");
}

function renderCustomChartsSettings() {
  const container = document.getElementById("customChartsList");
  if (!container) return;
  const customCharts = state.settings.custom_charts || [];

  const TYPE_LABELS = { line: "Line", bar: "Bar", doughnut: "Doughnut" };
  const fieldLabel = (key) => {
    const salesCh = state.settings.sales_channels        || [];
    const outCh   = state.settings.outstanding_channels  || [];
    const custCol = state.settings.custom_columns        || [];
    const map = {
      incoming: "Incoming", outgoing: "Outgoing", cogs: "COGS",
      starting_balance: "Starting Balance", total_sales: "Total Sales",
      total_outstanding: "Total Outstanding",
    };
    salesCh.forEach(ch => { map[`s:${ch}`] = `${ch} (Sales)`;        });
    outCh.forEach(ch   => { map[`o:${ch}`] = `${ch} (Outstanding)`;  });
    custCol.forEach(c  => { map[`c:${c.name}`] = c.name;             });
    return map[key] || key;
  };

  container.innerHTML = customCharts.map((c, i) => `
    <div class="custom-col-item">
      <span class="col-name">${escHtml(c.name)}</span>
      <span class="col-formula">${TYPE_LABELS[c.type] || c.type} · ${escHtml(fieldLabel(c.field))}</span>
      <button class="btn-icon" onclick="removeCustomChart(${i})">✕</button>
    </div>`).join("");

  const sel = document.getElementById("newChartField");
  if (sel) sel.innerHTML = buildCustomChartFieldOptions();
}

function renderCustomCharts(filtered, dates) {
  const container = document.getElementById("customChartsGrid");
  if (!container) return;

  Object.keys(charts)
    .filter(k => k.startsWith("custom_"))
    .forEach(k => { charts[k].destroy(); delete charts[k]; });

  const customCharts = state.settings.custom_charts || [];
  if (!customCharts.length) { container.innerHTML = ""; return; }

  const salesCh = state.settings.sales_channels       || [];
  const outCh   = state.settings.outstanding_channels || [];
  const palette = ["#6366f1","#06b6d4","#10b981","#f59e0b","#a855f7","#ef4444","#ec4899","#84cc16","#14b8a6","#f97316"];

  container.innerHTML = customCharts.map((c, i) => `
    <div class="chart-card${c.type !== "doughnut" ? " wide" : ""}">
      <div class="chart-card-header">
        <h3>${escHtml(c.name)}</h3>
        <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;">${c.type}</span>
      </div>
      <canvas id="customChart_${i}" height="${c.type === "doughnut" ? "180" : "100"}"></canvas>
    </div>`).join("");

  customCharts.forEach((c, i) => {
    const ctx   = document.getElementById(`customChart_${i}`).getContext("2d");
    const color = palette[i % palette.length];

    if (c.type === "doughnut") {
      let labels, values;
      if (c.field === "total_sales") {
        labels = salesCh;
        values = salesCh.map(ch => dates.reduce((s, d) => s + ((filtered[d].sales || {})[ch] || 0), 0));
      } else if (c.field === "total_outstanding") {
        const ld = dates[dates.length - 1];
        const lr = ld ? filtered[ld] : {};
        labels = outCh;
        values = outCh.map(ch => (lr.outstanding || {})[ch] || 0);
      } else {
        const total = dates.reduce((s, d) => s + getCustomFieldValue(filtered[d], c.field), 0);
        labels = [c.name];
        values = [total];
      }
      charts[`custom_${i}`] = new Chart(ctx, {
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: palette, borderWidth: 1, borderColor: "#111827" }] },
        options: {
          responsive: true,
          plugins: {
            legend: { position: "bottom", labels: { color: "#94a3b8", boxWidth: 12, font: { size: 12 } } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ₹${ctx.raw.toLocaleString("en-IN")}` } },
          },
        },
      });
    } else {
      charts[`custom_${i}`] = new Chart(ctx, {
        type: c.type,
        data: {
          labels: dates,
          datasets: [{
            label: c.name,
            data: dates.map(d => getCustomFieldValue(filtered[d], c.field)),
            borderColor: color,
            backgroundColor: color + (c.type === "line" ? "22" : "bb"),
            tension: 0.3,
            fill: c.type === "line",
            pointRadius: 3,
            borderRadius: c.type === "bar" ? 4 : undefined,
          }],
        },
        options: chartOptions("₹"),
      });
    }
  });
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

  if (!dateInput._fillWired) {
    dateInput.addEventListener("change", () => fillEntryForm(dateInput.value));
    dateInput._fillWired = true;
  }
  fillEntryForm(dateInput.value);
  renderGapCalendar();
}

function fillEntryForm(date) {
  const preview = document.getElementById("computedPreview");
  const computedFields = document.getElementById("computedFields");
  const form = document.getElementById("entryForm");

  const channels    = state.settings.sales_channels        || [];
  const outChannels = state.settings.outstanding_channels  || [];

  const row = state.data[date];
  if (!row) {
    // Clear all fields so stale data from a previously viewed date isn't retained
    ["starting_balance", "incoming", "outgoing", "cogs", "vendor_payments", "notes"].forEach((n) => {
      if (form.elements[n]) form.elements[n].value = "";
    });
    channels.forEach((ch) => {
      const el = form.elements[`sales_${ch}`];
      if (el) el.value = "";
    });
    outChannels.forEach((ch) => {
      const el = form.elements[`outstanding_${ch}`];
      if (el) el.value = "";
    });
    preview.classList.add("hidden");
    return;
  }

  // Use form.elements[name] — handles channel names with spaces correctly
  form.elements["starting_balance"].value = row.starting_balance  || "";
  form.elements["incoming"].value         = row.incoming          || "";
  form.elements["outgoing"].value         = row.outgoing          || "";
  form.elements["cogs"].value             = row.cogs              || "";
  form.elements["vendor_payments"].value  = row.vendor_payments   || "";
  form.elements["notes"].value            = row.notes             || "";

  channels.forEach((ch) => {
    const el = form.elements[`sales_${ch}`];
    if (el) el.value = (row.sales || {})[ch] || "";
  });

  outChannels.forEach((ch) => {
    const el = form.elements[`outstanding_${ch}`];
    if (el) el.value = (row.outstanding || {})[ch] || "";
  });

  const customCols = state.settings.custom_columns || [];
  if (customCols.length && row.custom) {
    computedFields.innerHTML = customCols.map((col) => {
      const val = (row.custom || {})[col.name];
      const display = typeof val === "number" ? fmt(val) : (val ?? "—");
      return `<div class="form-group">
        <label>${col.name}</label>
        <div class="computed-value">${display}</div>
      </div>`;
    }).join("");
    preview.classList.remove("hidden");
  } else {
    preview.classList.add("hidden");
  }
}

// ── Gap Calendar ───────────────────────────────────────────────────────────
function renderGapCalendar() {
  const container = document.getElementById("gapCalendar");
  if (!container) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = localDateStr(today);
  const filledDates = new Set(Object.keys(state.data));

  // Count non-Sunday gaps from GAP_START_DATE to today
  let gapCount = 0;
  {
    const d = new Date(GAP_START_DATE);
    while (d <= today) {
      if (d.getDay() !== 0 && !filledDates.has(localDateStr(d))) gapCount++;
      d.setDate(d.getDate() + 1);
    }
  }

  const isOpen = document.getElementById("gapCalendar").dataset.open !== "false";

  const DAY_HEADERS = ["M", "T", "W", "T", "F", "S", "S"];
  let html = `
    <div class="gap-cal-header" onclick="toggleGapCalendar()" style="cursor:pointer;">
      <span class="gap-cal-toggle">${isOpen ? "▾" : "▸"}</span>
      <span class="gap-cal-title">Data Gaps</span>
      <span class="gap-count ${gapCount > 0 ? "has-gaps" : "no-gaps"}">${gapCount} gap${gapCount !== 1 ? "s" : ""}</span>
      <span class="gap-hint">Sundays excluded · click any date to fill it in</span>
    </div>
    <div class="gap-months-row" ${isOpen ? "" : 'style="display:none"'}>`;

  let yr = GAP_START_DATE.getFullYear();
  let mo = GAP_START_DATE.getMonth();
  const endYr = today.getFullYear();
  const endMo = today.getMonth();

  while (yr < endYr || (yr === endYr && mo <= endMo)) {
    const firstOfMonth = new Date(yr, mo, 1);
    const daysInMonth = new Date(yr, mo + 1, 0).getDate();
    const monthLabel = firstOfMonth.toLocaleString("default", { month: "short", year: "numeric" });
    const padCells = (firstOfMonth.getDay() + 6) % 7; // Monday-first padding

    html += `<div class="gap-month">
      <div class="gap-month-label">${monthLabel}</div>
      <div class="gap-grid">
        ${DAY_HEADERS.map(h => `<div class="gap-cell header">${h}</div>`).join("")}
        ${'<div class="gap-cell"></div>'.repeat(padCells)}`;

    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(yr, mo, day);
      const ds = localDateStr(d);
      const isSun = d.getDay() === 0;
      const isToday = ds === todayStr;
      const beforeStart = d < GAP_START_DATE;
      const afterToday = d > today;

      let cls = "gap-cell";
      let attrs = "";

      if (beforeStart || afterToday) {
        cls += " out-range";
      } else if (isSun) {
        cls += " sun";
        attrs = `title="${ds} — Sunday"`;
      } else if (filledDates.has(ds)) {
        cls += " filled";
        attrs = `title="${ds} ✓" onclick="jumpToDate('${ds}')"`;
      } else {
        cls += " missing";
        attrs = `title="${ds} — Missing entry" onclick="jumpToDate('${ds}')"`;
      }
      if (isToday) cls += " today";

      html += `<div class="${cls}" ${attrs}>${day}</div>`;
    }

    html += "</div></div>";
    mo++;
    if (mo > 11) { mo = 0; yr++; }
  }

  html += "</div>";
  container.innerHTML = html;
}

window.jumpToDate = function (dateStr) {
  document.getElementById("entryDate").value = dateStr;
  fillEntryForm(dateStr);
  document.getElementById("entryForm").scrollIntoView({ behavior: "smooth", block: "start" });
};

window.toggleGapCalendar = function () {
  const container = document.getElementById("gapCalendar");
  const isOpen = container.dataset.open !== "false";
  container.dataset.open = isOpen ? "false" : "true";
  renderGapCalendar();
};

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
    incoming:         parseFloat(fd.get("incoming")         || 0),
    outgoing:         parseFloat(fd.get("outgoing")         || 0),
    cogs:             parseFloat(fd.get("cogs")             || 0),
    vendor_payments:  parseFloat(fd.get("vendor_payments")  || 0),
    notes: fd.get("notes") || "",
    sales,
    outstanding,
  };
}

// ── Reports ────────────────────────────────────────────────────────────────

function getReportCols() {
  const sc = state.settings.sales_channels  || [];
  const oc = state.settings.outstanding_channels || [];
  const cc = state.settings.custom_columns  || [];
  return [
    { key: "date",              label: "Date",            type: "text" },
    { key: "starting_balance",  label: "Starting Bal",    type: "num"  },
    { key: "incoming",          label: "Incoming",        type: "num"  },
    { key: "outgoing",          label: "Outgoing",        type: "num"  },
    { key: "cogs",              label: "COGS",            type: "num"  },
    { key: "vendor_payments",   label: "Vendor Payments", type: "num"  },
    ...sc.map(ch => ({ key: `s:${ch}`,    label: ch,          type: "num", g: "sales",  ch })),
    { key: "total_sales",       label: "Total Sales",  type: "num"  },
    ...oc.map(ch => ({ key: `o:${ch}`,    label: `${ch} O/S`, type: "num", g: "outstd", ch })),
    { key: "total_outstanding", label: "Total O/S",    type: "num"  },
    ...cc.map(c  => ({ key: `c:${c.name}`, label: c.name,     type: "num", g: "custom", ch: c.name })),
    { key: "notes",             label: "Notes",        type: "text" },
  ];
}

function rowVal(date, row, col) {
  switch (col.key) {
    case "date":              return date;
    case "starting_balance":  return +(row.starting_balance  || 0);
    case "incoming":          return +(row.incoming           || 0);
    case "outgoing":          return +(row.outgoing           || 0);
    case "cogs":              return +(row.cogs               || 0);
    case "vendor_payments":   return +(row.vendor_payments    || 0);
    case "total_sales":       return Object.values(row.sales       || {}).reduce((a,b)=>a+b, 0);
    case "total_outstanding": return Object.values(row.outstanding || {}).reduce((a,b)=>a+b, 0);
    default:
      if (col.g === "sales")  return +((row.sales       || {})[col.ch] || 0);
      if (col.g === "outstd") return +((row.outstanding || {})[col.ch] || 0);
      if (col.g === "custom") return +((row.custom      || {})[col.ch] ?? 0);
      return "";
  }
}

function getFilteredSortedEntries(data, cols) {
  let entries = Object.entries(data).map(([date, row]) => ({ date, row }));

  for (const f of rpt.filters) {
    const col = cols.find(c => c.key === f.colKey);
    if (!col) continue;
    entries = entries.filter(({ date, row }) => {
      const v = +rowVal(date, row, col);
      return f.op === ">=" ? v >= f.val : v < f.val;
    });
  }

  if (rpt.sort.col) {
    const col = cols.find(c => c.key === rpt.sort.col);
    if (col) {
      entries.sort((a, b) => {
        const va = rowVal(a.date, a.row, col);
        const vb = rowVal(b.date, b.row, col);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return rpt.sort.dir === "asc" ? cmp : -cmp;
      });
    }
  } else {
    entries.sort((a, b) => b.date.localeCompare(a.date));
  }
  return entries;
}

function renderReportTable(cols, entries) {
  const vis = cols.filter(c => !rpt.hidden.has(c.key));

  document.getElementById("reportHead").innerHTML = `<tr>
    ${vis.map(col => {
      const sorted = rpt.sort.col === col.key;
      const arrow  = sorted ? `<span class="sort-arrow">${rpt.sort.dir === "asc" ? "↑" : "↓"}</span>` : "";
      return `<th class="${col.type === "num" ? "num " : ""}sortable${sorted ? " sorted" : ""}" data-col="${col.key}">
        ${col.label}${arrow}
      </th>`;
    }).join("")}
    <th></th>
  </tr>`;

  const body = document.getElementById("reportBody");
  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="99" style="text-align:center;padding:2rem;color:var(--text-muted)">No rows match the current filters.</td></tr>`;
    return;
  }

  body.innerHTML = entries.map(({ date, row }) => `<tr>
    ${vis.map(col => {
      const v = rowVal(date, row, col);
      if (col.key === "date")  return `<td class="date-cell">${date}</td>`;
      if (col.key === "notes") return `<td>${row.notes || ""}</td>`;
      let cls = "num";
      if      (col.key === "incoming") cls += " positive";
      else if (col.key === "outgoing") cls += " negative";
      else if (col.g === "custom" && typeof v === "number") cls += v >= 0 ? " positive" : " negative";
      return `<td class="${cls}">${fmt(v)}</td>`;
    }).join("")}
    <td><button class="btn-icon" title="Delete" onclick="openDeleteModal('${date}')">✕</button></td>
  </tr>`).join("");
}

function refreshReportTable() {
  const cols     = getReportCols();
  const start    = document.getElementById("reportStart").value;
  const end      = document.getElementById("reportEnd").value;
  const lifetime = document.getElementById("lifetimeToggle").checked;
  const data     = lifetime ? state.data : filterByRange(state.data, start, end);
  renderReportTable(cols, getFilteredSortedEntries(data, cols));
}

function renderFilterChips() {
  const el = document.getElementById("filterChips");
  if (!el) return;
  const cols = getReportCols();
  el.innerHTML = rpt.filters.map((f, i) => {
    const col = cols.find(c => c.key === f.colKey);
    return `<span class="filter-chip">${col ? col.label : f.colKey} ${f.op} ${f.val.toLocaleString("en-IN")}
      <button onclick="removeFilter(${i})">✕</button></span>`;
  }).join("");
}

window.removeFilter = function(i) {
  rpt.filters.splice(i, 1);
  renderFilterChips();
  refreshReportTable();
};

function renderReports() {
  const start    = document.getElementById("reportStart").value;
  const end      = document.getElementById("reportEnd").value;
  const lifetime = document.getElementById("lifetimeToggle").checked;
  const filtered = lifetime ? state.data : filterByRange(state.data, start, end);
  const dates    = sortedDates(filtered);
  const cols     = getReportCols();

  // Summary (uses date-range data, unaffected by row filters)
  const totalIn    = dates.reduce((s,d) => s + (filtered[d].incoming || 0), 0);
  const totalOut   = dates.reduce((s,d) => s + (filtered[d].outgoing || 0), 0);
  const totalCogs  = dates.reduce((s,d) => s + (filtered[d].cogs     || 0), 0);
  const totalSales = dates.reduce((s,d) => s + Object.values(filtered[d].sales || {}).reduce((a,b)=>a+b,0), 0);

  document.getElementById("reportSummary").innerHTML = `
    <div class="summary-item">Entries <strong>${dates.length}</strong></div>
    <div class="summary-item">Total Incoming <strong>${fmt(totalIn)}</strong></div>
    <div class="summary-item">Total Outgoing <strong>${fmt(totalOut)}</strong></div>
    <div class="summary-item">Total COGS <strong>${fmt(totalCogs)}</strong></div>
    <div class="summary-item">Net Cashflow <strong style="color:${totalIn-totalOut>=0?"var(--green)":"var(--red)"}">${fmtSigned(totalIn-totalOut)}</strong></div>
    <div class="summary-item">Total Sales <strong>${fmt(totalSales)}</strong></div>
  `;

  // Controls toolbar
  const numCols = cols.filter(c => c.type === "num");
  document.getElementById("reportControls").innerHTML = `
    <div class="report-controls">
      <div class="filter-form">
        <label>Filter</label>
        <select id="filterColSel" class="select-sm">
          ${numCols.map(c => `<option value="${c.key}">${c.label}</option>`).join("")}
        </select>
        <select id="filterOpSel" class="select-sm">
          <option value=">=">≥ at least</option>
          <option value="<">&lt; less than</option>
        </select>
        <input type="number" id="filterValInput" class="input-sm" placeholder="0" style="width:88px" />
        <button class="btn btn-outline btn-sm" id="addFilterBtn">+ Add</button>
      </div>
      <div class="filter-chips" id="filterChips"></div>
      <div class="col-toggle-wrap">
        <button class="btn btn-outline btn-sm" id="colToggleBtn">Columns ▾</button>
        <div class="col-dropdown hidden" id="colDropdown">
          ${cols.map(c => `<label class="col-check-item">
            <input type="checkbox" data-col="${c.key}" ${!rpt.hidden.has(c.key) ? "checked" : ""} />${c.label}
          </label>`).join("")}
        </div>
      </div>
    </div>`;

  renderFilterChips();

  document.getElementById("addFilterBtn").addEventListener("click", () => {
    const colKey = document.getElementById("filterColSel").value;
    const op     = document.getElementById("filterOpSel").value;
    const val    = parseFloat(document.getElementById("filterValInput").value);
    if (isNaN(val)) { document.getElementById("filterValInput").focus(); return; }
    rpt.filters.push({ colKey, op, val });
    document.getElementById("filterValInput").value = "";
    renderFilterChips();
    refreshReportTable();
  });

  document.getElementById("filterValInput").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("addFilterBtn").click();
  });

  document.getElementById("colToggleBtn").addEventListener("click", e => {
    e.stopPropagation();
    document.getElementById("colDropdown").classList.toggle("hidden");
  });

  document.querySelectorAll("#colDropdown input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      cb.checked ? rpt.hidden.delete(cb.dataset.col) : rpt.hidden.add(cb.dataset.col);
      refreshReportTable();
    });
  });

  renderReportTable(cols, getFilteredSortedEntries(filtered, cols));
}

// ── Settings ───────────────────────────────────────────────────────────────
async function renderBackupList() {
  const list = document.getElementById("backupList");
  const backups = await api("/api/backups");
  if (!backups.length) {
    list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">No backups yet.</p>`;
    return;
  }
  list.innerHTML = `
    <table class="data-table" style="font-size:13px;">
      <thead><tr><th>File</th><th>Created</th><th style="text-align:right;">Size</th><th></th></tr></thead>
      <tbody>
        ${backups.map(b => `
          <tr>
            <td>${b.filename}</td>
            <td>${new Date(b.created_at).toLocaleString("en-IN")}</td>
            <td style="text-align:right;">${b.size_kb} KB</td>
            <td><a class="btn btn-outline btn-sm" href="/api/backup/${b.filename}" download>↓ Download</a></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function renderUserManagement() {
  const card = document.getElementById("userMgmtCard");
  if (!IS_ADMIN) return;
  card.style.display = "";

  const users = await api("/api/users");
  if (!Array.isArray(users)) return;

  document.getElementById("userList").innerHTML = users.map(u => `
    <div class="user-row">
      <span class="user-name">${u.username}</span>
      ${u.is_admin ? `<span class="user-badge">admin</span>` : ""}
      ${!u.is_admin ? `<button class="btn-icon" onclick="deleteUser('${u.username}')" title="Remove user">✕</button>` : ""}
    </div>`).join("");
}

window.deleteUser = async function(username) {
  if (!confirm(`Remove user "${username}"?`)) return;
  const res = await api(`/api/users/${username}`, { method: "DELETE" });
  if (res.success) {
    showToast(`User "${username}" removed.`);
    renderUserManagement();
  } else {
    showToast(res.error || "Failed to remove user.");
  }
};

function renderSettings() {
  const s = state.settings;
  renderTagList("salesChannelTags", s.sales_channels || [], "sales");
  renderTagList("outstandingChannelTags", s.outstanding_channels || [], "outstanding");
  renderCustomCols(s.custom_columns || []);
  renderCustomChartsSettings();
  renderBackupList();
  renderUserManagement();

  document.getElementById("emailEnabled").checked = !!s.email_enabled;
  document.getElementById("emailSender").value = s.email_sender || "";
  document.getElementById("emailPassword").value = "";
  document.getElementById("emailPassword").placeholder = s.email_password
    ? "Leave blank to keep existing password"
    : "App password (not your Gmail password)";
  document.getElementById("emailRecipient").value = s.email_recipient || "";

  const lastSentEl = document.getElementById("emailLastSent");
  lastSentEl.textContent = s.email_last_sent
    ? `Last sent: ${new Date(s.email_last_sent).toLocaleString("en-IN")}`
    : "Never sent";
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

window.removeCustomChart = async function (idx) {
  state.settings.custom_charts.splice(idx, 1);
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
      renderGapCalendar();
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

  document.getElementById("quickToday").addEventListener("click", () => {
    const t = new Date().toISOString().slice(0, 10);
    document.getElementById("lifetimeToggle").checked = false;
    document.getElementById("reportStart").disabled = false;
    document.getElementById("reportEnd").disabled = false;
    document.getElementById("reportStart").value = t;
    document.getElementById("reportEnd").value = t;
    renderReports();
  });

  document.getElementById("quickMonth").addEventListener("click", () => {
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    document.getElementById("lifetimeToggle").checked = false;
    document.getElementById("reportStart").disabled = false;
    document.getElementById("reportEnd").disabled = false;
    document.getElementById("reportStart").value = firstOfMonth;
    document.getElementById("reportEnd").value = today;
    renderReports();
  });

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

  // Settings: add custom chart
  document.getElementById("addCustomChartBtn").addEventListener("click", async () => {
    const name  = document.getElementById("newChartName").value.trim();
    const type  = document.getElementById("newChartType").value;
    const field = document.getElementById("newChartField").value;
    if (!name) { showToast("Chart name is required."); return; }
    state.settings.custom_charts = state.settings.custom_charts || [];
    state.settings.custom_charts.push({ name, type, field });
    document.getElementById("newChartName").value = "";
    await saveSettings();
    renderSettings();
  });
  document.getElementById("newChartName").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("addCustomChartBtn").click();
  });

  // Settings: update password
  document.getElementById("savePasswordBtn").addEventListener("click", async () => {
    const current = document.getElementById("currentPassword").value;
    const np = document.getElementById("newPassword").value;
    const cp = document.getElementById("confirmPassword").value;
    if (!current) { showMsg("passwordMsg", "Enter your current password.", "error"); return; }
    if (!np)      { showMsg("passwordMsg", "Enter a new password.", "error"); return; }
    if (np !== cp) { showMsg("passwordMsg", "New passwords do not match.", "error"); return; }

    const res = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ current_delete_password: current, delete_password: np }),
    });
    if (res.success) {
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confirmPassword").value = "";
      showMsg("passwordMsg", "Password updated.", "success");
      await loadAll();
    } else {
      showMsg("passwordMsg", res.error || "Failed.", "error");
    }
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

  // Backup: create
  document.getElementById("createBackupBtn").addEventListener("click", async () => {
    const btn = document.getElementById("createBackupBtn");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const res = await api("/api/backup", { method: "POST" });
      if (res.success) {
        showMsg("backupMsg", `Backup created: ${res.filename}`, "success");
        renderBackupList();
      } else {
        showMsg("backupMsg", res.error || "Failed.", "error");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Create Backup Now";
    }
  });

  // Email settings: save
  document.getElementById("saveEmailSettingsBtn").addEventListener("click", async () => {
    const pwd = document.getElementById("emailPassword").value.trim();
    const payload = {
      email_enabled: document.getElementById("emailEnabled").checked,
      email_sender: document.getElementById("emailSender").value.trim(),
      email_recipient: document.getElementById("emailRecipient").value.trim(),
    };
    if (pwd) payload.email_password = pwd;

    const res = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    if (res.success) {
      showMsg("emailMsg", "Email settings saved.", "success");
      await loadAll();
      renderSettings();
    } else {
      showMsg("emailMsg", res.error || "Failed to save.", "error");
    }
  });

  // Reports: sort by column header
  document.getElementById("reportHead").addEventListener("click", e => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const key = th.dataset.col;
    if (rpt.sort.col === key && rpt.sort.dir === "desc") {
      rpt.sort.col = null; rpt.sort.dir = "asc";
    } else if (rpt.sort.col === key) {
      rpt.sort.dir = "desc";
    } else {
      rpt.sort.col = key; rpt.sort.dir = "asc";
    }
    refreshReportTable();
  });

  // Close column dropdown when clicking outside
  document.addEventListener("click", e => {
    const dd = document.getElementById("colDropdown");
    if (dd && !dd.classList.contains("hidden") && !dd.parentElement.contains(e.target)) {
      dd.classList.add("hidden");
    }
  });

  // User management: add user
  if (IS_ADMIN) {
    document.getElementById("addUserBtn").addEventListener("click", async () => {
      const username = document.getElementById("newUserName").value.trim();
      const password = document.getElementById("newUserPassword").value;
      if (!username || !password) { showMsg("userMgmtMsg", "Username and password are required.", "error"); return; }
      const res = await api("/api/users", { method: "POST", body: JSON.stringify({ username, password }) });
      if (res.success) {
        document.getElementById("newUserName").value = "";
        document.getElementById("newUserPassword").value = "";
        showMsg("userMgmtMsg", `User "${username}" added.`, "success");
        renderUserManagement();
      } else {
        showMsg("userMgmtMsg", res.error || "Failed to add user.", "error");
      }
    });
    document.getElementById("newUserName").addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("newUserPassword").focus();
    });
    document.getElementById("newUserPassword").addEventListener("keydown", e => {
      if (e.key === "Enter") document.getElementById("addUserBtn").click();
    });
  }

  // Email settings: send test
  document.getElementById("sendTestEmailBtn").addEventListener("click", async () => {
    const btn = document.getElementById("sendTestEmailBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const res = await api("/api/send-test-email", { method: "POST" });
      if (res.success) {
        showMsg("emailMsg", "Test email sent successfully!", "success");
        await loadAll();
        renderSettings();
      } else {
        showMsg("emailMsg", res.error || "Failed to send.", "error");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "Send Test Now";
    }
  });
});
