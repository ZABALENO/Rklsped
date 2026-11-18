# RKL GPS API – popis pro napojení vlastní aplikace

Rozhraní jen pro **čtení**: polohy vozidel v reálném čase, historie jízd a podklady pro reporty, trasa přepravy s odhadem příjezdu, teplota a palivo, šablony (profily) vozidel. Data pocházejí z GPS systému EchoTrack, my je jen zprostředkováváme.

**Adresa:** `https://dashboard.airkl.cz`

## Přístup – bez přihlášení a bez klíče
Rozhraní je **otevřené**: stačí poslat obyčejný požadavek `GET`, žádný klíč, heslo ani přihlášení. Odpovědi mají povolené **CORS**, takže jde volat i přímo z prohlížeče (JavaScript na vaší webové stránce).

```bash
curl https://dashboard.airkl.cz/api/polohy
```

- Jen čtení. Nic se přes toto rozhraní nedá změnit ani smazat.
- Ochrana proti zahlcení: na jednu IP adresu nejvýše **120 požadavků za minutu** (u historie **12 za minutu**). Při překročení vrací server `429` a hlavičku `Retry-After`.
- Pozor: data obsahují aktuální polohy vozidel a jména řidičů. Adresu rozhraní proto nezveřejňujte mimo okruh lidí, kterým data patří. (RKL může přístup kdykoli zamknout klíčem. V takovém případě se do hlavičky přidá `X-API-Key: <klíč>`, jinak nic jiného se nemění.)

## Přehled funkcí
| Funkce | Adresa |
|---|---|
| Aktuální polohy všech vozidel (včetně stání, vzdáleností, teploty a paliva) | `GET /api/polohy` |
| Historie vozidla, kilometry po dnech, zastávky, jízdy (podklad pro reporty) | `GET /api/polohy/historie` |
| Trasa přepravy, vzdálenost a čas k místům, odhad příjezdu | `GET /api/polohy/trasa` |
| Šablony (profily) vozidel – seznamy SPZ, pravidla barev, nastavení teploty | `GET /api/polohy/profily` |
| Aktivní hlídání teploty u SPZ | `GET /api/polohy/teplota-hlidani` |

## 1) Aktuální polohy
`GET /api/polohy`

```json
{ "cars": [ {
    "spz": "2TS 2582", "id": 406, "speed": 85,
    "time": "2026-11-18T08:12:03.000Z",
    "driver": "Novák Jan", "trailer": "2TY 2502",
    "lat": 51.38, "lon": 6.45, "heading": 90, "on": true,
    "group": "ZA", "place": "Kempen - Haag", "country": "DE", "odometer": 412345,
    "span": 480, "still": { "50": 0, "100": 0, "200": 0, "500": 0, "1000": 0 },
    "stopMin": 0, "stopKnown": true,
    "temp": { "v": 5.5, "at": "2026-11-18T07:50:11.000Z", "min": 4.0, "max": 9.5, "n": 18, "upd": "2026-11-18T08:10:00.000Z" },
    "fuel": { "v": 181, "at": "2026-11-18T07:55:00.000Z", "min": 150, "max": 249, "n": 40, "upd": "2026-11-18T08:10:00.000Z" }
  } ],
  "tempWatch": [], "fetchedAt": "2026-11-18T08:12:10.000Z", "stale": false, "error": "" }
```

| Pole | Význam |
|---|---|
| `spz` | SPZ tahače (podle ní se vozidla v ostatních funkcích hledají) |
| `id` | číslo vozidla v GPS systému, potřebné pro historii |
| `speed` | rychlost v km/h (0 = stojí) |
| `time` | čas poslední polohy (ISO, UTC; `Z` na konci) |
| `driver`, `trailer` | řidič a SPZ připojeného návěsu (mohou být prázdné) |
| `lat`, `lon`, `heading` | souřadnice (WGS84) a směr jízdy ve stupních (může být `null`) |
| `group`, `place`, `country`, `odometer` | skupina vozidla, poslední známé místo, stát (např. `DE`) a stav tachometru (nemusí být vždy vyplněné) |
| `stopMin` | jak dlouho vozidlo stojí (minuty); `stopKnown:false` = stání začalo ještě před spuštěním sledování, takže je údaj minimální |
| `still` | po kolika minutách se vozidlo nepohnulo o víc než 50 / 100 / 200 / 500 / 1000 m; `span` = jak dlouhou historii (v minutách, nejvýše 8 h) pro to server má |
| `trip`, `nL`, `dL`, `nU`, `dU`, `dUd` | jen u vozidel na přepravě z dashboardu Západ: nejbližší nakládka / vykládka (`n` = název, `d` = vzdálenost v km vzdušnou čarou), `dUd` = o kolik km se auto za ~25 min přiblížilo k vykládce (kladné = blíží se) |
| `temp` | teplota z čidla (viz níže), jen u vozidel, která mají hlídání teploty |
| `fuel` | stav paliva v nádrži v litrech (viz níže), jen u vozidel, která mají zapnuté palivo ve štítku |

