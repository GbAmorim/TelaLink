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

## Configurações do app

A engrenagem (canto inferior esquerdo) abre as **Configurações**: tema Escuro, Claro ou Automático (segue o Windows) e qualidade da transmissão (Economia 720p/15 fps, Equilibrada 1080p/30 fps, Alta 1080p/60 fps). A qualidade também pode ser escolhida na tela "Ir ao vivo". O endereço do servidor fica em **Avançado**.

## Endereço do servidor dentro do app

Além do `.env.production`, o TelaLink tem **Configurações do servidor** (engrenagem no canto inferior esquerdo). Ali dá para colar o endereço do Render (aceita `https://...`, converte para `wss://`), clicar em **Testar** e **Salvar**. O endereço fica guardado naquele computador. Use isso para testar sem gerar um novo instalador; para distribuir, continue definindo `VITE_SIGNALING_URL` no `.env.production`.

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
