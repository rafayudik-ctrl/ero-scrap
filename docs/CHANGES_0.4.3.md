# Alterações 0.4.2 → 0.4.3

Objetivo: manter o projeto 100% gratuito com repositório público, mais leve para o host (Actions/Cloudflare) e para o usuário. `COPY_AUTHORIZED` continua `false` e é a **única** trava; nenhuma outra trava foi encontrada e nenhuma foi adicionada.

## Gratuidade
- **Repositório público** como caminho recomendado: minutos de Actions ilimitados. A varredura a cada 10 min (≈4.320 jobs/mês) estoura os 2.000 min do plano privado.
- `keepalive.yml`: reativa semanalmente os workflows agendados; o GitHub desliga cron de repositório público após 60 dias sem atividade.
- Manutenção diária (limpeza do D1) só roda entre 03:00 e 03:59 UTC. Antes rodava em toda execução (144×/dia).
- Jobs `process_video` mortos passam a ser podados após 7 dias (antes acumulavam para sempre). Jobs de exclusão mortos continuam preservados.

## Leveza por execução
- Workflow dividido em `scan` (≈1 min, sem dependências) e `storage` (FFmpeg/MEGAcmd só quando há trabalho). Um download longo não atrasa mais a próxima varredura.
- Removidos `npm ci` e cache npm do runner: ele só usa módulos nativos do Node (`jose` é usado apenas pela API no Pages).
- Lógica de decisão do workflow virou um passo `plan` legível e um script testado (`scripts/resolve-mode.mjs`).

## Privacidade em repositório público
- Secret opcional `SEARCH_KEYWORD` substitui `config/search-keyword.txt`, para não publicar o que é monitorado. Logs só trazem contagens, códigos e IDs aleatórios.

## Correções
- Upload da miniatura tem uma nova tentativa (antes, uma falha de rede deixava o item sem prévia para sempre).
- A página passou a refletir `copyAuthorized` de `/api/status` (faixa "Bloqueado/Liberado" e texto); antes era fixa.
- Novo `--maintenance-once` para forçar a limpeza manualmente.

## Testes
145 testes passando. Novos: palavra-chave por secret, janela de manutenção, poda de jobs mortos, resolução de modo com a trava fechada, CI sem secrets e runner sem `npm ci`.
