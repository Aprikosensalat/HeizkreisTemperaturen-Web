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
const CHAR_CALIBRATION_UUID = "7e6a0008-5c3b-4d2a-9f1e-8b4c2d6e0a01";

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
const CMD_SET_OFFSET = 11;
const CMD_CALIBRATE = 12;
const CMD_CLEAR_OFFSETS = 13;

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
// Einstellungen im localStorage, Logdaten in IndexedDB
const CHARTS_STORAGE_KEY = "heizkreis-charts";
const RANGE_STORAGE_KEY = "heizkreis-range";
const SENSORS_STORAGE_KEY = "heizkreis-sensors";
const DB_NAME = "heizkreis";
const DB_STORE = "records";
const LOCAL_SAVE_BATCH = 500;
const TAB_STORAGE_KEY = "heizkreis-tab";
const ZOOM_STORAGE_KEY = "heizkreis-zoom";
const OFFSET_MAX = 20;  // Grad, wie OFFSET_MAX in der Firmware

const el = (id) => document.getElementById(id);

const ui = {
  connect: el("connect"),
  message: el("message"),
  connection: el("connection"),
  sensors: el("sensors"),
  range: el("range"),
  addChart: el("addChart"),
  refresh: el("refresh"),
  download: el("download"),
  progress: el("progress"),
  history: el("history"),
  chartList: el("chartList"),
  localInfo: el("localInfo"),
  clearLocal: el("clearLocal"),
  archive: el("archive"),
  archiveProgress: el("archiveProgress"),
  archiveStatus: el("archiveStatus"),
  chartDialog: el("chartDialog"),
  chartDialogTitle: el("chartDialogTitle"),
  chartTitle: el("chartTitle"),
  chartAll: el("chartAll"),
  chartSelectAll: el("chartSelectAll"),
  chartSelectNone: el("chartSelectNone"),
  chartSensorList: el("chartSensorList"),
  chartSplit: el("chartSplit"),
  chartSplitLabel: el("chartSplitLabel"),
  chartDialogError: el("chartDialogError"),
  chartCancel: el("chartCancel"),
  chartOk: el("chartOk"),
  calendar: el("calendar"),
  calPrev: el("calPrev"),
  calNext: el("calNext"),
  calTitle: el("calTitle"),
  calGrid: el("calGrid"),
  dayPrev: el("dayPrev"),
  dayToday: el("dayToday"),
  dayNext: el("dayNext"),
  zoomControls: el("zoomControls"),
  zoom: el("zoom"),
  panPrev: el("panPrev"),
  panNext: el("panNext"),
  zoomRange: el("zoomRange"),
  interval: el("interval"),
  measure: el("measure"),
  scan: el("scan"),
  storage: el("storage"),
  clear: el("clear"),
  calibrateAll: el("calibrateAll"),
  clearOffsets: el("clearOffsets"),
  calibrationInfo: el("calibrationInfo"),
  calibrationList: el("calibrationList"),
  tabs: document.querySelectorAll("[data-tab]"),
  pages: document.querySelectorAll("[data-page]"),
};

let device = null;
let controlChar = null;
let sensorNameChar = null;
let status = null;
let sensors = emptySensors();  // je Slot {used, present, address, name}
let temps = [];                 // aktuelle Werte in Grad, null = kein Wert
let offsets = [];               // Offset je Slot in Grad
let rawTemps = [];              // Rohwerte ohne Offset, null = kein Wert
let calibrationSupported = false;
let calibrating = false;
let records = [];
let nextRecord = 0;
let syncing = false;
let resumePending = false;
let lastSyncData = 0;
let writeChain = Promise.resolve();
let hoverEpoch = null;

// Diagramme: {title, all, slots, hidden}. all = alle Sensoren, auch spaeter gefundene.
// hidden = in der Legende ausgeblendete Slots. Wird im Browser gespeichert.
let charts = [{ title: "", all: true, slots: [], hidden: [] }];
let chartViews = [];            // [{chart, canvas, tooltip}] der angezeigten Diagramme
let dialogChartIndex = null;    // im Dialog bearbeitetes Diagramm, null = neues

// Logdaten im Browser (IndexedDB)
let recordsFromBrowser = false; // records stammen aus dem Browser, nicht vom ESP32
let pendingLocal = [];          // noch nicht gespeicherte Datensaetze
let localDays = new Set();      // Tage (ms, 0 Uhr) mit Daten im Browser
let localFirstDay = null;
let localLoadToken = 0;
// Ganzes Log in den Browser laden: {start, next, stored, noTime, startedMs, lastData, resumePending}
let archive = null;

