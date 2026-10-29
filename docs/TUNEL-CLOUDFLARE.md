# CR IA — Cloudflare Tunnel + Access (VPS OVH pronta)

> Alvo: `https://ia.crjornada.com` servindo a stack local em
> `http://127.0.0.1:3000`, **sem nenhuma porta pública**.
> Pré-requisito: Tunnel `CRIA OVH` + Cloudflare Access (2 usuários) já instalados.

## 1. Rota do Tunnel (configuração existente — só conferir)

No host do Tunnel (`cloudflared`), o arquivo de ingress deve conter:

```yaml
tunnel: <TUNNEL-UUID-do-CRIA-OVH>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: ia.crjornada.com
    service: http://127.0.0.1:3000
    originRequest:
      connectTimeout: 30s
      noTLSVerify: false
  - service: http_status:404
```

- `service` aponta para **127.0.0.1** (loopback): o tráfego Cloudflare→VPS
  nunca atravessa rede pública local.
- O Compose da CR IA já publica **somente** em `127.0.0.1`:
  `127.0.0.1:3000` (site), `127.0.0.1:8787` (API debug), `127.0.0.1:11434`
  (Ollama), `127.0.0.1:8001` (ai-local). Confira com:
  ```bash
  ss -tlnp | grep -E '3000|8787|5432|11434|8001'
  # esperado: apenas linhas 127.0.0.1:PORTA (nunca 0.0.0.0:PORTA)
  ```
- **Não abra 80/443 no UFW** e **não instale Caddy** neste cenário:
  o TLS termina na Cloudflare; o Tunnel transporta tudo criptografado.

Após editar o ingress: `sudo systemctl restart cloudflared` (ou o nome do
serviço do Tunnel) e valide com `cloudflared tunnel info <nome>`.

## 2. DNS

No painel Cloudflare → DNS: `ia.crjornada.com` deve ser registro **CNAME**
para `<TUNNEL-UUID>.cfargotunnel.com` com proxy 🟠 ativado.

## 3. Cloudflare Access (2 usuários)

Zero Trust → Access → Applications → a aplicação de `ia.crjornada.com`:

- **Policy 1 (Allow):** `Emails` = e-mail do admin + e-mail da convidada.
- **Login methods:** One-time PIN (e-mail) — sem custo, sem app extra.
- **Session duration:** 12h (acompanha o JWT da CR IA).
- Opcional: `Country` = BR como segunda regra de proteção.

Com o Access ativo, mesmo com a URL pública, só os 2 e-mails entram —
antes mesmo de ver a tela de login da CR IA (defesa em 2 camadas).

## 4. Verificação de ponta a ponta

```bash
# 1. Local (na VPS): stack responde?
curl -s http://127.0.0.1:3000/api/health   # {"status":"ok",...}

# 2. Do seu computador (passa pelo Access + Tunnel):
curl -s https://ia.crjornada.com/api/health
# Sem sessão do Access: 302/redirect para login Cloudflare (correto).
# Com sessão: {"status":"ok",...}

# 3. Segurança: porta 3000 NÃO pode responder no IP público
curl -s -m 5 http://<IP-DA-VPS>:3000/api/health && echo "EXPOSTA (corrigir!)" || echo "OK: só loopback"
```

## 5. Operação

| Ação | Comando (na VPS, pasta `/opt/cr-ia/app`) |
|---|---|
| Ver saúde | `docker compose ps` + `curl http://127.0.0.1:3000/api/health` |
| Logs | `docker compose logs -f api worker` |
| Atualizar | `./scripts/update.sh` (faz backup antes) |
| Backup local | `./scripts/backup.sh` (também no cron diário) |
| Backup externo R2 | `./scripts/backup-r2.mjs` (após preencher `R2_*`) |
| Tunnel caiu? | `systemctl status cloudflared` → `sudo systemctl restart cloudflared` |

## 6. O que este projeto NÃO faz no seu servidor

Documentado e garantido pelo `scripts/deploy-vps-pronta.sh`:

- Não reinstala/atualiza Docker, não altera `sshd_config`.
- Não cria/altera regras UFW, não abre 80/443.
- Não instala Caddy (desnecessário com Tunnel).
- Não cria/altera túneis, rotas ou políticas Access (só documenta).
- Nunca sobrescreve segredos existentes no `.env`.
