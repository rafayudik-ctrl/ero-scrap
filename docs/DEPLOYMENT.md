# Implantação

A implantação atual e recomendada não usa um host persistente nem o computador do operador.

Siga o tutorial passo a passo em **[CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)**.

Arquitetura:

- GitHub privado e GitHub Actions para CI e runner Linux efêmero.
- Cloudflare Pages Git Integration para publicar site e Pages Functions automaticamente após push na branch `main`.
- Cloudflare D1 para metadados e Cloudflare R2 privado para miniaturas.
- MEGAcmd instalado/autenticado apenas dentro do runner temporário, quando houver vídeo para processar, teste `mega-check` ou exclusão vencida.

Não configure VPS, `systemd`, PM2, Codespaces permanente ou máquina local como serviço. Codespaces pode ser usado apenas temporariamente para extrair o ZIP e enviar os arquivos ao repositório, depois deve ser parado/excluído.

A trava `COPY_AUTHORIZED` deve permanecer `false` enquanto não houver autorização válida para copiar o conteúdo. Com a trava fechada, o workflow programado coleta metadados e consulta D1 para detectar exclusões vencidas; só autentica no MEGA se houver arquivo a excluir.
