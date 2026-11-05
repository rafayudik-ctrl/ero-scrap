# 0.4.9

- Intervalo do scan: de 10 para 20 minutos (`7,27,47 * * * *`, `intervalMinutes: 20`, scheduler local 20 min).
- Mais leve: 3 execuções por hora em vez de 6 (metade dos runners, metade das chamadas ao Worker/D1).
- Documentado o gatilho externo opcional (seção 17 de `CLOUD_DEPLOYMENT.md`), porque o `schedule` do GitHub atrasa/descarta execuções.
- Nenhuma mudança de lógica. A manutenção diária (UTC 03h) continua caindo dentro de uma execução.
