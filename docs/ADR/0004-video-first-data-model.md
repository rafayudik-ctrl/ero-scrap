# ADR-0004: Modelo de dados centrado no vídeo individual

- Status: Aceita
- Data: 2026-11-01

## Contexto

Um post pode conter diversos vídeos e imagens. O prazo de expiração e a primeira abertura são independentes por vídeo.

## Decisão

Separar `posts` de `video_assets`. A tabela `video_assets` armazena apenas vídeos. Imagens são descartadas antes da persistência. Cada vídeo recebe ID local e ID de origem próprios.

## Consequências

- Um único post pode produzir zero, um ou vários itens de catálogo.
- Cada item tem seu próprio armazenamento e retenção.
- Duplicidade é controlada por identificador de vídeo, não pelo título do post.
