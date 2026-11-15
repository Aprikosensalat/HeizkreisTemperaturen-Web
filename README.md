# Heizkreis-Temperaturen, Website

Stand: 12.11.2026

Statische Website ohne Build-Schritt. Sie verbindet sich per Web Bluetooth mit der
Firmware aus dem Projekt
[HeizkreisTemperaturen](https://github.com/Aprikosensalat/HeizkreisTemperaturen).

## Aktueller Stand

| Punkt | Status |
|---|---|
| Website | fertig geschrieben |
| Geprüft | lädt in Headless-Chrome von `file://` ohne Fehler. Mit simulierten BLE-Daten im 32-Sensor-Format (12 Sensoren, Sensorliste in 6 Teilen, 1 Tag Log, Lücke, fehlender Sensor) zeigt sie Kacheln, beide Diagramm-Ansichten, Legende, Fadenkreuz und Speicheranzeige richtig an. Kalender: Bei 3 Tagen simuliertem Log lädt "gestern" genau die 1440 Datensätze dieses Tages und bricht den Download am Tagesende ab. Pins werden in den Kacheln angezeigt. |
| Nicht geprüft | Verbindung zum ESP32, Live-Werte, Log-Download mit echter BLE-Verbindung, Umbenennen, CSV-Download |

Die Firmware läuft auf dem ESP32-C6, Sensoren sind noch keine angeschlossen. Die
Einzelheiten stehen in der
[README der Firmware](https://github.com/Aprikosensalat/HeizkreisTemperaturen#readme).

## Starten

**Online:** https://aprikosensalat.github.io/HeizkreisTemperaturen-Web/

Die Seite liegt auf GitHub Pages (Branch `main`, Ordner `/`). Jeder Push auf `main`
veröffentlicht sie nach etwa einer Minute neu. Auf dem Smartphone in Chrome öffnen und
bei Bedarf über das Menü "Zum Startbildschirm hinzufügen".

Web Bluetooth läuft nur über HTTPS oder `localhost`.

Am PC:

```
python -m http.server 8000
```

Danach `http://localhost:8000` in Chrome oder Edge öffnen.

Chrome auf Android funktioniert. Safari auf dem iPhone unterstützt Web Bluetooth nicht.

## Dateien

| Datei | Inhalt |
|---|---|
| [index.html](index.html) | Seitenaufbau |
| [style.css](style.css) | Darstellung, mit hellem und dunklem Modus sowie Handy-Layout, Basis aus `ESP32-WROOM-Web` |
| [app.js](app.js) | BLE-Verbindung, Log-Abgleich, Kalender, Diagramme, CSV-Export |
| [README.md](README.md) | diese Dokumentation mit BLE-Protokoll |

Die Website braucht keine Bibliotheken und keinen Build-Schritt. Die UUIDs in `app.js`
müssen zu denen in `src/main.cpp` der Firmware passen.

## Funktionen

- **Verbinden:** Der Browser zeigt nur Geräte mit dem passenden BLE-Service an.
- **Uhrzeit:** Sie wird beim Verbinden an den ESP32 gesendet. Die erste Uhrzeit nach dem
  Start des ESP32 korrigiert auch alle Datensätze, die seit diesem Start geloggt wurden.
- **Sensoren:** Bis zu 32, eine Kachel je Sensor mit Nummer, Name, aktueller Temperatur,
  ROM-Adresse (`28:FF:…`) und dem Pin (GPIO), an dem er zuletzt gefunden wurde. Die
  Farbe am Rand ist die Farbe der Kurve. Fehlt ein Sensor, steht dort "nicht gefunden",
  und er lässt sich mit "Vergessen" entfernen.
- **Umbenennen:** Wie im Templogger direkt in der Kachel: Name eintragen, dann
  "Speichern" oder Enter. Bis zu 24 Bytes, Umlaute zählen doppelt. Der Name steht im ESP32.
- **Verlauf:** Umschaltbar zwischen einem gemeinsamen Diagramm und einem Diagramm je
  Sensor mit eigener Temperaturachse. Alle Diagramme haben dieselbe Zeitachse. Die Wahl
  merkt sich der Browser. Beim Antippen oder Überfahren zeigt ein Fadenkreuz in allen
  Diagrammen Zeit und Werte. Lücken (Stromausfall, fehlender Sensor) werden nicht
  verbunden. Das Log wird jede Minute nachgeladen, und zwar nur die neuen Datensätze.
- **Kalender (Standard):** Zeitraum "Tag aus Kalender". Ein Monatskalender, darunter
  "Vortag", "Heute" und "Folgetag". Wählbar sind die Tage vom ersten Tag im Log bis heute.
  Das Diagramm zeigt immer den ganzen Tag von 0 bis 24 Uhr. Ist heute gewählt, kommen
  neue Messungen jede Minute dazu. Die CSV-Datei heißt dann `heizkreis_<Tag>.csv`.
  Geladen wird ab dem Segment, das vor dem Tag beginnt, bis zum Tagesende. Das dauert bei
  32 Sensoren und 1 min Intervall etwa 5 bis 15 Sekunden, je nach MTU.
- **Weitere Zeiträume:** Letzte 24 h, 7 Tage, 30 Tage oder alles. Der Startpunkt wird über
  das aktuelle Intervall geschätzt.
- **Reiter:** "Messwerte" mit Kacheln, Verlauf und Einstellungen, "Kalibrierung" für die
  Offsets. Der Browser merkt sich den zuletzt gewählten Reiter.
- **Kalibrierung:** Je Sensor Rohwert, Offset und korrigierter Wert. Der Offset lässt sich
  je Sensor eintragen und mit "Speichern" oder Enter übernehmen (±20 K, zwei
  Nachkommastellen). "Alle angleichen" lässt den ESP32 sofort messen und die Offsets so
  setzen, dass alle Sensoren den Mittelwert der Rohwerte anzeigen. Dafür müssen alle
  gerade dieselbe Temperatur haben. "Alle Offsets auf 0" setzt alles zurück. Darüber
  steht die Spanne der Roh- und der korrigierten Werte. Ein Offset ungleich 0 steht auch
  in der Kachel. Angezeigt, geloggt und exportiert werden die korrigierten Werte. Mit
  älterer Firmware ohne Kalibrierung zeigt der Reiter nur einen Hinweis.
- **Einstellungen:** Messintervall, sofort messen, Sensoren suchen, Log löschen
- **Speicheranzeige:** Anzahl Datensätze, Kapazität und wie viele Tage sie beim
  aktuellen Intervall reicht
- **CSV-Export:** Die Datei `heizkreis_<Datum>_<Uhrzeit>.csv` enthält die geladenen Daten.

## CSV-Format

Trennzeichen ist das Semikolon, Dezimaltrennzeichen das Komma, damit ein deutsches Excel
die Datei direkt öffnet.

```
Datum;Uhrzeit;Laufzeit_s;Vorlauf;Rücklauf;Außen
12.11.2026;14:30:00;3725;52,31;41,06;3,50
```

Die Zeile unter der Kopfzeile ist ein Beispiel. Datum und Uhrzeit stehen in der lokalen
Zeit des Browsers. Bei Datensätzen ohne bekannte Uhrzeit bleiben Datum und Uhrzeit leer.

## Einschränkungen

- Web Bluetooth läuft nur über HTTPS oder `localhost`.
- Chrome und Edge auf Android oder dem PC sind vorgesehen. Safari auf dem iPhone
  unterstützt Web Bluetooth nicht.
- Das Repo ist öffentlich, weil GitHub Pages im kostenlosen Plan nur für öffentliche
  Repos geht. Die Firmware liegt in einem privaten Repo.
- Die geladenen Logdaten liegen nur im Speicher der Seite. Beim Neuladen oder neuen
  Verbinden werden sie erneut vom ESP32 geholt.
- Die Verbindung hat keine Kopplung und kein Passwort.
- Im Kalender fehlen Datensätze ohne Uhrzeit. Lücken innerhalb des Logs (zum Beispiel
  ein Stromausfall über mehrere Tage) erkennt der Kalender nicht. Solche Tage sind wählbar
  und zeigen dann "keine Messwerte".

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
| 0008 | Kalibrierung | read, notify | 32 × i16 Offsets, danach 32 × i16 Rohwerte (ohne Offset), beides in 1/100 Grad, `-32768` = kein Wert. Kommt nach jeder Messung und jeder Änderung eines Offsets. |

Die Liste mit 32 Einträgen ist größer als die 512 Bytes, die eine Characteristic fassen
kann. Die Firmware schickt sie deshalb in 6 Teilen, nach Befehl 9 und nach jeder Änderung
(Suchen, Umbenennen, Vergessen). Ein Teil hat höchstens 212 Bytes und passt damit auch
in eine MTU von 247.

Ein Segment umfasst 2048 Datensätze, Segment n beginnt bei Index n × 2048. Der Zeitindex
dient dem Kalender, siehe [Funktionen](#funktionen).

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
| 11 | Offset setzen | Bit 0–7 Slot, Bit 16–31 Offset als i16 in 1/100 Grad |
| 12 | sofort messen und alle Sensoren auf den Mittelwert der Rohwerte angleichen | |
| 13 | alle Offsets auf 0 | |

Ein Datensatz hat 72 Bytes: u32 Unix-Zeit (0 = unbekannt), u32 Laufzeit seit dem Start in
Sekunden, 32 × i16 Temperaturen in 1/100 Grad, mit Offset. Die n-te Temperatur gehört zu Slot n, im
Datensatz genauso wie in der Characteristic 0001.

Ein Paket ohne Datensätze beendet die Übertragung. Geht ein Paket verloren, fordert die
Website ab dem fehlenden Index neu an. Die Firmware handelt beim Verbinden eine MTU von
517 Bytes aus, damit passen 7 Datensätze in ein Paket. Bei einer MTU von 247 sind es 3.

## Nächste Schritte

1. DS18B20 an den ESP32 anschließen, siehe
   [README der Firmware](https://github.com/Aprikosensalat/HeizkreisTemperaturen#readme).
2. Website öffnen, siehe [Starten](#starten), und alle Funktionen mit echter
   BLE-Verbindung testen, am PC und am Smartphone.
