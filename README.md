# RKL Spedice – přepravy v prodeji

Dashboard pro speditéry na https://rklspedice.onrender.com

- Zobrazuje až 30 přeprav z tabulky, které ve sloupci **Přeprava** nemají číslo `PZ/` a mají
  datum nakládky nejpozději dnes + 7 pracovních dní (bez víkendů a českých svátků); řádky bez data
  jsou na konci. Sloupce: datum nakládky, trasa, popis zboží, hmotnost, poznámka.
- **Prodáno** – zaškrtnutím řádek zmizí a započítá se do dnešních prodejů.
- **Označeno k prodeji** – tlačítko zobrazí jen řádky, které mají ve sloupci CODE nakl. „@@@“.
- **Připnutí** – ikona připínáčku přesune řádek nahoru jako URGENT (červeně), sdílené pro všechny.
- **Dnešní provize** = (Příjem CZK + Příjem EUR × kurz ČNB) − (Výdaj CZK + Výdaj EUR × kurz ČNB)
  u dnes prodaných přeprav; nepočítají se dopravci RKL, TONDAU, DU-AL a Tomáš Krejčí (seznam `PROV_EXCLUDE`
  v server.js) a přepravy se zápornou provizí horší než −5 000 Kč. V přehledu dnes prodaných je u každé přepravy dopravce.
- **Cena** (Příjem CZK / Příjem EUR) před poznámkou, u míst vykládky PSČ vykládky.
- **Vynulování** leaderboardu a dnes prodaných – v nastavení (statistiky se pak počítají od teď).
- **Režim TV** – tlačítko dole nebo adresa `?tv=1` (vypnutí `?tv=0`) zvětší stránku pro televizi.
- **Poznámka** – sdílená pro všechny, ukládá se do databáze.
- **Leaderboard** (dříve Skóre prodejců) – přepravy s dopravcem obsahujícím „RKL“ se nepočítají
  (ani když se dopravce na RKL změní dodatečně); dispečeři seřazení od nejvíce prodaných.
  Počítá se i úplně nový řádek, který se v tabulce objeví rovnou s číslem PZ, dopravcem bez „RKL“
  a datem nakládky od dneška (den, kdy řádek přibyl) dál.
  jakmile u přepravy, která byla dřív bez čísla, přibude ve sloupci **Přeprava** číslo,
  připíše se prodej podle prefixu: `PZ/26J` Jirka, `PZ/26G` Gabka, `PZ/26N` Pavel,
  `PZ/26U` Petr, `PZ/26H` Robin (rok v čísle se ignoruje, velikost písmen nevadí).
  Čas prodeje = zaškrtnutí „Prodáno“, jinak okamžik, kdy se číslo v tabulce poprvé objevilo.
  Přehled za den, měsíc a celé období.

## Přístup
Stránka je chráněná heslem z proměnné prostředí `APP_PASSWORD` (nastavené na Renderu, v kódu není).
Přihlášení vydrží v prohlížeči 180 dní, odhlásit jde odkazem „Odhlásit“ dole na stránce.

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

---

# RKL Doprava (rkldoprava.onrender.com)

Druhá stránka ze stejného repozitáře – start `node doprava.js`. Stejné heslo, pozadí a databáze
(Neon, vlastní tabulka `kv_doprava`), odkaz na tabulku se nastavuje zvlášť pod ozubeným kolečkem.

- Zobrazuje přepravy s dopravcem obsahujícím „RKL“ s nakládkou (Datum nakl.od) dnes až 4 pracovní
  dny zpět, dokud nemají všechny objednávky na čísle přepravy prošlý termín vykládky (Datum vykl.do).
- Jeden řádek = jedno číslo přepravy (PZ/…): **SPZ** (sloupec „SPZ“), **trasa** všech zásilek
  seřazená od místa nejbližšího Opavě po nejvzdálenější, **hmotnost**, **ložné metry** (sloupec Ložné metry,
  jinak odhad z počtu kusů a rozměrů v popisu – označeno „~“) a **příjem** = Příjem CZK + Příjem EUR × kurz ČNB.
- U každého města první 2 číslice PSČ, trasa je vždy celá (zalomená). Tlačítko „Skrýt příjem“.
- Na velké obrazovce (≥ 1600 px, TV ~160 cm) se sám zapne režim TV s větším písmem – vejde se 17 aut.

Polohy míst podle PSČ / názvu: data © [GeoNames](https://www.geonames.org/) (CC BY 4.0,
převod [zauberware/postal-codes-json-xml-csv](https://github.com/zauberware/postal-codes-json-xml-csv)),
chybějící místa se dohledají přes OpenStreetMap Nominatim a uloží do databáze.
