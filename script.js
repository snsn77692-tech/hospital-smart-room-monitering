(() => {
  "use strict";
  const ROOM_IDS = ["ROOM-101", "ROOM-102", "ROOM-103", "ROOM-104", "ROOM-105"];
  const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port !== "5000" ? "http://127.0.0.1:5000" : "";
  const DEFAULT_THRESHOLDS = { tempMin: 20, tempMax: 26, humidityMin: 40, humidityMax: 60, gasThreshold: 1800 };
  const DEMO_ROOMS = [
    { room_id: "ROOM-101", occupancy: "occupied", online: true, temperature: 22.8, humidity: 48, pir_motion: true, gas_adc: 716, co_calibrated: false, people_count: 2, people_count_validated: true, updated_at: new Date().toISOString(), active_alert_count: 0 },
    { room_id: "ROOM-102", occupancy: "available", online: true, temperature: 23.4, humidity: 51, pir_motion: false, gas_adc: 690, co_calibrated: false, people_count: null, people_count_validated: false, updated_at: new Date().toISOString(), active_alert_count: 0 },
    { room_id: "ROOM-103", occupancy: "occupied", online: true, temperature: 27.1, humidity: 63, pir_motion: true, gas_adc: 812, co_calibrated: false, people_count: 4, people_count_validated: true, updated_at: new Date().toISOString(), active_alert_count: 0 },
    { room_id: "ROOM-104", occupancy: "unknown", online: false, temperature: null, humidity: null, pir_motion: null, gas_adc: null, co_calibrated: false, people_count: null, people_count_validated: false, updated_at: null, active_alert_count: 0 },
    { room_id: "ROOM-105", occupancy: "available", online: true, temperature: 21.6, humidity: 46, pir_motion: false, gas_adc: 734, co_calibrated: false, people_count: null, people_count_validated: false, updated_at: new Date().toISOString(), active_alert_count: 0 }
  ];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    demo: localStorage.getItem("carewatch-demo") === "true",
    rooms: [],
    alerts: [],
    selectedRoom: null,
    thresholds: { ...DEFAULT_THRESHOLDS, ...JSON.parse(localStorage.getItem("carewatch-thresholds") || "{}") },
    staffToken: localStorage.getItem("carewatch-staff-token") || "",
    error: "",
    demoAlerts: JSON.parse(localStorage.getItem("carewatch-demo-alerts") || "[]"),
    knownLiveAlertIds: new Set(),
    lastFetchError: "",
    audioTimer: null
  };
  const icons = { rooms: "▣", available: "✓", occupied: "◉", alerts: "♢", offline: "⌁" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const isLive = () => !state.demo;
  const allAlerts = () => state.demo ? state.demoAlerts : state.alerts;
  const activeAlerts = () => allAlerts().filter(alert => !alert.resolved && !alert.resolved_at);

  function showError(message) {
    state.error = message || "";
    const node = $("#backend-error");
    node.textContent = state.error;
    node.classList.toggle("hidden", !state.error);
  }
  async function api(url, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.staffToken) headers["X-Staff-Token"] = state.staffToken;
    const response = await fetch(`${API_BASE}${url}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Server error (${response.status}).`);
    return payload;
  }
  function demoRooms() {
    return DEMO_ROOMS.map(room => ({ ...room, updated_at: room.online ? new Date().toISOString() : null }));
  }
  async function refreshData() {
    if (isLive()) {
      try {
        const [roomData, alertData] = await Promise.all([api("/api/rooms"), api("/api/alerts")]);
        state.rooms = Array.isArray(roomData.rooms) ? roomData.rooms : [];
        state.alerts = Array.isArray(alertData.alerts) ? alertData.alerts : [];
        showError("");
        $("#connection-label").textContent = "API connected";
        $("#connection-detail").textContent = "Live server readings";
        $("#connection-label").style.color = "";
        detectNewAlerts();
      } catch (error) {
        state.rooms = ROOM_IDS.map(room_id => ({
          room_id, occupancy: "unknown", online: false, temperature: null, humidity: null,
          pir_motion: null, gas_adc: null, co_calibrated: false, people_count: null,
          people_count_validated: false, updated_at: null, active_alert_count: 0
        }));
        state.alerts = [];
        showError(`Backend unavailable: ${error.message} — live readings are not being replaced with demo data.`);
        $("#connection-label").textContent = "API unavailable";
        $("#connection-detail").textContent = "Live data unavailable";
        $("#connection-label").style.color = "#c74340";
      }
    } else {
      state.rooms = demoRooms();
      state.alerts = [];
      showError("");
      $("#connection-label").textContent = "Demo data";
      $("#connection-detail").textContent = "Simulated readings only";
      $("#connection-label").style.color = "#b47616";
    }
    renderAll();
    if (state.selectedRoom) renderDetails(state.selectedRoom);
    syncAlarm();
  }
  function detectNewAlerts() {
    const active = state.alerts.filter(alert => !alert.resolved_at);
    for (const alert of active) {
      if (!state.knownLiveAlertIds.has(alert.alert_id)) {
        state.knownLiveAlertIds.add(alert.alert_id);
        notifyEmergency(alert);
      }
    }
  }
  function notifyEmergency(alert) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`Emergency — ${alert.room_id}`, { body: alert.message || "Emergency button pressed", tag: alert.alert_id });
    }
  }
  function setView(viewName) {
    const pageNames = { dashboard: "Dashboard", rooms: "All Rooms", detail: "Room details", alerts: "Active Alerts", settings: "Settings" };
    $$(".view").forEach(section => section.classList.toggle("hidden", section.id !== `${viewName}-view`));
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === (viewName === "detail" ? "rooms" : viewName)));
    $("#breadcrumb-current").textContent = pageNames[viewName] || "Dashboard";
    $("#sidebar").classList.remove("open");
    if (viewName === "alerts") renderAlerts();
    if (viewName === "settings") fillSettings();
  }
  function roomWarnings(room) {
    let count = 0;
    if (room.temperature != null && (room.temperature < state.thresholds.tempMin || room.temperature > state.thresholds.tempMax)) count++;
    if (room.humidity != null && (room.humidity < state.thresholds.humidityMin || room.humidity > state.thresholds.humidityMax)) count++;
    if (room.gas_adc != null && room.gas_adc >= state.thresholds.gasThreshold) count++;
    if (room.people_count_validated && Number.isInteger(room.people_count) && room.people_count > 3) count++;
    return count;
  }
  function roomState(room) {
    if ((room.active_alert_count || 0) > 0) return "emergency";
    if (!room.online) return "offline";
    if (roomWarnings(room) > 0) return "warning";
    if (room.occupancy === "occupied") return "occupied";
    return room.occupancy === "available" ? "available" : "offline";
  }
  function roomStatusText(room, status = roomState(room)) {
    if (status === "emergency") return "EMERGENCY";
    if (status === "warning") return "WARNING";
    if (status === "offline") return room.online ? "UNKNOWN" : "OFFLINE";
    return status.toUpperCase();
  }
  function displayTemp(value) { return value == null ? "—" : `${Number(value).toFixed(1)} °C`; }
  function displayHumidity(value) { return value == null ? "—" : `${Number(value).toFixed(0)}% RH`; }
  function renderSummary() {
    const rooms = state.rooms;
    const activeCount = activeAlerts().length;
    const cards = [
      ["Total rooms", rooms.length, icons.rooms, "icon-blue", "Monitored rooms"],
      ["Available", rooms.filter(room => room.occupancy === "available" && room.online).length, icons.available, "icon-green", "Online and marked available"],
      ["Occupied", rooms.filter(room => room.occupancy === "occupied" && room.online).length, icons.occupied, "icon-cyan", "Online and marked occupied"],
      ["Active alerts", activeCount, icons.alerts, "icon-red", "Unresolved emergency events"],
      ["Offline devices", rooms.filter(room => !room.online).length, icons.offline, "icon-orange", "No current device connection"]
    ];
    $("#summary-grid").innerHTML = cards.map(([label, value, icon, color, foot]) =>
      `<article class="summary-card"><div class="summary-head">${label}<span class="summary-icon ${color}">${icon}</span></div><div class="summary-value">${value}</div><div class="summary-foot">${foot}</div></article>`).join("");
    $("#nav-alert-count").textContent = activeCount;
  }
  function renderRoomCard(room) {
    const status = roomState(room);
    const occupancy = room.occupancy === "unknown" || !room.occupancy ? "UNKNOWN" : room.occupancy.toUpperCase();
    const pir = room.pir_motion == null ? "No reading" : room.pir_motion ? "Motion detected" : "No motion";
    const gas = room.gas_adc == null ? "No reading" : `${room.gas_adc} raw ADC`;
    const warnings = roomWarnings(room);
    return `<article class="room-card status-${status}" tabindex="0" role="button" data-room="${esc(room.room_id)}" aria-label="Open ${esc(room.room_id)} details">
      <div class="room-card-top"><h3>${esc(room.room_id)}</h3><span class="status-pill">${roomStatusText(room, status)}</span></div>
      <div class="room-meta"><i class="device-dot"></i>${room.online ? "ESP32 ONLINE" : "DEVICE OFFLINE"} <span>·</span> ${occupancy}</div>
      <div class="room-stats"><div class="room-stat"><label>Temperature</label><strong>${displayTemp(room.temperature)}</strong></div><div class="room-stat"><label>Humidity</label><strong>${displayHumidity(room.humidity)}</strong></div><div class="room-stat"><label>PIR motion</label><strong>${esc(pir)}</strong></div><div class="room-stat"><label>MQ-7 raw reading</label><strong>${esc(gas)}</strong></div></div>
      <div class="room-card-foot"><span class="warning-count">${warnings} active warning${warnings === 1 ? "" : "s"}</span><span class="room-open">Details →</span></div></article>`;
  }
  function bindRoomCards(container) {
    $$(".room-card", container).forEach(card => {
      const open = () => openRoom(card.dataset.room);
      card.addEventListener("click", open);
      card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    });
  }
  function renderRooms() {
    const markup = state.rooms.length ? state.rooms.map(renderRoomCard).join("") : `<div class="empty-state">No live room data is available. Connect to the Flask API or enable DEMO MODE in Settings.</div>`;
    $("#room-grid").innerHTML = markup;
    $("#all-room-grid").innerHTML = markup;
    bindRoomCards($("#room-grid"));
    bindRoomCards($("#all-room-grid"));
  }
  function statusBadge(text, type) { return `<span class="env-result env-${type}">${esc(text)}</span>`; }
  function envStatus(value, min, max) {
    if (value == null || !Number.isFinite(Number(value))) return statusBadge("SENSOR ERROR", "error");
    return Number(value) < min || Number(value) > max ? statusBadge("WARNING", "warning") : statusBadge("NORMAL", "normal");
  }
  function renderDetails(roomId) {
    const room = state.rooms.find(item => item.room_id === roomId);
    if (!room) {
      $("#detail-title").textContent = roomId;
      $("#detail-error").textContent = "Room data is not available. Check the backend connection or enable DEMO MODE.";
      $("#detail-error").classList.remove("hidden");
      $("#detail-cards").innerHTML = "";
      return;
    }
    $("#detail-error").classList.toggle("hidden", !room.sensor_error);
    $("#detail-error").textContent = room.sensor_error ? `Sensor error: ${room.sensor_error}` : "";
    $("#detail-title").textContent = room.room_id;
    $("#detail-subtitle").textContent = `${room.occupancy === "unknown" ? "Occupancy unknown" : room.occupancy[0].toUpperCase() + room.occupancy.slice(1)} · ${room.online ? "ESP32 online" : "ESP32 offline"}${state.demo ? " · DEMO MODE" : ""}`;
    $("#detail-updated").textContent = room.updated_at ? `Last sensor update ${new Date(room.updated_at).toLocaleString()}` : "Last sensor update unavailable";
    const countText = room.people_count_validated && Number.isInteger(room.people_count) ? `${room.people_count} people` : "COUNT SENSOR NOT CONNECTED";
    const pir = room.pir_motion == null ? "NO READING" : room.pir_motion ? "MOTION DETECTED" : "NO MOTION";
    const readings = [
      ["Temperature", displayTemp(room.temperature), "DHT11 · demonstration range", "icon-orange", "♨"],
      ["Humidity", displayHumidity(room.humidity), "DHT11 relative humidity", "icon-cyan", "◌"],
      ["PIR motion", pir, "PIR detects motion; it does not count people", "icon-blue", "⌁"],
      ["MQ-7 raw ADC", room.gas_adc == null ? "NO READING" : `${room.gas_adc}`, room.co_calibrated && room.co_measurement != null ? `Calibrated measurement: ${room.co_measurement} ${room.co_measurement_unit || ""}` : "CO SENSOR NOT CALIBRATED", "icon-orange", "◉"],
      ["People count", countText, room.people_count_validated ? "Validated count measurement" : "Independent count sensor required", "icon-blue", "♙"],
      ["Device connection", room.online ? "ESP32 ONLINE" : "ESP32 OFFLINE", room.updated_at ? "Device update received" : "No sensor update received", room.online ? "icon-green" : "icon-red", "⌁"],
      ["Occupancy", room.occupancy === "unknown" ? "UNKNOWN" : room.occupancy.toUpperCase(), "Set by authorized staff; never inferred from PIR", "icon-cyan", "▣"],
      ["Active warnings", roomWarnings(room), "Configured demonstration thresholds", roomWarnings(room) ? "icon-orange" : "icon-green", "!"]
    ];
    $("#detail-cards").innerHTML = readings.map(([label, value, detail, color, icon]) => `<article class="reading-card"><span class="reading-icon ${color}">${icon}</span><span class="reading-label">${label}</span><div class="reading-value">${esc(value)}</div><div class="reading-detail">${esc(detail)}</div></article>`).join("");
    const occupancyValue = room.occupancy === "unknown" ? "unknown" : room.occupancy;
    $("#occupancy-control").innerHTML = `<strong>Staff-set occupancy</strong><select id="occupancy-select" ${state.demo || !state.staffToken ? "disabled" : ""}><option value="unknown" ${occupancyValue === "unknown" ? "selected" : ""} disabled>Unknown</option><option value="available" ${occupancyValue === "available" ? "selected" : ""}>Available</option><option value="occupied" ${occupancyValue === "occupied" ? "selected" : ""}>Occupied</option></select>`;
    const temp = envStatus(room.temperature, state.thresholds.tempMin, state.thresholds.tempMax);
    const humidity = envStatus(room.humidity, state.thresholds.humidityMin, state.thresholds.humidityMax);
    const gasText = room.gas_adc == null ? statusBadge("SENSOR ERROR", "error") : room.gas_adc >= state.thresholds.gasThreshold ? statusBadge("RAW ADC WARNING", "warning") : statusBadge(room.co_calibrated && room.co_measurement != null ? "CALIBRATED" : "UNCALIBRATED", room.co_calibrated && room.co_measurement != null ? "normal" : "error");
    const peopleStatus = room.people_count_validated && Number.isInteger(room.people_count)
      ? room.people_count > 3 ? statusBadge("WARNING: MORE THAN 3 PEOPLE IN ROOM", "warning") : statusBadge("VALIDATED COUNT", "normal")
      : statusBadge("COUNT SENSOR NOT CONNECTED", "error");
    $("#environment-status").innerHTML = `<div class="environment-row"><span>Temperature · ${state.thresholds.tempMin}–${state.thresholds.tempMax} °C</span>${temp}</div><div class="environment-row"><span>Humidity · ${state.thresholds.humidityMin}–${state.thresholds.humidityMax}% RH</span>${humidity}</div><div class="environment-row"><span>MQ-7 · raw ADC ${room.gas_adc == null ? "unavailable" : room.gas_adc}</span>${gasText}</div><div class="environment-row"><span>Occupancy count</span>${peopleStatus}</div>`;
    const select = $("#occupancy-select");
    if (select) select.addEventListener("change", () => updateOccupancy(roomId, select.value));
  }
  async function openRoom(roomId) {
    state.selectedRoom = roomId;
    if (isLive()) {
      try {
        const data = await api(`/api/room/${encodeURIComponent(roomId)}`);
        const index = state.rooms.findIndex(room => room.room_id === roomId);
        if (index >= 0) state.rooms[index] = data.room;
      } catch (error) { showError(`Could not load ${roomId}: ${error.message}`); }
    }
    setView("detail");
    renderDetails(roomId);
  }
  async function updateOccupancy(roomId, occupancy) {
    if (state.demo) return;
    try {
      await api("/api/room/update", { method: "POST", body: JSON.stringify({ room_id: roomId, occupancy }) });
      await refreshData();
    } catch (error) {
      showError(error.message);
      renderDetails(roomId);
    }
  }
  function renderAlerts() {
    const alerts = allAlerts().sort((a, b) => String(b.event_time || "").localeCompare(String(a.event_time || "")));
    const active = alerts.filter(alert => !alert.resolved && !alert.resolved_at);
    $("#alert-banner").classList.toggle("hidden", active.length === 0);
    $("#alert-banner").innerHTML = active.length ? `<strong>EMERGENCY ALERT${active.length > 1 ? "S" : ""} — ${active.length} ACTIVE</strong><p>${active.map(alert => `${esc(alert.room_id)} · ${esc(new Date(alert.event_time).toLocaleString())}`).join(" &nbsp; | &nbsp; ")}</p>` : "";
    $("#alerts-list").innerHTML = alerts.length ? alerts.map(alert => {
      const isDemo = Boolean(alert.demo);
      const acknowledged = alert.acknowledged || Boolean(alert.acknowledged_at);
      const resolved = alert.resolved || Boolean(alert.resolved_at);
      return `<article class="alert-card ${resolved ? "resolved" : ""}"><span class="alert-symbol">!</span><div class="alert-body"><h3>${esc(alert.room_id)} — ${isDemo ? "DEMO EMERGENCY" : esc(alert.message || "Emergency button pressed")}</h3><p>Event time: ${esc(new Date(alert.event_time).toLocaleString())}${isDemo ? " · Local demo event" : ""}</p><div class="ack-state">${acknowledged ? `Acknowledged${alert.acknowledged_at ? ` at ${esc(new Date(alert.acknowledged_at).toLocaleString())}` : ""}` : "Not acknowledged"}${resolved ? ` · Resolved${alert.resolved_at ? ` at ${esc(new Date(alert.resolved_at).toLocaleString())}` : ""}` : ""}</div><div class="alert-actions">${!acknowledged && !resolved ? `<button class="button button-primary button-small" data-alert-action="ack" data-alert-id="${esc(alert.alert_id)}" data-demo="${isDemo}">ACKNOWLEDGE ALERT</button>` : ""}${!resolved ? `<button class="button button-danger button-small" data-alert-action="resolve" data-alert-id="${esc(alert.alert_id)}" data-demo="${isDemo}">RESOLVE ALERT</button>` : ""}${resolved ? statusBadge("RESOLVED", "normal") : ""}</div></div></article>`;
    }).join("") : `<div class="empty-state">No emergency events. New hardware events will appear here.</div>`;
    $$("[data-alert-action]", $("#alerts-list")).forEach(button => button.addEventListener("click", () => handleAlertAction(button)));
  }
  async function handleAlertAction(button) {
    const { alertAction, alertId, demo } = button.dataset;
    if (demo === "true") {
      const alert = state.demoAlerts.find(item => item.alert_id === alertId);
      if (!alert) return;
      if (alertAction === "ack") { alert.acknowledged = true; alert.acknowledged_at = new Date().toISOString(); }
      if (alertAction === "resolve") { alert.resolved = true; alert.resolved_at = new Date().toISOString(); }
      localStorage.setItem("carewatch-demo-alerts", JSON.stringify(state.demoAlerts));
      renderAll();
      return;
    }
    try {
      await api(`/api/alerts/${encodeURIComponent(alertId)}/${alertAction === "ack" ? "acknowledge" : "resolve"}`, { method: "POST", body: "{}" });
      await refreshData();
    } catch (error) { showError(error.message); }
  }
  function triggerDemoEmergency() {
    if (!state.demo) {
      showError("Enable DEMO MODE before creating a test emergency. This button never sends a hardware event.");
      return;
    }
    const alertId = `DEMO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const alert = { alert_id: alertId, room_id: "ROOM-103", event_time: new Date().toISOString(), message: "Demonstration emergency button pressed", demo: true, acknowledged: false, resolved: false };
    state.demoAlerts.unshift(alert);
    localStorage.setItem("carewatch-demo-alerts", JSON.stringify(state.demoAlerts));
    beep();
    if ("Notification" in window && Notification.permission === "granted") notifyEmergency(alert);
    renderAll();
    setView("alerts");
  }
  function beep() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.value = 0.045;
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start();
      window.setTimeout(() => { oscillator.stop(); context.close(); }, 350);
    } catch (error) { console.warn("Alarm audio could not start:", error); }
  }
  function syncAlarm() {
    const hasActive = activeAlerts().length > 0;
    if (hasActive && !state.audioTimer) {
      beep();
      state.audioTimer = window.setInterval(beep, 1800);
    } else if (!hasActive && state.audioTimer) {
      window.clearInterval(state.audioTimer);
      state.audioTimer = null;
    }
  }
  function renderAll() {
    $("#mode-badge").classList.toggle("hidden", !state.demo);
    $("#demo-banner").classList.toggle("hidden", !state.demo);
    $("#demo-toggle").checked = state.demo;
    const active = activeAlerts();
    const emergencyBanner = $("#global-emergency-banner");
    emergencyBanner.classList.toggle("hidden", active.length === 0);
    emergencyBanner.innerHTML = active.length ? `<strong>EMERGENCY ALERT${active.length > 1 ? "S" : ""} — ${active.length} ACTIVE</strong><p>${active.map(alert => `${esc(alert.room_id)} · ${esc(new Date(alert.event_time).toLocaleString())}`).join(" &nbsp; | &nbsp; ")} <button class="button button-small" id="open-alerts-banner">View alerts</button></p>` : "";
    const bannerButton = $("#open-alerts-banner");
    if (bannerButton) bannerButton.addEventListener("click", () => setView("alerts"));
    renderSummary();
    renderRooms();
    if (state.selectedRoom && !$("#detail-view").classList.contains("hidden")) renderDetails(state.selectedRoom);
    if (!$("#alerts-view").classList.contains("hidden")) renderAlerts();
  }
  function fillSettings() {
    const form = $("#threshold-form");
    for (const [key, value] of Object.entries(state.thresholds)) form.elements[key].value = value;
    $("#staff-form").elements.staffToken.value = state.staffToken;
  }
  function saveThresholds(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const next = Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map(key => [key, Number(values[key])]));
    if (Object.values(next).some(value => !Number.isFinite(value)) || next.tempMin >= next.tempMax || next.humidityMin >= next.humidityMax || next.gasThreshold < 0 || next.gasThreshold > 4095 || next.humidityMin < 0 || next.humidityMax > 100) {
      $("#settings-message").textContent = "Enter valid ordered limits.";
      return;
    }
    state.thresholds = next;
    localStorage.setItem("carewatch-thresholds", JSON.stringify(next));
    $("#settings-message").textContent = "Thresholds saved.";
    renderAll();
  }
  function init() {
    $("#today-label").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $$(".nav-item").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
    $$("[data-view]").filter(button => !button.classList.contains("nav-item")).forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
    $("#refresh-button").addEventListener("click", refreshData);
    $("#menu-button").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    $("#demo-toggle").addEventListener("change", event => {
      state.demo = event.target.checked;
      localStorage.setItem("carewatch-demo", String(state.demo));
      state.selectedRoom = null;
      setView("dashboard");
      refreshData();
    });
    $("#test-emergency").addEventListener("click", triggerDemoEmergency);
    $("#test-emergency-settings").addEventListener("click", triggerDemoEmergency);
    $("#threshold-form").addEventListener("submit", saveThresholds);
    $("#staff-form").addEventListener("submit", event => {
      event.preventDefault();
      state.staffToken = event.currentTarget.elements.staffToken.value.trim();
      localStorage.setItem("carewatch-staff-token", state.staffToken);
      $("#staff-message").textContent = "Token saved in this browser.";
      if (state.selectedRoom) renderDetails(state.selectedRoom);
    });
    $("#notification-button").addEventListener("click", async () => {
      if (!("Notification" in window)) { showError("Browser notifications are not supported here."); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") showError("Browser notification permission was not granted.");
      else { showError(""); $("#notification-button").title = "Notifications enabled"; }
    });
    fillSettings();
    refreshData();
    window.setInterval(refreshData, 4000);
  }
  init();
})();
