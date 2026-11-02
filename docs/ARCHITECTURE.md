# Arquitetura atual — Ero-Scrap 0.4.3

## Objetivo

Monitorar somente as duas primeiras páginas de `New` do Erome a cada dez minutos, descobrir publicações, identificar vídeos individuais e aplicar uma única palavra-chave (título **ou** tag). Quando a cópia estiver explicitamente autorizada, o pipeline revalida cada vídeo, baixa apenas arquivos públicos permitidos com duração confirmada de até 600 segundos, gera uma miniatura WebP e transfere o arquivo ao MEGA. O catálogo privado mantém os metadados e aplica retenção por vídeo: sete dias sem clique ou 24 horas após o primeiro clique.

## Princípios de engenharia

1. Frontend estático, Vanilla JS e CSS puro; nenhum framework ou player de vídeo.
2. O navegador recebe somente metadados paginados e miniaturas privadas pequenas.
3. O trabalho pesado ocorre em runners Linux efêmeros do GitHub Actions; nenhum computador pessoal ou VPS precisa ficar ligado.
4. Cloudflare Pages Functions cuida de autenticação/API, D1 guarda metadados/filas e R2 guarda miniaturas.
5. Uma única fonte da palavra-chave: `config/search-keyword.txt`, exatamente uma linha, lida em toda varredura.
6. Post e vídeo são entidades separadas; cada vídeo possui ID, duração, status, job e relógio de retenção próprios.
7. `COPY_AUTHORIZED` permanece `false` por padrão e é validado no runner, provider MEGA e API. A constante não substitui autorização do titular, consentimento dos participantes e confirmação de que todos são adultos.
8. Nenhum bypass de login, CAPTCHA, DRM, 401/403, 429, paywall, token ou outra restrição técnica.
9. A API interna oferece comandos allowlisted; não aceita SQL arbitrário nem token administrativo Cloudflare.
10. Upload e exclusão são idempotentes, com leases, tokens de propriedade, retries e backoff.
11. Falha de confirmação nunca apaga silenciosamente metadados nem assume que arquivo remoto foi excluído.

## Componentes de produção

### GitHub

- Repositório privado guarda código e a palavra-chave.
- Actions CI em runner `ubuntu-24.04` valida sintaxe, bundle Pages Functions e testes.
- Actions automation usa runners `ubuntu-24.04` descartáveis: a cada dez minutos executa a varredura e, se a trava estiver liberada, processa no máximo um vídeo por execução.
- Quando a trava está fechada, o mesmo workflow consulta D1 para saber se há exclusões vencidas e só instala/autentica o MEGAcmd quando há trabalho de retenção. Não há cron ou runner separado para limpeza.
- Actions D1 migrations aplica migrations remotas sob demanda.

O runner não é um serviço permanente. Ele instala dependências, executa uma tarefa, remove a sessão MEGA e a VM é descartada pelo GitHub.

### Cloudflare Pages — `apps/web` e `functions/`

- HTML semântico, CSS puro, JavaScript ES Modules.
- `functions/api/[[path]].js`: API de catálogo/status/abertura.
- `functions/internal/[[path]].js`: API interna para runner e thumbnails.
- `functions/health.js`: healthcheck.
- `_routes.json` restringe Functions a `/api/*`, `/internal/*` e `/health`; assets estáticos são entregues diretamente pelo CDN.
- `wrangler.jsonc` na raiz declara `pages_build_output_dir`, D1 e R2.

Pages Git Integration publica a cada push na branch de produção. O runtime de Pages não baixa vídeos nem executa FFmpeg.

### D1

D1 guarda posts, tags, vídeos, deduplicação, estado dos jobs, links MEGA privados, miniaturas e timestamps. O runner não recebe credenciais de conta Cloudflare: ele usa um Bearer token próprio e um Access Service Token para chamar uma API interna estreita.

### R2

Bucket privado `ero-scrap-thumbnails`, usado somente para WebP pequenas. A API entrega miniaturas após autenticar o usuário e confirmar que o asset está ativo.

### GitHub Actions runner — `apps/runner`

O runner executa em Ubuntu efêmero e possui:

- `ScanService`: lê a palavra-chave, consulta somente New 1/2, inspeciona posts que ainda aparecem nessas páginas e persiste metadados;
- `EromeMediaProcessingService`: com a trava aberta, reclama um job, relê a página pública do álbum, revalida título/tag, ID do vídeo e duração, baixa em stream, confirma duração real com FFprobe, gera WebP e envia ao MEGA;
- `RetentionService`: reclama jobs vencidos, exclui arquivo MEGA, remove thumbnail R2 e conclui D1;
- `MaintenanceService`: poda metadados/histórico antigos em lotes limitados.

O pipeline processa no máximo um vídeo por execução agendada. O arquivo temporário é gravado em disco da VM, nunca inteiro em RAM, e removido em `finally`.

### Adaptador Erome — `packages/source-erome`

