# Estado da Etapa 1

**Status:** implementação local preparada; deploy e validação no Cloudflare ainda não executados.

## Entregue no repositório

- [x] Monorepositório modular com frontend, API, domínio, configuração e migrations.
- [x] Frontend estático sem framework, com layout responsivo, tema claro/escuro e estados de UI.
- [x] API Worker somente leitura, com paginação por cursor e erros padronizados.
- [x] Autenticação Cloudflare Access com validação de JWT/JWKS e allowlist.
- [x] Bypass local explícito, condicionado a `APP_ENV=development`.
- [x] Trava de cópia `COPY_AUTHORIZED = false`.
- [x] Contratos e funções puras para normalização, palavras-chave, duração, classificação de mídia e retenção.
- [x] Schema D1 com posts, tags, vídeos individuais, varreduras, jobs, deduplicação, regras e auditoria.
- [x] 26 testes unitários e de rotas executados com sucesso nesta sessão.
- [x] CI para sintaxe, Worker dry-run e testes.
- [x] Documentação de arquitetura, segurança, dados, retenção, deploy e desenvolvimento assistido por IA.

## Ainda não executado

- [ ] Instalação real do pacote `jose` via npm neste ambiente.
- [ ] Build/dry-run do Worker via Wrangler.
- [ ] Execução da migration pelo Wrangler D1 local.
- [ ] Criação de recursos na conta Cloudflare.
- [ ] Criação do repositório remoto GitHub.
- [ ] Deploy do Pages ou Worker.

O ambiente de geração não conseguiu concluir acesso ao registry npm. Para testar os caminhos de rota localmente, foi usado temporariamente um stub isolado da dependência `jose`; portanto, os testes de API não comprovam a validação criptográfica real de JWT. O stub não faz parte do pacote entregue. A validação de assinatura JWT real depende de `npm ci` instalar `jose@6.2.14` e deve ser confirmada no CI/ambiente local com rede. Os testes de domínio, cursor e repositório com mock não dependem desse stub.

O ambiente disponível para a geração usa Node.js 22.16.0, abaixo do requisito declarado pelo projeto (Node.js 24+). A verificação sintática e os testes que não dependem de APIs exclusivas do Node 24+ foram executados nele; a CI está configurada para Node.js 26 LTS. O teste `wrangler deploy --dry-run` também depende da instalação do Wrangler pelo npm e ficou pendente por indisponibilidade do registry.

## Próximos passos para o usuário

1. Instalar Node.js 26 LTS (Node 24+ também é aceito).
2. Extrair o projeto e executar `npm ci`.
3. Copiar `apps/api/.dev.vars.example` para `apps/api/.dev.vars`.
4. Executar `npm run db:local:apply`.
5. Iniciar API e site em dois terminais.

Não habilitar cópia nem adicionar credenciais reais enquanto a autorização não tiver sido obtida.
