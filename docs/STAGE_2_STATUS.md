# Estado da Etapa 2

> Registro histórico da entrega ao final da Etapa 2. A Etapa 3 foi implementada depois; consulte `STAGE_3_STATUS.md` para o estado atual de catálogo, retenção e integração MEGA.

**Status:** núcleo de descoberta, inspeção e classificação de metadados implementado localmente. A etapa não está integralmente concluída em relação ao escopo original de processamento/armazenamento de mídia: download, geração de miniaturas a partir de arquivos e integração MEGA foram deliberadamente deixados de fora enquanto a autorização para cópia não estiver confirmada. Nenhum deploy foi realizado.

## Entregue no código

- [x] Palavra-chave única exclusivamente em `config/search-keyword.txt`, relida a cada execução.
- [x] Arquivo vazio desativa a varredura antes de qualquer chamada HTTP ou gravação.
- [x] Correspondência por substring normalizada no título **OU** em qualquer tag.
- [x] Consulta fixa exclusivamente a New páginas 1 e 2.
- [x] Página sem `#albums` é considerada alteração/erro de estrutura; `#albums` vazio é uma página válida sem posts.
- [x] Limite por página, limite de inspeções por execução e deduplicação de posts.
- [x] HTTP GET somente, timeout, limite de resposta e intervalo mínimo entre requisições.
- [x] Redirects inesperados e respostas 401/403/429 encerram a tentativa; não há tentativas de contornar controles.
- [x] Parser isolado por card; um card incompleto não desloca títulos/URLs de cards seguintes.
- [x] Um post pode conter vários vídeos; cada vídeo vira um asset independente.
- [x] Posts somente com imagens geram zero assets; em posts mistos, imagens não são persistidas.
- [x] Múltiplas fontes/qualidades dentro do mesmo elemento `<video>` são tratadas como um único vídeo lógico.
- [x] Duração por atributos explícitos, campos reconhecidos em `data-setup` ou rótulos `.duration` somente quando sua cardinalidade corresponde exatamente à lista de vídeos.
- [x] Duração de até 600.000 ms, inclusive; maior é `too_long`; ausência/ambiguidade é `duration_unknown` e nunca aprovada.
- [x] IDs estáveis por vídeo; título não é usado como chave de deduplicação.
- [x] D1 acessado pelo Worker via comandos allowlisted e SQL parametrizado; runner não possui token administrativo Cloudflare/D1.
- [x] API interna exige token próprio, limita tamanho do corpo e valida todos os comandos/payloads.
- [x] Runner Node.js possui execução única e scheduler de 10 minutos sem sobreposição.
- [x] Palavra-chave pode ser alterada no mesmo arquivo sem reiniciar o processo; os posts já inspecionados que continuam nas duas páginas são reavaliados com o termo novo.
- [x] Trava de cópia `COPY_AUTHORIZED = false` no domínio e também no Worker: o Worker rejeita status `eligible` enquanto a trava estiver fechada.

## Não implementado nesta entrega

- [ ] Download de arquivos de vídeo.
- [ ] Upload/armazenamento no MEGA.
- [ ] Extração/geração de miniaturas de arquivos de mídia.
- [ ] Jobs de transferência ou exclusão remota.
- [ ] Integração com R2.

Esses itens foram mantidos fora da entrega enquanto a autorização para copiar não estiver confirmada. O executor atual não faz requisições aos bytes dos vídeos, não usa Range e não persiste URLs de mídia.

## Limitações da origem

- Os seletores observados (`#albums`, `.album`, `.album-link`, `.album-title`, `<video><source>`, `.duration`) podem mudar e não são uma API oficial.
- A existência de `.duration` é observada em scripts comunitários, não garantida pelo Erome. O parser usa rótulos `.duration` apenas se houver exatamente um rótulo válido por vídeo, na ordem documental. A correspondência precisa ser validada com HTML público atual antes de operação contínua.
- Se a duração não estiver visível como metadado explícito ou a associação for ambígua, o vídeo é rejeitado como `duration_unknown`. O sistema não baixa o arquivo para descobrir a duração.
- A fonte pode exibir mais publicações nas duas páginas do que o limite técnico configurado; nesse caso o parser falha de forma explícita em vez de omitir silenciosamente cards excedentes.
- Só os posts ainda presentes nas duas páginas na execução atual são inspecionados. Não há crawl de páginas antigas.
- Não foi executada coleta real do Erome nesta sessão; os testes de parser usam fixtures sintéticas.

## Validação realizada nesta sessão

- `npm run check`: sintaxe verificada em 46 arquivos JavaScript.
- `node --test`: 77 testes passaram, 0 falharam.
- **Ressalva de dependência:** o registry npm não estava acessível. Para executar os testes de rotas que importam `jose`, foi criado temporariamente um stub local que sempre rejeita verificação criptográfica; o stub foi removido antes do empacotamento. Portanto, os testes validam os caminhos de autenticação fail-closed e os contratos de API, mas **não comprovam a validação real de assinatura/JWKS de JWT**.
- As migrations `0001` e `0002` foram executadas em SQLite local; também foi verificada a restrição que impede `stored` sem `uploaded_at` e `expires_at`.
- O runtime disponível nesta sessão foi Node.js 22.16.0, abaixo do requisito do projeto (`>=24`, Node 26 recomendado). A suíte foi executada nele; a execução em Node 26 permanece pendente.

## Validação pendente no ambiente do usuário

- [ ] `npm ci` com acesso ao registry npm para instalar `jose@6.2.14` e demais ferramentas.
- [ ] `npm test` em Node.js 26, sem stub.
- [ ] Verificação criptográfica JWT real com Cloudflare Access/JWKS.
- [ ] `npm run check:worker` via Wrangler.
- [ ] Aplicação das migrations pelo Wrangler D1 local.
- [ ] Execução read-only em ambiente local usando HTML público atual (sem download de mídia).
- [ ] Confirmar no HTML real como duração `.duration` se associa a cada vídeo.
- [ ] Deploy do Worker e configuração de Access Service Token.
- [ ] Runner hospedado em um host sempre ligado.

## Próxima fronteira (histórico)

No encerramento da Etapa 2, os próximos itens eram o catálogo, o controle do primeiro clique, a expiração e a integração MEGA. Esses componentes foram implementados em código na Etapa 3 e estão documentados em `STAGE_3_STATUS.md`. A cópia segue bloqueada por `COPY_AUTHORIZED = false`; não alterar essa trava apenas para fazer testes.
