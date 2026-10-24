# TelaLink — compartilhamento de tela

Aplicativo desktop Windows feito com Electron + React + Vite. A interface foi simplificada para dois fluxos: **Transmitir minha tela** e **Conectar a uma tela**.

## O que está incluído

- Código de sala aleatório gerado pelo servidor.
- Entrada de espectadores com código, sem aprovação manual do anfitrião.
- WebRTC com uma conexão independente por espectador.
- Captura do áudio do computador junto com a tela no Windows; o microfone não é capturado.
- Limite configurado de 5 espectadores simultâneos (6 conexões contando o anfitrião).
- Serviço de sinalização separado em `server/`.
- O servidor encaminha mensagens de negociação; não recebe nem armazena o vídeo.

## Teste local no mesmo computador

1. Instale Node.js LTS.
2. No terminal, na pasta `server`, execute `npm install` e `npm start`.
3. Em outro terminal, na raiz do projeto, execute `npm install` e `npm run dev`.
4. Crie uma transmissão e conecte outra instância usando o código.

`ws://localhost:3001` funciona apenas para teste na mesma máquina. Para computadores diferentes, é obrigatório publicar `server/` em um serviço acessível pela internet e usar uma URL WebSocket segura (`wss://`).

## Novidades da versão 5

- **Som do computador sem o Discord:** ao transmitir, o som do computador vai junto, mas o Discord (se estiver aberto) fica de fora, então quem assiste não ouve a voz da chamada. O Windows permite deixar de fora um aplicativo por vez; se o Discord não estiver aberto, fica de fora o próprio TelaLink (evita ouvir de volta as transmissões que você assiste). Também dá para escolher "Sem som".
- **Acesso com duas opções:** **Com solicitação** (padrão: quem digita o código pede para entrar e você confirma) ou **Aberta** (entra direto com o código).
- **Nomes e remover pessoas:** o nome de cada pessoa aparece nas caixas e na sua lista, e o botão **x** ao lado do nome (na barra da sua transmissão) remove a pessoa.
- **Aviso de servidor desatualizado:** se o servidor do Render ainda for o antigo, o app avisa (nomes, solicitação e remoção só funcionam com o servidor novo). Em Configurações → Avançado, **Testar** também mostra isso.
- Transmitir uma ou várias telas, assistir a até 5 transmissões em caixas responsivas, trocar de tela/janela ao vivo, tema claro/escuro e qualidade da transmissão continuam como antes.

### Passo obrigatório: instalar o módulo de som (uma vez, no computador onde você gera o instalador)

```powershell
npm install loopback-capture
```

Ele entra no instalador, e as outras pessoas não precisam instalar nada. Sem o módulo, o app funciona, mas só com "Sem som". Requer Windows 10 versão 2004 ou superior.

### Atualizar o servidor (obrigatório)

Envie a pasta `server` atualizada ao GitHub (o Render faz o deploy sozinho) e confira o `/health`. Depois gere o instalador novo: versões antigas não conversam direito com o servidor novo.

## Configurar o serviço para computadores diferentes

O projeto inclui `render.yaml` para publicar o servidor de sinalização no Render:

1. Publique a pasta `TelaLink/` em um repositório GitHub. O arquivo `render.yaml` precisa estar na raiz do repositório. Não envie arquivos `.env`.
2. No Render, escolha **New → Blueprint**, conecte o repositório e aplique a configuração encontrada. Ela cria um serviço Web gratuito a partir de `server/`.
3. Aguarde o deploy e teste a URL pública abrindo `https://seu-servico.onrender.com/health`. A resposta deve conter `"status":"ok"`.
4. Na raiz do projeto, crie `.env.production` e use o endereço do serviço com `wss://`:

   ```env
   VITE_SIGNALING_URL=wss://seu-servico.onrender.com
   ```

5. No Windows, execute `npm run build` novamente e distribua o instalador gerado em `release/`.

**Não distribua o instalador com `ws://localhost:3001` se a intenção é conectar computadores diferentes.** Cada instalação tentaria acessar o próprio computador do espectador.

O plano gratuito do Render é para testes: ele pode suspender o serviço após inatividade, levar cerca de um minuto para iniciar novamente e interromper sessões abertas. O TelaLink aguarda mais tempo na primeira conexão e envia keep-alives durante uma sessão, mas isso não elimina as limitações do plano gratuito. Para uso contínuo, escolha um plano pago no Render.

## Observações

- O WebRTC usa servidores STUN públicos para tentar estabelecer conexões diretas. Algumas redes corporativas, NATs restritivos ou firewalls exigem um servidor TURN para retransmitir mídia. STUN sozinho não garante conexão em todas as redes.
- O anfitrião transmite o áudio de saída do computador junto com a tela. O microfone não é incluído; confira se o Windows está reproduzindo o som pelo dispositivo de saída esperado.
- O vídeo é enviado separadamente a cada espectador. A largura de banda de upload do computador transmissor cresce conforme o número de espectadores.
- Qualquer pessoa com um código válido pode assistir; encerre a sala quando terminar e compartilhe o código apenas com pessoas autorizadas.
- O aplicativo não implementa controle remoto do computador.
