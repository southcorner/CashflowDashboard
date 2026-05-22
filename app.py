import os
import io
import json
from copy import deepcopy
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from flask import Flask, jsonify, render_template, request, send_file

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DAILY_FILE = os.path.join(DATA_DIR, "daily_data.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")
AUDIT_FILE = os.path.join(DATA_DIR, "audit_log.json")

DEFAULT_SETTINGS = {
    "sales_channels": ["DF", "AMZ PO", "FK PO", "Katana site", "Offline", "Badpeople site"],
    "outstanding_channels": ["AMZ", "FK", "Offline"],
    "custom_columns": [],
    "delete_password": "spacegoods123",
}


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)


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


# ── Routes ──────────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify(get_settings())


@app.route("/api/settings", methods=["POST"])
def api_update_settings():
    settings = get_settings()
    data = request.json or {}
    for key in ["sales_channels", "outstanding_channels", "custom_columns", "delete_password"]:
        if key in data:
            settings[key] = data[key]
    save_json(SETTINGS_FILE, settings)
    return jsonify({"success": True})


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


if __name__ == "__main__":
    ensure_dirs()
    print("\n  Space Goods Cashflow Dashboard")
    print("  Running at http://localhost:5000\n")
    app.run(debug=True, host="0.0.0.0", port=5000)
