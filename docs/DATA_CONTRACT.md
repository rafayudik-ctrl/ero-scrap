# Contrato de dados

Datas são strings ISO-8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`). Durações são inteiros em milissegundos. IDs são strings opacas; não derivar IDs de títulos.

## Search keyword

O contrato de configuração é um arquivo versionado `config/search-keyword.txt` com zero ou uma linha de texto. Zero linha/nada além de whitespace desativa o scan. Termos em múltiplas linhas e termos acima de 80 caracteres são rejeitados.

Não existem configurações no banco, URL, frontend ou variável de ambiente para substituir esse termo.

## Post (interno)

```json
{
  "id": "AbCd1234",
  "canonicalUrl": "https://www.erome.com/a/AbCd1234",
  "title": "Título da publicação",
  "pageNumber": 1
}
```

## Post snapshot (D1 → runner)

```json
{
  "id": "AbCd1234",
  "title": "Título da publicação",
  "details_checked_at": "2026-11-01T00:00:00.000Z",
  "tags": ["tag A", "tag B"],
  "videos": [
    {
      "id": "local-video-id",
      "post_id": "AbCd1234",
      "source_video_id": "source-asset-id",
      "duration_ms": 420000,
      "status": "discovered"
    }
  ]
}
```

A URL canônica do post é armazenada porque identifica a página pública. URLs de arquivo de mídia (vídeo ou imagem) não são armazenadas. O parser usa o caminho do media URL somente em memória para derivar um identificador estável quando a origem não fornece um ID próprio.

## VideoAsset

`video_assets` representa exclusivamente vídeos. Imagens e URLs de imagem são descartadas antes da persistência. Vários vídeos em um mesmo post geram vários registros.

Status relevantes na Etapa 2:

- `discovered`: metadados identificados.
- `ignored`: título e tags não correspondem à palavra-chave.
- `too_long`: duração explicitamente acima de 600000 ms.
- `duration_unknown`: duração ausente/inválida; não aceita.
- `copy_blocked`: correspondência e duração válidas, mas cópia permanece bloqueada.
- `eligible`: domínio permite classificar como elegível; não significa que foi copiado.

Estados futuros:

- `queued`, `processing`, `stored`, `clicked`, `delete_pending`, `deleted`, `error`.

## Manutenção

`maintenance.prune` (payload: `{ "now": ISO-8601 }`) apaga, em lotes de 500 linhas, vídeos que nunca foram armazenados e posts sem vídeo com mais de 14 dias, varreduras com mais de 14 dias e jobs `succeeded`/`cancelled` com mais de 7 dias. Resposta: `{ videos, posts, scans, jobs }` com a contagem apagada; o executor repete enquanto um lote vier cheio.

## Comando interno

Formato de request:

```json
{
  "operation": "posts.pending",
  "payload": {
    "postIds": ["AbCd1234"],
    "limit": 160,
    "keyword": "exemplo"
  }
}
```

A operação deve pertencer à allowlist em `apps/api/src/services/collector-service.js`. O cliente nunca envia SQL.

## API pública: catálogo

`GET /api/catalog?limit=24&q=termo&cursor=…`

A resposta contém somente metadados de itens efetivamente armazenados, não links privados ou URLs de mídia.

## API pública: status

`GET /api/status` retorna estágio, modo `metadata-only`, estado da trava e dados mínimos da última execução. Nenhum segredo é retornado.

## Erros

```json
{
  "error": {
    "code": "invalid_cursor",
    "message": "Pagination cursor is invalid."
  }
}
```

Mensagens não devem incluir stack trace, token, header de autenticação, URL de mídia, link compartilhável ou caminho de filesystem.
