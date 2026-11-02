# ADR-0002: Cloudflare Access + validação JWT no Worker

- Status: Aceita
- Data: 2026-11-01

## Contexto

O catálogo é privado. A proteção do site não deve depender de uma senha embutida no JavaScript.

## Decisão

Cloudflare Access protege o domínio; a API verifica o header `Cf-Access-Jwt-Assertion` usando JWKS, issuer, audience, RS256 e allowlist de e-mail. O modo de bypass existe somente em desenvolvimento local explícito.

## Consequências

- Requer configuração de Access e AUD em produção.
- Requer domínio protegido e ausência de endpoint alternativo público.
- A API falha fechada quando configuração de autenticação está incompleta.
