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
- Um **content script** varre a página em busca de tags `<video>`/`<source>`
  e coleta os metadados descritos abaixo.
- O **popup** (ícone da extensão) lista os vídeos detectados na aba atual e
  oferece um botão **Baixar** para cada um. A lista é ordenada por
  probabilidade de ser o vídeo principal — duração, depois tamanho, depois
  resolução, depois origem (um `<video>` na página vale mais que um XHR) —
  e não por ordem de detecção, que costuma trazer um anúncio na frente.
  Variantes de qualidade do mesmo stream ficam recolhidas atrás de um link,
  representadas pela de melhor qualidade.
- Streams HLS abrem a página `src/downloader.html`, que faz o parse da
  playlist, oferece as qualidades disponíveis (playlist master), pede a pasta
  de destino e grava os segmentos conforme chegam.
- O número no **badge** do ícone mostra quantos vídeos foram detectados.

### Metadados

O popup mostra nome, duração, resolução, tamanho e uma miniatura, em vez de
"Vídeo 1". As fontes, da mais específica para a mais genérica:

- **Nome**: `Content-Disposition` do servidor → `title`/`aria-label` do
  `<video>` ou heading próximo → `name` do JSON-LD `VideoObject` →
  `og:title` → `document.title`. As três primeiras costumam dar o nome
  limpo; `document.title` quase sempre vem com o sufixo do site colado.
- **Duração e resolução**: do próprio elemento `<video>` (após
  `loadedmetadata`), ou do JSON-LD / `og:video:duration`.
- **Miniatura**: atributo `poster` do `<video>`, `thumbnailUrl` do JSON-LD
  ou `og:image`.

Metadados de página valem para a aba inteira, e não só para a URL que casa:
a maioria dos streams é detectada pela rede, com uma URL que nunca aparece
na DOM, então o título da página é a única identificação disponível.

Na tela de escolha de qualidade, cada variante mostra **duração real e
tamanho estimado**, além de codec, taxa de quadros e HDR. A duração vem da
soma dos `#EXTINF` de cada playlist, buscadas em paralelo; o tamanho é
`BANDWIDTH × duração`. Se alguma playlist falhar, aquela linha simplesmente
fica sem a informação extra. Faixas de áudio e legendas presentes no stream
também são listadas (legendas ainda não são baixadas).

## Nome do arquivo

O nome sugerido segue a cadeia acima, mas é sempre editável:

- No **popup**, o nome é um campo de texto — clique e digite. `Enter` baixa
  direto.
- Na **página de download HLS**, há um campo *Nome do arquivo* nas telas de
  início e de escolha de qualidade. Se você editar o nome, ele é usado
  literalmente, sem o sufixo de qualidade que seria acrescentado ao nome
  sugerido (`Meu vídeo 1080p.mp4`).
- Nas **opções**, o interruptor *Perguntar onde salvar cada arquivo* faz os
  arquivos diretos abrirem o diálogo do Chrome, onde dá para mudar nome e
  pasta na hora.

Caracteres inválidos em nome de arquivo (`/ \ : * ? " < > |`) são trocados
por `_`, e o nome é limitado a 120 caracteres.

## Gravação em disco

O vídeo **não é montado em memória**. A página de download pede uma pasta
(File System Access API) e grava cada segmento assim que ele chega, em ordem
estrita, descartando o buffer em seguida. Os downloads acontecem em paralelo
(4 conexões) com uma janela limitada de antecipação, então o consumo de RAM
é constante independentemente do tamanho do vídeo.

Por isso a aba de download precisa ficar aberta enquanto ele roda: é ela quem
escreve no arquivo. Há botões de **Pausar/Retomar** e **Cancelar** — cancelar
remove o arquivo parcial da pasta.

## Lista de downloads, pausa e retomada

Downloads de **arquivos diretos** passam pelo `chrome.downloads`, então
aparecem em `chrome://downloads` com pausa e retomada nativas do navegador.

Downloads de **streams HLS** são gravados pela própria extensão e não chegam
ao gerenciador do Chrome. Para eles existe uma página própria (link
**Downloads** no rodapé do popup) que lista todos os streams — em andamento,
pausados, concluídos e falhos — com progresso ao vivo.

- **Pausar/retomar na mesma aba**: o botão na página de download bloqueia
  tanto o download quanto a gravação.
- **Retomar depois de fechar a aba**: a cada 25 segmentos, e sempre que o
  download é pausado, a extensão grava um *checkpoint* — fecha o arquivo
  (o que confirma os bytes no disco) e guarda no IndexedDB os handles da
  pasta e do arquivo junto com o índice do próximo segmento. Se a aba for
  fechada, o download aparece como **Interrompido** na lista com um botão
  **Retomar**, que reabre o arquivo em modo `keepExistingData`, posiciona a
  escrita no fim e continua de onde parou.

O checkpoint é necessário porque um `FileSystemWritableFileStream` grava num
arquivo temporário e só transfere para o destino no `close()` — sem ele, uma
aba encerrada no meio perderia tudo.

## Quando um download falha

Erros são classificados em **temporários** (HTTP 4xx/5xx, queda de conexão,
timeout) e **permanentes** (DRM, playlist inválida ou sem segmentos, mux.js
indisponível). A distinção decide o que acontece com o arquivo parcial:

- **Temporário**: o que já foi baixado é confirmado no disco e o ponto de
  retomada é salvo. Aparece um botão **Tentar novamente** que continua do
  segmento onde parou, sem rebaixar o que já veio, e sem pedir a pasta de
  novo (a permissão já foi concedida naquela aba).
- **Permanente**: tentar de novo daria o mesmo erro, então o botão não
  aparece e o arquivo parcial é removido.

O mesmo botão existe na lista de downloads, onde falhas ficam registradas com
**Tentar novamente** (se houver ponto salvo) ou **Baixar de novo** (se a falha
foi antes do primeiro checkpoint). Downloads falhos com ponto de retomada não
somem no "Limpar finalizados".

Para arquivos diretos, uma falha aparece embaixo do item no popup e o botão
vira **Tentar novamente**, em vez de o popup fechar sem dizer nada.

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
  nela, não no service worker. Fechar a aba interrompe o download (o navegador
  pede confirmação), mas ele fica retomável a partir do último checkpoint.
- **Retomada depende do servidor**: a playlist é buscada de novo ao retomar.
  Se as URLs dos segmentos tiverem token com validade curta, ou se a playlist
  tiver mudado, a retomada falha e é preciso recomeçar.
- **Retomada de streams MPEG-TS**: o remuxer é recriado do zero, reaproveitando
  o cabeçalho MP4 já gravado. Funciona na prática, mas pode haver uma pequena
  descontinuidade de timestamps no ponto da emenda. Streams fMP4 não têm esse
  problema.
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
src/downloads.html/css/js  Lista de downloads de streams, com retomada
src/registry.js            Registro em storage.local + handles no IndexedDB
src/options.html/css/js    Lista de domínios ignorados
src/vendor/mux.js          mux.js 7.1.0 — remux MPEG-TS → MP4 (Apache-2.0)
icons/                     Ícones (16/48/128)
```
