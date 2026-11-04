# Implantação 100% em nuvem — GitHub Actions + Cloudflare Pages

Este é o procedimento recomendado para manter o Ero-Scrap funcionando sem um computador ou servidor seu ligado. O GitHub Actions fornece runners Linux temporários; o Cloudflare Pages hospeda a interface e as Pages Functions; D1 guarda metadados e, por padrão, as miniaturas (R2 é uma opção); MEGA guarda os arquivos de vídeo autorizados.

> **Atenção:** `COPY_AUTHORIZED` permanece `false` no código entregue. Nesse estado, o workflow agenda e executa apenas a varredura de metadados. Para habilitar transferência, é necessário que o operador tenha autorização válida para copiar o material e altere deliberadamente a constante central. Não contorne login, CAPTCHA, 401/403, 429, DRM, controles de acesso ou limitações do Erome. O coletor interrompe a operação quando a fonte recusa o acesso.

## 1. Como a execução fica distribuída

| Serviço | Responsabilidade |
|---|---|
| GitHub **público** | Repositório, configuração, CI e workflows (minutos de Actions ilimitados e gratuitos) |
| GitHub Actions | Runners Linux efêmeros: um job de varredura e um job de armazenamento por ciclo |
| Cloudflare Pages | HTML, CSS e JavaScript estáticos |
| Cloudflare Pages Functions | API same-origin e autenticação |
| Cloudflare D1 | Publicações, vídeos, estados, jobs e retenção |
| Cloudflare D1 (padrão) ou R2 (opcional) | Miniaturas WebP pequenas, privadas. D1 não exige cartão de crédito; R2 pode exigir |
| MEGA | Arquivos de vídeo temporários |

O runner não permanece ligado. Cada execução inicia uma VM do GitHub Actions, instala o que for necessário, executa a tarefa e termina. Os arquivos temporários são removidos no final e a VM é descartada.

O site não baixa nem reproduz vídeos no navegador. A página recebe metadados paginados e miniaturas pequenas; o botão de abertura passa pela API, registra o primeiro clique e redireciona para o MEGA.

## 2. Preparar o repositório GitHub

1. No GitHub, crie um repositório **público** chamado `ero-scrap`. Público é o que mantém o projeto 100% gratuito (veja a seção 14). Os segredos nunca ficam no repositório, mas leia a seção 16 sobre o que fica visível.
2. Use a branch padrão `main`.
3. Envie o conteúdo deste projeto para a raiz do repositório. O arquivo `package.json`, a pasta `functions/`, a pasta `apps/`, `database/` e `wrangler.jsonc` precisam ficar diretamente na raiz, não dentro de uma segunda pasta `ero-scrap/`.
4. Não envie `.env`, `.dev.vars`, `node_modules`, tokens, senhas, cookies ou arquivos de mídia.

### Envio sem instalar ferramentas no computador

É possível fazer o preparo pelo navegador:

- Baixe o ZIP de release e crie o repositório vazio no GitHub.
- Abra um Codespace do repositório (Code → Codespaces → Create codespace on main).
- No Explorer do Codespaces, carregue o ZIP para a raiz do Codespace.
- Abra o terminal integrado do Codespaces e execute:

```bash
unzip -q ero-scrap-cloud-runner-v0.4.5.zip -d /tmp/ero-scrap-release
cp -a /tmp/ero-scrap-release/. .
rm -rf /tmp/ero-scrap-release
git status --short
```

- Confirme que `package.json`, `functions/`, `apps/`, `database/`, `packages/` e `wrangler.jsonc` aparecem na raiz.
- Faça commit e push para `main`. O workflow `CI` executará os testes no GitHub Actions usando a versão Node fixada em `.node-version`; não é necessário instalar Node ou ferramentas no seu computador.
- Aguarde o CI terminar. Se falhar, abra o log do workflow antes de prosseguir para o deploy.
- Pare e exclua o Codespace depois do envio. Ele é apenas uma ferramenta temporária de preparação no navegador; não será o host do monitoramento.

O GitHub permite enviar no navegador até 100 arquivos por operação e limita cada arquivo enviado pelo navegador a 25 MiB; o ZIP evita ter que enviar centenas de arquivos separadamente. Confira os limites atuais antes de criar um Codespace se sua conta tiver franquia reduzida.

