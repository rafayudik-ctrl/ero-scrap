# 0.4.13

- Quando o runner para por erro, o log do GitHub agora mostra tudo o que é preciso para corrigir:
  operação que falhou (`operation`), status HTTP, código, causa vinda do servidor (`detail`),
  uma dica (`hint`) para limites do D1 grátis / migrations faltando, causa de rede e um stack curto.
  Também escreve uma linha `::error` que aparece no resumo da execução, sem abrir o log.
- O Worker devolve ao runner (autenticado) a operação e a cadeia de causas do erro do D1, e registra o mesmo
  com `console.error` (Cloudflare > Pages > Functions > Logs).
- Respostas que não são JSON (página HTML de erro da Cloudflare, por exemplo limite excedido) agora mostram o texto da página.
- O repositório é público, então os logs também são: todo texto passa por `sanitizeDiagnostic`
  (sem URLs, tokens ou strings longas; no máximo 400 caracteres). Tokens e palavra-chave nunca são impressos.
- Antes: `runner stopped: The collector operation could not be completed.` (sem dizer o motivo).
