# 0.4.12

- Miniaturas de vídeos verticais não ficam mais cortadas.
  - Geração: a miniatura agora cabe numa caixa de 320x320 mantendo a proporção, sem ampliar
    (16:9 -> 320x180, 9:16 -> 180x320, quadrado -> 320x320). Vertical fica menor em bytes que antes (568 px de altura).
  - Catálogo: `object-fit: contain` (nada é cortado) e, quando a imagem é vertical, o cartão usa uma caixa 3:4.
    Na visualização em lista a caixa continua 16:9, com a imagem inteira dentro.
  - Vale também para as miniaturas já guardadas: o ajuste visual não depende de gerar de novo.
- A imagem agora é posicionada de forma absoluta dentro da caixa, para ela nunca esticar a altura do cartão.
