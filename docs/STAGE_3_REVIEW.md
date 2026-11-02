> **Nota histórica:** este relatório descreve a revisão v0.3.1, antes do pipeline Erome → MEGA e da implantação com GitHub Actions serem integrados na v0.4.1. Para o estado atual, consulte `STAGE_3_STATUS.md`, `PROJECT_SPEC.md`, `EROME_ADAPTER.md` e `CLOUD_DEPLOYMENT.md`.

# Revisão da Etapa 3 — correções e redução de peso

Revisão feita sobre `ero-scrap-stage3.zip` (v0.3.0). Resultado: v0.3.1. Contrato do produto, trava `COPY_AUTHORIZED` e arquitetura não mudaram.

## Bugs corrigidos

| # | Problema | Efeito | Como foi verificado |
|---|----------|--------|---------------------|
| 1 | `Referrer-Policy: no-referrer` na página | O navegador envia `Origin: null` no POST do formulário; o Worker rejeita com 403. **O botão "Abrir no MEGA" nunca funcionava.** | Chromium real: reproduzido antes, corrigido depois (`Referrer-Policy: same-origin`). |
| 2 | CSP `form-action 'self'` | O CSP também vale para o redirecionamento 303; o navegador bloqueava a ida ao `mega.nz`. | Chromium real: bloqueio reproduzido; com `https://mega.nz` no `form-action` o `GET mega.nz` é emitido. |
| 3 | Título do post revertia | A cada varredura a listagem sobrescrevia o título refinado pela inspeção do álbum, e a palavra-chave passava a ser avaliada sobre o título da listagem. | Teste em SQLite real. |
| 4 | Fila de exclusão podia travar | Itens já em `delete_pending` (inclusive com job `dead`) ocupavam as vagas do `LIMIT`, impedindo que novos vencidos ganhassem job. | Teste em SQLite real (falhava antes). |
| 5 | Job órfão em loop | Job cujo asset sumiu ficava `leased`, expirava e era reclamado para sempre. Agora vira `cancelled`. | Teste em SQLite real. |
| 6 | `Cache-Control` duplicado em `_headers` | Pelo documento do Pages, regras que casam a mesma URL são mescladas e valores repetidos são unidos por vírgula (`no-cache, public, max-age=3600`). Agora nenhuma URL casa duas regras de `Cache-Control`. | Documentação do Cloudflare Pages + teste estático. |

## Redução de peso

**Banco (D1) e Worker**

- A listagem não regrava mais ~80 posts a cada 10 min (`updated_at` mudava sempre).
- O runner só envia avaliações cujo status mudou; antes reescrevia todos os vídeos visíveis a cada varredura.
- Manutenção diária (`maintenance.prune`): posts, vídeos, varreduras e jobs antigos eram acumulados para sempre.
- Índice parcial `idx_video_assets_catalog` (migration 0005): a página do catálogo lê só as linhas da página, sem ordenar em memória.
- `/api/status` devolve os contadores: a página faz 2 chamadas ao carregar em vez de 3.
- Miniaturas ficam 24 h no cache do navegador (antes 5 min): menos Worker + D1 + R2 por visita.
- Retenção: esvazia rajadas de vencimentos em até 5 lotes por execução.

**Navegador**

- Busca com debounce de 350 ms e sem nova chamada se o texto final for igual ao já carregado.
- `runtime-config.js` com `defer` (não bloqueia a renderização).
- Cabeçalho da página compactado: o catálogo aparece sem rolar.
- CSP sem curinga `*.workers.dev`.

## Testes

- 106 → 125 testes. Novos: `d1-sqlite.test.js` (SQL real sobre as migrations), `maintenance-service.test.js`, `web-headers.test.js`, e casos em scan/retention.
- `tests/helpers/sqlite-d1.js`: D1 de teste sobre SQLite real (usa `node:sqlite`, Node 24+).
- Ponta a ponta no Chromium: página estática + Worker real + SQLite; contadores, miniatura, POST de abertura e redirecionamento.

## Medido e deixado como está

- Parsing de um álbum de 205 KB: ~13 ms. Irrelevante diante dos 1,5 s entre requisições.
- Dependências: só `jose` (Worker). Mantida; verificar JWT à mão seria risco sem ganho.

## Pendências que dependem do operador

- Confirmar o seletor real do HTML do Erome (`#albums`, `.album-link`, duração) contra uma página ao vivo; só há fixtures.
- Sem `<video data-duration>` ou `.duration` no HTML, todo vídeo vira `duration_unknown` e nada é aceito.
- `check:worker`, `jose` real e Cloudflare Access não puderam ser executados aqui (sem acesso ao registry npm).
- O trecho Erome → MEGA continua bloqueado por `COPY_AUTHORIZED = false` e **não existe downloader**; só o `--store-local` com arquivo local. Não alterei isso.
