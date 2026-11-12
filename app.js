"use strict";

// Muessen zu den UUIDs in src/main.cpp der Firmware passen.
const SERVICE_UUID = "7e6a0000-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_TEMPERATURES_UUID = "7e6a0001-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_STATUS_UUID = "7e6a0002-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_CONTROL_UUID = "7e6a0003-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_LOG_DATA_UUID = "7e6a0004-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_SENSORS_UUID = "7e6a0005-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_SENSOR_NAME_UUID = "7e6a0006-5c3b-4d2a-9f1e-8b4c2d6e0a01";
const CHAR_SEGMENTS_UUID = "7e6a0007-5c3b-4d2a-9f1e-8b4c2d6e0a01";

const CMD_SET_TIME = 1;
const CMD_SET_INTERVAL = 2;
const CMD_LOG_CLEAR = 3;
const CMD_DOWNLOAD = 4;
const CMD_DOWNLOAD_CANCEL = 5;
const CMD_SCAN = 6;
const CMD_FORGET = 7;
const CMD_MEASURE = 8;
const CMD_SENSOR_LIST = 9;
const CMD_SEGMENTS = 10;

const FLAG_TIME_SET = 1 << 0;
const FLAG_SENSOR_OK = 1 << 1;
const SENSOR_USED = 1 << 0;
const SENSOR_PRESENT = 1 << 1;

// Wie im Templogger: bis zu 32 Sensoren, Namen bis 24 Zeichen.
const MAX_SENSORS = 32;
const NO_VALUE = -32768;
const RECORD_SIZE = 8 + MAX_SENSORS * 2;
const SENSOR_NAME_LEN = 25;
const SENSOR_ENTRY_SIZE = 1 + 1 + 8 + SENSOR_NAME_LEN;  // Flags, Pin, Adresse, Name
const SENSOR_NAME_BYTES = SENSOR_NAME_LEN - 1;
const SEGMENT_RECORDS = 2048;
const SEGMENTS_TIMEOUT_MS = 5000;
const SYNC_STALL_MS = 2000;
const AUTO_REFRESH_MS = 60000;
const VIEW_STORAGE_KEY = "heizkreis-view";

const el = (id) => document.getElementById(id);

const ui = {
  connect: el("connect"),
  message: el("message"),
  connection: el("connection"),
  sensors: el("sensors"),
  range: el("range"),
  view: el("view"),
  refresh: el("refresh"),
  download: el("download"),
  progress: el("progress"),
  history: el("history"),
  combined: el("combined"),
  chart: el("chart"),
  legend: el("legend"),
  tooltip: el("tooltip"),
  chartList: el("chartList"),
  calendar: el("calendar"),
  calPrev: el("calPrev"),
  calNext: el("calNext"),
  calTitle: el("calTitle"),
  calGrid: el("calGrid"),
  dayPrev: el("dayPrev"),
  dayToday: el("dayToday"),
  dayNext: el("dayNext"),
  interval: el("interval"),
  measure: el("measure"),
  scan: el("scan"),
  storage: el("storage"),
  clear: el("clear"),
};

let device = null;
let controlChar = null;
let sensorNameChar = null;
let status = null;
let sensors = emptySensors();  // je Slot {used, present, address, name}
let temps = [];                 // aktuelle Werte in Grad, null = kein Wert
let records = [];
let nextRecord = 0;
let syncing = false;
let resumePending = false;
let lastSyncData = 0;
let writeChain = Promise.resolve();
let hoverEpoch = null;
let singleCharts = [];          // [{slot, canvas, tooltip}] in der Ansicht "Je Sensor"

// Kalender: Zeitindex der Segmente und gewaehlter Tag
let segments = [];              // [{segment, epoch}], epoch 0 = unbekannt
let segmentsBuffer = [];
let segmentsResolve = null;
let selectedDay = startOfDay(new Date());
let calendarMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
let dayStartIndex = 0;
let dayEndIndex = 0;

