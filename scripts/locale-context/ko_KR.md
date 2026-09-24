## Korean (ko_KR) — Locale-Specific Rules

- Register depends on the surface the string is for (the packet marks each string `php[...]` or `js[...]`, see `scripts/translate-prompt.md`):
  - PHP strings (`php` in the packet; `.po` files under `translations/php/`) — order notes, emails, receipts, admin notices — use formal 합니다체/하십시오체 (~습니다, ~됩니다, ~하십시오, ~하시겠습니까?). Wrong: "주문 상태는 %s에 의해 설정됐고, 계산대에서는 결제를 받지 않았어요." (해요체). Right: "주문 상태는 %s에 의해 설정되었으며, 계산대에서 결제를 받지 않았습니다." (합니다체).
  - JS strings (`js` in the packet) for the POS app UI and the WP-admin settings, consent and store screens use polite conversational register (해요체): 원하시나요 (correct) not 원하십니까 (too formal). 확인하세요 (correct) not 확인하십시오 (too formal).
  - Everywhere else, and whenever unsure, match the dominant register already used in the same target file, and never mix registers within one string.
- Required terminology: 영수증 (Receipt), 계산대 (Checkout), 캐셔 (Cashier), PG 서비스 (Payment gateway, as in WooCommerce), 템플릿 (Template).
- Prefer native Korean over English loanwords where natural: 작업 over 액션, 용지 over 지면.
- Use proper Korean particles: 템플릿이 삭제되었습니다 (complete sentence with subject particle), not just 템플릿 삭제됨.
