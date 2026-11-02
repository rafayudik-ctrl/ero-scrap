# ADR-0001: Frontend estático sem framework

- Status: Aceita
- Data: 2026-11-01

## Contexto

O produto precisa ser leve em computadores modestos e celulares e deve transferir o trabalho pesado para componentes separados.

## Decisão

HTML semântico, CSS puro e JavaScript Vanilla com ES Modules. Cloudflare Pages publica `apps/web/public` diretamente, sem bundler.

## Consequências

- Bundle mínimo e poucas dependências.
- Menor custo de runtime e manutenção.
- Componentes de UI serão funções/módulos simples.
- Se a interface crescer, só adicionar ferramenta após medir benefício e custo.
