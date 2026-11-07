# Estado atual — Ero-Scrap 0.5.4

## Entregue em código

- Catálogo privado paginado com busca e modos grade/lista.
- Cards com título, duração, data, prazo e miniatura autenticada quando disponível.
- Abertura por POST autenticado; primeiro clique registrado uma única vez e redirecionamento 303 para o link MEGA.
- URL compartilhável MEGA não aparece nas respostas JSON do catálogo.
- Retenção individual: sete dias desde upload quando não clicado; 24 horas desde o primeiro clique.
- Jobs de exclusão idempotentes com lease/token, retry/backoff e tratamento de leases obsoletas.
- Adaptador MEGAcmd oficial para verificar conexão, upload de arquivo local autorizado, validar objeto, criar link, revogar compartilhamento e excluir o arquivo exato.
- Pipeline de código Erome → stream temporário → FFprobe → miniatura WebP → MEGA → registro D1/R2.
- Revalidação da palavra-chave, álbum público, ID individual e duração antes de qualquer transferência.
- Trava `COPY_AUTHORIZED = false`, verificada no runner, downloader, adaptador MEGA e Worker. Com a trava fechada, nenhum pedido de bytes de vídeo nem upload ocorre.
- GitHub Actions com runners efêmeros Ubuntu 24.04 como executor; Cloudflare Pages Functions/D1/R2 para site, API, dados e miniaturas.
- Workflow de 15 minutos com consulta barata de trabalho pendente; MEGAcmd só é instalado/autenticado quando existe upload ou exclusão vencida; FFmpeg só é instalado quando existe vídeo na fila.
- Tutorial de implantação sem computador/servidor próprio ligado em `CLOUD_DEPLOYMENT.md`, usando GitHub Codespaces apenas para preparar o repositório, GitHub Actions para execução e Cloudflare Pages para hospedagem.

## Validação realizada nesta sessão

- `node scripts/check-syntax.mjs`: passou; 73 arquivos JavaScript verificados.
- Testes direcionados mais recentes para repository, collector service/repository e processamento de jobs: 27/27 aprovados.
- Suíte completa `node --test`: 125/127 passaram. Dois arquivos de teste que importam rotas protegidas não iniciaram porque `jose@6.2.14` não estava instalado no ambiente (`ERR_MODULE_NOT_FOUND`).
- `npm ci --ignore-scripts --no-audit --no-fund` foi tentado; falhou por erro DNS `EAI_AGAIN` para `registry.npmjs.org`. Não foi usado stub para mascarar a ausência da dependência.
- Arquivos `package.json`, `package-lock.json` e Wrangler JSONC foram analisados; YAML dos workflows foi parseado.
- Migrations D1 0001–0006 foram aplicadas em SQLite local de teste nas verificações anteriores; os testes de retenção/leases e as constraints foram aprovados.

## Validação pendente

- O Node disponível nesta sessão era `22.16.0`; o projeto exige Node `26.13.0`, declarado em `.node-version`.
- `npm test` completo em Node 26 com `jose` instalado pelo lockfile.
- Bundle de Pages Functions via Wrangler (`npm run check:pages`); a resolução do `npx` expirou nesta sessão.
- Verificação real de assinatura JWT/JWKS com Cloudflare Access.
- Deploy real das Pages Functions e aplicação das migrations pelo Wrangler/Cloudflare D1.
- Teste read-only contra o HTML público atual do Erome. Fixtures de parser são sintéticas; seletores e URLs de mídia podem mudar.
- Teste real de login/transferência/exclusão na conta MEGA do operador, usando somente arquivo de teste próprio/autorizado.
- Nenhum acesso a contas do operador ou deploy foi realizado nesta sessão.

## Condições para operação

1. Seguir `CLOUD_DEPLOYMENT.md` para preparar repositório, Pages, D1, R2, Access e secrets.
2. Aplicar as migrations remotas antes da primeira varredura.
3. Começar com workflow `metadata` e confirmar parsing do título, tags, vídeos e durações no Erome atual.
4. Executar `mega-check` e testar upload/exclusão com arquivo de teste próprio ou expressamente autorizado.
5. Manter `COPY_AUTHORIZED = false` até existir autorização válida para copiar/armazenar o material e até que privacidade, consentimento e maioridade dos participantes estejam confirmados.

A implementação do pipeline de download está presente no código, mas permanece bloqueada por padrão e não foi validada end-to-end contra um álbum real nem contra uma conta MEGA real. A implantação é sem host próprio: a execução usa runners descartáveis do GitHub Actions; Pages não processa arquivos de vídeo.
