# ADR-0003: Executor de mídia separado do Worker

- Status: Aceita
- Data: 2026-11-01

## Contexto

Download, inspeção, processamento e upload de vídeo têm duração e consumo de memória imprevisíveis para um Worker de API. O operador também não deseja manter computador ou VPS ligado.

## Decisão

Operações de mídia são executadas por um processo Node.js independente dentro de um runner Linux efêmero do GitHub Actions. O Pages Functions coordena por API interna; o runner consulta D1 por comandos allowlisted e processa em streams com concorrência limitada. Nenhum host persistente é necessário.

## Consequências

- Não é necessário manter computador, VPS ou serviço Node.js permanentemente ligado.
- Cada execução usa uma VM temporária do GitHub Actions, que é descartada ao terminar.
- O Worker permanece pequeno, rápido e dentro dos limites do runtime.
- O custo e a cadência passam a depender dos limites e da disponibilidade dos agendamentos do GitHub Actions.