**Teplota a palivo.** Jsou k dispozici jen u vozidel, která jsou zapnutá v nějaké šabloně (nastavení teploty / palivo ve štítku) nebo mají aktivní hlídání teploty; ostatním pole `temp` a `fuel` chybí. `v` je poslední hodnota, `at` její čas, `min`/`max` rozsah za dnešek, `n` počet záznamů, `upd` kdy jsme report naposledy stáhli. Vozidlo zapisuje hodnoty zhruba **po 30 minutách**, údaj tedy může být o tolik starý – podle `at` posuďte čerstvost. Vozidla bez čidla pole nemají vůbec (nebo `v:null`).

Ostatní pole:
- `fetchedAt` – kdy jsme data vzali z GPS systému; `stale:true` + `error` = GPS systém je dočasně nedostupný a vidíte poslední známý stav.
- `tempWatch` – seznam aktivních hlídání teploty (totéž co funkce 5).

Data se u nás drží 25 s, častější dotazování nemá smysl. Doporučené: jednou za 30–60 s.

## 2) Historie vozidla a podklady pro reporty
`GET /api/polohy/historie?car=<id>&from=<datum>&to=<datum>[&light=1]`

```bash
curl "https://dashboard.airkl.cz/api/polohy/historie?car=406&from=2026-11-01&to=2026-11-17&light=1"
```

- `car` – číslo vozidla (`id` z funkce 1).
- Datum: `YYYY-MM-DD` nebo `YYYY-MM-DDTHH:MM` (pražský čas). Nejdéle **32 dní** najednou.
- `light=1` vrátí jen souhrn (doporučeno). Bez něj přibudou `points` (`[lat, lon, čas_ms]`, pro vykreslení čáry na mapě) a `rows` (zdrojové záznamy).

```json
{ "carId": 406, "from": "2026-11-01", "to": "2026-11-17",
  "summary": {
    "total": { "km": 6120.5, "driveMs": 188000000, "stopMs": 1100000000, "maxSpeed": 94,
               "countries": ["CZ","DE"], "drivers": ["Novák Jan"], "records": 5210 },
    "days":  [ { "day": "2026-11-01", "km": 540.2, "driveMs": 29000000, "stopMs": 57000000,
                 "maxSpeed": 91, "countries": ["CZ","DE"], "drivers": ["Novák Jan"] } ],
    "stops": [ { "from": "...", "to": "...", "durMs": 2700000, "place": "Bruntál", "country": "CZ",
                 "lat": 49.99, "lon": 17.46, "open": false } ],
    "trips": [ { "from": "...", "to": "...", "fromPlace": "Bruntál", "toPlace": "Worms", "km": 780.4 } ]
  } }
```
- `total` – součty za celé období: kilometry, doba jízdy a stání (v milisekundách), nejvyšší rychlost, státy, řidiči.
- `days[]` – totéž po dnech (`day` = pražský den). Z toho vzniknou např. denní a měsíční reporty.
- `stops[]` – zastávky od 10 min (`open:true` = vozidlo tam stojí stále). `trips[]` – jízdy mezi zastávkami.
- První dotaz trvá několik sekund (GPS systém je pomalý), stejný dotaz se 3 minuty drží v paměti. Dotazy se u nás řadí za sebe, **neposílejte víc vozidel naráz**, ale jedno po druhém.

