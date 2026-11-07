# 0.5.1

- Post removido do Erome (HTTP 404/410 na página do álbum) agora vira `source_post_gone`, falha definitiva: o job não é repetido e não conta como falha de sistema. Antes aparecia como `http_error` e era repetido.
