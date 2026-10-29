# CR IA v0.3.1 — correção de assinatura de releases

Esta versão corrige o problema `Trusted comment not present`, causado por assinatura
parcial de duas linhas. O verificador da API agora exige o formato oficial de
quatro linhas e verifica tanto a assinatura do ZIP quanto o comentário confiável.

O pacote **não está assinado**. Assinaturas antigas e o arquivo
`cr-ia-release.pub` anterior NÃO servem para o ZIP novo.

## Antes da instalação

1. Confirme os backups do banco, de `cr-ia_apidata`, do código e do `.env`.
2. Copie para a VPS o ZIP corrigido, sem extrair em `/opt/cr-ia/app`.
3. Com sua conta SSH, execute `bash scripts/preparar-assinatura-vps.sh /caminho/ZIP.zip`
   **a partir desta release extraída em diretório temporário**, ou use o
   script auxiliar `preparar-assinatura-vps.sh` entregue separadamente.
4. Guarde a chave `.key` **somente sob seu controle**. Se ela for criada na VPS,
   transfira-a para armazenamento offline protegido e depois remova da VPS.
5. Faça `minisign -Vm ZIP.zip -p cr-ia-release-nova.pub -x ZIP.zip.minisig`.
6. Configure `UPDATE_SIGNING_PUBLIC_KEY` no `.env` com a segunda linha da
   chave pública nova. **Nunca configure a chave privada no `.env`.**
7. Verifique o deploy em staging e o procedimento de rollback. A assinatura
   assegura origem em relação à chave escolhida, não atesta que o programa não
   tenha falhas.

Não execute `scripts/install-vps.sh` na VPS existente (ele é bootstrap de VPS
nova e pode modificar firewall, contas e pacotes). Não execute
`docker compose down -v` nem apague os volumes `cr-ia_pgdata` ou `cr-ia_apidata`.

Esta entrega foi corrigida em ambiente local, mas **não foi instalada nem testada
na VPS do usuário**. Faça verificação de compatibilidade antes da implantação.
