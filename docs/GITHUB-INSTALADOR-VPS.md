# CR IA — GitHub público/privado e instalador de VPS

**Situação:** pacote de código preparado; **não** implantado nem homologado numa VPS nova.
**Atenção:** `bootstrap-github.sh` só deve ser executado em VPS Ubuntu nova. Não use na VPS já
em funcionamento em `/opt/cr-ia/app`; o script se recusa a sobrescrevê-la.

## Publicar o projeto

1. Crie o repositório `rykellmy31-star/CR-IA` inicialmente **PÚBLICO**, vazio.
2. No Windows, extraia este pacote e execute `PUBLICAR-NO-GITHUB-WINDOWS.bat` dentro da pasta.
3. Verifique o conteúdo antes de publicar, especialmente **qualquer** chave, senha, backup ou arquivo `.env`.
4. Não adicione banco de dados, imagens de usuários, registros, sessões e segredos ao GitHub.

`.env.example` contém apenas exemplo de nomes de configurações; os valores reais são gerados na VPS.

## Instalação em VPS Ubuntu **nova**

Requisitos planejados: Ubuntu 22.04/24.04 LTS, 4+ GB RAM (recomendados 8+), 15+ GiB
livres, DNS apontado ao servidor e acesso `sudo`.

Envie `scripts/bootstrap-github.sh` para o servidor e execute, via SSH:

```bash
sudo CRIA_REPO=rykellmy31-star/CR-IA CRIA_REF=main CRIA_DOMAIN=ia.crjornada.com \
  bash /home/ubuntu/bootstrap-github.sh
```

O bootstrap instala componentes Ubuntu/Docker, clona o repositório, gera `.env` com chaves e
senhas locais, sobe os serviços, oferece instalação de Ollama e ativa HTTPS e backups.
Ele também instala o comando global **`menu`**.

- **Repo público:** clone e atualização não exigem token GitHub.
- **Repo privado:** durante clone ou atualização, informe um token GitHub fine-grained,
  `Contents: Read-only`, selecionando apenas `CR-IA`, gerado por você. Ele não é salvo no Git.

**Importante:** o instalador ainda não possui um sistema de licença próprio. Token de licença
exige verificador separado ou licenças assinadas sob seu controle, especialmente para um repo
público. Não trate token GitHub como licença.

Depois da instalação:

```bash
menu
```

Leia [MENU-VPS.md](MENU-VPS.md) para opções e limitações.

## VPS CR IA já em funcionamento

**Não rode `bootstrap-github.sh` ou um clone por cima da pasta existente.** A vinculação ao GitHub
precisa ser um procedimento separado, depois de comparar diferenças, confirmar backup de banco +
volumes e preservar `.env`/instalação em produção. O menu só autoriza atualização via Git quando
`/opt/cr-ia/app/.git` existir e corresponder ao projeto correto.

## Observações

- Atualizações por ZIP assinadas no painel são um mecanismo **separado** da atualização por GitHub.
- Token do GitHub é solicitado em terminal somente se o repositório exigir autenticação.
- Esta entrega tem testes estáticos e locais, mas precisa de teste de integração e deploy em VPS de homologação.
- Não confunda sincronização do catálogo de IAs no painel com atualização do código pelo menu.
