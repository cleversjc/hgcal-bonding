// Keep this version equal to sw.js; bump both for every shell release.
const SHELL_VERSION = '2026-10-28-mobile-v1';
let started = false;
let installEvent = null;
let registration = null;
let statusSequence = 0;
const observers = new Set();
const state = {
  canInstall: false,
  installed: false,
  offlineStatus: 'preparing',
  updateAvailable: false,
  detail: '首次联网打开后，正在准备离线文件。'
};

export function getMobileAppState() { return { ...state }; }

function publish(changes) {
  Object.assign(state, changes);
  for (const observer of observers) {
    try { observer(getMobileAppState()); } catch { /* UI observer must not stop registration. */ }
  }
}

function checkWorker(worker) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close(); reject(new Error('Offline check timed out'));
    }, 8000);
    channel.port1.onmessage = event => {
      clearTimeout(timeout); channel.port1.close(); resolve(event.data);
    };
    try { worker.postMessage({ type: 'HGCAL_SHELL_STATUS' }, [channel.port2]); }
    catch (error) { clearTimeout(timeout); channel.port1.close(); reject(error); }
  });
}

async function inspectOfflineState() {
  const sequence = ++statusSequence;
  const worker = navigator.serviceWorker.controller || registration?.active;
  if (!worker || worker.state !== 'activated') return;
  try {
    const result = await checkWorker(worker);
    if (sequence !== statusSequence) return;
    if (result?.type === 'HGCAL_SHELL_STATUS' && result.version === SHELL_VERSION && result.ready) {
      publish({ offlineStatus: 'ready', detail: '当前界面、编号表和位置图已缓存，可离线查号和记录。' });
    } else {
      publish({ offlineStatus: 'error', detail: '离线文件尚未完整准备，请保持联网，关闭应用后重新打开。' });
    }
  } catch {
    if (sequence === statusSequence) publish({ offlineStatus: 'error', detail: '暂时无法确认离线文件；请保持联网使用。' });
  }
}

function observeWorker(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && registration?.waiting) publish({ updateAvailable: true });
    if (worker.state === 'activated') void inspectOfflineState();
    if (worker.state === 'redundant' && !registration?.active) {
      publish({ offlineStatus: 'error', detail: '离线文件下载未完成，请联网重新打开；本机记录仍然保留。' });
    }
  });
}

async function prepareOffline() {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('MessageChannel' in window)) {
    publish({ offlineStatus: 'unavailable', detail: '此浏览器环境暂不支持离线启动，请联网使用。' });
    return;
  }
  try {
    registration = await navigator.serviceWorker.register(new URL('./sw.js', import.meta.url), {
      scope: new URL('./', import.meta.url).pathname, updateViaCache: 'none'
    });
    registration.addEventListener('updatefound', () => observeWorker(registration.installing));
    observeWorker(registration.installing);
    if (registration.waiting) publish({ updateAvailable: true });
    navigator.serviceWorker.addEventListener('controllerchange', () => void inspectOfflineState());
    void navigator.serviceWorker.ready.then(() => inspectOfflineState()).catch(() => {});
    await inspectOfflineState();
    // An available release waits for existing windows to close; no forced
    // reload, skipWaiting, data deletion, or draft interruption occurs.
    if (navigator.onLine) void registration.update().catch(() => {});
  } catch {
    publish({ offlineStatus: 'error', detail: '离线准备未完成，请保持联网使用；本机记录不受影响。' });
  }
}

export function initMobileApp(onChange) {
  if (typeof onChange === 'function') observers.add(onChange);
  if (!started) {
    started = true;
    const standalone = window.matchMedia('(display-mode: standalone)');
    publish({ installed: standalone.matches || navigator.standalone === true });
    standalone.addEventListener?.('change', event => publish({ installed: event.matches || navigator.standalone === true }));
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); installEvent = event;
      publish({ canInstall: !state.installed });
    });
    window.addEventListener('appinstalled', () => {
      installEvent = null; publish({ canInstall: false, installed: true });
    });
    window.addEventListener('online', () => {
      if (!registration && state.offlineStatus !== 'unavailable') void prepareOffline();
      else void inspectOfflineState();
    });
    void prepareOffline();
  }
  if (typeof onChange === 'function') onChange(getMobileAppState());
  return () => observers.delete(onChange);
}

export async function promptMobileInstall() {
  const event = installEvent;
  if (!event || state.installed) return 'unavailable';
  installEvent = null;
  publish({ canInstall: false });
  try {
    // Called directly by the user's install-button action.
    const result = await event.prompt();
    const choice = result || await event.userChoice;
    return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch { return 'unavailable'; }
}
