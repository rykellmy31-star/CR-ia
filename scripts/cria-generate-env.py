#!/usr/bin/env python3
"""Create .env once with unique secrets, never overwrite an existing installation."""
import getpass
import os
import pathlib
import re
import secrets
import sys

root = pathlib.Path(__file__).resolve().parent.parent
sample = root / '.env.example'
target = root / '.env'
if target.exists():
    sys.exit('ERRO: .env já existe. Instalador não sobrescreve segredos.')
if not sample.is_file():
    sys.exit('ERRO: .env.example não encontrado.')

domain = os.environ.get('CRIA_DOMAIN', 'ia.crjornada.com').strip().lower()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?', domain) or '.' not in domain or '..' in domain:
    sys.exit('ERRO: domínio inválido. Defina CRIA_DOMAIN=seudominio.com')

print('Configurando CR IA (seus dados não serão enviados ao GitHub).')
email = input('E-mail do administrador: ').strip()
if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
    sys.exit('ERRO: e-mail inválido.')

print('Defina a senha do Superadmin (mínimo 12 caracteres).')
password = getpass.getpass('Senha do Superadmin: ')
confirmation = getpass.getpass('Confirme a senha: ')
# Docker Compose uses .env interpolation; disallow characters that could be parsed specially.
if password != confirmation or not re.fullmatch(r'[a-zA-Z0-9!@%_+=:,.^~-]{12,128}', password):
    sys.exit('ERRO: senhas diferentes ou caracteres incompatíveis. Use 12+ caracteres entre letras, números, ! @ % _ + = : , . ^ ~ -')
if password.lower() in {'trocar123!', 'password1234', 'admin123456'}:
    sys.exit('ERRO: senha padrão proibida.')

values = {
    'ADMIN_EMAIL': email,
    'ADMIN_PASSWORD': password,
    'GUEST_PASSWORD': secrets.token_urlsafe(28),
    'POSTGRES_PASSWORD': secrets.token_hex(32),
    'JWT_SECRET': secrets.token_hex(32),
    'CREDENTIALS_SECRET': secrets.token_hex(32),
    'UPDATER_QUEUE_SECRET': secrets.token_hex(32),
    'CORS_ORIGINS': f'https://{domain}',
    'PUBLIC_API_URL': f'https://{domain}/api',
    'OPENROUTER_REFERER': f'https://{domain}',
    'CHAT_PROVIDER': 'ollama',
    'BLOCK_PAID_PROVIDERS': 'true',
    'UPDATE_SIGNING_PUBLIC_KEY': '',
}
contents = sample.read_text(encoding='utf-8').splitlines()
written = set()
new_lines = []
for line in contents:
    match = re.match(r'^([A-Z][A-Z0-9_]*)=', line)
    if match and match.group(1) in values:
        key = match.group(1)
        new_lines.append(f'{key}={values[key]}')
        written.add(key)
    else:
        new_lines.append(line)
for key, val in values.items():
    if key not in written:
        new_lines.append(f'{key}={val}')
try:
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(new_lines) + '\n')
        fh.flush()
        os.fsync(fh.fileno())
except FileExistsError:
    sys.exit('ERRO: .env criado por outro processo. Não vou sobrescrever.')
print('Arquivo .env criado com permissão 600 e segredos únicos. Nenhuma senha foi exibida.')