// Kalender: Zeitindex der Segmente und gewaehlter Tag
let segments = [];              // [{segment, epoch}], epoch 0 = unbekannt
let segmentsBuffer = [];
let segmentsResolve = null;
let selectedDay = startOfDay(new Date());
let calendarMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
let dayStartIndex = 0;
let dayEndIndex = 0;
let viewEnd = null;             // Ende des Ausschnitts, null = am Ende (jetzt bzw. Tagesende)

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

    // Aeltere Firmware hat keine Kalibrierung, die Seite laeuft dann ohne.
    let calibrationChar = null;
    try {
      calibrationChar = await service.getCharacteristic(CHAR_CALIBRATION_UUID);
      calibrationChar.addEventListener("characteristicvaluechanged", (event) => {
        onCalibration(event.target.value);
      });
      await calibrationChar.startNotifications();
      calibrationSupported = true;
    } catch (error) {
      calibrationChar = null;
      calibrationSupported = false;
    }

    // Korrigiert auch alle Daten, die seit dem Start ohne Uhrzeit geloggt wurden.
    await sendCommand(CMD_SET_TIME, Math.floor(Date.now() / 1000));
    // Die Sensorliste kommt in Teilen ueber Notifications.
    sensors = emptySensors();
    await sendCommand(CMD_SENSOR_LIST);
    onTemperatures(await temperaturesChar.readValue());
    onStatus(await statusChar.readValue());
    if (calibrationChar) {
      onCalibration(await calibrationChar.readValue());
    }

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
  offsets = [];
  rawTemps = [];
  calibrationSupported = false;
  calibrating = false;
  ui.progress.hidden = true;
  ui.connection.textContent = "Nicht verbunden";
  ui.connect.textContent = "Verbinden";
  ui.storage.textContent = "Speicher: –";
  if (archive) {
    finishArchive(false, ", weil die Verbindung getrennt wurde");
  }
  flushLocal();
  renderSensors();
  renderCalibration();
  renderHistory();
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
  renderCalibration();
}

// Kalibrierung: 32 x i16 Offsets, danach 32 x i16 Rohwerte, beides in 1/100 Grad
function onCalibration(view) {
  const count = Math.min(MAX_SENSORS, Math.floor(view.byteLength / 4));
  offsets = [];
  rawTemps = [];
  for (let slot = 0; slot < count; slot++) {
    offsets.push(view.getInt16(slot * 2, true) / 100);
    const raw = view.getInt16((MAX_SENSORS + slot) * 2, true);
    rawTemps.push(raw === NO_VALUE ? null : raw / 100);
  }
  if (calibrating) {
    calibrating = false;
    showMessage("");
  }
  renderSensors();
  renderCalibration();
  updateControls();
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
  saveSensorsLocal();
  renderSensors();
  renderCalibration();
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
  if (archive) {
    onArchiveData(view);
    return;
  }
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
    const record = {
      index: first + i,
      epoch,
      uptimeS: view.getUint32(offset + 4, true),
      temps: readTemps(view, offset + 8),
    };
    records.push(record);
    if (epoch > 0) {
      pendingLocal.push(record);
    }
  }
  nextRecord = first + count;
  if (pendingLocal.length >= LOCAL_SAVE_BATCH) {
    flushLocal();
  }

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
// Erster Tag mit Daten auf dem ESP32 oder im Browser, null = nicht begrenzen
function firstDataDay() {
  // Hat das aelteste Segment keine Uhrzeit, koennen spaetere Datensaetze darin
  // trotzdem eine haben. Dann den Kalender nicht nach vorne begrenzen.
  if (segments.length > 0 && segments[0].epoch === 0) {
    return null;
  }
  const days = [];
  if (segments.length > 0) {
    days.push(startOfDay(new Date(segments[0].epoch * 1000)));
  }
  if (localFirstDay) {
    days.push(localFirstDay);
  }
  return days.length ? new Date(Math.min(...days)) : null;
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
  recordsFromBrowser = false;
  nextRecord = rangeStartIndex();
}

async function startSync() {
  if (syncing || archive || !isConnected()) {
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
  flushLocal();
  updateControls();
  renderHistory();
}

setInterval(() => {
  if (syncing && Date.now() - lastSyncData > SYNC_STALL_MS) {
    lastSyncData = Date.now();
    resumePending = false;
    requestResume();
  }
  if (archive && Date.now() - archive.lastData > SYNC_STALL_MS) {
    archive.lastData = Date.now();
    archive.resumePending = false;
    requestArchiveResume();
  }
}, 1000);

// --- Ganzes Log in den Browser laden --------------------------------------

async function startArchive() {
  if (!isConnected() || !status || archive) {
    return;
  }
  if (syncing) {
    syncing = false;
    ui.progress.hidden = true;
    await sendCommand(CMD_DOWNLOAD_CANCEL);
  }
  archive = {
    start: status.oldestIndex,
    next: status.oldestIndex,
    stored: 0,
    noTime: 0,
    startedMs: Date.now(),
    lastData: Date.now(),
    resumePending: false,
  };
  showMessage("");
  updateArchiveUi();
  updateControls();
  await sendCommand(CMD_DOWNLOAD, archive.next);
}

function requestArchiveResume() {
  if (!archive || archive.resumePending || !isConnected()) {
    return;
  }
  archive.resumePending = true;
  sendCommand(CMD_DOWNLOAD, archive.next).catch(() => {
    if (archive) {
      archive.resumePending = false;
    }
  });
}

// Wie onLogData, aber alles geht nur in den Browser-Speicher.
function onArchiveData(view) {
  const first = view.getUint32(0, true);
  const count = Math.floor((view.byteLength - 4) / RECORD_SIZE);
  archive.lastData = Date.now();

  // Alte Daten wurden inzwischen auf dem Geraet ueberschrieben.
  if (status && archive.next < status.oldestIndex && first >= status.oldestIndex) {
    archive.next = first;
  }
  if (first !== archive.next) {
    requestArchiveResume();
    return;
  }
  archive.resumePending = false;

  if (count === 0) {
    finishArchive(true);
    return;
  }
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * RECORD_SIZE;
    const epoch = view.getUint32(offset, true);
    if (epoch === 0) {
      archive.noTime++;
      continue;
    }
    pendingLocal.push({
      epoch,
      uptimeS: view.getUint32(offset + 4, true),
      temps: readTemps(view, offset + 8),
    });
    archive.stored++;
  }
  archive.next = first + count;
  if (pendingLocal.length >= LOCAL_SAVE_BATCH) {
    flushLocal(false);  // Anzeige erst am Ende auffrischen, getAllKeys ist teuer
  }
  updateArchiveUi();
}

