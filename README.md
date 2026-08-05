# Baixador de Vídeos da Web

Extensão para Google Chrome (Manifest V3) que detecta e baixa vídeos
reproduzidos em páginas da web:

- **Arquivos diretos** (`.mp4`, `.webm`, `.ogg`, `.mov`, etc.) — download
  imediato.
- **Streams HLS** (`.m3u8`) — o formato de streaming usado pela maioria dos
  sites. A extensão baixa todos os segmentos, descriptografa AES-128 padrão
  quando presente, converte MPEG-TS para MP4 e grava direto no disco, com
  escolha de qualidade, barra de progresso e cancelamento.

## Como funciona

- Um **service worker** observa o tráfego de rede da aba e captura URLs de
  mídia (por `Content-Type` ou pela extensão do arquivo), incluindo
  manifestos HLS. O estado é mantido em `chrome.storage.session`, para
  sobreviver ao encerramento do worker.
- Um **content script** varre a página em busca de tags `<video>`/`<source>`.
- O **popup** (ícone da extensão) lista os vídeos detectados na aba atual e
  oferece um botão **Baixar** para cada um. Variantes de qualidade do mesmo
  stream ficam recolhidas atrás de um link.
- Streams HLS abrem a página `src/downloader.html`, que faz o parse da
  playlist, oferece as qualidades disponíveis (playlist master), pede a pasta
  de destino e grava os segmentos conforme chegam.
- O número no **badge** do ícone mostra quantos vídeos foram detectados.

### Gravação em disco

O vídeo **não é montado em memória**. A página de download pede uma pasta
(File System Access API) e grava cada segmento assim que ele chega, em ordem
estrita, descartando o buffer em seguida. Os downloads acontecem em paralelo
(4 conexões) com uma janela limitada de antecipação, então o consumo de RAM
é constante independentemente do tamanho do vídeo.

Por isso a aba de download precisa ficar aberta até o fim: é ela quem escreve
no arquivo. Há um botão **Cancelar**, e o arquivo parcial é removido da pasta
se o download for interrompido ou falhar.

### Conversão para MP4

Segmentos MPEG-TS passam pelo [mux.js](https://github.com/videojs/mux.js)
(`src/vendor/mux.js`) e são remuxados para MP4 fragmentado em tempo real,
segmento a segmento. O resultado é um `.mp4` que abre em qualquer player —
não é mais preciso converter o `.ts` à mão. Streams que já são fMP4 são
gravados sem conversão.

## Instalar em modo desenvolvedor

1. Abra `chrome://extensions` no Chrome.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. O ícone da extensão aparece na barra de ferramentas.

## Opções

A página de opções (link no rodapé do popup, ou botão **Detalhes → Opções da
extensão**) permite manter uma lista de **domínios ignorados**. Vídeos
hospedados nesses domínios não são detectados nem contados no badge —
útil para redes de anúncios. Subdomínios são incluídos automaticamente.

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
  dois arquivos na mesma pasta. Juntá-los num só exige FFmpeg — a extensão
  mostra o comando pronto quando isso acontece. O mux.js remuxa faixas, mas
  não combina dois streams independentes em um único MP4.
- **A aba de download precisa ficar aberta**: a gravação em disco acontece
  nela, não no service worker. Fechar a aba cancela o download (o navegador
  pede confirmação).
- **DASH (`.mpd`)** ainda não é suportado.
- Transmissões **ao vivo**: baixa apenas o trecho disponível no momento.
- Não baixa `blob:` nem `data:` URIs diretamente (mas o stream HLS por trás
  deles é detectado pela rede).
- Requer a **File System Access API** (`showDirectoryPicker`), disponível em
  Chrome/Edge; não funciona em Firefox.

## Estrutura

```
manifest.json              Configuração da extensão (MV3)
src/background.js          Service worker: detecção, estado de sessão, badge
src/content.js             Varredura de <video>/<source> na DOM
src/popup.html/css/js      UI do popup e disparo de downloads
src/downloader.html/css/js Página de download HLS (qualidade, disco, remux)
src/options.html/css/js    Lista de domínios ignorados
src/vendor/mux.js          mux.js 7.1.0 — remux MPEG-TS → MP4 (Apache-2.0)
icons/                     Ícones (16/48/128)
```
