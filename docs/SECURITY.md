# Segurança

## Trava de cópia

`packages/config/src/security.js` define `COPY_AUTHORIZED = false`. O valor não é configurável pelo navegador, D1, `.env`, GitHub Actions secret ou Cloudflare variable.

A trava é verificada por:

- coletor/runner antes de reivindicar jobs de processamento;
- downloader/fluxo de processamento antes de solicitar mídia;
- `MegaCmdStorageProvider.uploadLocalFile` antes de tocar em arquivos ou chamar MEGAcmd;
- `FfmpegThumbnailGenerator` antes de ler/gerar miniaturas;
- Worker antes de registrar novos arquivos ou aceitar upload de miniatura.

A exclusão de arquivos já armazenados continua permitida mesmo com a trava fechada. O modo `cleanup` não baixa nem copia conteúdo.

## Coleta e mídia

- Somente a aba pública `New`, páginas 1 e 2, e posts nelas listados.
- O downloader só aceita URLs HTTPS com host dentro de `erome.com` e extensão de vídeo permitida.
- Redirecionamentos não são seguidos.
- HTTP 401/403 é falha definitiva; 429 aguarda nova tentativa posterior.
- Não há cookies, login automatizado do site, proxy alternativo, user-agent stealth ou bypass de CAPTCHA/DRM/controle de acesso.
- A duração é verificada na inspeção da página e novamente pelo FFprobe sobre o arquivo baixado; as durações devem corresponder dentro da tolerância.
- Tamanho máximo do arquivo temporário: 4 GiB. O runner também precisa ter espaço temporário suficiente.

A implementação só deve ser habilitada para mídia que o operador está autorizado a copiar e armazenar. A constante é um bloqueio técnico, não autorização jurídica ou substituto de consentimento/termos do serviço.

## Cloudflare Access

- O site e API pública validam JWT do Cloudflare Access via JWKS, algoritmo RS256, issuer, audience, expiração e allowlist de e-mail.
- O endpoint interno também deve estar atrás de Access Service Auth.
- Bypass local somente com `APP_ENV=development` e `DEV_AUTH_BYPASS=true`; nunca configure em Pages/produção.
- Runner usa `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` e Bearer token separado `COLLECTOR_API_TOKEN`.

## Segredos

- MEGA email/password/TOTP seed somente em GitHub Actions Secrets.
- `RUNNER_API_TOKEN` somente em Cloudflare Pages Secret e o mesmo valor como `COLLECTOR_API_TOKEN` em GitHub Secret.
- Access Service Token só nos GitHub Actions Secrets.
- `CLOUDFLARE_API_TOKEN` para migrations, restrito a D1 Edit e à conta correta.
- Nunca registrar headers, tokens, links MEGA, TOTP seed, e-mail ou conteúdo dos arquivos em log.

## Links MEGA

Links compartilháveis são bearer URLs: qualquer pessoa que obtenha URL e chave pode acessar até que o arquivo seja removido/revogado. Por isso:

- `share_url` só fica no D1;
- JSON do catálogo não contém URL de compartilhamento;
- abrir item exige Access, `Origin` exato e POST;
- resposta 303 usa `Cache-Control: no-store` e `Referrer-Policy: no-referrer`;
- URL redirecionada é validada para HTTPS/`mega.nz`;
- Access protege o Ero-Scrap, mas não substitui a segurança do link já emitido pelo MEGA.

## API interna

- `POST /internal/collector`: Bearer token, JSON limitado e allowlist de operações.
- `PUT /internal/thumbnails/:id`: token, ID validado, body `image/webp` limitado a 256 KiB, assinatura RIFF/WEBP, asset armazenado ativo e gate autorizado.
- Nenhum SQL arbitrário; SQL parametrizado.
- R2 privado; a leitura de thumbnail passa pela API autenticada e só aceita a key esperada de item ativo.

## GitHub Actions

- Runner efêmero padrão Linux, permissões `contents: read`, sem `GITHUB_TOKEN` de escrita.
- `concurrency` impede runners concorrentes no mesmo catálogo.
- `timeout-minutes` limita consumo em caso de travamento.
- `npm ci` instala o lockfile; nenhuma dependência é instalada dinamicamente pelo aplicativo.
- Workflow recebe secrets somente como variáveis de ambiente e não ecoa credenciais.

## Frontend

- Nunca recebe token do runner, credenciais MEGA, `share_url` ou SQL.
- DOM usa `textContent`, não injeta título como HTML.
- Miniaturas carregam lazy e sem player/autoplay.
- CSP restritiva em `apps/web/public/_headers`.