async function finishArchive(complete, reason = "") {
  const done = archive;
  archive = null;
  await flushLocal();
  let text = complete
    ? `Fertig: ${done.stored.toLocaleString("de-DE")} Datensätze vom ESP32 im Browser gespeichert.`
    : `Abgebrochen${reason}. ${done.stored.toLocaleString("de-DE")} Datensätze sind bis dahin gespeichert.`;
  if (done.noTime > 0) {
    text += ` ${done.noTime.toLocaleString("de-DE")} Datensätze ohne Uhrzeit wurden übersprungen.`;
  }
  showMessage(text);
  updateArchiveUi();
  updateControls();
  // Die laufende Ansicht wurde fuer den Download unterbrochen, jetzt neu laden.
  if (isConnected() && status) {
    if (dayMode()) {
      await loadDay();
    } else {
      resetRecords();
      renderHistory();
      await startSync();
    }
  }
}

async function cancelArchive() {
  if (!archive) {
    return;
  }
  await sendCommand(CMD_DOWNLOAD_CANCEL).catch(() => {});
  await finishArchive(false);
}

function updateArchiveUi() {
  ui.archive.textContent = archive ? "Abbrechen" : "Alles vom ESP32 in den Browser laden";
  ui.archive.classList.toggle("danger", Boolean(archive));
  ui.archiveProgress.hidden = !archive;
  ui.archiveStatus.hidden = !archive;
  if (!archive) {
    return;
  }
  const end = status ? status.nextIndex : archive.next;
  const total = Math.max(1, end - archive.start);
  const done = Math.max(0, archive.next - archive.start);
  ui.archiveProgress.max = total;
  ui.archiveProgress.value = done;
  let text = `${done.toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")} Datensätzen geladen`;
  const elapsed = (Date.now() - archive.startedMs) / 1000;
  if (done > 0 && elapsed > 3) {
    const rest = ((total - done) * elapsed) / done;
    text += rest >= 90 ? `, noch etwa ${Math.ceil(rest / 60)} min` : `, noch etwa ${Math.ceil(rest)} s`;
  }
  ui.archiveStatus.textContent = text;
}

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
    await loadLocal();
    return;
  }
  // Waehrend "Alles laden" laeuft, wird die Ansicht danach neu geladen.
  if (archive) {
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
  recordsFromBrowser = false;
  nextRecord = dayStartIndex;
  hoverEpoch = null;
  viewEnd = null;
  renderHistory();
  await startSync();
}

