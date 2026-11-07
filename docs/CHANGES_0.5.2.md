# 0.5.2

- Os logs de falha agora trazem o status HTTP (`httpStatus`: 404, 410, 429, 503...) quando o erro veio de uma resposta do Erome, tanto da página do álbum quanto do servidor de mídia.
- Novos avisos no scan: `album inspection failed` (postId, errorCode, httpStatus) e `listing page failed` (page, errorCode, httpStatus).
