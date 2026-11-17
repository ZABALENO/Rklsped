# RKL GPS API – popis pro napojení vlastní aplikace

Rozhraní jen pro **čtení** polohy vozidel, jejich historie (podklad pro reporty) a trasy přepravy. Data pocházejí z GPS systému EchoTrack, my je jen zprostředkováváme. Strojově čitelný popis je v souboru `gps-api.openapi.yaml` (otevře se v Swagger Editoru, Postmanu apod.).

**Adresa:** `https://dashboard.airkl.cz`

## Přihlášení
Každý požadavek nese klíč, který dostanete od RKL (musí být nastavený na serveru jako `GPS_API_KEY`, minimálně 16 znaků):

```
X-API-Key: <klíč>
```
nebo `Authorization: Bearer <klíč>`. Bez klíče nebo se špatným klíčem vrací server `401`. Klíč se posílá jen ze serveru (nebo z důvěryhodné aplikace), nikdy ho nevkládejte do veřejné webové stránky. Odpovědi mají povolené CORS, takže jde volat i z prohlížeče, ale klíč by pak byl vidět.

## 1) Aktuální polohy
`GET /api/polohy`

```bash
curl -H "X-API-Key: $KEY" https://dashboard.airkl.cz/api/polohy
```
```json
{ "cars": [ { "spz": "2TF 5107", "id": 361, "speed": 85, "time": "2026-11-17T09:12:03+01:00",
              "driver": "Novák", "trailer": "", "lat": 49.94, "lon": 17.90, "heading": 90,
              "group": "VN", "place": "Opava", "country": "CZ", "odometer": 412345 } ],
  "fetchedAt": "2026-11-17T08:12:10.000Z", "stale": false, "error": "" }
```
- `id` je číslo vozidla pro historii. `group`, `place`, `country`, `odometer` nemusí být vždy vyplněné.
- Data se u nás ukládají na 25 s, častější dotazování nemá smysl. Doporučené: jednou za 30–60 s.

## 2) Historie vozidla a reporty
`GET /api/polohy/historie?car=<id>&from=<datum>&to=<datum>[&light=1]`

```bash
curl -H "X-API-Key: $KEY" "https://dashboard.airkl.cz/api/polohy/historie?car=361&from=2026-11-01&to=2026-11-17&light=1"
```
- Datum: `YYYY-MM-DD` nebo `YYYY-MM-DDTHH:MM` (pražský čas). Nejdéle **32 dní** najednou.
- `light=1` vrátí jen souhrn (doporučeno). Bez něj přibudou `points` (`[lat, lon, čas_ms]`, pro vykreslení čáry) a `rows` (zdrojové záznamy).
- `summary.total`: km, doba jízdy a stání (ms), nejvyšší rychlost, státy, řidiči.
- `summary.days[]`: totéž po dnech. `summary.stops[]`: zastávky (od 10 min). `summary.trips[]`: jízdy mezi zastávkami.
- První dotaz trvá několik sekund (GPS systém je pomalý), stejný dotaz se 3 minuty drží v paměti. Dotazy se u nás řadí za sebe, **neposílejte víc vozidel naráz**, ale po jednom.

**Reporty** se skládají z této odpovědi: např. měsíční přehled km = pro každé vozidlo zavolat historii za měsíc a sečíst `summary.total.km`; ujeté km po dnech jsou v `summary.days`.

## 3) Trasa přepravy a vzdálenost k místům
`GET /api/polohy/trasa?spz=<SPZ>&p=<místa>`

`p` je JSON pole zakódované v base64url (UTF-8), nejvýše 12 míst:
```json
[ {"n":"Opava","c":"CZ","z":"746 01","s":"L"}, {"n":"Praha","c":"CZ","z":"110 00","s":"U"} ]
```
`n` název, `c` země, `z` PSČ, `s` = `L` nakládka / `U` vykládka. Odpověď obsahuje souřadnice míst (podle PSČ/obce, tedy orientačně), silniční trasu (`route.line`, `km`, `min`), polohu auta a pro každé místo `fromCar` (km a minuty od auta; `road:false` = odhad vzdušnou čarou).

```js
const p = Buffer.from(JSON.stringify(places)).toString('base64url');
fetch(`https://dashboard.airkl.cz/api/polohy/trasa?spz=${encodeURIComponent('2TF 5107')}&p=${p}`, { headers: { 'X-API-Key': KEY } });
```

## Chyby
| kód | význam |
|---|---|
| 400 | neplatný parametr (datum, vozidlo, období přes 32 dní, místa) |
| 401 | chybí nebo je špatný klíč |
| 502 | GPS systém je dočasně nedostupný, zkuste za chvíli |

## Pravidla slušného používání
- Jen čtení, žádné zápisy.
- Polohy nejčastěji jednou za 30 s, historii jen na vyžádání a po jednom vozidle.
- Čas v odpovědích je pražský; ISO řetězce s `Z` jsou UTC.