function selectDay(date) {
  const today = startOfDay(new Date());
  selectedDay = startOfDay(date > today ? today : date);
  viewEnd = null;
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
    if (localDays.has(date.getTime())) {
      button.classList.add("has-data");
      button.title = "Daten im Browser gespeichert";
    }
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
  // Ohne Verbindung gibt es keine aktuellen Werte, die Namen kommen aus dem Browser.
  if (!isConnected()) {
    return;
  }
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
    address.textContent = sensorLocation(sensor, slot);

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

// Adresse und Pin, an dem der Sensor zuletzt gefunden wurde, dazu ein Offset ungleich 0
function sensorLocation(sensor, slot) {
  let text = sensor.pin >= 0 ? `${sensor.address} · GPIO ${sensor.pin}` : sensor.address;
  if (slot !== undefined && offsets[slot]) {
    text += ` · Offset ${formatSigned(offsets[slot])} K`;
  }
  return text;
}

function formatSigned(value) {
  return (value > 0 ? "+" : "") + formatNumber(value, 2);
}

// --- Kalibrierung -------------------------------------------------------

// Spanne zwischen groesstem und kleinstem Wert, null bei weniger als 2 Werten
function spread(values) {
  const valid = values.filter((v) => v !== null && v !== undefined);
  return valid.length < 2 ? null : Math.max(...valid) - Math.min(...valid);
}

function renderCalibration() {
  // Nicht neu aufbauen, solange ein Offset bearbeitet wird.
  if (ui.calibrationList.contains(document.activeElement) && document.activeElement.tagName === "INPUT") {
    return;
  }
  ui.calibrationList.replaceChildren();

  if (!isConnected()) {
    ui.calibrationInfo.textContent = "Nicht verbunden";
    return;
  }
  if (!calibrationSupported) {
    ui.calibrationInfo.textContent =
      "Die Firmware auf dem ESP32 kennt noch keine Kalibrierung. Bitte die aktuelle Firmware flashen.";
    return;
  }

  const slots = [];
  sensors.forEach((sensor, slot) => {
    if (sensor.used) {
      slots.push(slot);
    }
  });
  const present = slots.filter((slot) => sensors[slot].present && rawTemps[slot] !== null && rawTemps[slot] !== undefined);
  if (present.length > 0) {
    const raws = present.map((slot) => rawTemps[slot]);
    const mean = raws.reduce((a, b) => a + b, 0) / raws.length;
    const rawSpread = spread(raws);
    const calSpread = spread(present.map((slot) => temps[slot]));
    let text = `${present.length} Sensor(en) mit Messwert. Mittelwert der Rohwerte ${formatNumber(mean, 2)} °C`;
    if (rawSpread !== null) {
      text += `, Spanne roh ${formatNumber(rawSpread, 2)} K, korrigiert ${formatNumber(calSpread, 2)} K`;
    }
    ui.calibrationInfo.textContent = text + ".";
  } else {
    ui.calibrationInfo.textContent = "Noch keine Messwerte.";
  }

  for (const slot of slots) {
    const sensor = sensors[slot];
    const raw = rawTemps[slot];
    const value = temps[slot];
    const offset = offsets[slot] || 0;

    const row = document.createElement("div");
    row.className = "calibration-row";
    row.style.setProperty("--color", seriesColor(slot));

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `${slot + 1}. ${sensorName(slot)}`;

    const values = document.createElement("span");
    values.className = "readings";
    if (!sensor.present) {
      values.textContent = "nicht gefunden";
    } else if (raw === null || raw === undefined) {
      values.textContent = "kein Messwert";
    } else {
      values.textContent =
        `roh ${formatNumber(raw, 2)} °C  ${offset < 0 ? "−" : "+"} ${formatNumber(Math.abs(offset), 2)} K  = ` +
        `${value === null || value === undefined ? "–" : formatNumber(value, 2)} °C`;
    }

    const controls = document.createElement("div");
    controls.className = "controls";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.min = String(-OFFSET_MAX);
    input.max = String(OFFSET_MAX);
    input.value = offset.toFixed(2);
    input.setAttribute("aria-label", `Offset für ${sensorName(slot)} in Kelvin`);
    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = "K";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "secondary small";
    save.textContent = "Speichern";
    save.addEventListener("click", () => run(() => setOffset(slot, input.value)));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        run(() => setOffset(slot, input.value));
      }
    });
    controls.append(input, unit, save);

    row.append(name, values, controls);
    ui.calibrationList.append(row);
  }
  updateControls();
}

async function setOffset(slot, text) {
  // Ein leeres oder ungueltiges Zahlenfeld liefert "", das waere sonst Offset 0.
  const trimmed = String(text).trim().replace(",", ".");
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value) || Math.abs(value) > OFFSET_MAX) {
    showMessage(`Offset muss eine Zahl zwischen −${OFFSET_MAX} und ${OFFSET_MAX} K sein.`);
    return;
  }
  const cents = Math.round(value * 100);
  // Bit 0-7 Slot, Bit 16-31 Offset als i16
  const arg = (((cents & 0xffff) << 16) | slot) >>> 0;
  await sendCommand(CMD_SET_OFFSET, arg);
  document.activeElement.blur();
  showMessage("");
  renderCalibration();
}

async function calibrateAllSensors() {
  const count = sensors.filter((s, slot) => s.present && rawTemps[slot] !== null && rawTemps[slot] !== undefined).length;
  if (count < 2) {
    showMessage("Zum Angleichen braucht es mindestens 2 Sensoren mit Messwert.");
    return;
  }
  if (!confirm(
    `${count} Sensoren angleichen? Alle müssen gerade dieselbe Temperatur haben. ` +
    "Die bisherigen Offsets werden überschrieben."
  )) {
    return;
  }
  calibrating = true;
  showMessage("Messe und gleiche an …");
  await sendCommand(CMD_CALIBRATE);
}

async function clearAllOffsets() {
  if (confirm("Die Offsets aller Sensoren auf 0 setzen?")) {
    await sendCommand(CMD_CLEAR_OFFSETS);
  }
}

// --- Reiter -------------------------------------------------------------

