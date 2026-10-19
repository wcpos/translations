## Albanian (sq) — Locale-Specific Rules

- Standard Albanian (the Tosk-based standard used in Albania and Kosovo), not Gheg dialect forms. Always write ë and ç; never substitute e or c.
- Use the formal second person "ju" throughout — this is business software addressing a merchant or cashier.
- UI labels use sentence case, not English Title Case: "Shto klient", not "Shto Klient".
- Numbers: decimal separator is a comma and the thousands separator is a full stop (1.250,50). The currency is the lek (ALL); keep whatever symbol or code the source places and do not add one.
- Dates in prose use day.month.year order where the source spells out a format; leave date-format tokens untouched.
- VAT is "TVSH" (tatimi mbi vlerën e shtuar). A fiscal receipt in Albania is a "kupon tatimor"; use "faturë" for an invoice and keep the POS sense of Receipt (the slip printed at the till) rather than the accounting sense.
- Terms that WooCommerce core also uses (order, product, coupon, refund, payment gateway, cart, checkout) must follow WooCommerce's Albanian translation on translate.wordpress.org where one exists; where the Albanian WooCommerce translation leaves a term in English, keep it in English here too.
- Keep the technical terms listed in scripts/translation-context.md in English (POS, SKU, API, URL, ID, Webhook, Plugin, Sync, Log, Cache, QR Code).
- Keep short POS labels short: "Qty" stays a short abbreviation ("Sas."), "No." stays "Nr.", do not expand "Min", "Max", "Inc", "Exc".
- Albanian nouns inflect for case and definiteness; make placeholders read naturally in the surrounding sentence instead of forcing the English word order ("Porosia {number} u ruajt", not "{number} porosi u ruajt" when the source is "Order {number} saved").
