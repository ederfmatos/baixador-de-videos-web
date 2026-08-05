# Baixador de Vídeos da Web

Extensão para Google Chrome (Manifest V3) que detecta e baixa vídeos
reproduzidos em páginas da web:

- **Arquivos diretos** (`.mp4`, `.webm`, `.ogg`, `.mov`, etc.) — download
  imediato.
- **Streams HLS** (`.m3u8`) — o formato de streaming usado pela maioria dos
  sites. A extensão baixa todos os segmentos, descriptografa AES-128 padrão
  quando presente e junta tudo em um único arquivo, com escolha de qualidade
  e barra de progresso.

## Como funciona

- Um **service worker** observa o tráfego de rede da aba e captura URLs de
  mídia (por `Content-Type` ou pela extensão do arquivo), incluindo
  manifestos HLS.
- Um **content script** varre a página em busca de tags `<video>`/`<source>`.
- O **popup** (ícone da extensão) lista os vídeos detectados na aba atual e
  oferece um botão **Baixar** para cada um.
- Streams HLS abrem a página `src/downloader.html`, que faz o parse da
  playlist, oferece as qualidades disponíveis (playlist master) e baixa os
  segmentos com progresso.
- O número no **badge** do ícone mostra quantos vídeos foram detectados.

## Instalar em modo desenvolvedor

1. Abra `chrome://extensions` no Chrome.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. O ícone da extensão aparece na barra de ferramentas.

## Testar

1. Abra uma página com um vídeo de arquivo direto (ex.: um `<video>` `.mp4`
   público de teste).
2. Reproduza o vídeo. O badge deve mostrar a contagem.
3. Clique no ícone da extensão e use **Baixar**.

## Limitações

- **DRM**: streams protegidos (Widevine, FairPlay, PlayReady, SAMPLE-AES) são
  detectados e **recusados** — a extensão não contorna proteção de conteúdo.
  Apenas a criptografia de transporte AES-128 padrão do HLS é suportada.
- **HLS com áudio separado** (comum em fMP4): vídeo e áudio são salvos como
  dois arquivos; juntá-los em um só exige FFmpeg (a extensão avisa quando
  isso acontece).
- **HLS em TS**: o resultado é um `.ts` (abre no VLC); converter para `.mp4`
  exige FFmpeg.
- **DASH (`.mpd`)** ainda não é suportado.
- Transmissões **ao vivo**: baixa apenas o trecho disponível no momento.
- O vídeo é montado em memória antes de salvar — vídeos muito longos
  (vários GB) podem falhar.
- Não baixa `blob:` nem `data:` URIs diretamente (mas o stream HLS por trás
  deles é detectado pela rede).

## Estrutura

```
manifest.json             Configuração da extensão (MV3)
src/background.js         Service worker: detecção via webRequest + badge
src/content.js            Varredura de <video>/<source> na DOM
src/popup.html/css/js     UI do popup e lógica de download
src/downloader.html/css/js Página de download HLS (qualidade + progresso)
icons/                    Ícones (16/48/128)
```
