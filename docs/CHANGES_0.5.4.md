# 0.5.4

- Padrão: 4 páginas da aba New a cada 15 minutos (antes 2 páginas a cada 20).
- Quantidade de páginas configurável pela variável `SCAN_LISTING_PAGES` (1 a 6; vazio = 4), com teto validado no runner, no cliente do Erome, no parser e na API.
- Crons: Cloudflare `3,18,33,48 * * * *`; GitHub `7,22,37,52 * * * *`.
- A API aceita listas de até 480 posts por varredura (6 páginas x 80 cards).
- Testes novos: profundidade padrão/personalizada, página que falha vira `partial`, limites 1–6.
