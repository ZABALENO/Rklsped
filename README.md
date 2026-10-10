# RKL Spedice – přepravy v prodeji

Dashboard pro speditéry na https://rklspedice.onrender.com

- Zobrazuje až 30 přeprav z tabulky, které ve sloupci **Přeprava** nemají číslo `PZ/` a mají
  datum nakládky nejpozději dnes + 7 pracovních dní (bez víkendů a českých svátků); řádky bez data
  jsou na konci. Sloupce: datum nakládky, trasa, popis zboží, hmotnost, poznámka.
- **Prodáno** – zaškrtnutím řádek zmizí a započítá se do dnešních prodejů.
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

- Zobrazuje přepravy s dopravcem obsahujícím „RKL“, které mají **dnes** nakládku
  (Datum nakl.od–do) nebo vykládku (Datum vykl.od–do).
- Jeden řádek = jedno číslo přepravy (PZ/…): **SPZ** (sloupec „SPZ“), **trasa** všech zásilek
  seřazená od místa nejbližšího Opavě po nejvzdálenější a **příjem** = Příjem CZK + Příjem EUR × kurz ČNB.
- Kompaktní řádky – na obrazovku se vejde 20+ SPZ.

Polohy míst podle PSČ / názvu: data © [GeoNames](https://www.geonames.org/) (CC BY 4.0,
převod [zauberware/postal-codes-json-xml-csv](https://github.com/zauberware/postal-codes-json-xml-csv)),
chybějící místa se dohledají přes OpenStreetMap Nominatim a uloží do databáze.