function showTab(name) {
  if (![...ui.tabs].some((tab) => tab.dataset.tab === name)) {
    name = "main";
  }
  for (const tab of ui.tabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const page of ui.pages) {
    page.hidden = page.dataset.page !== name;
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, name);
  } catch (e) {}
  if (name === "main") {
    drawCharts();  // Diagramme haben im versteckten Reiter keine Groesse
  } else {
    renderCalibration();
  }
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

function renderHistory() {
  renderCalendar();
  const timed = timedRecords();
  const dayText = dayMode()
    ? selectedDay.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }) + ": "
    : "";
  if (records.length === 0 && !isConnected()) {
    ui.history.textContent = localDays.size > 0
      ? `${dayText}keine Daten im Browser gespeichert`
      : "Noch keine Daten geladen";
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
  if (recordsFromBrowser && records.length > 0) {
    ui.history.textContent += " (aus dem Browser-Speicher)";
  }

  renderCharts();
  updateControls();
}

// --- Diagramme ----------------------------------------------------------

function chartSlots(chart) {
  return chart.all ? activeSlots() : chart.slots;
}

function visibleSlots(chart) {
  return chartSlots(chart).filter((slot) => !chart.hidden.includes(slot));
}

function chartTitle(chart, index) {
  if (chart.title) {
    return chart.title;
  }
  if (chart.all) {
    return "Alle Sensoren";
  }
  if (chart.slots.length === 1) {
    return `${chart.slots[0] + 1}. ${sensorName(chart.slots[0])}`;
  }
  return `Diagramm ${index + 1}`;
}

function saveCharts() {
  try {
    localStorage.setItem(CHARTS_STORAGE_KEY, JSON.stringify(charts));
  } catch (e) {}
}

function loadCharts() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHARTS_STORAGE_KEY));
    if (!Array.isArray(saved)) {
      return;
    }
    const validSlots = (list) => (Array.isArray(list) ? list : [])
      .filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < MAX_SENSORS);
    charts = saved.map((chart) => ({
      title: typeof chart.title === "string" ? chart.title : "",
      all: Boolean(chart.all),
      slots: validSlots(chart.slots),
      hidden: validSlots(chart.hidden),
    }));
  } catch (e) {}
}

// Baut je Diagramm eine Karte mit Titel, Knoepfen, Diagramm und Legende.
function renderCharts() {
  ui.chartList.replaceChildren();
  chartViews = [];
  if (charts.length === 0) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Kein Diagramm. Über \"Diagramm hinzufügen\" eines anlegen.";
    ui.chartList.append(hint);
  }
  charts.forEach((chart, index) => {
    const slots = chartSlots(chart);
    const card = document.createElement("div");
    card.className = slots.length === 1 ? "chart-card single" : "chart-card";
    if (slots.length === 1) {
      card.style.setProperty("--color", seriesColor(slots[0]));
    }

    const head = document.createElement("div");
    head.className = "chart-head";
    const title = document.createElement("h3");
    title.textContent = chartTitle(chart, index);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary small";
    edit.textContent = "Sensoren";
    edit.addEventListener("click", () => openChartDialog(index));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger small";
    remove.textContent = "Entfernen";
    remove.addEventListener("click", () => {
      if (confirm(`Diagramm "${chartTitle(chart, index)}" entfernen?`)) {
        charts.splice(index, 1);
        saveCharts();
        renderCharts();
      }
    });
    head.append(title, edit, remove);

    const canvas = document.createElement("canvas");
    addPointerHandlers(canvas);

    // Legende: Antippen blendet einen Sensor in diesem Diagramm aus und wieder ein.
    const legend = document.createElement("div");
    legend.className = "legend";
    if (slots.length > 1) {
      for (const slot of slots) {
        const item = document.createElement("button");
        item.type = "button";
        item.style.setProperty("--color", seriesColor(slot));
        item.textContent = sensorName(slot);
        const hidden = chart.hidden.includes(slot);
        item.classList.toggle("off", hidden);
        item.setAttribute("aria-pressed", String(!hidden));
        item.title = hidden ? "Einblenden" : "Ausblenden";
        item.addEventListener("click", () => {
          chart.hidden = hidden ? chart.hidden.filter((s) => s !== slot) : [...chart.hidden, slot];
          saveCharts();
          renderCharts();
        });
        legend.append(item);
      }
    } else if (slots.length === 1) {
      const address = document.createElement("span");
      address.className = "address";
      address.textContent = sensorLocation(sensors[slots[0]], slots[0]);
      legend.append(address);
    }

    const tooltip = document.createElement("p");
    tooltip.className = "tooltip";
    card.append(head, canvas, legend, tooltip);
    ui.chartList.append(card);
    chartViews.push({ chart, canvas, tooltip });
  });
  drawCharts();
}

// Slots fuer die Auswahl: belegte, im Log vorkommende und schon gewaehlte
function selectableSlots(chart) {
  const slots = new Set([...activeSlots(), ...chart.slots]);
  sensors.forEach((sensor, slot) => {
    if (sensor.used) {
      slots.add(slot);
    }
  });
  return [...slots].sort((a, b) => a - b);
}

