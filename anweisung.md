# Anweisung

Bei deutschen Texten im Projekt auf korrekte Umlaute achten:

- ü statt ue
- ä statt ae
- ö statt oe
- ß statt ss, wenn grammatisch passend

Das gilt besonders für README, UI-Texte, Dokumentation und sichtbare Beschriftungen.

## Bot-Trennung

Alles, was Bot-Mechanik, Bot-Strategie, Lernlogik, ökonomische Prüfung, Risikoentscheidung oder Grid-/RL-Logik betrifft, gehört nicht in das Chart-Replay-Tool selbst.

Das Chart-Replay-Tool stellt nur die Bot-Schnittstelle, Anzeige, Steuerung und Order-Ausführung bereit. Bot-Fachlogik bleibt getrennt in `bot_bridge` beziehungsweise in eigenständigen Bot-Dateien.

Bot-Elemente dürfen nicht in die normale Chart-Replay-Oberfläche eingebaut werden, außer sie gehören eindeutig zur Schnittstelle zwischen Tool und externem Bot.
