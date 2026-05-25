import os
import io
import json
import hashlib
import smtplib
import ssl
import atexit
import zipfile
from copy import deepcopy
from datetime import datetime, date, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from flask import Flask, jsonify, render_template, request, send_file, session, redirect
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

app = Flask(__name__, template_folder="template")
app.secret_key = os.environ.get("SECRET_KEY", "sg_cf_9k2x7m4p_2024")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DAILY_FILE = os.path.join(DATA_DIR, "daily_data.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
AUDIT_FILE = os.path.join(DATA_DIR, "audit_log.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
USERS_FILE = os.path.join(DATA_DIR, "users.json")

DEFAULT_SETTINGS = {
    "sales_channels": ["DF", "AMZ PO", "FK PO", "Katana site", "Offline", "Badpeople site"],
    "outstanding_channels": ["AMZ", "FK", "Offline"],
    "custom_columns": [],
    "delete_password": "spacegoods123",
    "email_enabled": False,
    "email_sender": "",
    "email_password": "",
    "email_recipient": "",
    "email_last_sent": None,
}


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    _ensure_admin()


# ── Auth ─────────────────────────────────────────────────────────────────────

def _hash_pw(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def load_users():
    return load_json(USERS_FILE, {})


def _ensure_admin():
    users = load_users()
    if not any(v.get("is_admin") for v in users.values()):
        users["Vivek"] = {"password_hash": _hash_pw("Keviv@0411"), "is_admin": True}
        save_json(USERS_FILE, users)


@app.before_request
def require_login():
    public = {"login_page", "login_post", "logout", "static"}
    if request.endpoint in public or request.endpoint is None:
        return
    if "username" not in session:
        if request.path.startswith("/api/"):
            return jsonify({"error": "unauthenticated"}), 401
        return redirect("/login")


@app.route("/login", methods=["GET"])
def login_page():
    if "username" in session:
        return redirect("/")
    return render_template("login.html")


@app.route("/login", methods=["POST"])
def login_post():
    data = request.json or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    users = load_users()
    user = users.get(username)
    if not user or user.get("password_hash") != _hash_pw(password):
        return jsonify({"error": "Invalid username or password"}), 401
    session["username"] = username
    session["is_admin"] = bool(user.get("is_admin"))
    return jsonify({"success": True, "is_admin": session["is_admin"]})


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.route("/api/users", methods=["GET"])
def api_get_users():
    if not session.get("is_admin"):
        return jsonify({"error": "Admin access required"}), 403
    users = load_users()
    return jsonify([
        {"username": u, "is_admin": v.get("is_admin", False)}
        for u, v in users.items()
    ])


@app.route("/api/users", methods=["POST"])
def api_add_user():
    if not session.get("is_admin"):
        return jsonify({"error": "Admin access required"}), 403
    data = request.json or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    users = load_users()
    if username in users:
        return jsonify({"error": f"Username '{username}' already exists"}), 400
    users[username] = {"password_hash": _hash_pw(password), "is_admin": False}
    save_json(USERS_FILE, users)
    return jsonify({"success": True})


@app.route("/api/users/<username>", methods=["DELETE"])
def api_delete_user(username):
    if not session.get("is_admin"):
        return jsonify({"error": "Admin access required"}), 403
    if username == session.get("username"):
        return jsonify({"error": "Cannot delete your own account"}), 400
    users = load_users()
    if username not in users:
        return jsonify({"error": "User not found"}), 404
    if users[username].get("is_admin"):
        return jsonify({"error": "Cannot delete admin accounts"}), 400
    del users[username]
    save_json(USERS_FILE, users)
    return jsonify({"success": True})


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return deepcopy(default)


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def get_settings():
    s = load_json(SETTINGS_FILE, DEFAULT_SETTINGS)
    for k, v in DEFAULT_SETTINGS.items():
        s.setdefault(k, v)
    return s


def compute_custom(row, custom_columns):
    results = {}
    sales = row.get("sales", {})
    outstanding = row.get("outstanding", {})
    ns = {
        "incoming": float(row.get("incoming", 0)),
        "outgoing": float(row.get("outgoing", 0)),
        "cogs": float(row.get("cogs", 0)),
        "starting_balance": float(row.get("starting_balance", 0)),
        "total_sales": float(sum(sales.values())),
        "total_outstanding": float(sum(outstanding.values())),
        "__builtins__": {},
    }
    for ch, val in sales.items():
        ns[ch.replace(" ", "_").replace("-", "_")] = float(val)
    for ch, val in outstanding.items():
        ns["outstanding_" + ch.replace(" ", "_")] = float(val)
    safe_builtins = {"sum": sum, "abs": abs, "min": min, "max": max, "round": round}

    for col in custom_columns:
        try:
            results[col["name"]] = eval(col["formula"], {"__builtins__": safe_builtins}, ns)
        except Exception as e:
            results[col["name"]] = f"ERR: {e}"
    return results


# ── Email ───────────────────────────────────────────────────────────────────

def _inr(n):
    try:
        return f"₹{abs(float(n)):,.0f}"
    except Exception:
        return "₹0"


def generate_weekly_html(settings, daily):
    today = date.today()
    week_start = today - timedelta(days=7)
    week_start_str = week_start.isoformat()
    today_str = today.isoformat()

    week_data = {d: r for d, r in sorted(daily.items()) if week_start_str <= d <= today_str}
    dates = sorted(week_data.keys())

    sales_channels = settings.get("sales_channels", [])
    out_channels = settings.get("outstanding_channels", [])

    total_incoming = sum(r.get("incoming", 0) for r in week_data.values())
    total_outgoing = sum(r.get("outgoing", 0) for r in week_data.values())
    total_cogs = sum(r.get("cogs", 0) for r in week_data.values())
    net = total_incoming - total_outgoing
    total_sales = sum(sum(r.get("sales", {}).values()) for r in week_data.values())
    sales_by_channel = {
        ch: sum(r.get("sales", {}).get(ch, 0) for r in week_data.values())
        for ch in sales_channels
    }

    latest_date = dates[-1] if dates else None
    latest_outstanding = week_data[latest_date].get("outstanding", {}) if latest_date else {}
    total_outstanding = sum(latest_outstanding.values())

    net_color = "#10b981" if net >= 0 else "#ef4444"

    def kpi_cell(label, value, color="#e2e8f0"):
        return f"""<td width="33%" style="padding:4px;">
          <div style="background:#16213e;border-radius:10px;padding:14px;border:1px solid #1f2d45;">
            <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">{label}</div>
            <div style="font-size:18px;font-weight:700;color:{color};">{value}</div>
          </div></td>"""

    daily_rows = ""
    for d in reversed(dates):
        r = week_data[d]
        day_sales = sum(r.get("sales", {}).values())
        daily_rows += f"""<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;">{d}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;text-align:right;color:#10b981;">{_inr(r.get('incoming',0))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;text-align:right;color:#ef4444;">{_inr(r.get('outgoing',0))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;text-align:right;">{_inr(r.get('cogs',0))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;text-align:right;">{_inr(day_sales)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #1a2540;color:#64748b;">{r.get('notes','')}</td>
        </tr>"""
    if not daily_rows:
        daily_rows = '<tr><td colspan="6" style="padding:16px;text-align:center;color:#64748b;">No data recorded this week.</td></tr>'

    sales_rows = "".join(
        f'<tr><td style="padding:6px 10px;">{ch}</td><td style="padding:6px 10px;text-align:right;">{_inr(val)}</td></tr>'
        for ch, val in sales_by_channel.items()
    )
    outstanding_rows = "".join(
        f'<tr><td style="padding:6px 10px;">{ch}</td><td style="padding:6px 10px;text-align:right;">{_inr(latest_outstanding.get(ch, 0))}</td></tr>'
        for ch in out_channels
    )

    html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;color:#e2e8f0;">
<div style="max-width:620px;margin:0 auto;padding:24px;">

  <div style="background:#16213e;border-radius:12px;padding:20px 24px;margin-bottom:16px;border:1px solid #1f2d45;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="background:#6366f1;width:38px;height:38px;border-radius:8px;display:inline-block;text-align:center;line-height:38px;font-weight:700;font-size:13px;margin-right:12px;vertical-align:middle;">SG</div>
        <span style="font-size:17px;font-weight:700;vertical-align:middle;">Space Goods</span>
        <div style="font-size:12px;color:#64748b;margin-top:4px;">Weekly Cashflow Report &nbsp;·&nbsp; {week_start_str} to {today_str}</div>
      </td>
    </tr></table>
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
    <tr>
      {kpi_cell("Total Incoming", _inr(total_incoming), "#10b981")}
      {kpi_cell("Total Outgoing", _inr(total_outgoing), "#ef4444")}
      {kpi_cell("Net Cashflow", _inr(net), net_color)}
    </tr>
    <tr>
      {kpi_cell("Total COGS", _inr(total_cogs))}
      {kpi_cell("Total Sales", _inr(total_sales), "#a855f7")}
      {kpi_cell("Total Outstanding", _inr(total_outstanding), "#f59e0b")}
    </tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="8" style="margin-bottom:16px;">
    <tr>
      <td width="50%" style="padding-right:8px;vertical-align:top;">
        <div style="background:#16213e;border-radius:10px;padding:16px;border:1px solid #1f2d45;">
          <div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:10px;">Sales by Channel</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
            {sales_rows}
            <tr style="border-top:1px solid #1f2d45;">
              <td style="padding:7px 10px;font-weight:600;">Total</td>
              <td style="padding:7px 10px;text-align:right;font-weight:600;">{_inr(total_sales)}</td>
            </tr>
          </table>
        </div>
      </td>
      <td width="50%" style="padding-left:8px;vertical-align:top;">
        <div style="background:#16213e;border-radius:10px;padding:16px;border:1px solid #1f2d45;">
          <div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:10px;">Outstanding (as of {latest_date or 'N/A'})</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
            {outstanding_rows}
            <tr style="border-top:1px solid #1f2d45;">
              <td style="padding:7px 10px;font-weight:600;">Total</td>
              <td style="padding:7px 10px;text-align:right;font-weight:600;">{_inr(total_outstanding)}</td>
            </tr>
          </table>
        </div>
      </td>
    </tr>
  </table>

  <div style="background:#16213e;border-radius:10px;padding:16px;border:1px solid #1f2d45;margin-bottom:16px;">
    <div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:10px;">Daily Breakdown</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border-collapse:collapse;">
      <tr style="color:#64748b;">
        <th style="padding:7px 10px;text-align:left;font-weight:500;">Date</th>
        <th style="padding:7px 10px;text-align:right;font-weight:500;">Incoming</th>
        <th style="padding:7px 10px;text-align:right;font-weight:500;">Outgoing</th>
        <th style="padding:7px 10px;text-align:right;font-weight:500;">COGS</th>
        <th style="padding:7px 10px;text-align:right;font-weight:500;">Sales</th>
        <th style="padding:7px 10px;text-align:left;font-weight:500;">Notes</th>
      </tr>
      {daily_rows}
    </table>
  </div>

  <div style="text-align:center;color:#374151;font-size:11px;padding-top:4px;">
    Generated by Space Goods Cashflow Dashboard &nbsp;·&nbsp; {datetime.now().strftime("%d %b %Y, %I:%M %p")}
  </div>
</div>
</body></html>"""
    return html


def last_sunday_6pm():
    now = datetime.now()
    days_since_sunday = (now.weekday() + 1) % 7
    last_sunday = now.date() - timedelta(days=days_since_sunday)
    t = datetime(last_sunday.year, last_sunday.month, last_sunday.day, 18, 0, 0)
    if t > now:
        t -= timedelta(days=7)
    return t


def check_missed_email():
    settings = get_settings()
    if not settings.get("email_enabled"):
        return
    last_sent = settings.get("email_last_sent")
    threshold = last_sunday_6pm()
    if last_sent and datetime.fromisoformat(last_sent) >= threshold:
        return
    send_weekly_email()


def send_weekly_email():
    settings = get_settings()
    if not settings.get("email_enabled"):
        return False, "Weekly email is not enabled."

    sender = settings.get("email_sender", "").strip()
    password = settings.get("email_password", "").replace(" ", "").strip()
    recipients = [r.strip() for r in settings.get("email_recipient", "").split(",") if r.strip()]

    if not all([sender, password, recipients]):
        return False, "Email settings are incomplete. Please fill in sender, password, and recipient."

    daily = load_json(DAILY_FILE, {})
    html = generate_weekly_html(settings, daily)

    subject = f"Weekly Cashflow Report — {datetime.now().strftime('%d %b %Y')}"
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(html, "html"))

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
            server.login(sender, password)
            server.sendmail(sender, recipients, msg.as_string())
        settings["email_last_sent"] = datetime.now().isoformat()
        save_json(SETTINGS_FILE, settings)
        return True, "Email sent successfully."
    except Exception as e:
        return False, str(e)


# ── Routes ──────────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return render_template(
        "index.html",
        username=session.get("username", ""),
        is_admin=session.get("is_admin", False),
    )


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(get_settings())


@app.route("/api/settings", methods=["POST"])
def api_update_settings():
    settings = get_settings()
    data = request.json or {}
    if "delete_password" in data:
        if data.get("current_delete_password") != settings.get("delete_password"):
            return jsonify({"error": "Current password is incorrect."}), 403

    updatable = [
        "sales_channels", "outstanding_channels", "custom_columns", "delete_password",
        "email_enabled", "email_sender", "email_password", "email_recipient",
    ]
    for key in updatable:
        if key in data:
            settings[key] = data[key]
    if "email_password" in data:
        settings["email_password"] = data["email_password"].replace(" ", "").strip()
    save_json(SETTINGS_FILE, settings)
    return jsonify({"success": True})


@app.route("/api/send-test-email", methods=["POST"])
def api_send_test_email():
    success, message = send_weekly_email()
    if success:
        return jsonify({"success": True, "message": message})
    return jsonify({"error": message}), 400


@app.route("/api/data", methods=["GET"])
def api_get_data():
    daily = load_json(DAILY_FILE, {})
    settings = get_settings()
    custom_cols = settings.get("custom_columns", [])
    result = {}
    for date, row in daily.items():
        result[date] = dict(row)
        result[date]["custom"] = compute_custom(row, custom_cols)
    return jsonify(result)


@app.route("/api/data", methods=["POST"])
def api_post_data():
    daily = load_json(DAILY_FILE, {})
    audit = load_json(AUDIT_FILE, [])
    data = request.json or {}

    date = data.get("date", "").strip()
    if not date:
        return jsonify({"error": "date is required"}), 400

    if date in daily:
        audit.append({
            "timestamp": datetime.now().isoformat(),
            "action": "overwrite",
            "date": date,
            "original": deepcopy(daily[date]),
        })
        save_json(AUDIT_FILE, audit)

    daily[date] = {
        "starting_balance": float(data.get("starting_balance", 0)),
        "incoming": float(data.get("incoming", 0)),
        "outgoing": float(data.get("outgoing", 0)),
        "cogs": float(data.get("cogs", 0)),
        "sales": {k: float(v) for k, v in data.get("sales", {}).items()},
        "outstanding": {k: float(v) for k, v in data.get("outstanding", {}).items()},
        "notes": str(data.get("notes", "")),
        "updated_at": datetime.now().isoformat(),
    }
    save_json(DAILY_FILE, daily)
    return jsonify({"success": True})


@app.route("/api/data/<date>", methods=["DELETE"])
def api_delete_data(date):
    payload = request.json or {}
    settings = get_settings()
    if payload.get("password") != settings.get("delete_password"):
        return jsonify({"error": "Invalid password"}), 403

    daily = load_json(DAILY_FILE, {})
    if date not in daily:
        return jsonify({"error": "Date not found"}), 404

    audit = load_json(AUDIT_FILE, [])
    audit.append({
        "timestamp": datetime.now().isoformat(),
        "action": "delete",
        "date": date,
        "original": deepcopy(daily[date]),
    })
    save_json(AUDIT_FILE, audit)
    del daily[date]
    save_json(DAILY_FILE, daily)
    return jsonify({"success": True})


@app.route("/api/audit", methods=["GET"])
def api_audit():
    return jsonify(load_json(AUDIT_FILE, []))


@app.route("/api/import", methods=["POST"])
def api_import():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400

    settings = get_settings()
    daily = load_json(DAILY_FILE, {})
    audit = load_json(AUDIT_FILE, [])

    wb = openpyxl.load_workbook(request.files["file"], data_only=True)
    ws = wb.active
    headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]

    imported, errors = 0, []
    for ri, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        try:
            rd = dict(zip(headers, row))
            raw_date = rd.get("date") or rd.get("Date") or rd.get("DATE")
            if raw_date is None:
                continue
            if isinstance(raw_date, datetime):
                date_str = raw_date.strftime("%Y-%m-%d")
            else:
                date_str = str(raw_date).strip()

            def num(keys):
                for k in keys:
                    v = rd.get(k)
                    if v not in (None, ""):
                        try:
                            return float(v)
                        except Exception:
                            pass
                return 0.0

            sales = {ch: num([ch, f"sales_{ch}"]) for ch in settings.get("sales_channels", [])}
            outstd = {ch: num([ch, f"outstanding_{ch}"]) for ch in settings.get("outstanding_channels", [])}

            if date_str in daily:
                audit.append({
                    "timestamp": datetime.now().isoformat(),
                    "action": "import_overwrite",
                    "date": date_str,
                    "original": deepcopy(daily[date_str]),
                })

            daily[date_str] = {
                "starting_balance": num(["starting_balance", "Starting Balance"]),
                "incoming": num(["incoming", "Incoming"]),
                "outgoing": num(["outgoing", "Outgoing"]),
                "cogs": num(["cogs", "COGS"]),
                "sales": sales,
                "outstanding": outstd,
                "notes": str(rd.get("notes") or rd.get("Notes") or ""),
                "updated_at": datetime.now().isoformat(),
            }
            imported += 1
        except Exception as e:
            errors.append(f"Row {ri}: {e}")

    save_json(DAILY_FILE, daily)
    save_json(AUDIT_FILE, audit)
    return jsonify({"imported": imported, "errors": errors})


@app.route("/api/export", methods=["GET"])
def api_export():
    daily = load_json(DAILY_FILE, {})
    settings = get_settings()
    start = request.args.get("start")
    end = request.args.get("end")

    rows = {d: r for d, r in sorted(daily.items()) if (not start or d >= start) and (not end or d <= end)}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Cashflow Report"

    hfont = Font(bold=True, color="FFFFFF")
    hfill = PatternFill(start_color="16213E", end_color="16213E", fill_type="solid")
    center = Alignment(horizontal="center")

    sales_chs = settings.get("sales_channels", [])
    out_chs = settings.get("outstanding_channels", [])
    cust_cols = settings.get("custom_columns", [])

    headers = (
        ["Date", "Starting Balance", "Incoming", "Outgoing", "COGS"]
        + [f"Sales: {c}" for c in sales_chs]
        + ["Total Sales"]
        + [f"Outstanding: {c}" for c in out_chs]
        + ["Total Outstanding"]
        + [c["name"] for c in cust_cols]
        + ["Notes", "Last Updated"]
    )

    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=ci, value=h)
        cell.font = hfont
        cell.fill = hfill
        cell.alignment = center

    for ri, (date, row) in enumerate(rows.items(), start=2):
        custom = compute_custom(row, cust_cols)
        sales = row.get("sales", {})
        outstd = row.get("outstanding", {})
        vals = (
            [date, row.get("starting_balance", 0), row.get("incoming", 0),
             row.get("outgoing", 0), row.get("cogs", 0)]
            + [sales.get(c, 0) for c in sales_chs]
            + [sum(sales.values())]
            + [outstd.get(c, 0) for c in out_chs]
            + [sum(outstd.values())]
            + [custom.get(c["name"]) for c in cust_cols]
            + [row.get("notes", ""), row.get("updated_at", "")]
        )
        for ci, v in enumerate(vals, 1):
            ws.cell(row=ri, column=ci, value=v)

    for col in ws.columns:
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(
            max(len(str(c.value or "")) for c in col) + 4, 35
        )

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"spacegoods_cashflow_{datetime.now().strftime('%Y%m%d')}.xlsx",
    )


@app.route("/api/template", methods=["GET"])
def api_template():
    settings = get_settings()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Import Template"

    hfont = Font(bold=True, color="FFFFFF")
    hfill = PatternFill(start_color="0F3460", end_color="0F3460", fill_type="solid")

    headers = (
        ["date", "starting_balance", "incoming", "outgoing", "cogs"]
        + settings.get("sales_channels", [])
        + settings.get("outstanding_channels", [])
        + ["notes"]
    )
    for ci, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=ci, value=h)
        cell.font = hfont
        cell.fill = hfill

    ws.cell(row=2, column=1, value=datetime.now().strftime("%Y-%m-%d"))
    for col in ws.columns:
        ws.column_dimensions[get_column_letter(col[0].column)].width = 18

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name="spacegoods_import_template.xlsx",
    )


@app.route("/api/backup", methods=["POST"])
def api_create_backup():
    ensure_dirs()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{timestamp}.zip"
    filepath = os.path.join(BACKUP_DIR, filename)

    files = [
        (DAILY_FILE, "daily_data.json"),
        (SETTINGS_FILE, "settings.json"),
        (AUDIT_FILE, "audit_log.json"),
    ]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, arcname in files:
            if os.path.exists(path):
                zf.write(path, arcname)
    buf.seek(0)

    with open(filepath, "wb") as f:
        f.write(buf.read())

    return jsonify({"success": True, "filename": filename})


@app.route("/api/backups", methods=["GET"])
def api_list_backups():
    ensure_dirs()
    files = sorted(
        [f for f in os.listdir(BACKUP_DIR) if f.endswith(".zip")],
        reverse=True,
    )
    result = []
    for f in files:
        stat = os.stat(os.path.join(BACKUP_DIR, f))
        result.append({
            "filename": f,
            "size_kb": round(stat.st_size / 1024, 1),
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return jsonify(result)


@app.route("/api/backup/<filename>", methods=["GET"])
def api_download_backup(filename):
    safe = os.path.basename(filename)
    filepath = os.path.join(BACKUP_DIR, safe)
    if not os.path.exists(filepath):
        return jsonify({"error": "Not found"}), 404
    return send_file(filepath, as_attachment=True, download_name=safe)


if __name__ == "__main__":
    ensure_dirs()

    # Start scheduler only in the main process (not the reloader child)
    if not app.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        import threading
        scheduler = BackgroundScheduler()
        scheduler.add_job(
            send_weekly_email,
            CronTrigger(day_of_week="sun", hour=18, minute=0),
            id="weekly_report",
            replace_existing=True,
        )
        scheduler.start()
        atexit.register(lambda: scheduler.shutdown(wait=False))
        threading.Timer(5, check_missed_email).start()

    print("\n  Space Goods Cashflow Dashboard")
    print("  Running at http://localhost:5000\n")
    app.run(debug=True, host="0.0.0.0", port=5000)