function openChartDialog(index) {
  dialogChartIndex = index;
  const chart = index === null ? { title: "", all: false, slots: [], hidden: [] } : charts[index];
  ui.chartDialogTitle.textContent = index === null ? "Diagramm hinzufügen" : "Diagramm bearbeiten";
  ui.chartTitle.value = chart.title;
  ui.chartAll.checked = chart.all;
  ui.chartSplit.checked = false;
  ui.chartSplitLabel.hidden = index !== null;
  ui.chartDialogError.hidden = true;

  ui.chartSensorList.replaceChildren();
  const slots = selectableSlots(chart);
  if (slots.length === 0) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Noch keine Sensoren bekannt. Einmal mit dem ESP32 verbinden.";
    ui.chartSensorList.append(hint);
  }
  for (const slot of slots) {
    const label = document.createElement("label");
    label.className = "check";
    label.style.setProperty("--color", seriesColor(slot));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(slot);
    box.checked = chart.all || chart.slots.includes(slot);
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    label.append(box, swatch, document.createTextNode(`${slot + 1}. ${sensorName(slot)}`));
    ui.chartSensorList.append(label);
  }
  updateChartDialog();
  ui.chartDialog.showModal();
}

function dialogBoxes() {
  return [...ui.chartSensorList.querySelectorAll("input[type=checkbox]")];
}

function updateChartDialog() {
  const all = ui.chartAll.checked;
  for (const box of dialogBoxes()) {
    box.disabled = all;
    if (all) {
      box.checked = true;
    }
  }
  ui.chartSelectAll.disabled = all;
  ui.chartSelectNone.disabled = all;
  ui.chartSplit.disabled = all;
}

function applyChartDialog() {
  const all = ui.chartAll.checked;
  const selected = dialogBoxes().filter((box) => box.checked).map((box) => Number(box.value));
  if (!all && selected.length === 0) {
    ui.chartDialogError.textContent = "Mindestens einen Sensor wählen.";
    ui.chartDialogError.hidden = false;
    return;
  }
  const title = ui.chartTitle.value.trim();
  if (dialogChartIndex === null) {
    if (!all && ui.chartSplit.checked) {
      for (const slot of selected) {
        charts.push({ title: "", all: false, slots: [slot], hidden: [] });
      }
    } else {
      charts.push({ title, all, slots: all ? [] : selected, hidden: [] });
    }
  } else {
    const chart = charts[dialogChartIndex];
    chart.title = title;
    chart.all = all;
    chart.slots = all ? [] : selected;
    chart.hidden = chart.hidden.filter((slot) => all || selected.includes(slot));
  }
  saveCharts();
  ui.chartDialog.close();
  hoverEpoch = null;
  renderCharts();
}

// --- Logdaten im Browser -------------------------------------------------

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB wird nicht unterstützt"));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      // Schluessel ist die Unix-Zeit. Indizes des ESP32 beginnen nach "Log loeschen"
      // wieder bei 0 und taugen deshalb nicht als Schluessel.
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: "epoch" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Temperaturen kompakt als 1/100 Grad wie auf dem ESP32
function toStored(record) {
  return {
    epoch: record.epoch,
    uptimeS: record.uptimeS,
    temps: Int16Array.from(record.temps, (v) => (v === null ? NO_VALUE : Math.round(v * 100))),
  };
}

function fromStored(item) {
  return {
    index: -1,
    epoch: item.epoch,
    uptimeS: item.uptimeS,
    temps: Array.from(item.temps, (v) => (v === NO_VALUE ? null : v / 100)),
  };
}

async function flushLocal(refresh = true) {
  if (pendingLocal.length === 0) {
    if (refresh) {
      await refreshLocalInfo();
    }
    return;
  }
  const batch = pendingLocal;
  pendingLocal = [];
  try {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    for (const record of batch) {
      store.put(toStored(record));
    }
    await idbTransaction(tx);
    // Den Browser bitten, die Daten nicht bei Speichermangel zu verwerfen.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if (refresh) {
      await refreshLocalInfo();
    }
  } catch (error) {
    showMessage(`Daten konnten nicht im Browser gespeichert werden: ${error.message}`);
  }
}

async function loadLocalRange(start, end) {
  const db = await openDb();
  const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
  const range = Number.isFinite(end) ? IDBKeyRange.bound(start, end, false, true) : IDBKeyRange.lowerBound(start);
  const items = await idbRequest(store.getAll(range));
  return items.map(fromStored);
}

// Ohne Verbindung den gewaehlten Zeitraum aus dem Browser zeigen
async function loadLocal() {
  if (isConnected()) {
    return;
  }
  let start = 0;
  let end = Infinity;
  if (dayMode()) {
    [start, end] = dayBounds();
  } else {
    const days = Number(ui.range.value);
    if (days > 0) {
      start = Math.floor(Date.now() / 1000) - days * 86400;
    }
  }
  const token = ++localLoadToken;
  let list = [];
  try {
    list = await loadLocalRange(start, end);
  } catch (error) {
    showMessage(`Daten im Browser nicht lesbar: ${error.message}`);
  }
  // Inzwischen verbunden oder anderer Zeitraum gewaehlt
  if (token !== localLoadToken || isConnected()) {
    return;
  }
  records = list;
  recordsFromBrowser = true;
  hoverEpoch = null;
  renderHistory();
}

