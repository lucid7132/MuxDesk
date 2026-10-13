const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cmux', {
  profile: {
    load: () => ipcRenderer.invoke('profile:load'),
    save: (profile) => ipcRenderer.invoke('profile:save', profile),
    flush: (profile) => ipcRenderer.send('profile:flush', profile)
  },
  terminal: {
    request: (method, params) => ipcRenderer.invoke('terminal:request', method, params),
    onEvent: (listener) => {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('terminal:event', wrapped);
      return () => ipcRenderer.removeListener('terminal:event', wrapped);
    }
  },
  shortcuts: {
    update: (shortcuts) => ipcRenderer.send('shortcuts:update', shortcuts),
    onPressed: (listener) => {
      const wrapped = (_event, shortcut) => listener(shortcut);
      ipcRenderer.on('shortcut:pressed', wrapped);
      return () => ipcRenderer.removeListener('shortcut:pressed', wrapped);
    }
  },
  window: {
    control: (action) => ipcRenderer.send('window:control', action)
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:read-text'),
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text)
  },
  credentials: {
    set: (id, password) => ipcRenderer.invoke('credentials:set', id, password),
    get: (id) => ipcRenderer.invoke('credentials:get', id),
    delete: (id) => ipcRenderer.invoke('credentials:delete', id)
  },
  external: {
    openUrl: (url) => ipcRenderer.invoke('external:open-url', url)
  }
});