- URLs fixas de New page 1/2; não aceita outras páginas.
- Inspeciona somente posts que aparecem nessas duas páginas.
- Um post pode ter vários vídeos e imagens. Imagens não são enfileiradas.
- `mediaUrl` é transitória; a API sanitiza e não persiste URLs de mídia em D1. O runner reabre o álbum antes da transferência para obter a URL pública atual.
- Hosts precisam pertencer a `erome.com`/subdomínios HTTPS e extensões suportadas. Redirecionamentos, hosts externos, autenticação e 401/403 são recusados; 429 é reagendado sem tentar contornar o limite.
- Duração ausente ou ambígua é `duration_unknown`, nunca aceita por suposição.

A estrutura HTML do Erome não é API oficial e pode mudar. Fixtures são artificiais; o primeiro teste de produção precisa confirmar o parsing atual. Se a página recusar acesso, o coletor para.

### Processamento de mídia — `packages/media-tools`

- FFprobe verifica arquivo regular, stream de vídeo e duração real.
- Duração real precisa ser `> 0` e `<= 600000 ms`, e permanecer dentro da tolerância do metadado descoberto.
- FFmpeg gera WebP com 320 px de largura e limite de 256 KiB.
- Timeouts, limites de bytes e limpeza de temporários são obrigatórios.

### MEGA — `packages/storage-mega`

MEGAcmd oficial é executado com `spawn`, `shell: false`, argumentos separados, saída limitada e timeout. O upload usa caminho determinístico por asset para retry idempotente. O link é armazenado apenas no servidor. A exclusão revoga o compartilhamento quando aplicável e remove o arquivo exato, nunca a pasta recursivamente.

## Fluxos principais

### Descoberta

```text
GitHub Actions (cada 10 min)
  -> ler config/search-keyword.txt
  -> GET New page 1 e page 2 (sem página 3+)
  -> upsert dos posts
  -> inspecionar posts ainda visíveis que não possuem detalhes
  -> extrair tags e vídeos individuais; imagens ficam de fora
  -> aplicar palavra-chave no título OU nas tags
  -> exigir duração confirmada <= 600 s
  -> persistir avaliação; enfileirar somente quando COPY_AUTHORIZED=true
```

### Download autorizado

```text
GitHub Actions runner efêmero
  -> claim de um job com lease
  -> reabrir álbum público e validar termo, ID e duração
  -> obter URL atual de mídia pública
  -> baixar por stream para disco temporário (sem cookies/proxy/redirect)
  -> FFprobe confirma stream e duração real
  -> FFmpeg gera WebP
  -> MEGA upload e confirmação do objeto/link
  -> D1 registra upload + expires_at = uploaded_at + 7 dias
  -> R2 guarda thumbnail
  -> limpar arquivos temporários e sessão MEGA
```

### Abertura e retenção

```text
Browser autenticado
  -> POST /api/catalog/:id/open
  -> API valida Origin + Access JWT
  -> D1 registra first_clicked_at apenas uma vez
  -> expires_at = first_clicked_at + 24 h
  -> 303 para o link MEGA

GitHub Actions (mesmo job de 10 min; também no modo full)
  -> consultar D1 se há exclusões vencidas
  -> se houver, autenticar MEGA e reclamar exclusões com lease
  -> apagar arquivo exato no MEGA
  -> apagar thumbnail no R2
  -> remover registro do catálogo e concluir job no D1
```

## Limites operacionais

- 2 páginas New por varredura, no máximo 80 cards por página e 160 inspeções de posts por ciclo.
- Intervalo mínimo de 1,5 s entre requisições públicas e timeout/limite de tamanho HTML.
- GitHub schedule é best-effort; cron configurado não é SLA de tempo real.
- Um vídeo por execução de processamento; concorrência controlada por workflow group e lease D1.
- Arquivo máximo configurado: 4 GiB, sujeito ao espaço temporário real disponível no runner.
- Duração máxima: 600.000 ms.
- Miniatura máxima: 256 KiB.
- Thumbnail WebP: 320 px.
- D1 recebe apenas metadados; vídeos nunca são enviados ao Pages, D1, R2 ou GitHub.
- Expiração por vídeo: 7 dias após upload; primeiro clique encurta uma única vez para 24 horas após o clique.
- Com a trava desligada, a varredura só registra metadados; no mesmo job o runner consulta D1 e pode executar exclusões vencidas sem liberar novas cópias.

## Fora do escopo / restrições permanentes

- Contornar autenticação, paywall, CAPTCHA, DRM, 401/403, 429 ou bloqueios técnicos.
- Copiar mídia sem autorização válida dos titulares e participantes, ou material cuja idade/consentimento não possa ser confirmado.
- Reprodução de vídeo no Ero-Scrap; o botão abre o MEGA.
- Armazenar vídeos no GitHub/Pages/Worker ou na memória do navegador.
- Rodar um servidor local ou computador pessoal continuamente.
