# Desenvolvimento local

## Ferramentas

- Node.js 26 LTS recomendado (Node.js 24+ suportado).
- npm.
- Wrangler 4.156.0 para desenvolver Pages Functions localmente.
- MEGAcmd/FFmpeg são instalados pelo runner GitHub Actions quando há trabalho autorizado ou exclusão vencida; não são necessários para o catálogo web.

## Instalar e configurar

```bash
npm ci
```

PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars
```

Para teste local, configure `COLLECTOR_API_TOKEN` no `.env` e `RUNNER_API_TOKEN`, `TEAM_DOMAIN`, `POLICY_AUD` e `ALLOWED_EMAILS` em `.dev.vars`. Os arquivos são ignorados pelo Git. Em produção, os segredos ficam somente nos secrets do GitHub Actions e Pages.

## Palavra-chave

Edite exclusivamente `config/search-keyword.txt`, uma linha, até 80 caracteres. Arquivo vazio desliga a varredura. A mudança é lida na execução seguinte, sem reiniciar o processo contínuo.

## D1 local

```bash
npm run db:local:apply
```

As migrations criam as tabelas necessárias e os índices de catálogo/retention.

## Serviços

A aplicação é Pages + Pages Functions same-origin. Em um terminal:

```bash
npm run dev:pages
```

A interface, `/api/*`, `/internal/*` e `/health` são servidos pelo Wrangler em `http://localhost:8788`. Configure os bindings locais de D1/R2 e os valores `.dev.vars` conforme os exemplos. O bypass de Access é permitido somente com `APP_ENV=development` e `DEV_AUTH_BYPASS=true`; o endpoint interno continua exigindo Bearer token próprio.

O modo `--watch` existe para desenvolvimento e não é necessário em produção. Em produção, GitHub Actions cria VMs temporárias para cada execução e nenhuma máquina do operador precisa ficar ligada. O workflow consulta D1 depois da varredura; só prepara MEGAcmd/FFmpeg quando há uma operação de mídia ou exclusão vencida.

## MEGA somente leitura

Copie `.env.example` para `.env`, configure `MEGA_REMOTE_ROOT` se necessário, autentique o MEGAcmd manualmente e rode:

```bash
npm run mega:check
```

Esse teste apenas executa `mega-whoami`. Não envia arquivo, cria link, cria pasta ou apaga conteúdo. Não é necessário preencher credenciais do Worker para executar esse comando.

## Testes

```bash
npm run check
npm test
npm run check:pages
```

O teste completo requer `npm ci` e a dependência `jose` para JWT Access. O `check:pages` precisa de Wrangler disponível/cacheado e valida a compilação sem publicar. Em CI, o workflow usa Node.js 26.13.0 e instala as dependências a partir do lockfile.

## Segurança e testes de integração

- A constante de cópia permanece `false` por padrão e há testes que garantem bloqueio no executor e no Worker.
- Não usar URLs reais de vídeos, credenciais MEGA ou links privados em fixtures.
- Usar arquivos de vídeo sintéticos próprios em testes locais.
- Testar `retention` com provider fake antes de configurar exclusão na conta real.
- Não usar `media:store-local` nem habilitar o pipeline Erome enquanto a autorização não estiver confirmada e a trava não tiver sido conscientemente habilitada.
- A API nunca retorna `share_url` no catálogo.

## Operações locais de mídia

A verificação de duração usa FFprobe no arquivo local; não aceite duração digitada como entrada confiável. Configure `FFPROBE_BINARY` e `FFMPEG_BINARY` quando o host tiver os executáveis fora do `PATH`. A trava `COPY_AUTHORIZED` impede inspeção/cópia para armazenamento nos fluxos de mídia protegidos.
