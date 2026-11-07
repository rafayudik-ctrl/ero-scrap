# 0.5.0

- **Ordenação do catálogo:** mais recentes, mais antigos, maior duração, menor duração (`?order=recent|oldest|longest|shortest`).
  Paginação por cursor correta nas quatro ordens (desempate pelo id). Um cursor de outra ordem é rejeitado.
- **Apagar antes do prazo:** botão por vídeo, `POST /api/catalog/<id>/delete` (mesma proteção do "Abrir": POST, Origin confiável, sessão).
  O vídeo sai do catálogo na hora; a remoção do MEGA e do banco é feita pela retenção já existente. Uma escrita no D1.
- **Retenção configurável:** padrão de vídeos não abertos passou de 7 para **4 dias**.
  Variável de repositório `UNOPENED_RETENTION_DAYS` (1 a 7). O Worker aceita qualquer número inteiro de dias de 1 a 7.
  Diminuir o valor também encurta os vídeos já guardados e não abertos (faxina diária, só linhas alteradas).
- Textos da página não citam mais "sete dias".
