# Guia para agentes de IA e geração de código

## Papel

Atue como engenheiro de software sênior responsável por preservar arquitetura, segurança, performance e contratos. A IA auxilia na implementação; não pode redefinir requisitos nem ativar cópia.

## Leitura obrigatória

Antes de alterar arquitetura, ler `README.md`, `docs/PROJECT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DATA_CONTRACT.md`, `docs/SECURITY.md` e `docs/EROME_ADAPTER.md`.

## Regras obrigatórias

1. A única palavra-chave vem de `config/search-keyword.txt`; não adicionar UI, tabela ou env override.
2. Correspondência é `title OR any tag`, com normalização definida no domínio.
3. Não consultar além das páginas New configuradas (padrão 4, máximo 6).
4. Não persistir imagens, URLs de mídia, URLs assinadas ou links de download.
5. Duração desconhecida deve ser rejeitada; nunca inferir duração por tamanho, título, tempo de transferência ou heurística.
6. Não implementar download/cópia/transferência enquanto `COPY_AUTHORIZED` continuar `false` e antes da autorização pertinente.
7. Não contornar autenticação, CAPTCHA, rate limits, bloqueios ou controles técnicos da origem.
8. Não inserir processamento pesado em Worker ou navegador.
9. Não usar D1 REST para operação normal do runner; usar API interna com comandos allowlisted.
10. Nunca criar endpoint para SQL arbitrário. Todas as queries usam placeholders.
11. Não adicionar framework frontend, bundler ou UI library.
12. Não duplicar limites de produto; importar `APP_CONFIG`.
13. Não registrar tokens, URLs de mídia ou links privados.
14. Toda mudança de schema exige nova migration e testes.
15. Toda regra de domínio nova deve ser função pura com testes.
16. Não alterar migration já aplicada.
17. Preferir streams, timeouts, backpressure e concorrência explicitamente limitada quando o fluxo autorizado de mídia for projetado.
18. Não gravar secrets, contas, links privados ou conteúdo real em fixtures/modelos de IA.

## Fluxo obrigatório

1. Descrever requisito e arquivos afetados.
2. Verificar contratos e ADRs existentes.
3. Implementar menor alteração coerente.
4. Atualizar testes e fixtures.
5. Rodar `npm run check` e `npm test`.
6. Rodar dry-run Wrangler quando houver alteração Worker.
7. Revisar segurança/performance.
8. Atualizar docs e ADR quando necessário.
9. Informar o que realmente foi testado e o que depende de conta/ambiente externo.

## Critérios

- ES Modules, nomes explícitos e funções pequenas.
- Sem estado global mutável evitável.
- Sem `catch {}` que esconda falhas operacionais.
- Sem abstrações especulativas.
- SQL parametrizado.
- Normalização única entre ingestão e busca.
- Erros internos sanitizados no perímetro HTTP.
