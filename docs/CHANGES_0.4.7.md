# Alterações 0.4.6 → 0.4.7

- **Travamento de 45 minutos no passo "Process one queued video".** O limite de cada comando do MEGAcmd era 15 minutos para todos, inclusive para consultas rápidas. Um comando preso (o suspeito principal é o `export`, que pode esperar uma confirmação de direitos autorais que ninguém responde num executor sem terminal) segurava o job até o limite.
- **Prazos por comando:** `ls`, `mkdir`, `export`, `rm` e `whoami` falham em 60 s com `mega_timeout` e o nome do comando no log. Só o `put` (a transferência) mantém o prazo longo.
- **`export -a -f`:** aceita o aviso do MEGAcmd de forma não interativa, para nunca esperar resposta.
- **Prazo do passo:** o passo de processamento tem `timeout-minutes: 35`, então a falha é clara e o passo de logout do MEGA ainda roda.
- A tarefa que falhou é reagendada automaticamente; o arquivo parcial no MEGA é detectado e reaproveitado na nova tentativa (envio idempotente).
- 160 testes passando.
