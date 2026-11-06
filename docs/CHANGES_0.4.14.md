# 0.4.14

Correção do erro `D1 free tier daily row write limit` (100.000 escritas/dia, índices incluídos).

- **Causa:** o scan gravava no D1 todos os posts do Erome (título, tags, vídeos e avaliações), cerca de 77 escritas por post, mesmo os que não tinham a palavra-chave.
- O scan agora examina o álbum na memória do runner e só grava posts que casam com a palavra e têm vídeo.
- Álbuns já examinados ficam em uma linha (`scan_state`, migration `0009`; a tabela também é criada sozinha). Uma escrita por scan, só se algo novo foi examinado; mudar a palavra-chave refaz o exame.
- Faxina diária: no máximo uma vez por dia UTC (antes podia repetir em todos os scans da hora 03 UTC), no máximo 3 lotes de 500 (antes 20), linhas descartadas após 3 dias em vez de 14. Mídia guardada nunca é removida.
- `matchingPosts` no registro do scan passa a contar só posts gravados.
- Documentação: seção 18 de `CLOUD_DEPLOYMENT.md` (limite, como conferir, alternativa Turso).