// Anzahl, Zeitraum und Tage mit Daten fuer Anzeige und Kalender
async function refreshLocalInfo() {
  try {
    const db = await openDb();
    const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
    const keys = await idbRequest(store.getAllKeys());
    localDays = new Set();
    for (const epoch of keys) {
      localDays.add(startOfDay(new Date(epoch * 1000)).getTime());
    }
    localFirstDay = keys.length ? startOfDay(new Date(keys[0] * 1000)) : null;
    ui.localInfo.textContent = keys.length
      ? `Im Browser gespeichert: ${keys.length.toLocaleString("de-DE")} Datensätze vom ` +
        `${formatTime(keys[0])} bis ${formatTime(keys[keys.length - 1])}`
      : "Im Browser gespeichert: keine Daten";
  } catch (error) {
    ui.localInfo.textContent = `Im Browser gespeichert: nicht verfügbar (${error.message})`;
  }
  ui.clearLocal.disabled = localDays.size === 0 || Boolean(archive);
  renderCalendar();
}

async function clearLocal() {
  if (!confirm("Alle lokal im Browser gespeicherten Logdaten löschen? Die Daten auf dem ESP32 bleiben.")) {
    return;
  }
  pendingLocal = [];
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  tx.objectStore(DB_STORE).clear();
  await idbTransaction(tx);
  await refreshLocalInfo();
  if (!isConnected()) {
    records = [];
    renderHistory();
  }
}

// Sensornamen fuer Legenden und Auswahl ohne Verbindung
function saveSensorsLocal() {
  try {
    localStorage.setItem(SENSORS_STORAGE_KEY, JSON.stringify(
      sensors.map((s) => ({ used: s.used, address: s.address, name: s.name }))
    ));
  } catch (e) {}
}

function loadSensorsLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(SENSORS_STORAGE_KEY));
    if (!Array.isArray(saved)) {
      return;
    }
    saved.slice(0, MAX_SENSORS).forEach((s, slot) => {
      sensors[slot] = {
        used: Boolean(s && s.used),
        present: false,
        pin: -1,
        address: s && typeof s.address === "string" ? s.address : "",
        name: s && typeof s.name === "string" ? s.name : "",
      };
    });
  } catch (e) {}
}

// Zeitachse aller Diagramme: im Kalender der gewaehlte Ausschnitt des Tages,
// sonst die geladenen Daten
function chartSpan(points) {
  if (points.length === 0) {
    return null;
  }
  if (dayMode()) {
    return dayWindow();
  }
  return [points[0].epoch, Math.max(points[points.length - 1].epoch, points[0].epoch + 60)];
}

// --- Ausschnitt im Tagesverlauf ------------------------------------------

function zoomSeconds() {
  return dayMode() ? Number(ui.zoom.value) : 0;
}

// Spaetestes Ende des Ausschnitts: heute jetzt, an anderen Tagen das Tagesende.
// Am fruehen Morgen reicht der Ausschnitt ueber "jetzt" hinaus.
function latestWindowEnd(seconds) {
  const [dayStart, dayEnd] = dayBounds();
  const now = Math.floor(Date.now() / 1000);
  return Math.max(Math.min(dayEnd, now), dayStart + seconds);
}

function dayWindow() {
  const [dayStart, dayEnd] = dayBounds();
  const seconds = zoomSeconds();
  if (!seconds || seconds >= dayEnd - dayStart) {
    return [dayStart, dayEnd];
  }
  const latest = latestWindowEnd(seconds);
  const end = Math.max(dayStart + seconds, viewEnd === null ? latest : Math.min(viewEnd, latest));
  return [end - seconds, end];
}

// Verschiebt den Ausschnitt um einen halben Ausschnitt, -1 frueher, +1 spaeter.
function pan(direction) {
  const seconds = zoomSeconds();
  if (!seconds) {
    return;
  }
  const [dayStart] = dayBounds();
  const latest = latestWindowEnd(seconds);
  const end = dayWindow()[1] + (direction * seconds) / 2;
  const clamped = Math.min(Math.max(end, dayStart + seconds), latest);
  viewEnd = clamped >= latest ? null : clamped;
  hoverEpoch = null;
  drawCharts();
}