## 3. Preparar o Cloudflare D1 (e, opcionalmente, R2)

No painel Cloudflare:

1. Abra **Workers & Pages → D1 SQL Database → Create**.
2. Crie o banco com o nome exato `ero-scrap-db`.
3. Copie o `database_id` exibido.

### Onde ficam as miniaturas: D1 ou R2

A variável `THUMBNAIL_STORE` em `wrangler.jsonc` escolhe o armazenamento das miniaturas. Só um fica ativo por vez.

| Valor | O que é | Exige |
|---|---|---|
| `"d1"` (padrão) | Miniaturas WebP (poucos KB cada) dentro do próprio banco D1, apagadas junto com o item | Nada além do D1. Sem cartão de crédito |
| `"r2"` | Miniaturas em um bucket R2 privado | Conta R2 ativada (a Cloudflare pode pedir cartão), bucket e binding |

Para usar **R2** em vez de D1:

1. Em **R2 Object Storage → Create bucket**, crie `ero-scrap-thumbnails`. Mantenha privado; não habilite `r2.dev`.
2. No `wrangler.jsonc`, troque `"THUMBNAIL_STORE": "d1"` por `"THUMBNAIL_STORE": "r2"` e remova o `//` da linha `{ "binding": "THUMBNAILS", ... }`.
3. Faça commit em `main`. O Pages publica de novo.

Para voltar ao D1, desfaça as duas alterações. Trocar de um para o outro **não migra** as miniaturas já existentes: os itens antigos ficam sem prévia ("Prévia indisponível") até expirarem (no máximo cerca de 8 dias), e os novos já usam o armazenamento escolhido. As migrations criam a tabela `thumbnails` do D1 mesmo se você usar R2; ela só fica vazia.

No GitHub, abra `wrangler.jsonc` e substitua:

```jsonc
"database_id": "REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID"
```

pelo ID real do D1. Não altere `database_name`, `binding`, `bucket_name` ou `migrations_dir` sem atualizar os códigos dependentes. Faça commit para `main`.

O `wrangler.jsonc` da raiz é a fonte de configuração do projeto Pages: ele declara `pages_build_output_dir`, o binding D1, a variável `THUMBNAIL_STORE` e (se você escolher R2) o binding R2. As Pages Functions são compiladas com `wrangler pages functions build`, e os bindings podem ser declarados pelo arquivo Wrangler ou pelo painel; mantenha as duas configurações consistentes.

## 4. Criar o projeto Cloudflare Pages com Git Integration

1. No Cloudflare, abra **Workers & Pages → Create application → Pages → Connect to Git**.
2. Conecte sua conta GitHub e autorize o acesso somente ao repositório `ero-scrap`.
3. Selecione o repositório `ero-scrap` e a branch de produção `main`.
4. Configure:
   - Framework preset: `None`.
   - Root directory: `/` (raiz do repositório).
   - Build command: `npm ci --ignore-scripts --no-audit --no-fund && npm run check:pages`.
   - Build output directory: `apps/web/public`.
   - Environment variable de build `NODE_VERSION`: `26.13.0`.
5. Salve e faça o primeiro deploy.

O Cloudflare Pages usa a pasta `/functions` na raiz para descobrir rotas de Pages Functions. Não mova essa pasta para `apps/web/public`. O arquivo `apps/web/public/_routes.json` limita invocações de Functions a `/api/*`, `/internal/*` e `/health`, de modo que arquivos estáticos como CSS, JavaScript e HTML sejam servidos diretamente pelo CDN.

Após o primeiro deploy, anote a origem exata, por exemplo `https://ero-scrap.pages.dev`. Se o nome real do projeto gerar outro hostname, use o hostname real em todos os passos seguintes.

## 5. Configurar a origem no Wrangler

Abra `wrangler.jsonc` no GitHub e altere:

```jsonc
"WEB_ORIGIN": "https://ero-scrap.pages.dev"
```

para a URL real do Pages, sem barra final. Faça commit e aguarde o próximo deploy.

## 6. Proteger o site: senha (padrão) ou Cloudflare Access

A variável `AUTH_MODE` em `wrangler.jsonc` escolhe como o site fica privado. Só um modo fica ativo por vez; um valor desconhecido deixa o site **fechado** (erro 503), nunca aberto.

