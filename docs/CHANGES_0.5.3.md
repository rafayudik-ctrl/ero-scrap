# 0.5.3

- Borda dourada nos vídeos já abertos (contagem de 24 h iniciada); aplica na hora ao clicar em "Abrir no MEGA".
- MEGA: a pasta do vídeo é removida depois de apagar o arquivo, se (e somente se) estiver confirmadamente vazia. Também no upload falho e no arquivo já ausente.
- MEGA: faxina limitada de pastas vazias antigas (`MEGA_EMPTY_FOLDER_SWEEP_CHECKS`, padrão 10, 0 desliga, máx. 200), só roda quando a execução apagou algo; falha nunca derruba a retenção.
- Novo ícone `favicon.svg` (não quadrado) e logo do cabeçalho atualizado.
