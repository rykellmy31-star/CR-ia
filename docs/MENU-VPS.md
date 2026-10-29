# CR IA — comando `menu` no SSH (VPS Ubuntu)

**O que faz:** administra a CR IA instalada em `/opt/cr-ia/app` sem inserir chaves de IA no GitHub.
O menu é instalado pelo bootstrap de VPS **nova**. Em VPS já instalada, somente depois de
comparar/migrar a instalação atual com o repositório, execute:

```bash
sudo bash /opt/cr-ia/app/scripts/instalar-menu.sh
menu
```

Não execute o `bootstrap-github.sh` sobre uma VPS existente: ele recusa isso para preservar os dados.

## Opções

- `1`: mostra saúde dos contêineres e commit instalado.
- `2`: **Atualizar sistema de IA**: consulta o GitHub, mostra o commit novo, pede confirmação,
  exige backup do PostgreSQL e de arquivos, atualiza código e reconstrói serviços. Não basta mudar
  a lista de modelos: esta opção atualiza a versão do aplicativo.
- `3`: **Atualizar script/instalador**: busca apenas os scripts de operação do GitHub, valida `bash -n`,
  solicita confirmação e guarda cópia dos scripts anteriores. **Não reinicia** a CR IA.
- `4`: cria backup agora.
- `5`: mostra últimas linhas dos logs sem exibir `.env`.
- `6`: mostra commit e repositório; não mostra segredos.
- `0`: sai do menu.

O script atualizador **não sobrescreve** `.env` ou volumes Docker. Há riscos reais de falha ou
mudanças de schema; backup ainda precisa ter restauração ensaiada em outra VPS. Os serviços da
produção podem ficar indisponíveis brevemente durante build/deploy.

## Repositório público → privado

O menu aceita repositório **público sem token GitHub** e, quando ele ficar **privado**, solicitará
um token GitHub fine-grained com permissão `Contents: Read-only`, só para CR-IA.
Nunca coloque esse token em `.env`, código, URL de remote, scripts ou logs.

## APIs no painel

OpenRouter/NVIDIA e outras chaves são gerenciadas no Superadmin/Credenciais, **não** no GitHub.
A VPS usa o segredo `CREDENTIALS_SECRET` criado localmente para cifrar credenciais.
Modelos pagos, de teste ou sem API compatível não devem ser habilitados automaticamente.

## Token de licença do instalador

**Token de instalação/licença é diferente do token GitHub.** O GitHub público pode ser baixado por
qualquer pessoa; solicitar uma senha em um script público não protege o código contra cópias.
A emissão e validação segura de licenças exige um serviço próprio sob controle do dono ou um
esquema de licenças assinadas com a chave privada sob controle do dono. **Não implementado neste
pacote**. Não confunda o token opcional do GitHub (privado) com essa autorização.

## Segurança

Antes de publicar código num repo público, revise todos os arquivos para remover `.env`, tokens,
senhas, backups, exportações de clientes, logs e chaves. Depois de exposto publicamente, mudar
para privado não desfaz clones/forks anteriores.
