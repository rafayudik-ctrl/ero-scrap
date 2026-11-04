# Alterações 0.4.3 → 0.4.4

Objetivo: uma alternativa ao R2 que seja gratuita e **sem cartão de crédito**, com troca simples entre as duas. `COPY_AUTHORIZED` continua sendo a única trava.

- **Miniaturas no D1 (novo padrão).** Tabela `thumbnails` (migration `0007`), com texto base64 de poucos KB por vídeo e `ON DELETE CASCADE`: a prévia some junto com o item na retenção, sem código extra. Menos um serviço para criar e manter.
- **Chave de troca.** `THUMBNAIL_STORE` em `wrangler.jsonc`: `"d1"` ou `"r2"`. Para R2, além da variável, habilitar a linha `r2_buckets`. Valor inválido é recusado (503), nunca adivinhado.
- **R2 continua funcionando** com o mesmo comportamento de antes.
- `wrangler.jsonc` não declara mais o bucket R2 por padrão: um bucket inexistente impedia o primeiro deploy.
- `/api/status` informa `thumbnailStore`.
- Trocar de armazenamento não migra prévias antigas; elas somem em até cerca de 8 dias.
- 150 testes passando (novos: seleção do armazenamento, ida e volta byte a byte no D1, cascata, item expirado, compatibilidade R2, `wrangler.jsonc` válido).
