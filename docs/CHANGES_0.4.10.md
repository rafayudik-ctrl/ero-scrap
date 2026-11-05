# 0.4.10

- Cada execução do workflow processa até **4 vídeos**, um de cada vez (`APP_CONFIG.media.maxVideosPerRun`).
  Só um arquivo fica em disco/memória por vez; cada job é reservado (lease) apenas quando vai ser processado.
- Nenhum vídeo novo é iniciado depois de 20 min de execução (`startBudgetMs`), então o limite de 35 min do passo não é a saída normal.
- O lote para cedo se a fila acabar ou após 2 falhas seguidas (ex.: MEGA fora do ar), para não gastar tempo repetindo o mesmo erro.
- Com 3 execuções/hora, a capacidade vai de 3 para até 12 vídeos/hora.
- Para mudar o número, edite `maxVideosPerRun` em `packages/config/src/app.js` (1 a 10).