function emptySensors() {
  return Array.from({ length: MAX_SENSORS }, () => ({
    used: false,
    present: false,
    pin: -1,
    address: "",
    name: "",
  }));
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function sameDay(a, b) {
  return a.getTime() === startOfDay(b).getTime();
}

function dayMode() {
  return ui.range.value === "day";
}

// Beginn und Ende des gewaehlten Tages in Unix-Zeit (Ortszeit, auch bei Zeitumstellung)
function dayBounds() {
  return [
    Math.floor(selectedDay.getTime() / 1000),
    Math.floor(addDays(selectedDay, 1).getTime() / 1000),
  ];
}

function showMessage(text) {
  ui.message.textContent = text;
  ui.message.hidden = !text;
}

function isConnected() {
  return Boolean(device && device.gatt.connected && controlChar);
}

function formatNumber(value, digits) {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Die ersten 8 Farben kommen aus style.css, weitere ueber den goldenen Winkel.
function seriesColor(slot) {
  if (slot < 8) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--s${slot}`).trim();
  }
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const hue = Math.round((slot * 137.508 + 20) % 360);
  return `hsl(${hue}, 65%, ${dark ? 65 : 40}%)`;
}

function sensorName(slot) {
  return (sensors[slot] && sensors[slot].name) || `Sensor ${slot + 1}`;
}

// Web Bluetooth erlaubt nur eine GATT-Operation gleichzeitig.
function enqueue(operation) {
  writeChain = writeChain.catch(() => {}).then(operation);
  return writeChain;
}

function sendCommand(op, arg = 0) {
  const data = new DataView(new ArrayBuffer(5));
  data.setUint8(0, op);
  data.setUint32(1, arg, true);
  return enqueue(() => controlChar.writeValueWithResponse(data.buffer));
}

// --- Verbindung ---------------------------------------------------------

async function connect() {
  showMessage("");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);
    ui.connection.textContent = "Verbinde …";

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const temperaturesChar = await service.getCharacteristic(CHAR_TEMPERATURES_UUID);
    const statusChar = await service.getCharacteristic(CHAR_STATUS_UUID);
    const logDataChar = await service.getCharacteristic(CHAR_LOG_DATA_UUID);
    const sensorsChar = await service.getCharacteristic(CHAR_SENSORS_UUID);
    const segmentsChar = await service.getCharacteristic(CHAR_SEGMENTS_UUID);
    sensorNameChar = await service.getCharacteristic(CHAR_SENSOR_NAME_UUID);
    controlChar = await service.getCharacteristic(CHAR_CONTROL_UUID);

    temperaturesChar.addEventListener("characteristicvaluechanged", (event) => {
      onTemperatures(event.target.value);
    });
    statusChar.addEventListener("characteristicvaluechanged", (event) => {
      onStatus(event.target.value);
    });
    logDataChar.addEventListener("characteristicvaluechanged", (event) => {
      onLogData(event.target.value);
    });
    sensorsChar.addEventListener("characteristicvaluechanged", (event) => {
      onSensorPage(event.target.value);
    });
    segmentsChar.addEventListener("characteristicvaluechanged", (event) => {
      onSegments(event.target.value);
    });
    await temperaturesChar.startNotifications();
    await statusChar.startNotifications();
    await logDataChar.startNotifications();
    await sensorsChar.startNotifications();
    await segmentsChar.startNotifications();

    // Korrigiert auch alle Daten, die seit dem Start ohne Uhrzeit geloggt wurden.
    await sendCommand(CMD_SET_TIME, Math.floor(Date.now() / 1000));
    // Die Sensorliste kommt in Teilen ueber Notifications.
    sensors = emptySensors();
    await sendCommand(CMD_SENSOR_LIST);
    onTemperatures(await temperaturesChar.readValue());
    onStatus(await statusChar.readValue());

    ui.connection.textContent = `Verbunden mit ${device.name || "ESP32"}`;
    ui.connect.textContent = "Trennen";
    if (dayMode()) {
      await loadDay();
    } else {
      await fetchSegments();  // fuer den Datumsbereich des Kalenders
      resetRecords();
      await startSync();
    }
  } catch (error) {
    if (error.name !== "NotFoundError") {
      showMessage(`Verbindung fehlgeschlagen: ${error.message}`);
    }
    if (device && device.gatt.connected) {
      device.gatt.disconnect();
    } else {
      onDisconnected();
    }
  }
}

function onDisconnected() {
  controlChar = null;
  sensorNameChar = null;
  status = null;
  syncing = false;
  resumePending = false;
  temps = [];
  ui.progress.hidden = true;
  ui.connection.textContent = "Nicht verbunden";
  ui.connect.textContent = "Verbinden";
  ui.storage.textContent = "Speicher: –";
  renderSensors();
  updateControls();
}

// --- Eingehende Daten ---------------------------------------------------

function readTemps(view, offset) {
  const values = [];
  for (let slot = 0; slot < MAX_SENSORS; slot++) {
    const raw = view.getInt16(offset + slot * 2, true);
    values.push(raw === NO_VALUE ? null : raw / 100);
  }
  return values;
}

function onTemperatures(view) {
  temps = readTemps(view, 0);
  renderSensors();
}

// Ein Teil der Sensorliste: u8 erster Slot, u8 Anzahl, danach die Eintraege.
function onSensorPage(view) {
  const decoder = new TextDecoder();
  const firstSlot = view.getUint8(0);
  const count = view.getUint8(1);
  for (let i = 0; i < count; i++) {
    const slot = firstSlot + i;
    const offset = 2 + i * SENSOR_ENTRY_SIZE;
    if (slot >= MAX_SENSORS || offset + SENSOR_ENTRY_SIZE > view.byteLength) {
      break;
    }
    const flags = view.getUint8(offset);
    const pin = view.getInt8(offset + 1);
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, SENSOR_ENTRY_SIZE);
    const address = Array.from(bytes.slice(2, 10), (b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(":");
    const nameBytes = bytes.slice(10);
    const end = nameBytes.indexOf(0);
    sensors[slot] = {
      used: Boolean(flags & SENSOR_USED),
      present: Boolean(flags & SENSOR_PRESENT),
      pin,
      address,
      name: decoder.decode(end < 0 ? nameBytes : nameBytes.slice(0, end)),
    };
  }
  renderSensors();
  renderHistory();
}

function onStatus(view) {
  const flags = view.getUint8(0);
  status = {
    timeSet: Boolean(flags & FLAG_TIME_SET),
    sensorOk: Boolean(flags & FLAG_SENSOR_OK),
    oldestIndex: view.getUint32(1, true),
    nextIndex: view.getUint32(5, true),
    capacity: view.getUint32(9, true),
    intervalS: view.getUint32(13, true),
  };

  // Das Log wurde auf dem Geraet geloescht.
  if (status.nextIndex < nextRecord) {
    if (dayMode()) {
      records = [];
      nextRecord = status.oldestIndex;
    } else {
      resetRecords();
    }
    renderHistory();
  }

  const stored = status.nextIndex - status.oldestIndex;
  const percent = status.capacity ? formatNumber((stored / status.capacity) * 100, 1) : "0";
  const days = (status.capacity * status.intervalS) / 86400;
  ui.storage.textContent =
    `Speicher: ${stored.toLocaleString("de-DE")} von ` +
    `${status.capacity.toLocaleString("de-DE")} Datensätzen (${percent} %), ` +
    `reicht bei diesem Intervall für etwa ${formatNumber(days, 0)} Tage`;

  if (isConnected()) {
    ui.connection.textContent =
      `Verbunden mit ${device.name || "ESP32"}` +
      (status.sensorOk ? "" : " – keine Sensoren gefunden");
  }

  if (document.activeElement !== ui.interval) {
    const value = String(status.intervalS);
    if (![...ui.interval.options].some((option) => option.value === value)) {
      ui.interval.add(new Option(`${value} s`, value));
    }
    ui.interval.value = value;
  }
  updateControls();
}

function onLogData(view) {
  // Nach einem Abbruch koennen noch Pakete unterwegs sein.
  if (!syncing) {
    return;
  }
  const first = view.getUint32(0, true);
  const count = Math.floor((view.byteLength - 4) / RECORD_SIZE);
  lastSyncData = Date.now();

  // Alte Daten wurden auf dem Geraet ueberschrieben: an der neuen Grenze weitermachen.
  if (status && nextRecord < status.oldestIndex && first >= status.oldestIndex) {
    nextRecord = first;
  }

  if (first !== nextRecord) {
    requestResume();
    return;
  }
  resumePending = false;

  if (count === 0) {
    finishSync();
    return;
  }

  // Im Kalender nur Datensaetze des gewaehlten Tages behalten. Ist das Ende des
  // Tages erreicht, wird der Download abgebrochen.
  const [dayStart, dayEnd] = dayBounds();
  let reachedEnd = false;
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * RECORD_SIZE;
    const epoch = view.getUint32(offset, true);
    if (dayMode()) {
      if (epoch >= dayEnd) {
        reachedEnd = true;
        break;
      }
      if (epoch < dayStart) {
        continue;  // davor oder ohne Uhrzeit
      }
    }
    records.push({
      index: first + i,
      epoch,
      uptimeS: view.getUint32(offset + 4, true),
      temps: readTemps(view, offset + 8),
    });
  }
  nextRecord = first + count;

  if (reachedEnd) {
    sendCommand(CMD_DOWNLOAD_CANCEL).catch(() => {});
    finishSync();
    return;
  }

  const startIndex = rangeStartIndex();
  const endIndex = dayMode() ? dayEndIndex : status ? status.nextIndex : 0;
  if (endIndex > startIndex) {
    ui.progress.max = endIndex - startIndex;
    ui.progress.value = Math.max(0, nextRecord - startIndex);
  }
  ui.history.textContent = `Lade Log: ${records.length.toLocaleString("de-DE")} Datensätze`;
}

// Zeitindex: u32 erstes Segment, u16 Anzahl, danach je Segment u32 Unix-Zeit.
// Ein Paket mit Anzahl 0 beendet die Liste.
function onSegments(view) {
  const first = view.getUint32(0, true);
  const count = view.getUint16(4, true);
  if (count === 0) {
    segments = segmentsBuffer;
    segmentsBuffer = [];
    renderCalendar();
    if (segmentsResolve) {
      segmentsResolve();
    }
    return;
  }
  for (let i = 0; i < count && 6 + i * 4 + 4 <= view.byteLength; i++) {
    segmentsBuffer.push({ segment: first + i, epoch: view.getUint32(6 + i * 4, true) });
  }
}

function fetchSegments() {
  segmentsBuffer = [];
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      segmentsResolve = null;
      resolve();
    };
    const timer = setTimeout(done, SEGMENTS_TIMEOUT_MS);
    segmentsResolve = done;
    sendCommand(CMD_SEGMENTS).catch(done);
  });
}

// Erster Tag mit Uhrzeit im Log, null = unbekannt
function firstDataDay() {
  // Hat das aelteste Segment keine Uhrzeit, koennen spaetere Datensaetze darin
  // trotzdem eine haben. Dann den Kalender nicht nach vorne begrenzen.
  if (segments.length === 0 || segments[0].epoch === 0) {
    return null;
  }
  return startOfDay(new Date(segments[0].epoch * 1000));
}

// --- Log-Abgleich -------------------------------------------------------

// Erster Index fuer den gewaehlten Zeitraum, geschaetzt ueber das aktuelle Intervall.
function rangeStartIndex() {
  if (!status) {
    return 0;
  }
  if (dayMode()) {
    return dayStartIndex;
  }
  const days = Number(ui.range.value);
  if (days === 0) {
    return status.oldestIndex;
  }
  const wanted = Math.ceil((days * 86400) / Math.max(1, status.intervalS));
  return Math.max(status.oldestIndex, status.nextIndex - wanted);
}

function resetRecords() {
  records = [];
  nextRecord = rangeStartIndex();
}

async function startSync() {
  if (syncing || !isConnected()) {
    return;
  }
  syncing = true;
  resumePending = false;
  lastSyncData = Date.now();
  ui.progress.hidden = false;
  updateControls();
  try {
    await sendCommand(CMD_DOWNLOAD, nextRecord);
  } catch (error) {
    syncing = false;
    ui.progress.hidden = true;
    showMessage(`Log konnte nicht geladen werden: ${error.message}`);
    updateControls();
  }
}

function requestResume() {
  if (resumePending || !isConnected()) {
    return;
  }
  resumePending = true;
  sendCommand(CMD_DOWNLOAD, nextRecord).catch(() => {
    resumePending = false;
  });
}

function finishSync() {
  syncing = false;
  ui.progress.hidden = true;
  if (status) {
    records = records.filter((record) => record.index >= status.oldestIndex);
  }
  updateControls();
  renderHistory();
}

setInterval(() => {
  if (syncing && Date.now() - lastSyncData > SYNC_STALL_MS) {
    lastSyncData = Date.now();
    resumePending = false;
    requestResume();
  }
}, 1000);

// Neue Messungen nachladen. Im Kalender nur, wenn der heutige Tag gewaehlt ist.
setInterval(() => {
  if (isConnected() && (!dayMode() || sameDay(selectedDay, new Date()))) {
    startSync();
  }
}, AUTO_REFRESH_MS);

// --- Kalender -----------------------------------------------------------

// Laedt den gewaehlten Tag. Der Zeitindex der Segmente zeigt, ab welchem
// Datensatz der Tag beginnen kann. Geladen wird von dort bis zum Tagesende.
async function loadDay() {
  renderCalendar();
  if (!isConnected() || !status) {
    return;
  }
  if (syncing) {
    syncing = false;
    await sendCommand(CMD_DOWNLOAD_CANCEL);
  }
  await fetchSegments();

  const [dayStart, dayEnd] = dayBounds();
  let startSegment = segments.length ? segments[0].segment : 0;
  let endIndex = status.nextIndex;
  for (const s of segments) {
    if (s.epoch > 0 && s.epoch <= dayStart) {
      startSegment = s.segment;
    }
    if (s.epoch >= dayEnd) {
      endIndex = s.segment * SEGMENT_RECORDS;
      break;
    }
  }
  dayStartIndex = Math.max(status.oldestIndex, startSegment * SEGMENT_RECORDS);
  dayEndIndex = Math.max(dayStartIndex, endIndex);

  records = [];
  nextRecord = dayStartIndex;
  hoverEpoch = null;
  renderHistory();
  await startSync();
}

function selectDay(date) {
  const today = startOfDay(new Date());
  selectedDay = startOfDay(date > today ? today : date);
  calendarMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
  run(loadDay);
}

function renderCalendar() {
  ui.calendar.hidden = !dayMode();
  if (!dayMode()) {
    return;
  }
  const today = startOfDay(new Date());
  const minDay = firstDataDay();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();

  ui.calTitle.textContent = calendarMonth.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  ui.calGrid.replaceChildren();
  for (const name of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) {
    const head = document.createElement("span");
    head.className = "weekday";
    head.textContent = name;
    ui.calGrid.append(head);
  }
  // Montag ist der erste Tag der Woche
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) {
    ui.calGrid.append(document.createElement("span"));
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(d);
    button.disabled = date > today || (minDay !== null && date < minDay);
    if (date.getTime() === selectedDay.getTime()) {
      button.classList.add("selected");
    }
    if (date.getTime() === today.getTime()) {
      button.classList.add("today");
    }
    button.addEventListener("click", () => selectDay(date));
    ui.calGrid.append(button);
  }

  ui.calPrev.disabled = minDay !== null && calendarMonth <= new Date(minDay.getFullYear(), minDay.getMonth(), 1);
  ui.calNext.disabled = new Date(year, month + 1, 1) > today;
  ui.dayPrev.disabled = minDay !== null && selectedDay <= minDay;
  ui.dayNext.disabled = selectedDay >= today;
  ui.dayToday.disabled = selectedDay.getTime() === today.getTime();
}

// --- Sensoren -----------------------------------------------------------

function renderSensors() {
  // Nicht neu aufbauen, solange ein Name bearbeitet wird.
  if (ui.sensors.contains(document.activeElement) && document.activeElement.tagName === "INPUT") {
    return;
  }
  ui.sensors.replaceChildren();
  sensors.forEach((sensor, slot) => {
    if (!sensor.used) {
      return;
    }
    const value = temps[slot];
    const ok = sensor.present && value !== null && value !== undefined;

    const tile = document.createElement("div");
    tile.className = ok ? "value" : "value missing";
    tile.style.setProperty("--color", seriesColor(slot));

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${slot + 1}. ${sensorName(slot)}`;

    const number = document.createElement("span");
    number.className = "number";
    if (ok) {
      number.textContent = formatNumber(value, 1) + " ";
      const unit = document.createElement("small");
      unit.textContent = "°C";
      number.append(unit);
    } else {
      number.textContent = sensor.present ? "kein Messwert" : "nicht gefunden";
    }

    const address = document.createElement("span");
    address.className = "address";
    address.textContent = sensorLocation(sensor);

    // Name direkt eingeben und speichern, wie im Templogger
    const input = document.createElement("input");
    input.type = "text";
    input.value = sensor.name;
    input.placeholder = `Sensor ${slot + 1}`;
    input.maxLength = SENSOR_NAME_BYTES;
    input.setAttribute("aria-label", `Name für Sensor ${slot + 1}`);
    input.disabled = !isConnected();

    const controls = document.createElement("div");
    controls.className = "controls";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "secondary small";
    save.textContent = "Speichern";
    save.disabled = !isConnected();
    save.addEventListener("click", () => run(() => renameSensor(slot, input.value)));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        run(() => renameSensor(slot, input.value));
      }
    });
    controls.append(input, save);
    if (!sensor.present) {
      const forget = document.createElement("button");
      forget.type = "button";
      forget.className = "danger small";
      forget.textContent = "Vergessen";
      forget.disabled = !isConnected();
      forget.addEventListener("click", () => run(() => forgetSensor(slot)));
      controls.append(forget);
    }

    tile.append(label, number, address, controls);
    ui.sensors.append(tile);
  });

  if (isConnected() && status && !sensors.some((sensor) => sensor.used)) {
    const hint = document.createElement("p");
    hint.className = "message";
    hint.textContent =
      "Keine Sensoren gefunden. Verkabelung und den 4,7-kΩ-Pull-up an der Datenleitung prüfen.";
    ui.sensors.append(hint);
  }
}

