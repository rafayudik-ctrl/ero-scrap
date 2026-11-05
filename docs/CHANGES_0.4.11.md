# 0.4.11

- Novo agendador opcional e confiável: `workers/scheduler/` (Cloudflare Worker + Cron Trigger).
  Dispara o workflow nos minutos 3, 23 e 43, sem atraso e sem descarte. Grátis, sem cartão.
- Leve: uma requisição a cada 20 min, sem banco, sem estado, sem dependências, um único arquivo
  (pode ser colado no painel da Cloudflare). Uma nova tentativa só em erro de rede/5xx/429.
- O token do GitHub vive só como Secret do Worker e nunca aparece em log (testado).
- `COPY_AUTHORIZED` segue como única trava: o Worker sempre pede o modo `auto`.
- O agendador do GitHub continua como opção. A variável de repositório `EXTERNAL_SCHEDULER=true`
  faz os dois jobs ignorarem o `schedule` do GitHub (evita scan duplicado).
- `check-syntax` passou a verificar `workers/`. Docs: seção 17 de `CLOUD_DEPLOYMENT.md` reescrita (opções A/B/C).
