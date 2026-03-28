// background.js — service worker
// Gestiona las descargas por lotes y el estado global

let autoDownloadAbort = false;
let activeDownload = null; // { recording, opts }

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Zoom UdeA] Extensión instalada correctamente.');
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.url || '';
  
  if (url.startsWith('blob:chrome-extension://')) {
    suggest();
    return;
  }

  if (!activeDownload || !activeDownload.recording) {
    suggest();
    return;
  }

  const originalExt = (item.filename.split('.').pop() || '').toLowerCase();

  let type = 'video';
  if (['vtt', 'srt'].includes(originalExt) || url.match(/\.(vtt|srt)(\?|$)/i)) type = 'transcript';
  else if (['txt', 'csv'].includes(originalExt) || url.match(/\.(txt|csv)(\?|$)/i)) type = 'chat';
  else if (['m4a', 'mp3', 'wav'].includes(originalExt) || url.match(/\.(m4a|mp3|wav)(\?|$)/i)) type = 'audio';

  if (type === 'video' && !activeDownload.opts.video) { suggest({ cancel: true }); return; }
  if (type === 'transcript' && !activeDownload.opts.transcript) { suggest({ cancel: true }); return; }
  if (type === 'chat' && !activeDownload.opts.chat) { suggest({ cancel: true }); return; }
  if (type === 'audio' && !activeDownload.opts.audio) { suggest({ cancel: true }); return; }

  const ext = originalExt || (type === 'video' ? 'mp4' : type === 'transcript' ? 'vtt' : type === 'chat' ? 'txt' : 'm4a');
  const filename = buildFilename(activeDownload.recording, type, ext);
  suggest({ filename, conflictAction: 'uniquify' });

  if (activeDownload.expectedCount) {
    activeDownload.receivedCount = (activeDownload.receivedCount || 0) + 1;
    if (activeDownload.receivedCount >= activeDownload.expectedCount && activeDownload.onAllReceived) {
      if (activeDownload.fallbackTimeout) clearTimeout(activeDownload.fallbackTimeout);
      const cb = activeDownload.onAllReceived;
      activeDownload.onAllReceived = null;
      setTimeout(cb, 500); // Dar 500ms extra para que el gestor interno termine de encolar
    }
  }
});