// Adresse und Pin, an dem der Sensor zuletzt gefunden wurde
function sensorLocation(sensor) {
  return sensor.pin >= 0 ? `${sensor.address} · GPIO ${sensor.pin}` : sensor.address;
}

// Kuerzt auf SENSOR_NAME_BYTES Bytes UTF-8, ohne ein Zeichen zu zerschneiden.
function encodeName(name) {
  const encoder = new TextEncoder();
  const chars = [...name.trim()];
  while (encoder.encode(chars.join("")).length > SENSOR_NAME_BYTES) {
    chars.pop();
  }
  return encoder.encode(chars.join(""));
}

async function renameSensor(slot, name) {
  const bytes = encodeName(name);
  const data = new Uint8Array(1 + bytes.length);
  data[0] = slot;
  data.set(bytes, 1);
  await enqueue(() => sensorNameChar.writeValueWithResponse(data));
  document.activeElement.blur();
  showMessage("");
  renderSensors();
}

async function forgetSensor(slot) {
  if (confirm(`${sensorName(slot)} vergessen? Der Slot wird frei und beim nächsten Suchen neu vergeben.`)) {
    await sendCommand(CMD_FORGET, slot);
  }
}

// --- Verlauf ------------------------------------------------------------

function formatTime(epoch) {
  return new Date(epoch * 1000).toLocaleString("de-DE");
}

