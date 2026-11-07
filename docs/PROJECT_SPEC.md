# Especificação do projeto

## Objetivo

Aplicação privada com frontend estático, coletor de metadados e catálogo de arquivos autorizados. A interface não processa vídeos; o executor Node.js fica separado da Cloudflare.

## Palavra-chave

Existe exatamente uma palavra/frase ativa em `config/search-keyword.txt`, uma linha, até 80 caracteres. O arquivo é a única fonte configurável. Um post corresponde quando o termo aparece no título **OU** em qualquer tag, com normalização Unicode NFKD, case-insensitive e sem diacríticos.

## Descoberta

- Fonte: aba pública New; somente as primeiras páginas (padrão 1–4, máx. 6).
- A cada 15 minutos no modo contínuo.
- Post só com imagens: ignorado.
- Post misto: imagens ignoradas; cada vídeo é uma entidade independente.
- Duração elegível: `0 < duration_ms <= 600000` e explicitamente confirmada.
- Duração ausente/ambígua: rejeitar.
- Não contornar login, CAPTCHA, bloqueios, controles técnicos ou limites.

## Autorização e cópia

`COPY_AUTHORIZED` é uma constante central default `false`. É aplicada pelo workflow, executor, downloader, gerador de miniatura, provider MEGA e Worker. O pipeline completo Erome → download temporário em stream → FFprobe → miniatura WebP → MEGA → D1/R2 está implementado, mas não executa enquanto a trava permanecer fechada. O runner revalida palavra-chave, ID individual do vídeo e duração na página; FFprobe também confirma a duração real antes do upload.

A variável técnica não constitui permissão jurídica. O operador deve ter autorização válida para copiar e armazenar cada vídeo e respeitar os termos da fonte, privacidade, consentimento e direitos dos participantes. O código não contorna login, CAPTCHA, DRM, 401/403, 429, redirecionamentos ou outros controles de acesso.

## Catálogo e retenção

- Só mostrar registros com storage confirmado e dentro do prazo.
- O catálogo não expõe `share_url` nem identificador remoto.
- O botão de abrir usa POST autenticado, registra primeiro clique e redireciona para MEGA.
- Sem clique: expiração sete dias depois do upload.
- Primeiro clique: expiração 24 horas depois; cliques seguintes não renovam.
- Exclusão: MEGA -> miniatura R2 -> linha do catálogo.
- Falhas: manter `delete_pending` e retry/backoff.
- Prazos independentes para cada vídeo.

## Requisitos não funcionais

- Frontend: HTML/CSS/Vanilla JS; sem frameworks.
- API: Workers, D1 e R2 privado.
- Runner: GitHub Actions em VMs Linux efêmeras; Node.js 26.13.0 conforme `.node-version`.
- MEGAcmd por adapter separado e `spawn` sem shell.
- FFmpeg somente no runner, timeout e output limitados.
- D1 acessado pelo Worker, nunca diretamente pelo runner.
- Sem armazenamento de vídeo em Pages/GitHub/D1.
- Sem carregar bytes de vídeo no navegador.

## Etapas

### 1 — Fundação

Repositório, contratos, domain, D1 inicial, API base, identidade visual, autenticação e CI. Ver `STAGE_1_STATUS.md`.

### 2 — Coletor

Configuração por arquivo, varredura New 1–2, parser de posts/tags/videos, regra de duração e executor de metadados. Ver `STAGE_2_STATUS.md`.

### 3 — Catálogo e armazenamento

Catálogo, abertura autenticada, retenção, exclusão e miniaturas R2. O adaptador MEGA atende tanto ao upload do pipeline Erome, após revalidação e autorização, quanto a arquivos locais de teste explicitamente fornecidos. Ver `STAGE_3_STATUS.md`.
