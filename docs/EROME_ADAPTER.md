# Adaptador Erome: observações e limitações

## Rotas consultadas

- New page 1: `https://www.erome.com/explore/new`
- New page 2: `https://www.erome.com/explore/new?page=2`

A rota pública New e uma página pública de álbum foram verificadas durante o planejamento. Uma implementação comunitária, não oficial, observa os seletores `.album-link`, `.album-title` e a estrutura `<video><source src="…">`. Essa implementação não é documentação oficial e pode ficar desatualizada.

## Listing parser

`listing-parser.js` limita pageNumber a 1 ou 2, exige o contêiner `#albums`, extrai cada card `.album` independentemente e procura dentro do mesmo card os links `.album-link` e `.album-title`. Um card malformado não desloca nem mistura o título/URL dos cards seguintes. Um `#albums` válido sem cards representa uma página vazia; ausência do contêiner indica HTML inesperado. Os resultados são limitados a 80 cards por página. Caso a página exceda o limite, a coleta gera erro parcial, em vez de descartar cards silenciosamente.

## Album parser

`album-parser.js` reconhece:

- tags em links com rota `/tag/` ou `/tags/`;
- elementos com classes `tag`, `tag-*` ou atributo `data-tag`;
- links que exibem tag como texto iniciado por `#`;
- `meta keywords` e `article:tag`;
- elementos `<video>` e fontes `<source>` com extensão de vídeo conhecida e host sob `erome.com`.

Se um único elemento `<video>` tiver múltiplas fontes/qualidades, apenas a primeira fonte suportada é tratada como um asset lógico para evitar contar variantes de codec como vídeos diferentes.

## Duração: limitação crítica

O parser aceita duração explícita em atributos (`data-duration-ms`, `data-duration`, `duration`, `data-length`), em campos reconhecidos de JSON `data-setup` e em elementos visíveis com classe `.duration`. Scripts comunitários recentes do Erome identificam rótulos `.duration` na página do álbum e os associam aos grupos de mídia. Como não existe API oficial documentada, essa observação é tratada como frágil.

A associação de `.duration` a vídeos é conservadora: o parser só usa os rótulos se a quantidade de rótulos válidos for exatamente igual à quantidade de elementos de vídeo identificados; nesse caso, associa na ordem do documento. Se houver divergência, duplicidade ou falta, não tenta adivinhar e mantém a duração como desconhecida. Duração explícita no próprio elemento de vídeo tem precedência.

O parser não baixa nem faz requisição Range aos arquivos de mídia para obter duração. **Ainda não foi validado que o HTML real de todos os álbuns forneça um rótulo confiável para cada vídeo.** Se não houver duração explícita, o vídeo recebe `duration_unknown` e é rejeitado. Essa decisão evita aceitar vídeos acima de 10 minutos por engano.

A estrutura e os rótulos `.duration` foram observados em código comunitário, não em documentação oficial do Erome. Antes de produção, é obrigatório comparar com uma página pública real e confirmar que cada rótulo pertence ao vídeo correspondente. Não adicionar heurísticas nem contornar controles de acesso.

## Fixtures e manutenção

Os fixtures em `tests/fixtures/erome/` são artificiais e não contêm mídia real. Quando a estrutura pública mudar:

1. validar manualmente a página pública, respeitando os termos e os controles;
2. guardar somente trecho HTML mínimo e não sensível como fixture;
3. atualizar parser e testes;
4. manter rejeição fail-closed para duração desconhecida;
5. não gravar URLs privadas/assinadas.


## Pipeline de mídia Erome → MEGA (implementado, gate fechado)

`apps/runner/src/services/erome-media-processing-service.js` conecta a fila de vídeos elegíveis ao processamento final:

1. Verifica `COPY_AUTHORIZED` antes de reivindicar qualquer job ou solicitar bytes da fonte.
2. Lê novamente a única palavra-chave de `config/search-keyword.txt`.
3. Reconsulta a página pública do álbum e revalida título/tag, ID individual, URL e duração.
4. `EromeMediaDownloader` transfere o arquivo em stream para um diretório temporário privado, com tamanho e timeout limitados.
5. FFprobe confirma a existência de stream de vídeo e sua duração real; a duração tem de coincidir com metadados dentro da tolerância de 2 segundos e continuar em até 600.000 ms.
6. FFmpeg gera uma miniatura WebP pequena; o provider MEGA envia o vídeo e confirma o objeto/link; o Worker registra metadados e a miniatura vai para R2 privado.
7. O arquivo temporário e artefatos intermediários são removidos em `finally`, inclusive em falhas.

O downloader não envia cookies, não autentica no site, não segue redirects e não tenta hosts alternativos. 401/403 são falhas permanentes; 429 é reagendado para uma execução futura, sem retry imediato nem bypass. URLs de mídia transitórias não são gravadas em D1. O pipeline processa um vídeo por execução do workflow para limitar RAM, disco temporário, tráfego e concorrência.

O workflow GitHub Actions roda em runner efêmero e não exige um computador ou VPS do operador. Com `COPY_AUTHORIZED = false` o fluxo fica inerte: as varreduras apenas coletam metadados e marcam os vídeos como `copy_blocked`. O código do downloader está presente, mas não foi validado contra arquivos reais nem contra uma conta MEGA do operador. A validade dos seletores e da associação de duração precisa ser confirmada em modo metadata com páginas públicas atuais antes de habilitar qualquer transferência autorizada.