function timedRecords() {
  return records.filter((record) => record.epoch > 0);
}

// Slots, die im Log vorkommen oder aktuell belegt sind
function activeSlots() {
  const slots = [];
  for (let slot = 0; slot < MAX_SENSORS; slot++) {
    if (sensors[slot].used || records.some((record) => record.temps[slot] !== null)) {
      slots.push(slot);
    }
  }
  return slots;
}

function singleView() {
  return ui.view.value === "single";
}

function renderHistory() {
  renderCalendar();
  const timed = timedRecords();
  const dayText = dayMode()
    ? selectedDay.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }) + ": "
    : "";
  if (records.length === 0 && !isConnected()) {
    ui.history.textContent = "Noch keine Daten geladen";
  } else if (records.length === 0) {
    ui.history.textContent = dayMode() ? `${dayText}keine Messwerte` : "Keine Logdaten vorhanden";
  } else if (dayMode()) {
    ui.history.textContent = `${dayText}${records.length.toLocaleString("de-DE")} Datensätze`;
  } else {
    let text = `${records.length.toLocaleString("de-DE")} Datensätze`;
    if (timed.length > 0) {
      text += `, ${formatTime(timed[0].epoch)} bis ${formatTime(timed[timed.length - 1].epoch)}`;
    }
    const missing = records.length - timed.length;
    if (missing > 0) {
      text += `. ${missing.toLocaleString("de-DE")} davon ohne Uhrzeit, sie fehlen im ` +
        "Diagramm und stehen ohne Datum in der CSV-Datei.";
    }
    ui.history.textContent = text;
  }

  const slots = activeSlots();
  ui.combined.hidden = singleView();
  ui.chartList.hidden = !singleView();

  if (singleView()) {
    // Je Sensor eine Karte mit eigenem Diagramm
    ui.chartList.replaceChildren();
    singleCharts = slots.map((slot) => {
      const card = document.createElement("div");
      card.className = "chart-card";
      card.style.setProperty("--color", seriesColor(slot));
      const title = document.createElement("h3");
      title.textContent = `${slot + 1}. ${sensorName(slot)}`;
      const address = document.createElement("span");
      address.className = "address";
      address.textContent = sensorLocation(sensors[slot]);
      const canvas = document.createElement("canvas");
      const tooltip = document.createElement("p");
      tooltip.className = "tooltip";
      card.append(title, address, canvas, tooltip);
      ui.chartList.append(card);
      addPointerHandlers(canvas);
      return { slot, canvas, tooltip };
    });
  } else {
    singleCharts = [];
    ui.legend.replaceChildren();
    for (const slot of slots) {
      const item = document.createElement("span");
      item.style.setProperty("--color", seriesColor(slot));
      item.textContent = sensorName(slot);
      ui.legend.append(item);
    }
  }
  drawCharts();
  updateControls();
}

