# Heizkreis-Temperaturen, Website

Stand: 12.11.2026

## Aktueller Stand

| Punkt | Status |
|---|---|
| Website | fertig geschrieben |
| Geprüft | lädt in Headless-Chrome von `file://` ohne Fehler. Mit simulierten BLE-Daten im 32-Sensor-Format (12 Sensoren, Sensorliste in 6 Teilen, 1 Tag Log, Lücke, fehlender Sensor) zeigt sie Kacheln, beide Diagramm-Ansichten, Legende, Fadenkreuz und Speicheranzeige richtig an. Kalender: Bei 3 Tagen simuliertem Log lädt "gestern" genau die 1440 Datensätze dieses Tages und bricht den Download am Tagesende ab. Pins werden in den Kacheln angezeigt. |
| Nicht geprüft | Verbindung zum ESP32, Live-Werte, Log-Download mit echter BLE-Verbindung, Umbenennen, CSV-Download |

Die Firmware aus dem Projekt `HeizkreisTemperaturen` läuft auf dem ESP32-C6, Sensoren
sind noch keine angeschlossen. Die Einzelheiten stehen in der `DOKUMENTATION.md` des
Firmware-Projekts.

## Dateien

| Datei | Inhalt |
|---|---|
| [index.html](index.html) | Seitenaufbau |
| [style.css](style.css) | Darstellung, mit hellem und dunklem Modus sowie Handy-Layout, Basis aus `ESP32-WROOM-Web` |
| [app.js](app.js) | BLE-Verbindung, Log-Abgleich, Diagramm, CSV-Export |
| [README.md](README.md) | Start der Website und BLE-Protokoll |

Die Website braucht keine Bibliotheken und keinen Build-Schritt. Die UUIDs in `app.js`
müssen zu denen in `src/main.cpp` der Firmware passen.

## Funktionen

- **Verbinden:** Der Browser zeigt nur Geräte mit dem passenden BLE-Service an.
- **Uhrzeit:** Sie wird beim Verbinden an den ESP32 gesendet. Die erste Uhrzeit nach dem
  Start des ESP32 korrigiert auch alle Datensätze, die seit diesem Start geloggt wurden.
- **Sensoren:** Bis zu 32, eine Kachel je Sensor mit Nummer, Name, aktueller Temperatur,
  ROM-Adresse (`28:FF:…`) und dem Pin (GPIO), an dem er zuletzt gefunden wurde. Die Farbe am Rand ist die Farbe der Kurve. Fehlt ein
  Sensor, steht dort "nicht gefunden", und er lässt sich mit "Vergessen" entfernen.
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
- Für das Smartphone muss die Website auf einem HTTPS-Webspace liegen, zum Beispiel
  GitHub Pages. Das ist noch nicht eingerichtet.
- Die geladenen Logdaten liegen nur im Speicher der Seite. Beim Neuladen oder neuen
  Verbinden werden sie erneut vom ESP32 geholt.
- Die Verbindung hat keine Kopplung und kein Passwort.
- Im Kalender fehlen Datensätze ohne Uhrzeit. Lücken innerhalb des Logs (zum Beispiel
  ein Stromausfall über mehrere Tage) erkennt der Kalender nicht. Solche Tage sind wählbar
  und zeigen dann "keine Messwerte".

## Nächste Schritte

1. DS18B20 an den ESP32 anschließen, siehe Firmware-Dokumentation.
2. Website starten, siehe [README.md](README.md), und alle Funktionen mit echter
   BLE-Verbindung testen.
3. Website für die Nutzung am Smartphone auf GitHub Pages veröffentlichen.
