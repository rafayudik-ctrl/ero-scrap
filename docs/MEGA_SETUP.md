# Integração MEGA / MEGAcmd

## Papel do MEGA

O MEGA guarda os vídeos autorizados por prazo limitado. O Ero-Scrap guarda no D1 somente metadados e identificadores do objeto; a miniatura WebP fica em um bucket R2 privado. O navegador nunca recebe o link MEGA no JSON do catálogo: o botão de abertura registra o primeiro clique e retorna um redirecionamento autenticado.

## Runner em nuvem

Na implantação recomendada, MEGAcmd não fica instalado no computador do operador. O workflow `.github/workflows/automation.yml` instala o pacote oficial para Ubuntu 24.04 no runner Linux temporário apenas quando há processamento, teste de conexão ou exclusão vencida, autentica e chama `mega-logout`/`mega-quit` no final. As credenciais ficam limitadas ao step de autenticação, não ao job inteiro.

Secrets do GitHub Actions:

- `MEGA_EMAIL`: e-mail da conta.
- `MEGA_PASSWORD`: senha da conta.
- `MEGA_TOTP_SECRET`: seed Base32 do autenticador TOTP, somente quando a conta usa TOTP. Não é o código rotativo de seis dígitos.

Variable opcional:

- `MEGA_REMOTE_ROOT`: por padrão `/Ero-Scrap`.

Não grave credenciais no repositório, `.env`, argumentos de workflow, logs, D1 ou Pages. O script `scripts/mega-login.mjs` evita exibir a saída do MEGAcmd e pode calcular o código TOTP a partir de uma seed configurada como secret.

O login é repetido em cada execução efêmera `full`/`cleanup`, pois a sessão é descartada com a VM. O comando MEGAcmd recebe timeout máximo configurado de 15 minutos, e o job de automação tem limite de 45 minutos para acomodar download, FFprobe/FFmpeg e upload de arquivos maiores. Antes de ativar a cópia, execute o workflow manual `mega-check`. Ele instala MEGAcmd no runner efêmero, autentica, executa `mega-whoami` e termina a sessão sem upload, criação de link ou exclusão. O modo `cleanup` só autentica quando existe exclusão vencida. A disponibilidade do login automatizado e eventuais verificações de segurança/rate limit da conta devem ser testadas pelo titular.

## Trava de autorização

`packages/config/src/security.js` mantém `COPY_AUTHORIZED = false`. Enquanto estiver fechada:

- O downloader não pede bytes de vídeo.
- `mega-put` não é executado.
- Não são geradas miniaturas a partir de vídeos.
- O comando `mega:check` e `mega:login` são apenas operações de autenticação/verificação.
- O modo `cleanup` continua permitido para remover arquivos já vencidos.

Somente depois de obter a permissão aplicável, o titular pode deliberadamente alterar a constante central para `true` e fazer commit/deploy. O código não contorna login, CAPTCHA, bloqueios 401/403, limites 429 ou outros controles da fonte.

## Operações usadas pelo provider

| Operação | Comando MEGAcmd | Finalidade |
|---|---|---|
| Ver sessão | `mega-whoami` | Verificação somente leitura |
| Criar diretório | `mega-mkdir -p` | Pasta por ID de vídeo |
| Enviar arquivo | `mega-put` | Upload de arquivo temporário validado |
| Confirmar objeto | `mega-ls --show-handles` | Confirmação de arquivo remoto |
| Criar link | `mega-export -a` | Link de compartilhamento armazenado no D1 |
| Revogar link | `mega-export -d` | Revogação best-effort antes da exclusão |
| Excluir | `mega-rm -f` | Remove apenas o caminho exato |

O provider usa `spawn` com `shell: false`, aceita somente asset IDs e paths validados, tem timeouts, captura limitada de saída e caminhos determinísticos para retry idempotente.

## Teste de conexão

No GitHub Actions, execute o modo manual `mega-check`; ele autentica no runner efêmero e confirma `mega-whoami` sem enviar, compartilhar ou excluir arquivos. Não é necessário instalar MEGAcmd no computador pessoal. Não use `mega-put` com vídeos de origem sem a autorização aplicável.

## Expiração e privacidade

- Vídeo nunca aberto: sete dias após upload confirmado.
- Primeiro clique: prazo passa a 24 horas do primeiro clique.
- Cliques seguintes não renovam o prazo.
- Exclusão remota só é considerada concluída quando MEGAcmd confirma que o objeto exato foi apagado ou já estava ausente.
- Link MEGA é uma credencial bearer: quem obtiver a URL/chave pode abrir o arquivo enquanto ele existir. Não copie links para logs ou mensagens públicas.
