# Ero-Scrap

Sistema pessoal de monitoramento de publicações recentes, com catálogo privado de vídeos temporários. A implantação recomendada não exige computador ou servidor seu ligado: **GitHub Actions** executa tarefas em runners Linux `ubuntu-24.04` efêmeros; **Cloudflare Pages + Pages Functions** hospeda a interface/API; **D1** armazena metadados e miniaturas (R2 é uma alternativa opcional, escolhida em `THUMBNAIL_STORE`); **MEGA** armazena os arquivos autorizados.

> **Trava de cópia:** `packages/config/src/security.js` mantém `COPY_AUTHORIZED = false`. Assim, o agendamento opera em modo de metadados e não baixa nem copia arquivos de vídeo. Transferências só podem ser habilitadas deliberadamente depois que o responsável tiver autorização válida. O código não tenta contornar login, CAPTCHA, DRM, 401/403, 429 ou controles de acesso da fonte.

## Objetivo e regras

- Consultar somente as páginas 1 e 2 da aba `New`, com cadência configurada de dez minutos.
- Ler uma única palavra/frase do secret `SEARCH_KEYWORD` (recomendado em repositório público) ou, se ele não existir, de `config/search-keyword.txt`; o post corresponde quando o termo aparece no título **OU** em qualquer tag.
- Inspecionar cada post encontrado nas duas páginas; um post pode conter vários vídeos e imagens.
- Ignorar posts somente com imagens e ignorar imagens em posts mistos.
- Aceitar vídeos somente quando a duração é explicitamente conhecida e `0 < duração <= 600000 ms` (10 minutos).
- Identificar cada vídeo individualmente, evitar duplicados e processar uma tarefa por vez.
- Quando cópia autorizada estiver ativa, armazenar vídeos no MEGA e miniaturas WebP privadas no D1 (padrão, sem cartão) ou no R2 (opcional).
- Primeiro clique válido inicia prazo de 24 horas; sem clique, prazo de sete dias após o upload. O prazo não é renovado por cliques posteriores.

## Arquitetura

| Componente | Responsabilidade |
|---|---|
| `apps/web` | HTML, CSS e JavaScript Vanilla; sem frameworks |
| `functions/` | Cloudflare Pages Functions same-origin para API, interno e health |
| `apps/api` | Regras de autenticação, D1, catálogo e comandos internos |
| `apps/runner` | Coletor, fila de processamento, downloader, FFprobe/FFmpeg, MEGA e retenção |
| `packages/domain` | Regras puras de título, tag, duração e retenção |
| `packages/source-erome` | Leitura pública, parsing e download controlado do vídeo depois da trava |
| `packages/storage-mega` | Adaptador MEGAcmd sem shell, upload idempotente, link e exclusão exata |
| `packages/media-tools` | FFprobe e miniatura WebP pequena |
| `database/migrations` | Schema D1 versionado |
| `.github/workflows` | CI, agendamento em runner efêmero e migrations manuais |

A interface carrega somente metadados paginados e miniaturas. Vídeos nunca são enviados ao GitHub, Pages, D1 ou ao navegador como parte do catálogo. O runner guarda o arquivo em disco temporário da VM, valida por FFprobe, transfere para MEGA e remove o temporário ao concluir.

## Palavra-chave

Defina o secret `SEARCH_KEYWORD` no GitHub (o valor é mascarado nos logs e não aparece no repositório público) ou edite `config/search-keyword.txt`. A fonte é lida novamente em toda varredura, então a alteração vale na execução seguinte. Vazio nas duas desativa a busca. Não existe campo para editar a palavra-chave no site ou em D1.

## Implantação sem computador ligado

Siga **[docs/CLOUD_DEPLOYMENT.md](docs/CLOUD_DEPLOYMENT.md)**. O guia cobre GitHub público, Cloudflare Pages Git Integration, D1 (R2 opcional), senha do site (ou Cloudflare Access), secrets do GitHub, migrations, cron e teste em modo metadata.

Resumo dos workflows:

- `CI`: valida sintaxe, bundle Pages Functions e testes em push/PR.
- `Ero-Scrap automation`: agenda a cada dez minutos em dois jobs independentes (`scan` e `storage`), então um download longo não atrasa a varredura. Com a trava fechada, coleta metadados e consulta D1 para saber se há exclusões vencidas; só instala/autentica o MEGAcmd quando há algo a excluir e as credenciais estão configuradas. Com a trava deliberadamente aberta, revalida, consulta a fila no D1 e só instala MEGAcmd/FFmpeg quando existe vídeo ou exclusão vencida; processa no máximo um vídeo por runner efêmero.
- `Apply Cloudflare D1 migrations`: aplicação manual de migrations em produção.

## Desenvolvimento e testes

Requisito: Node.js `26.13.0` (arquivo `.node-version`).

```bash
npm ci
npm run check
npm run check:pages
npm test
```

Para desenvolvimento local, consulte [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Arquivos `.env`, `.dev.vars`, credenciais e `node_modules` não devem ser commitados.

## Segurança e limites operacionais

- Acesso ao catálogo: senha do site com cookie assinado e limite de tentativas (padrão, `AUTH_MODE="password"`) ou Cloudflare Access (`AUTH_MODE="access"`). `/internal/*` exige sempre o Bearer token do executor.
- A API interna exige também Bearer token próprio e só aceita comandos allowlisted; o runner nunca recebe token administrativo Cloudflare nem SQL.
- Miniaturas privadas (D1 ou bucket R2 privado); URL MEGA não aparece no JSON público do catálogo.
- 401/403, redirects e hosts fora da allowlist interrompem o downloader sem fallback de acesso; 429 é reagendado.
- GitHub Actions schedule é best-effort, não um relógio de tempo real. Jobs podem atrasar ou ser coalescidos quando houver execução sobreposta.
- O cron a cada dez minutos executa cerca de 4.320 jobs/mês. A verificação de retenção é feita dentro do mesmo job, sem um cron extra. Em repositório **público** os minutos de Actions são gratuitos e ilimitados; em um privado, a franquia gratuita de 2.000 min/mês não comporta esse ritmo. O workflow `keepalive` reativa os agendamentos semanalmente para o GitHub não desligá-los após 60 dias sem atividade.

## Documentação

- [Implantação 100% em nuvem](docs/CLOUD_DEPLOYMENT.md)
- [Arquitetura](docs/ARCHITECTURE.md)
- [Contrato de dados](docs/DATA_CONTRACT.md)
- [Adaptador Erome](docs/EROME_ADAPTER.md)
- [Integração MEGA](docs/MEGA_SETUP.md)
- [Segurança](docs/SECURITY.md)
- [Retenção](docs/RETENTION.md)
- [Desenvolvimento](docs/DEVELOPMENT.md)
- [Especificação do projeto](docs/PROJECT_SPEC.md)