| Modo | O que é | Exige |
|---|---|---|
| `"password"` (padrão) | Uma senha só sua (secret `SITE_PASSWORD`). A página mostra um campo de login e guarda um cookie assinado por 30 dias | Nada além do Pages. Sem Zero Trust, sem cartão |
| `"access"` | Cloudflare Zero Trust Access: login por código enviado ao seu e-mail, com a página inteira protegida na borda | Conta Zero Trust (a Cloudflare pode pedir forma de pagamento) |

### Modo `password` (padrão)

1. Crie uma senha longa e exclusiva, de pelo menos 12 caracteres (frase com várias palavras serve). Ela é o único segredo que protege o catálogo.
2. No Pages → Settings → Variables and Secrets → Production, crie o secret `SITE_PASSWORD` com essa senha.
3. Ao abrir o site, a página mostra o campo **Entrar**. O botão **Sair** aparece no topo.

Como funciona e quais são os limites:

- O servidor compara a senha sem vazar o tempo de resposta e guarda apenas um cookie assinado (`HttpOnly`, `Secure`, `SameSite=Strict`), nunca a senha. Trocar `SITE_PASSWORD` desconecta todos os navegadores.
- 5 senhas erradas seguidas do mesmo IP bloqueiam esse IP por 15 minutos, e 30 falhas somadas bloqueiam todo mundo pelo mesmo período. O contador é uma linha pequena no D1, gravada só em falhas.
- A **estrutura** da página (HTML, CSS e JavaScript) fica pública, mas ela não contém dados. Catálogo, miniaturas e abertura de vídeos exigem o cookie.
- Não há recuperação de senha: se esquecer, defina outra no secret.
- É uma senha única. Use o Access se precisar de várias pessoas, e-mails individuais ou autenticação em dois fatores.

### Modo `access` (Cloudflare Zero Trust)

No `wrangler.jsonc`, troque `"AUTH_MODE": "password"` por `"AUTH_MODE": "access"`. Configure duas aplicações Self-hosted no Cloudflare Zero Trust → Access → Applications:

#### Aplicação humana

- Hostname: seu hostname Pages, por exemplo `ero-scrap.pages.dev`.
- Path: `/*`.
- Policy: `Allow` somente para seu endereço de e-mail.
- Não crie uma regra pública/Everyone.

#### Aplicação interna do runner (opcional)

- Mesmo hostname Pages.
- Path: `/internal/*`.
- Crie um **Service Token** no Access.
- Policy: `Service Auth` permitindo somente esse Service Token.

Essa segunda aplicação é uma camada extra: o Worker sempre exige o Bearer token `RUNNER_API_TOKEN` em `/internal/*`, com qualquer modo. Se você a criar, cadastre também os secrets `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET` no GitHub; sem a aplicação interna, deixe-os vazios.

Na página da aplicação humana, copie:

- Team domain: `https://<team>.cloudflareaccess.com`.
- Audience (AUD) da política.

## 7. Configurar secrets e variables no Cloudflare Pages

No projeto Pages → Settings → Variables and Secrets → Production, adicione os seguintes **secrets**:

| Nome | Valor |
|---|---|
| `RUNNER_API_TOKEN` | Segredo aleatório com no mínimo 64 caracteres hexadecimais |
| `SITE_PASSWORD` | Modo `password`: a senha do site (mínimo 12 caracteres) |
| `TEAM_DOMAIN` | Só modo `access`: team domain do Cloudflare Access |
| `POLICY_AUD` | Só modo `access`: Audience da aplicação humana |
| `ALLOWED_EMAILS` | Só modo `access`: seu e-mail exato; para vários, separar por vírgula |

`RUNNER_API_TOKEN` deve ser criado em um gerenciador de senhas ou gerador criptograficamente seguro. Não use a senha MEGA nem uma senha reutilizada. Use o mesmo valor no secret `COLLECTOR_API_TOKEN` do GitHub.

Faça um novo deploy Pages depois de adicionar bindings/secrets, para garantir que o runtime receba todas as configurações.

## 8. Configurar secrets e variables no GitHub

No repositório → Settings → Secrets and variables → Actions.

### Variables

| Nome | Valor |
|---|---|
| `COLLECTOR_API_URL` | `https://ero-scrap.pages.dev/internal/collector` (ajuste o hostname) |
| `MEGA_REMOTE_ROOT` | `/Ero-Scrap` (opcional) |