function formatClock(epoch, dayEnd) {
  // Das Tagesende als 24:00 statt 00:00 anzeigen
  if (epoch === dayEnd) {
    return "24:00";
  }
  return new Date(epoch * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function renderZoom() {
  ui.zoomControls.hidden = !dayMode();
  if (!dayMode()) {
    return;
  }
  const seconds = zoomSeconds();
  const [dayStart, dayEnd] = dayBounds();
  const [start, end] = dayWindow();
  ui.zoomRange.textContent = `${formatClock(start, dayEnd)} – ${formatClock(end, dayEnd)}`;
  ui.panPrev.disabled = !seconds || start <= dayStart;
  ui.panNext.disabled = !seconds || end >= latestWindowEnd(seconds);
}

function drawCharts() {
  renderZoom();
  const points = timedRecords().sort((a, b) => a.epoch - b.epoch);
  const span = chartSpan(points);
  for (const view of chartViews) {
    drawChart(view.canvas, visibleSlots(view.chart), view.tooltip, points, span);
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

  // Nur Punkte im Ausschnitt zaehlen fuer Achse und Fadenkreuz. Gezeichnet wird je
  // ein Punkt davor und danach mit, damit die Linien bis an den Rand gehen.
  let first = 0;
  let last = points.length - 1;
  if (span) {
    while (first < points.length && points[first].epoch < span[0]) {
      first++;
    }
    while (last >= 0 && points[last].epoch > span[1]) {
      last--;
    }
  }
  const inside = points.slice(first, last + 1);
  points = points.slice(Math.max(0, first - 1), Math.min(points.length, last + 2));

  let min = Infinity;
  let max = -Infinity;
  for (const record of inside) {
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
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];
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

  // Linien ausserhalb des Ausschnitts abschneiden
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
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
  ctx.restore();

  // Fadenkreuz mit den Werten des naechsten Datensatzes im Ausschnitt
  if (hoverEpoch === null || inside.length === 0) {
    tooltip.textContent = "";
    return;
  }
  const record = nearestRecord(inside, hoverEpoch);
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
  ui.archive.disabled = !connected;
  ui.clearLocal.disabled = localDays.size === 0 || Boolean(archive);
  if (archive) {
    ui.refresh.disabled = true;
    ui.clear.disabled = true;
  }
  const calibration = connected && calibrationSupported;
  ui.calibrateAll.disabled = !calibration || calibrating;
  ui.clearOffsets.disabled = !calibration || calibrating;
  for (const control of ui.calibrationList.querySelectorAll("button, input")) {
    control.disabled = !calibration || calibrating;
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
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, ui.range.value);
  } catch (e) {}
  if (dayMode()) {
    run(loadDay);
    return;
  }
  renderCalendar();
  if (!isConnected()) {
    run(loadLocal);
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

ui.zoom.addEventListener("change", () => {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, ui.zoom.value);
  } catch (e) {}
  viewEnd = null;
  hoverEpoch = null;
  drawCharts();
});
ui.panPrev.addEventListener("click", () => pan(-1));
ui.panNext.addEventListener("click", () => pan(1));

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

ui.addChart.addEventListener("click", () => openChartDialog(null));
ui.chartAll.addEventListener("change", updateChartDialog);
ui.chartSelectAll.addEventListener("click", () => dialogBoxes().forEach((box) => (box.checked = true)));
ui.chartSelectNone.addEventListener("click", () => dialogBoxes().forEach((box) => (box.checked = false)));
ui.chartCancel.addEventListener("click", () => ui.chartDialog.close());
ui.chartOk.addEventListener("click", applyChartDialog);
ui.clearLocal.addEventListener("click", () => run(clearLocal));
ui.archive.addEventListener("click", () => run(archive ? cancelArchive : startArchive));

ui.refresh.addEventListener("click", () => run(startSync));
ui.download.addEventListener("click", downloadCsv);
ui.interval.addEventListener("change", () => run(() => sendCommand(CMD_SET_INTERVAL, Number(ui.interval.value))));
ui.measure.addEventListener("click", () => run(() => sendCommand(CMD_MEASURE)));
ui.scan.addEventListener("click", () => run(() => sendCommand(CMD_SCAN)));

ui.calibrateAll.addEventListener("click", () => run(calibrateAllSensors));
ui.clearOffsets.addEventListener("click", () => run(clearAllOffsets));
for (const tab of ui.tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}

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

window.addEventListener("resize", drawCharts);
// Beim Schliessen oder Wechseln der Seite noch nicht gespeicherte Daten sichern
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushLocal();
  }
});
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

// Gespeicherte Einstellungen aus der letzten Sitzung
function restoreSelect(select, key) {
  const saved = localStorage.getItem(key);
  if (saved !== null && [...select.options].some((option) => option.value === saved)) {
    select.value = saved;
  }
}

try {
  restoreSelect(ui.zoom, ZOOM_STORAGE_KEY);
  restoreSelect(ui.range, RANGE_STORAGE_KEY);
  localStorage.removeItem("heizkreis-view");  // fruehere Auswahl "Ein Diagramm / Je Sensor"
} catch (e) {}
loadCharts();
loadSensorsLocal();

renderHistory();
let savedTab = "main";
try {
  savedTab = localStorage.getItem(TAB_STORAGE_KEY) || "main";
} catch (e) {}
showTab(savedTab);
refreshLocalInfo().then(() => loadLocal());
