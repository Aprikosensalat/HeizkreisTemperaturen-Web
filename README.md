# Heizkreis-Temperaturen, Website

Statische Website ohne Build-Schritt. Sie verbindet sich per Web Bluetooth mit der
Firmware aus dem Projekt `HeizkreisTemperaturen`.

## Starten

Web Bluetooth läuft nur über HTTPS oder `localhost`.

Am PC:

```
python -m http.server 8000
```

Danach `http://localhost:8000` in Chrome oder Edge öffnen.

Für das Smartphone müssen die Dateien auf einem HTTPS-Webspace liegen, zum Beispiel
GitHub Pages oder Netlify. Chrome auf Android funktioniert. Safari auf dem iPhone
unterstützt Web Bluetooth nicht.

## BLE-Protokoll

Alle Werte sind little-endian. UUID-Schema: `7e6aXXXX-5c3b-4d2a-9f1e-8b4c2d6e0a01`.
Gerätename `Heizkreis`.

| XXXX | Name | Eigenschaften | Inhalt |
|---|---|---|---|
| 0000 | Service | | |
| 0001 | Temperaturen | read, notify | 32 × i16 in 1/100 Grad, `-32768` = kein Wert |
| 0002 | Status | read, notify | u8 Flags, u32 ältester Index, u32 nächster Index, u32 Kapazität, u32 Intervall (s) |
| 0003 | Steuerung | write | u8 Befehl, u32 Argument |
| 0004 | Logdaten | notify | u32 erster Index, danach Datensätze |
| 0005 | Sensoren | notify | Teil der Sensorliste: u8 erster Slot, u8 Anzahl (höchstens 6), danach je Slot 35 Bytes: u8 Flags, i8 GPIO (-1 = nicht gefunden), 8 Bytes ROM-Adresse, 25 Bytes Name (UTF-8, mit Nullbyte) |
| 0006 | Sensorname | write | u8 Slot, danach der Name als UTF-8, höchstens 24 Bytes |
| 0007 | Zeitindex | notify | Teil des Zeitindex: u32 erstes Segment, u16 Anzahl (höchstens 40), danach je Segment u32 Unix-Zeit des ersten Datensatzes (0 = unbekannt). Anzahl 0 beendet die Liste. |

Die Liste mit 32 Einträgen ist größer als die 512 Bytes, die eine Characteristic fassen
kann. Die Firmware schickt sie deshalb in 6 Teilen, nach Befehl 9 und nach jeder Änderung
(Suchen, Umbenennen, Vergessen). Ein Teil hat höchstens 212 Bytes und passt damit auch
in eine MTU von 247.

Ein Segment umfasst 2048 Datensätze, Segment n beginnt bei Index n × 2048. Der Zeitindex
dient dem Kalender, siehe [DOKUMENTATION.md](DOKUMENTATION.md).

Status-Flags: Bit 0 Uhrzeit gesetzt, Bit 1 mindestens ein Sensor gefunden.

Sensor-Flags: Bit 0 Slot belegt, Bit 1 Sensor beim letzten Suchen gefunden.

| Befehl | Bedeutung | Argument |
|---|---|---|
| 1 | Uhrzeit setzen | Unix-Zeit |
| 2 | Messintervall setzen | Sekunden, 5 bis 3600 |
| 3 | Log löschen | |
| 4 | Log senden | erster Index |
| 5 | Senden abbrechen | |
| 6 | 1-Wire-Bus neu durchsuchen und danach sofort messen | |
| 7 | Slot freigeben | Slot |
| 8 | sofort messen | |
| 9 | Sensorliste über 0005 senden | |
| 10 | Zeitindex über 0007 senden | |

Ein Datensatz hat 72 Bytes: u32 Unix-Zeit (0 = unbekannt), u32 Laufzeit seit dem Start in
Sekunden, 32 × i16 Temperaturen in 1/100 Grad. Die n-te Temperatur gehört zu Slot n, im
Datensatz genauso wie in der Characteristic 0001.

Ein Paket ohne Datensätze beendet die Übertragung. Geht ein Paket verloren, fordert die
Website ab dem fehlenden Index neu an. Die Firmware handelt beim Verbinden eine MTU von
517 Bytes aus, damit passen 7 Datensätze in ein Paket. Bei einer MTU von 247 sind es 3.
