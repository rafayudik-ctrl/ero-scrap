# ADR 0005 — Adaptador MEGA e leases de retenção

- Status: aceito
- Etapa: 3

## Contexto

A retenção exclui objetos remotos e só então remove a miniatura privada e o registro do catálogo. Um executor pode atrasar, perder conectividade ou ter sua lease expirada enquanto outro executor assume o mesmo job. Sem propriedade por tentativa, um executor antigo poderia completar ou reagendar o job que já pertence a outro.

A integração de armazenamento precisa permanecer substituível e não deve introduzir um cliente proprietário do protocolo MEGA.

## Decisões

1. Usar o MEGAcmd oficial por meio de um provider `storage-mega`, com `spawn` sem shell no POSIX e um wrapper PowerShell fixo no Windows.
2. O provider aceita somente caminhos de arquivos locais fornecidos pelo operador; não recebe URL remota de vídeos do Erome.
3. `COPY_AUTHORIZED` é `false` por padrão e é conferido antes de inspecionar arquivos, gerar miniaturas ou executar upload. A verificação read-only `mega:check` não depende da trava.
4. A duração local é obtida por FFprobe e comparada à duração descoberta já registrada no D1. Duração não é um parâmetro de linha de comando confiável.
5. Cada claim de retenção gera um token aleatório de 128 bits no D1. Conclusão, falha/retry e remoção da miniatura exigem o token atualmente gravado no job.
6. Retenção executa lotes pequenos e jobs usam leases de 30 minutos para reduzir disputa com operações remotas limitadas por timeout.
7. O registro do catálogo só é removido após confirmação de ausência/exclusão do objeto remoto e tratamento da miniatura.

## Consequências

- Adaptadores de armazenamento futuros podem substituir MEGA sem alterar a API de catálogo.
- Um executor obsoleto não consegue sobrescrever o estado de um job reatribuído.
- Upload real continua desabilitado até autorização efetiva e alteração consciente da trava no Worker e no executor.
- MEGAcmd e FFprobe precisam ser instalados e autenticados pelo operador no host persistente.
- Testes locais não comprovam sessão real MEGA ou configuração Cloudflare; esses passos são validação operacional separada.