**Reporty** si složíte z této odpovědi. Např. měsíční přehled kilometrů: pro každé vozidlo zavolat historii za měsíc a sečíst `summary.total.km`; kilometry po dnech jsou v `summary.days`. Zastávky a jízdy dávají přehled o době stání, trasách a státech.

## 3) Trasa přepravy a vzdálenost k místům
`GET /api/polohy/trasa?spz=<SPZ>&p=<místa>`

`p` je JSON pole zakódované v base64url (UTF-8), nejvýše 12 míst:
```json
[ {"n":"Opava","c":"CZ","z":"746 01","s":"L"}, {"n":"Praha","c":"CZ","z":"110 00","s":"U"} ]
```
`n` název, `c` země, `z` PSČ, `s` = `L` nakládka / `U` vykládka. Odpověď obsahuje souřadnice míst (podle PSČ a obce, tedy orientačně), silniční trasu (`route.line`, `km`, `min`), polohu auta a pro každé místo `fromCar` (km a minuty od auta; `road:false` = odhad vzdušnou čarou, když silniční výpočet není k dispozici).

```js
const p = btoa(unescape(encodeURIComponent(JSON.stringify(places))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const r = await fetch(`https://dashboard.airkl.cz/api/polohy/trasa?spz=${encodeURIComponent('2TF 5107')}&p=${p}`);
```
V Node.js: `Buffer.from(JSON.stringify(places)).toString('base64url')`.

## 4) Šablony (profily) vozidel
`GET /api/polohy/profily`

```json
{ "profiles": [ { "id": "p1", "name": "Západ export", "spz": ["2TS 2582", "2TV 9668"],
    "rules": [ { "c": "red", "t": "still", "a": 120, "r": 100, "m": 0 } ],
    "label": { "on": true, "f": ["spz", "driver", "temp"] },
    "temp": { "on": true, "lo": 0, "hi": 8 }, "u": "2026-11-17T12:00:00.000Z" } ],
  "editable": false }
```
Seznam pojmenovaných šablon vozidel (např. „Západ export“) s jejich SPZ, pravidly barev, nastavením štítku a mezí teploty (`temp.lo` / `temp.hi` ve °C). Hodí se jako předdefinované výběry vozidel ve vaší aplikaci. Šablony lze měnit jen přímo na stránce GPS, přes toto rozhraní ne.

## 5) Aktivní hlídání teploty
`GET /api/polohy/teplota-hlidani`

```json
{ "watch": [ { "spz": "2TS 2583", "target": 5, "tol": 2, "until": "2026-11-18T20:00:00.000Z" } ] }
```
Hlídání teploty u konkrétní SPZ na určitou dobu: `target` je cílová teplota, `tol` povolená odchylka (±) v °C, `until` do kdy hlídání platí. Hlídání zakládá a ruší obsluha na stránce GPS. Vaše aplikace si podle `temp.v` z funkce 1 může odchylku vyhodnotit sama: `abs(temp.v - target) > tol`.

## Chyby
| kód | význam |
|---|---|
| 400 | neplatný parametr (datum, vozidlo, období přes 32 dní, místa) |
| 401 | rozhraní je zamčené klíčem a požadavek ho neobsahuje (jen po zamčení) |
| 429 | příliš mnoho požadavků, počkejte minutu |
| 502 | GPS systém je dočasně nedostupný, zkuste za chvíli |

## Pravidla slušného používání
- Jen čtení, žádné zápisy.
- Polohy nejčastěji jednou za 30 s, historii jen na vyžádání a po jednom vozidle.
- Čas v odpovědích je v ISO tvaru; řetězce s `Z` jsou UTC (pražský čas je o 1 h v zimě, o 2 h v létě víc). Denní seskupení (`day`) je v pražském čase.
- Souřadnice míst z funkce 3 jsou odvozené z PSČ a obce, ber je jako orientační.

## Příklad: minimální aplikace (JavaScript)
```html
<script>
async function load() {
  const j = await (await fetch('https://dashboard.airkl.cz/api/polohy')).json();
  document.body.innerHTML = j.cars.map(c =>
    `${c.spz} (${c.driver || '–'}): ${c.speed} km/h, ${c.place || ''} ${c.country || ''}`).join('<br>');
}
load(); setInterval(load, 30000);
</script>
```