// Zeitachse aller Diagramme: im Kalender der ganze Tag, sonst die geladenen Daten
function chartSpan(points) {
  if (points.length === 0) {
    return null;
  }
  if (dayMode()) {
    return dayBounds();
  }
  return [points[0].epoch, Math.max(points[points.length - 1].epoch, points[0].epoch + 60)];
}

function drawCharts() {
  const points = timedRecords().sort((a, b) => a.epoch - b.epoch);
  const span = chartSpan(points);
  if (singleView()) {
    for (const chart of singleCharts) {
      drawChart(chart.canvas, [chart.slot], chart.tooltip, points, span);
    }
  } else {
    drawChart(ui.chart, activeSlots(), ui.tooltip, points, span);
  }
}

function niceStep(raw) {
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

function chartArea(width, height) {
  return { left: 44, right: width - 8, top: 8, bottom: height - 22 };
}

function drawChart(canvas, slots, tooltip, points, span) {
  const style = getComputedStyle(document.documentElement);
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0) {
    return;
  }
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px system-ui, sans-serif";

  const area = chartArea(width, height);
  const muted = style.getPropertyValue("--muted").trim();
  const border = style.getPropertyValue("--border").trim();

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(area.left, area.top, area.right - area.left, area.bottom - area.top);

  let min = Infinity;
  let max = -Infinity;
  for (const record of points) {
    for (const slot of slots) {
      const v = record.temps[slot];
      if (v !== null) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }
  if (!span || !Number.isFinite(min)) {
    tooltip.textContent = "";
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Keine Daten", (area.left + area.right) / 2, (area.top + area.bottom) / 2);
    return;
  }
  const pad = Math.max(0.5, (max - min) * 0.08);
  min -= pad;
  max += pad;

  const [startEpoch, endEpoch] = span;
  const duration = endEpoch - startEpoch;
  const toX = (epoch) => area.left + ((epoch - startEpoch) / duration) * (area.right - area.left);
  const toY = (value) => area.bottom - ((value - min) / (max - min)) * (area.bottom - area.top);

  // Hilfslinien und Beschriftung der Temperaturachse
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yStep = niceStep((max - min) / (height > 200 ? 5 : 3));
  for (let v = Math.ceil(min / yStep) * yStep; v <= max; v += yStep) {
    ctx.beginPath();
    ctx.moveTo(area.left, toY(v));
    ctx.lineTo(area.right, toY(v));
    ctx.stroke();
    const label = Math.abs(v) < yStep / 1000 ? 0 : v;  // sonst steht dort "-0"
    ctx.fillText(formatNumber(label, yStep < 1 ? 1 : 0), area.left - 6, toY(v));
  }

  // Zeitachse, an der Ortszeit ausgerichtet
  const offset = -new Date().getTimezoneOffset() * 60;
  const steps = [600, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];
  const maxTicks = width > 500 ? 6 : 4;
  const xStep = steps.find((s) => duration / s <= maxTicks) || steps[steps.length - 1];
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let t = Math.ceil((startEpoch + offset) / xStep) * xStep - offset; t <= endEpoch; t += xStep) {
    ctx.beginPath();
    ctx.moveTo(toX(t), area.top);
    ctx.lineTo(toX(t), area.bottom);
    ctx.stroke();
    const date = new Date(t * 1000);
    const label = xStep >= 86400
      ? date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })
      : date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    // Am Rand buendig ausrichten, damit nichts abgeschnitten wird
    const x = toX(t);
    ctx.textAlign = x > area.right - 20 ? "right" : x < area.left + 20 ? "left" : "center";
    ctx.fillText(label, x, area.bottom + 6);
  }

  // Bei vielen Punkten reicht ein Punkt je Bildschirmpixel.
  const step = Math.max(1, Math.floor(points.length / (area.right - area.left)));
  // Luecken (Stromausfall, fehlender Sensor) werden nicht verbunden.
  const maxGap = Math.max(300, (status ? status.intervalS : 60) * 3) * step;

  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  for (const slot of slots) {
    ctx.strokeStyle = seriesColor(slot);
    ctx.beginPath();
    let previousEpoch = null;
    for (let i = 0; i < points.length; i += step) {
      const record = points[i];
      const v = record.temps[slot];
      if (v === null) {
        previousEpoch = null;
        continue;
      }
      if (previousEpoch === null || record.epoch - previousEpoch > maxGap) {
        ctx.moveTo(toX(record.epoch), toY(v));
      } else {
        ctx.lineTo(toX(record.epoch), toY(v));
      }
      previousEpoch = record.epoch;
    }
    ctx.stroke();
  }

  // Fadenkreuz mit den Werten des naechsten Datensatzes
  if (hoverEpoch === null) {
    tooltip.textContent = "";
    return;
  }
  const record = nearestRecord(points, hoverEpoch);
  const x = toX(record.epoch);
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, area.top);
  ctx.lineTo(x, area.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  tooltip.replaceChildren();
  const when = document.createElement("b");
  when.textContent = formatTime(record.epoch);
  tooltip.append(when);
  for (const slot of slots) {
    const v = record.temps[slot];
    if (v === null) {
      continue;
    }
    ctx.fillStyle = seriesColor(slot);
    ctx.beginPath();
    ctx.arc(x, toY(v), 4, 0, Math.PI * 2);
    ctx.fill();
    const dot = document.createElement("span");
    dot.style.color = seriesColor(slot);
    dot.textContent = "  ● ";
    const label = slots.length > 1 ? `${sensorName(slot)} ` : "";
    tooltip.append(dot, document.createTextNode(`${label}${formatNumber(v, 1)} °C`));
  }
}