### Secrets necessários para a varredura

| Nome | Valor |
|---|---|
| `COLLECTOR_API_TOKEN` | Exatamente o mesmo valor de `RUNNER_API_TOKEN` no Pages |
| `CF_ACCESS_CLIENT_ID` | ID do Service Token `/internal/*` |
| `CF_ACCESS_CLIENT_SECRET` | Secret do Service Token `/internal/*` |
| `SEARCH_KEYWORD` | Sua palavra-chave (uma linha, até 80 caracteres). **Recomendado em repositório público**: substitui `config/search-keyword.txt`, que fica vazio e visível a todos |

### Secrets para MEGA

Configure quando estiver pronto para testar a autenticação MEGA:

| Nome | Valor |
|---|---|
| `MEGA_EMAIL` | E-mail da conta MEGA |
| `MEGA_PASSWORD` | Senha da conta MEGA |
| `MEGA_TOTP_SECRET` | Seed Base32 do autenticador TOTP, somente se sua conta usar TOTP |

`MEGA_TOTP_SECRET` não é o código de seis dígitos que muda a cada 30 segundos; é a chave-semente Base32 exibida quando o TOTP foi configurado. Se não tiver essa seed, deixe o secret ausente e use um método de autenticação MEGA suportado pelo seu processo de conta antes de ativar a etapa `full`. Nunca grave esses valores em arquivos do repositório.

### Secrets para migrations D1

| Nome | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token API Cloudflare limitado à conta e com permissão D1 Edit |
| `CLOUDFLARE_ACCOUNT_ID` | ID da sua conta Cloudflare |

Crie o token na área de API Tokens do Cloudflare. Não use Global API Key. Limite o escopo à conta correta e à permissão mínima necessária para D1.

## 9. Executar as migrations D1

No GitHub → Actions → **Apply Cloudflare D1 migrations** → Run workflow.

A execução usa o `wrangler.jsonc` da raiz e aplica as migrations pendentes no banco `ero-scrap-db`. Confirme no log que todas as migrations terminaram sem erro. Não execute a automação de coleta antes desta etapa.

## 10. Configurar a palavra-chave

Há duas fontes, nesta ordem:

1. **Secret `SEARCH_KEYWORD` do GitHub** (recomendado com repositório público). O valor é mascarado nos logs e ninguém vê o que você monitora. Para trocar a palavra, edite o secret; a próxima execução já usa o novo valor.
2. **Arquivo `config/search-keyword.txt`**, usado quando o secret não existe ou está vazio. Num repositório público, qualquer pessoa lê esse arquivo.

Regras valem para as duas fontes:

- exatamente uma palavra ou frase em uma única linha; linhas adicionais são rejeitadas;
- título **OU** qualquer tag;
- não diferencia maiúsculas/minúsculas ou acentos;
- até 80 caracteres;
- vazio nas duas fontes desativa a varredura.

Não existe campo de edição na interface nem valor em D1.

## 11. Ativar o agendamento do GitHub Actions

O arquivo `.github/workflows/automation.yml` agenda execuções nos minutos `7, 17, 27, 37, 47, 57` de cada hora (UTC), isto é, a cada dez minutos. Cada execução tem **dois jobs independentes**:

- **scan** (cerca de 1 minuto): lê as duas primeiras páginas de "New", grava metadados e, uma vez por dia (03:00–03:59 UTC), faz a limpeza de metadados antigos. Não instala dependências nem usa MEGA.
- **storage**: consulta (somente leitura) se há vídeo elegível ou exclusão vencida. Só quando existe trabalho ele instala FFmpeg e MEGAcmd, entra no MEGA, processa **no máximo um vídeo** e aplica a retenção. Se não há nada a fazer, termina em segundos.

Como os dois jobs têm filas de concorrência separadas, um download demorado no job `storage` **não atrasa** a próxima varredura. O workflow `keepalive.yml` roda uma vez por semana e reativa os workflows agendados, para o GitHub não desligá-los após 60 dias sem atividade no repositório público.

No GitHub:

1. Abra Settings → Actions → General.
2. Confirme que Actions está habilitado para o repositório.
3. Em Actions → Ero-Scrap automation, clique em **Run workflow**.
4. Comece com o modo `metadata`.
5. Confira os logs e o endpoint `/health`.
6. Depois de cadastrar MEGA secrets, use `mega-check` para validar login/`mega-whoami` sem upload, link ou exclusão.

Com `COPY_AUTHORIZED = false`, o modo `auto` executa somente coleta de metadados e consulta se há exclusões vencidas. Não faz download de vídeo, não cria miniaturas e não envia arquivos ao MEGA. Se houver um item vencido e credenciais MEGA estiverem configuradas, executa apenas a limpeza; sem credenciais, informa que a retenção está pendente e não tenta autenticar.

### Modos manuais

| Modo | O que faz | Trava necessária |
|---|---|---|
| `auto` | Com a trava falsa, só metadados; com a verdadeira, processamento e retenção | Automático |
| `metadata` | Varre páginas 1 e 2, atualiza metadados e executa exclusões vencidas | Não |
| `full` | Varre, processa no máximo um vídeo, aplica retenção e manutenção | `COPY_AUTHORIZED = true` |
| `cleanup` | Só exclusões vencidas (sem varredura), se houver credenciais MEGA | Não libera cópia |
| `mega-check` | Autentica e verifica `mega-whoami`, sem modificar arquivos | Não libera cópia |

Os modos `full` e `mega-check` exigem credenciais MEGA; `mega-check` não altera arquivos. O modo `full` falha antes de iniciar caso a constante esteja `false`. O modo `cleanup` pode apagar arquivos já armazenados mesmo que a trava de cópia esteja fechada. O modo `metadata` também verifica se há exclusões vencidas e só autentica no MEGA quando precisa executá-las.

## 12. Habilitar transferência autorizada

Não faça isso antes de obter permissão para copiar o material. Quando e somente quando a autorização aplicável estiver confirmada, o responsável pode alterar deliberadamente:

`packages/config/src/security.js`

```js
export const COPY_AUTHORIZED = true;
```

Faça commit na branch `main`. O Cloudflare Pages republica a API e os workflows seguintes passam a usar a mesma revisão do código. Configure e teste a conta MEGA com arquivo cujo uso/cópia estejam autorizados. A primeira execução pode ser manual com `mode=full`.

A automação revalida o título/tag, o ID individual, a duração da página e a duração real via FFprobe. Somente então transfere para MEGA. Respostas 401/403, redirecionamentos, URLs fora do domínio permitido e limites 429 não são contornados. 429 é reagendado; bloqueios definitivos permanecem como erro.

## 13. Verificação de produção

- `https://<seu-projeto>.pages.dev/health` retorna status de saúde (se não for bloqueado pela policy humana na borda).
- Abra o site e entre (senha ou e-mail permitido, conforme o modo).
- `/api/status` deve mostrar `copyAuthorized: false` antes da autorização; a faixa "Bloqueado/Liberado" da página segue esse valor.
- `/api/catalog` não deve devolver `share_url` nem `storage_object_id`.
- `/internal/collector` sem o Bearer token deve responder 401 (e, com a camada Access opcional, sem o Service Token também).
- Sem login, `/api/status` e `/api/catalog` respondem 401 `authentication_required`; `/api/status` logado mostra `authMode`.
- `/api/status` mostra `thumbnailStore` com o armazenamento ativo (`d1` ou `r2`). Se usar R2, o bucket deve continuar privado.
- A palavra-chave está no secret `SEARCH_KEYWORD` (ou, sem secret, em `config/search-keyword.txt`).
- Os workflows de CI precisam passar antes de qualquer mudança de produção.

## 14. Custos e limites importantes

### GitHub Actions: por que o repositório é público

Dez minutos entre varreduras são cerca de 4.320 execuções por mês. Num repositório **privado** da conta Free, a franquia é de 2.000 minutos/mês de Linux, e como cada job é cobrado em minutos inteiros, a varredura sozinha (1 minuto × 4.320) já passaria do limite. Em repositório **público**, runners padrão do GitHub são gratuitos e sem limite de minutos, então o projeto fica em R$ 0 sem cortar a frequência. Consulte os termos atuais do GitHub antes de ativar, pois franquias e preços podem mudar.

