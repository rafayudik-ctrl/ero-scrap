# Alterações 0.4.5 → 0.4.6

- **Correção do `mega_command_failed` no primeiro envio.** Antes de enviar, o programa consulta (`mega-ls`) se o arquivo já existe. O MEGAcmd responde "Couldn't find ..." quando não existe, e esse texto não era reconhecido como "arquivo inexistente"; o programa tratava como erro e abortava antes do `mkdir` e do `put`. Agora "couldn't find", "could not find" e "cannot find" também contam como inexistente. A exclusão por retenção usa a mesma checagem e foi corrigida junto. Falhas de login (por exemplo "Not logged in") continuam sendo erro, nunca "inexistente".
- **Diagnóstico no log:** a falha agora informa `megaCommand` (ls, mkdir, put, export...) e `exitCode`, nunca a saída do MEGAcmd, que pode conter links.
- 159 testes passando (novos: texto "Couldn't find" e falha de login não confundida com arquivo ausente).
