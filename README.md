# RKL Spedice – přepravy v prodeji

Dashboard pro speditéry na https://rklspedice.onrender.com

- Zobrazuje až 30 přeprav z tabulky, které mají ve sloupci **CODE nakl.** znak `@@@`
  a ještě nemají číslo přepravy (datum nakládky, trasa, popis zboží, hmotnost, poznámka).
- **Prodáno** – zaškrtnutím řádek zmizí a započítá se do dnešních prodejů.
- **Poznámka** – sdílená pro všechny, ukládá se do databáze.
- **Skóre prodejců** – jakmile u nabízené přepravy přibude ve sloupci **Přeprava** číslo,
  připíše se prodej podle prefixu: `PZ/26J` Jirka, `PZ/26G` Gabka, `PZ/26N` Pavel,
  `PZ/26U` Petr, `PZ/26H` Robin (rok v čísle se ignoruje, velikost písmen nevadí).
  Čas prodeje = zaškrtnutí „Prodáno“, jinak okamžik, kdy se číslo v tabulce poprvé objevilo.
  Přehled za den, měsíc a celé období.

## Data
Tabulka se nikam neukládá. Odkaz (Google Sheets / Drive / OneDrive / SharePoint, „Kdokoli s odkazem“)
se nastavuje pod ozubeným kolečkem dole na stránce; server tabulku stahuje do paměti (každé 3 min).
Trvale se ukládá jen odkaz, stav „Prodáno“, poznámky a skóre – do Postgresu (`DATABASE_URL`),
bez něj do dočasného souboru. Zálohu lze stáhnout/obnovit v nastavení (`/api/export`).

## Spuštění
```
npm install
npm start   # http://localhost:3000
```
