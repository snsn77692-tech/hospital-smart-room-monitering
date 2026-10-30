import math
import hmac
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory


ROOT = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("HOSPITAL_DB_PATH", ROOT / "hospital.db"))
ROOM_IDS = [f"ROOM-{number}" for number in range(101, 106)]
app = Flask(__name__, static_folder=None)


@app.after_request
def allow_local_frontend(response):
    origin = request.headers.get("Origin", "")
    if origin.startswith(("http://localhost:", "http://127.0.0.1:")):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Staff-Token"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def connect_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def initialize_db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    with connect_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS rooms (
                room_id TEXT PRIMARY KEY,
                occupancy TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (occupancy IN ('available', 'occupied', 'unknown')),
                online INTEGER NOT NULL DEFAULT 0,
                temperature REAL,
                humidity REAL,
                pir_motion INTEGER,
                gas_adc INTEGER,
                co_calibrated INTEGER NOT NULL DEFAULT 0,
                co_measurement REAL,
                co_measurement_unit TEXT,
                people_count INTEGER,
                people_count_validated INTEGER NOT NULL DEFAULT 0,
                sensor_error TEXT,
                updated_at TEXT
            )"""
        )
        db.execute(
            """CREATE TABLE IF NOT EXISTS alerts (
                alert_id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL REFERENCES rooms(room_id),
                event_time TEXT NOT NULL,
                message TEXT NOT NULL DEFAULT 'Emergency button pressed',
                acknowledged_at TEXT,
                resolved_at TEXT
            )"""
        )
        db.executemany(
            "INSERT OR IGNORE INTO rooms (room_id) VALUES (?)",
            [(room_id,) for room_id in ROOM_IDS],
        )


def room_dict(row):
    result = dict(row)
    result["online"] = bool(result["online"])
    if result["updated_at"]:
        try:
            updated = datetime.fromisoformat(result["updated_at"].replace("Z", "+00:00"))
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            result["online"] = result["online"] and (datetime.now(timezone.utc) - updated).total_seconds() <= 15
        except ValueError:
            result["online"] = False
    else:
        result["online"] = False
    result["co_calibrated"] = bool(result["co_calibrated"])
    result["people_count_validated"] = bool(result["people_count_validated"])
    result["pir_motion"] = (
        None if result["pir_motion"] is None else bool(result["pir_motion"])
    )
    return result


def alert_dict(row):
    result = dict(row)
    result["acknowledged"] = result["acknowledged_at"] is not None
    result["resolved"] = result["resolved_at"] is not None
    return result


def staff_authorized():
    expected = os.environ.get("HOSPITAL_STAFF_TOKEN")
    if not expected:
        return False, ("Staff actions are disabled: configure HOSPITAL_STAFF_TOKEN.", 503)
    supplied = request.headers.get("X-Staff-Token", "")
    if not supplied or not hmac.compare_digest(supplied, expected):
        return False, ("Authorized staff token required.", 401)
    return True, None


def device_authorized():
    expected = os.environ.get("HOSPITAL_DEVICE_TOKEN")
    if not expected:
        return False, ("Device ingestion is disabled: configure HOSPITAL_DEVICE_TOKEN.", 503)
    supplied = request.headers.get("X-Device-Token", "")
    if not supplied or not hmac.compare_digest(supplied, expected):
        return False, ("Authorized device token required.", 401)
    return True, None


def json_error(message, status):
    return jsonify({"error": message}), status


def valid_number(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and minimum <= value <= maximum


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:filename>")
def frontend_file(filename):
    if filename in {"index.html", "style.css", "script.js", "firebase-messaging-sw.js"}:
        return send_from_directory(ROOT, filename)
    return json_error("Not found.", 404)


@app.get("/api/rooms")
def get_rooms():
    with connect_db() as db:
        rows = db.execute("SELECT * FROM rooms ORDER BY room_id").fetchall()
        alerts = db.execute(
            "SELECT room_id, COUNT(*) AS count FROM alerts WHERE resolved_at IS NULL GROUP BY room_id"
        ).fetchall()
    counts = {row["room_id"]: row["count"] for row in alerts}
    rooms = []
    for row in rows:
        room = room_dict(row)
        room["active_alert_count"] = counts.get(room["room_id"], 0)
        rooms.append(room)
    return jsonify({"rooms": rooms, "mode": "live"})


@app.get("/api/room/<room_id>")
def get_room(room_id):
    with connect_db() as db:
        row = db.execute("SELECT * FROM rooms WHERE room_id = ?", (room_id.upper(),)).fetchone()
        count = db.execute(
            "SELECT COUNT(*) FROM alerts WHERE room_id = ? AND resolved_at IS NULL",
            (room_id.upper(),),
        ).fetchone()[0]
    if row is None:
        return json_error("Room not found.", 404)
    room = room_dict(row)
    room["active_alert_count"] = count
    return jsonify({"room": room, "mode": "live"})


@app.post("/api/room/update")
def update_room():
    authorized, error = staff_authorized()
    if not authorized:
        return json_error(*error)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("A JSON request body is required.", 400)
    room_id = data.get("room_id")
    occupancy = data.get("occupancy")
    if not isinstance(room_id, str) or room_id.upper() not in ROOM_IDS:
        return json_error("Invalid room_id.", 400)
    if occupancy not in {"available", "occupied"}:
        return json_error("occupancy must be 'available' or 'occupied'.", 400)
    with connect_db() as db:
        db.execute("UPDATE rooms SET occupancy = ? WHERE room_id = ?", (occupancy, room_id.upper()))
    return jsonify({"ok": True, "room_id": room_id.upper(), "occupancy": occupancy})


@app.post("/api/room/<room_id>/sensor")
def update_sensor_readings(room_id):
    """ESP32 sensor ingestion endpoint; absent values remain unknown."""
    authorized, error = device_authorized()
    if not authorized:
        return json_error(*error)
    room_id = room_id.upper()
    if room_id not in ROOM_IDS:
        return json_error("Room not found.", 404)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("A JSON request body is required.", 400)
    allowed = {
        "online", "temperature", "humidity", "pir_motion", "gas_adc",
        "co_calibrated", "co_measurement", "co_measurement_unit",
        "people_count", "people_count_validated", "sensor_error",
    }
    if set(data) - allowed:
        return json_error("Request contains unsupported fields.", 400)
    if "temperature" in data and data["temperature"] is not None and not valid_number(data["temperature"], -40, 85):
        return json_error("temperature must be between -40 and 85 °C.", 400)
    if "humidity" in data and data["humidity"] is not None and not valid_number(data["humidity"], 0, 100):
        return json_error("humidity must be between 0 and 100 % RH.", 400)
    if "gas_adc" in data and data["gas_adc"] is not None and (
        isinstance(data["gas_adc"], bool) or not isinstance(data["gas_adc"], int) or not 0 <= data["gas_adc"] <= 4095
    ):
        return json_error("gas_adc must be an integer from 0 to 4095.", 400)
    for field in ("online", "pir_motion", "co_calibrated", "people_count_validated"):
        if field in data and not isinstance(data[field], bool):
            return json_error(f"{field} must be a boolean.", 400)
    co_measurement = data.get("co_measurement")
    co_unit = data.get("co_measurement_unit")
    if co_measurement is not None and (
        not valid_number(co_measurement, 0, 100000) or data.get("co_calibrated") is not True
    ):
        return json_error("co_measurement must be a finite non-negative calibrated measurement.", 400)
    if co_measurement is not None and (not isinstance(co_unit, str) or not 1 <= len(co_unit) <= 16):
        return json_error("co_measurement_unit is required with a calibrated measurement.", 400)
    if co_measurement is None and co_unit is not None:
        return json_error("co_measurement_unit requires co_measurement.", 400)
    people_count = data.get("people_count")
    count_validated = data.get("people_count_validated", False)
    if people_count is not None and (
        isinstance(people_count, bool) or not isinstance(people_count, int) or not 0 <= people_count <= 100
    ):
        return json_error("people_count must be an integer from 0 to 100 or null.", 400)
    if people_count is not None and not count_validated:
        return json_error("people_count requires people_count_validated=true.", 400)
    sensor_error = data.get("sensor_error")
    if sensor_error is not None and (not isinstance(sensor_error, str) or len(sensor_error) > 500):
        return json_error("sensor_error must be a string of at most 500 characters or null.", 400)

    fields = {
        "online": int(data.get("online", True)),
        "temperature": data.get("temperature"),
        "humidity": data.get("humidity"),
        "pir_motion": None if data.get("pir_motion") is None else int(data["pir_motion"]),
        "gas_adc": data.get("gas_adc"),
        "co_calibrated": int(data.get("co_calibrated", False)),
        "co_measurement": co_measurement,
        "co_measurement_unit": co_unit,
        "people_count": people_count,
        "people_count_validated": int(count_validated),
        "sensor_error": sensor_error,
        "updated_at": now_utc(),
    }
    with connect_db() as db:
        db.execute(
            """UPDATE rooms SET online=:online, temperature=:temperature, humidity=:humidity,
               pir_motion=:pir_motion, gas_adc=:gas_adc, co_calibrated=:co_calibrated,
               co_measurement=:co_measurement, co_measurement_unit=:co_measurement_unit,
               people_count=:people_count, people_count_validated=:people_count_validated,
               sensor_error=:sensor_error, updated_at=:updated_at WHERE room_id=:room_id""",
            {**fields, "room_id": room_id},
        )
    return jsonify({"ok": True, "room_id": room_id, "updated_at": fields["updated_at"]})


@app.post("/api/emergency")
def create_emergency():
    authorized, error = device_authorized()
    if not authorized:
        return json_error(*error)
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("A JSON request body is required.", 400)
    alert_id = data.get("event_id")
    room_id = data.get("room_id")
    event_time = data.get("event_time", now_utc())
    if not isinstance(alert_id, str) or not 1 <= len(alert_id) <= 128:
        return json_error("event_id must be a string of 1 to 128 characters.", 400)
    if not isinstance(room_id, str) or room_id.upper() not in ROOM_IDS:
        return json_error("Invalid room_id.", 400)
    if not isinstance(event_time, str) or len(event_time) > 64:
        return json_error("event_time must be an ISO timestamp string.", 400)
    try:
        datetime.fromisoformat(event_time.replace("Z", "+00:00"))
    except ValueError:
        return json_error("event_time must be a valid ISO timestamp.", 400)
    message = data.get("message", "Emergency button pressed")
    if not isinstance(message, str) or not 1 <= len(message) <= 250:
        return json_error("message must be a string of 1 to 250 characters.", 400)
    with connect_db() as db:
        try:
            db.execute(
                "INSERT INTO alerts (alert_id, room_id, event_time, message) VALUES (?, ?, ?, ?)",
                (alert_id, room_id.upper(), event_time, message),
            )
        except sqlite3.IntegrityError:
            existing = db.execute("SELECT * FROM alerts WHERE alert_id = ?", (alert_id,)).fetchone()
            return jsonify({"ok": True, "duplicate": True, "alert": alert_dict(existing)}), 200
    return jsonify({"ok": True, "duplicate": False, "alert_id": alert_id}), 201


@app.get("/api/alerts")
def get_alerts():
    with connect_db() as db:
        rows = db.execute("SELECT * FROM alerts ORDER BY event_time DESC").fetchall()
    return jsonify({"alerts": [alert_dict(row) for row in rows], "mode": "live"})


@app.post("/api/alerts/<alert_id>/acknowledge")
def acknowledge_alert(alert_id):
    authorized, error = staff_authorized()
    if not authorized:
        return json_error(*error)
    with connect_db() as db:
        row = db.execute("SELECT * FROM alerts WHERE alert_id = ?", (alert_id,)).fetchone()
        if row is None:
            return json_error("Alert not found.", 404)
        if row["acknowledged_at"] is None:
            db.execute("UPDATE alerts SET acknowledged_at = ? WHERE alert_id = ?", (now_utc(), alert_id))
            row = db.execute("SELECT * FROM alerts WHERE alert_id = ?", (alert_id,)).fetchone()
    return jsonify({"ok": True, "alert": alert_dict(row)})


@app.post("/api/alerts/<alert_id>/resolve")
def resolve_alert(alert_id):
    authorized, error = staff_authorized()
    if not authorized:
        return json_error(*error)
    with connect_db() as db:
        row = db.execute("SELECT * FROM alerts WHERE alert_id = ?", (alert_id,)).fetchone()
        if row is None:
            return json_error("Alert not found.", 404)
        if row["resolved_at"] is None:
            db.execute("UPDATE alerts SET resolved_at = ? WHERE alert_id = ?", (now_utc(), alert_id))
            row = db.execute("SELECT * FROM alerts WHERE alert_id = ?", (alert_id,)).fetchone()
    return jsonify({"ok": True, "alert": alert_dict(row)})


initialize_db()


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "5000")), debug=False)
