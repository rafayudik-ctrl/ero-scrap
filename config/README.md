# Configuração do coletor

Edite exclusivamente `search-keyword.txt` para alterar a palavra ou frase monitorada.

- Coloque exatamente uma palavra ou frase em uma única linha.
- A comparação ignora maiúsculas/minúsculas e acentos.
- O post corresponde quando o título **ou** qualquer tag contém a expressão.
- O arquivo é lido no início de cada varredura; não é necessário reiniciar o executor.
- Arquivo vazio desativa a coleta.
- Linhas adicionais, controles e termos com mais de 80 caracteres são rejeitados.

Não coloque comentários no arquivo de palavra-chave. Não existe configuração equivalente no banco, na API ou na interface.
