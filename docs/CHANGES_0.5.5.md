# 0.5.5

- Corrige `pagesScanned must be an integer between zero and 2` (HTTP 400 em `scan.finish`): a API ainda limitava o registro da varredura a 2 páginas. Agora usa o teto de 6.
- Importante: publique o site/API de novo no Cloudflare Pages junto com o runner (a API roda lá, não no GitHub).
- Teste real de `scan.finish` com 4, 6 e 7 páginas.
- Nova migration `0010_scan_runs_more_pages.sql`: o log de varreduras tinha `CHECK (pages_scanned BETWEEN 0 AND 2)` no banco. A tabela é recriada com limite 6 (mantém só as 20 linhas mais recentes). **Rode o workflow "Apply Cloudflare D1 migrations" antes da próxima varredura.**
