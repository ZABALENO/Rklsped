// Dispečeři podle prefixu čísla přepravy (PZ/26J… = Jirka atd.)
const SELLERS = { J: 'Jirka', G: 'Gabka', N: 'Pavel', U: 'Petr', H: 'Robin' };
const SELLER_ORDER = ['Jirka', 'Gabka', 'Pavel', 'Petr', 'Robin'];
function sellerOf(prepr) {
  const m = String(prepr || '').match(/^\s*PZ\s*\/\s*\d{2}\s*([A-Z])/i);
  if (!m) return null;
  const L = m[1].toUpperCase();
  return { letter: L, name: SELLERS[L] || `Ostatní (${L})` };
}
module.exports = { SELLERS, SELLER_ORDER, sellerOf };