function nearestRecord(points, epoch) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].epoch < epoch) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.abs(points[lo].epoch - epoch) <= Math.abs(points[hi].epoch - epoch) ? points[lo] : points[hi];
}

// Das Fadenkreuz steht in allen Diagrammen an derselben Zeit.
function onPointer(event) {
  const span = chartSpan(timedRecords().sort((a, b) => a.epoch - b.epoch));
  if (!span) {
    return;
  }
  const [startEpoch, endEpoch] = span;
  const rect = event.currentTarget.getBoundingClientRect();
  const area = chartArea(rect.width, rect.height);
  const fraction = (event.clientX - rect.left - area.left) / (area.right - area.left);
  hoverEpoch = startEpoch + Math.min(1, Math.max(0, fraction)) * (endEpoch - startEpoch);
  drawCharts();
}

function addPointerHandlers(canvas) {
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", () => {
    hoverEpoch = null;
    drawCharts();
  });
}

// --- CSV ----------------------------------------------------------------

function csvNumber(value, digits) {
  return value.toFixed(digits).replace(".", ",");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function csvDate(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function csvTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Semikolon und Dezimalkomma, damit ein deutsches Excel die Datei direkt oeffnet.
function downloadCsv() {
  const slots = activeSlots();
  const header = ["Datum", "Uhrzeit", "Laufzeit_s", ...slots.map((slot) => sensorName(slot).replace(/;/g, ","))];
  const lines = [header.join(";")];
  for (const record of records) {
    const date = new Date(record.epoch * 1000);
    lines.push(
      [
        record.epoch > 0 ? csvDate(date) : "",
        record.epoch > 0 ? csvTime(date) : "",
        record.uptimeS,
        ...slots.map((slot) => (record.temps[slot] === null ? "" : csvNumber(record.temps[slot], 2))),
      ].join(";")
    );
  }
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const now = new Date();
  link.href = URL.createObjectURL(blob);
  link.download = dayMode()
    ? `heizkreis_${selectedDay.getFullYear()}-${pad(selectedDay.getMonth() + 1)}-${pad(selectedDay.getDate())}.csv`
    : `heizkreis_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// --- Bedienung ----------------------------------------------------------

function updateControls() {
  const connected = isConnected() && status !== null;
  ui.refresh.disabled = !connected || syncing;
  ui.download.disabled = records.length === 0 || syncing;
  ui.interval.disabled = !connected;
  ui.measure.disabled = !connected;
  ui.scan.disabled = !connected;
  ui.clear.disabled = !connected || syncing;
  for (const control of ui.sensors.querySelectorAll("button, input")) {
    control.disabled = !connected;
  }
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    showMessage(`Befehl fehlgeschlagen: ${error.message}`);
  }
}

ui.connect.addEventListener("click", () => {
  if (device && device.gatt.connected) {
    device.gatt.disconnect();
  } else {
    connect();
  }
});

ui.range.addEventListener("change", () => {
  hoverEpoch = null;
  if (dayMode()) {
    run(loadDay);
    return;
  }
  renderCalendar();
  if (!isConnected()) {
    drawCharts();
    return;
  }
  run(async () => {
    if (syncing) {
      syncing = false;
      await sendCommand(CMD_DOWNLOAD_CANCEL);
    }
    resetRecords();
    renderHistory();
    await startSync();
  });
});

ui.calPrev.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
ui.calNext.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
ui.dayPrev.addEventListener("click", () => selectDay(addDays(selectedDay, -1)));
ui.dayNext.addEventListener("click", () => selectDay(addDays(selectedDay, 1)));
ui.dayToday.addEventListener("click", () => selectDay(new Date()));

ui.view.addEventListener("change", () => {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, ui.view.value);
  } catch (e) {}
  hoverEpoch = null;
  renderHistory();
});

ui.refresh.addEventListener("click", () => run(startSync));
ui.download.addEventListener("click", downloadCsv);
ui.interval.addEventListener("change", () => run(() => sendCommand(CMD_SET_INTERVAL, Number(ui.interval.value))));
ui.measure.addEventListener("click", () => run(() => sendCommand(CMD_MEASURE)));
ui.scan.addEventListener("click", () => run(() => sendCommand(CMD_SCAN)));

ui.clear.addEventListener("click", () => {
  if (confirm("Alle Logdaten auf dem ESP32 unwiderruflich löschen?")) {
    run(async () => {
      await sendCommand(CMD_LOG_CLEAR);
      records = [];
      nextRecord = 0;
      renderHistory();
    });
  }
});

addPointerHandlers(ui.chart);
window.addEventListener("resize", drawCharts);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderSensors();
  renderHistory();
});

if (!navigator.bluetooth) {
  ui.connect.disabled = true;
  showMessage(
    "Dieser Browser unterstützt Web Bluetooth nicht, oder die Seite läuft nicht über " +
      "HTTPS bzw. localhost. Nutze Chrome oder Edge auf Android oder dem PC."
  );
}

try {
  const savedView = localStorage.getItem(VIEW_STORAGE_KEY);
  if (savedView === "single" || savedView === "combined") {
    ui.view.value = savedView;
  }
} catch (e) {}

renderHistory();
