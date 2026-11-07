# Política de retenção

## Regras de produto

- O relógio de sete dias começa somente depois da confirmação do upload remoto e do registro do arquivo.
- Sem primeiro clique: `expires_at = uploaded_at + 7 dias`.
- Primeiro clique válido: `first_clicked_at` é gravado uma única vez e `expires_at = first_clicked_at + 24 horas`.
- Cliques posteriores nunca renovam o prazo.
- Cada vídeo tem relógio próprio; outros vídeos no mesmo post não são afetados.
- O link MEGA não é exposto no JSON do catálogo. A abertura passa pelo Worker, que registra o clique e redireciona.

## Execução em nuvem

Em produção, a retenção não depende de processo residente nem de computador pessoal:

- Com `COPY_AUTHORIZED = true`, cada execução `full` a cada 15 minutos também processa a fila de retenção.
- Com a trava `false`, a execução `metadata` consulta D1 no mesmo runner para saber se há exclusões vencidas. Só instala e autentica o MEGAcmd se existir trabalho e as credenciais estiverem configuradas.
- Não existe cron de limpeza separado; a verificação ocorre no mesmo job de 15 minutos, evitando 720 jobs adicionais por mês.
- A exclusão ocorre no primeiro runner que confirmar um item vencido e conseguir autenticar no MEGA; a latência normal é até uma cadência do workflow, mais eventual atraso do GitHub Actions.
- O modo manual `cleanup` executa somente a limpeza, sem habilitar cópia.

## Exclusão

O executor reclama itens vencidos em lotes pequenos (2 itens). Se o lote vier cheio, repete imediatamente, até 5 lotes por execução.

Somente vídeos `stored`/`clicked` vencidos recebem novo job. Itens já em `delete_pending` possuem job próprio e não disputam vaga com os novos, de modo que jobs `dead` não bloqueiam a exclusão dos demais. Um job cujo asset desapareceu é marcado `cancelled`.

1. D1 seleciona itens vencidos e cria um `delete_video` com chave idempotente `retention:<assetId>`.
2. O item passa para `delete_pending`; o job recebe lease.
3. O provider MEGA verifica/remove o arquivo remoto exato.
4. Depois da confirmação, o Worker apaga a miniatura privada do R2.
5. D1 remove a linha `video_assets` e marca o job como `succeeded`.
6. O registro de deduplicação pode permanecer, sem exibição no catálogo.

Nunca apagar a linha do catálogo antes da confirmação do armazenamento remoto.

## Falhas

- Falha no MEGA ou provider desconhecido: mantém `delete_pending` e reagenda com backoff exponencial limitado.
- Falha no R2/D1 depois do delete MEGA: job é repetido; ausência remota confirmada é considerada sucesso idempotente.
- Conclusão, retry e limpeza de miniatura exigem o token da lease atual; um executor antigo não pode finalizar um job reatribuído.
- Após oito tentativas, job é marcado `dead` para inspeção operacional. O registro não é eliminado silenciosamente; pode exigir reconciliação manual.
- Se o processo cair com lease ativo, job torna-se elegível novamente quando `lease_expires_at` vencer.

## Limites

- `APP_CONFIG.retention.unopenedDays = 7`.
- `APP_CONFIG.retention.afterFirstClickHours = 24`.
- `APP_CONFIG.retention.sweepIntervalMinutes = 10` (cadência de processamento; o runner consulta D1 no mesmo job).
- `APP_CONFIG.retention.batchSize = 2` (lote conservador para operações sequenciais no MEGA).
- Todos os timestamps são UTC ISO-8601.