function buildFilename(rec, type, ext) {
  const idx = String(rec.index).padStart(2, '0');
  const date = rec.date.replace(/[\/\\:*?"<>|]/g, '-');
  const dur = rec.duration ? `_${rec.duration}min` : '';
  
  let prefix = 'Clase';
  if (type === 'transcript') prefix = 'Transcripcion';
  if (type === 'chat') prefix = 'Chat';
  if (type === 'audio') prefix = 'Audio';

  return `${prefix}_${idx}_${date}${dur}.${ext}`;
}



chrome.commands.onCommand.addListener((command) => {
  if (command === 'abort-download') {
    autoDownloadAbort = true;
    activeDownload = null;
    console.log('[Zoom UdeA] Descarga automática abortada por comando.');
  }
});


// Escucha mensajes del popup para acciones que requieren permisos de fondo
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'abortDownload') {
    autoDownloadAbort = true;
    chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: 'Descarga masiva CANCELADA por el usuario.' });
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'autoDownloadSelected') {
    const files = msg.files || [];
    const rec = msg.recording || { index: 1, topic: 'grabacion', date: 'sin-fecha', duration: null };
    const opts = msg.opts || { video: true, audio: false, transcript: false, chat: false };

    for (const f of files) {
      if (f.type === 'video' && !opts.video) continue;
      if (f.type === 'audio' && !opts.audio) continue;
      if (f.type === 'transcript' && !opts.transcript) continue;
      if (f.type === 'chat' && !opts.chat) continue;

      const filename = buildFilename(rec, f.type, f.ext || (f.type === 'video' ? 'mp4' : f.type === 'transcript' ? 'vtt' : 'txt'));
      chrome.downloads.download({ url: f.url, filename, saveAs: false }, (downloadId) => {
        console.log('[Zoom UdeA] descarga directa', downloadId, filename, f.url);
      });
    }

    sendResponse({ ok: true, count: files.length });
    return true;
  }

  if (msg.action === 'autoDownloadAbort') {
    autoDownloadAbort = true;
    activeDownload = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'autoDownloadBatch') {
    autoDownloadAbort = false;
    activeDownload = null;
    (async () => {
      const recordings = msg.recordings || [];
      const opts = msg.opts || { video: true, audio: false, transcript: false, chat: false };

      for (let i = 0; i < recordings.length; i++) {
        if (autoDownloadAbort) {
          sendResponse({ ok: false, reason: 'aborted' });
          return;
        }
        const rec = recordings[i];

        await new Promise((resolve) => {
          chrome.tabs.create({ url: rec.playUrl, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              resolve();
              return;
            }
            const tabId = tab.id;
            let timeoutId;

            const cleanup = () => {
              clearTimeout(timeoutId);
              chrome.tabs.remove(tabId, () => {
                const _ = chrome.runtime.lastError;
                resolve();
              });
            };

            const onUpdatedCallback = (updatedTabId, info) => {
              if (updatedTabId !== tabId) return;
              if (info.status === 'complete') {
                chrome.tabs.get(tabId, (currentTab) => {
                  if (chrome.runtime.lastError || !currentTab.url || !currentTab.url.includes('/rec/play/')) {
                    console.log('[Zoom UdeA] Redirección intermedia, esperando URL de Moodle /rec/play/:', currentTab?.url);
                    return; // Retornamos para esperar el VERDADERO evento complete de la siguiente URL
                  }
                  
                  // Es la página correcta, inyectar!
                  chrome.tabs.onUpdated.removeListener(onUpdatedCallback);
                  activeDownload = { recording: rec, opts };
                  chrome.tabs.sendMessage(tabId, { action: 'clickDownloadButton', opts, recording: rec }, (res) => {
                    if (chrome.runtime.lastError) {
                      chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] No cargó el script (¿demasiadas recargas?)` });
                      cleanup();
                      return;
                    }
                    if (!res || !res.ok) {
                      chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] ${res?.error || 'Falló al intentar descargar'}` });
                      cleanup();
                      return;
                    }

                    const req = opts;
                    const found = res.foundTypes || {};
                    const missing = [];
                    let expectedCount = 0;

                    if (req.video && found.video) expectedCount++; 
                    else if (req.video) missing.push('Video');
                    
                    if (req.audio && found.audio) expectedCount++; 
                    else if (req.audio) missing.push('Audio');
                    
                    if (req.transcript && found.transcript) expectedCount++; 
                    else if (req.transcript) missing.push('Transcripción');
                    
                    if (req.chat && found.chat) expectedCount++; 
                    else if (req.chat) missing.push('Chat');
                    
                    if (missing.length > 0) {
                      chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] La plataforma no incluye: ${missing.join(', ')}` });
                    }

                    // Techo de seguridad inteligente:
                    const limit = res.totalOffered || expectedCount;
                    if (expectedCount > limit) expectedCount = limit;

                    if (expectedCount === 0) {
                      cleanup();
                    } else {
                      activeDownload.expectedCount = expectedCount;
                      activeDownload.receivedCount = 0;
                      activeDownload.onAllReceived = cleanup;
                      
                      activeDownload.fallbackTimeout = setTimeout(() => {
                        chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] Tiempo agotado esperando ${expectedCount} archivos (ofrecidos: ${limit}). Avanzando...` });
                        if (activeDownload.onAllReceived) {
                           activeDownload.onAllReceived = null;
                           cleanup();
                        }
                      }, 35000); 
                    }
                  });
                });
              }
            };

            chrome.tabs.onUpdated.addListener(onUpdatedCallback);
            timeoutId = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(onUpdatedCallback);
              cleanup();
            }, 30000);
          });
        });
      }
      if (!autoDownloadAbort) {
        sendResponse({ ok: true, aborted: false });
      }
    })();
    return true;
  }
});