O tempo por execução foi reduzido: o runner usa apenas módulos nativos do Node (sem `npm ci`, sem cache), a varredura e o armazenamento rodam em jobs separados e FFmpeg/MEGAcmd só são instalados quando há trabalho real. O job `storage` tem timeout de 45 minutos; cada comando MEGAcmd pode durar até 15 minutos.

### Cloudflare (plano gratuito)

| Recurso | Limite gratuito | Uso esperado |
|---|---|---|
| Pages Functions (Workers) | 100.000 requisições/dia | Cada ciclo faz algumas dezenas de chamadas internas; só álbuns ainda não inspecionados geram chamadas extras. A ordem de grandeza fica em poucos milhares por dia |
| D1 | 100.000 linhas escritas/dia; 5 milhões lidas/dia | Apenas álbuns novos geram escrita; a limpeza roda uma vez por dia |
| D1 (miniaturas, padrão) | 5 GB no total; 100.000 linhas escritas/dia | Uma linha de poucos KB por vídeo, apagada com o item: bem abaixo dos limites |
| R2 (opcional) | 10 GB, operações mensais incluídas | Miniaturas WebP pequenas |
| Pages (builds) | 500 builds/mês | Um build por commit; evite commits frequentes em `main` |

Os valores acima vêm da documentação pública da Cloudflare no momento desta revisão; confira os limites atuais no painel.

### Agendamento

O GitHub schedule é best-effort: pode atrasar ou perder execuções em períodos de carga, e só roda a partir da branch padrão. A concorrência impede dois jobs do mesmo tipo de trabalharem simultaneamente; execuções sobrepostas podem esperar/coalescer. Portanto, “a cada dez minutos” é a cadência configurada, não uma garantia em tempo real.

### MEGA e dados

- O login MEGA ocorre em cada runner efêmero quando há processamento, teste de conexão ou exclusão vencida; a sessão não persiste entre execuções. O modo `mega-check` valida a sessão sem alterar arquivos.
- Teste a autenticação com a conta escolhida antes de ativar a cópia. O MEGA pode aplicar verificações de segurança/rate limits próprios.
- O runner Linux tem disco temporário limitado. O download máximo configurado é 4 GiB; isso não significa que todo vídeo desse tamanho será aceito pelo espaço livre em cada VM. Verifique o limite e reduza `APP_CONFIG.media.maxFileBytes` se necessário.
- Links MEGA são bearer links: qualquer pessoa que obtenha a URL e a chave pode acessar o conteúdo enquanto estiver disponível. Não compartilhe logs, links ou screenshots que os revelem.
- Cloudflare Pages e o navegador não armazenam os vídeos.

## 15. Atualizar o projeto

1. Altere o código/configuração em branch de trabalho ou Codespaces.
2. Aguarde CI (sintaxe, bundle Pages Functions e testes).
3. Faça merge/commit em `main`.
4. Cloudflare Pages publica automaticamente.
5. O próximo GitHub Actions executa o código novo.
6. Se houver migration nova, rode primeiro **Apply Cloudflare D1 migrations** em Actions.

Nunca edite a cópia de `COPY_AUTHORIZED` em `.env`, secret ou Pages variable: ela existe somente como constante de código no repositório.

## 16. Repositório público: o que fica visível

- **Visível a todos:** código, `COPY_AUTHORIZED`, workflows, `config/search-keyword.txt` e os **logs** das execuções. Os logs do runner imprimem apenas contagens, códigos de erro e identificadores internos aleatórios; nunca títulos, palavra-chave, URLs de vídeo ou links MEGA.
- **Nunca no repositório:** tokens, senhas MEGA, `SITE_PASSWORD`, o Service Token do Access (se usar) e `SEARCH_KEYWORD`. Eles vivem em Secrets do GitHub/Cloudflare e são mascarados nos logs.
- **Mantenha `config/search-keyword.txt` vazio** e use o secret `SEARCH_KEYWORD`.
- Em Settings → Actions → General → *Fork pull request workflows*, deixe a aprovação obrigatória para colaboradores externos. Os workflows de CI não usam nenhum secret.
- O catálogo continua privado: a API exige a senha do site (ou o Cloudflare Access); o código público não dá acesso aos dados.
- Se você não quiser expor nem o código, a alternativa é repositório privado, mas então os 2.000 minutos mensais não bastam para varrer a cada dez minutos.
