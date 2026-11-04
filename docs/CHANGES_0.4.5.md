# Alterações 0.4.4 → 0.4.5

Objetivo: uma alternativa ao Cloudflare Zero Trust, gratuita e **sem cartão**, com troca simples. `COPY_AUTHORIZED` continua sendo a única trava de cópia; autenticação não é uma trava de cópia, é o controle de quem vê o catálogo.

- **`AUTH_MODE`** em `wrangler.jsonc`: `"password"` (novo padrão) ou `"access"`. Valor desconhecido fecha o site (503).
- **Modo senha:** secret `SITE_PASSWORD` (mínimo 12 caracteres), `POST /api/login`, cookie assinado (HMAC-SHA256, `HttpOnly`, `Secure`, `SameSite=Strict`, 30 dias), `POST /api/logout`. WebCrypto puro, sem dependências. A chave de assinatura deriva da senha: trocá-la desconecta todos.
- **Limite de tentativas** no D1 (migration `0008`): 5 falhas por IP e 30 globais em 15 min. Linhas minúsculas, gravadas só em falhas e podadas diariamente.
- **Tela de login** na página, botão Sair, e tratamento de 401 sem recarregar nada extra.
- **Mais leve:** a biblioteca `jose` só é carregada no modo `access`.
- **Executor:** o Service Token do Access passou a ser opcional; o Bearer token em `/internal/*` continua obrigatório sempre.
- `/api/status` informa `authMode`.
- Limite conhecido: o modo senha é uma senha única, sem 2FA nem vários usuários, e a estrutura estática da página fica pública (sem dados).
- 157 testes passando (novos: tokens, expiração e adulteração, cookie com flags, origem estrangeira, bloqueio após 5 falhas, limpeza, rota de abertura exige sessão, executor sem Access).
