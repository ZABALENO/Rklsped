# RKL Spedice – přepravy v prodeji

Dashboard pro speditéry: zobrazí až 30 přeprav, které se aktuálně prodávají
(datum nakládky, trasa, popis zboží, hmotnost). Zaškrtnutím **Prodáno** řádek zmizí
a započítá se do denní statistiky prodaných přeprav.

## Data
Tabulka se do repozitáře ani na server **neukládá**. Do pole „Odkaz na tabulku“ se vloží
veřejný odkaz (Google Sheets / Google Drive / OneDrive / SharePoint – „Kdokoli s odkazem“).
Server soubor jen stáhne do paměti, vybere potřebné sloupce a pošle je prohlížeči.
Odkaz si pamatuje jen prohlížeč. Data se obnovují každých 5 minut.

Rozpoznávané sloupce: `Datum nakl.od`, `Trasa`, `Popis zboží`, `Hmotnost(kg)`, `Objednávka`
(hlavička se hledá v prvních 15 řádcích, stačí list se sloupcem „Trasa“).

Na serveru se ukládá jen stav „Prodáno“ (číslo objednávky, trasa, čas) – zároveň se drží
i v prohlížeči, takže restart serveru na free plánu Renderu o statistiku nepřipraví.

## Spuštění
```
npm install
npm start   # http://localhost:3000
```
Render: Node web service, build `npm install`, start `node server.js`.
