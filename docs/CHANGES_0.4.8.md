# 0.4.8

- Testes agora funcionam com `COPY_AUTHORIZED` em `true` **ou** `false`.
  Os testes que só fazem sentido com a trava fechada são pulados quando ela está aberta;
  os demais passam a seguir o valor real da constante. Nenhum código de produção mudou.
- Para `true`, edite apenas `packages/config/src/security.js`.
