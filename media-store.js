/**
 * 本地视频存储（IndexedDB）。
 * 面试录像只保存在用户本机的浏览器里，绝不上传云端；报告页/历史页回放时从这里读回。
 * 注意：仅限"本设备 + 本浏览器"，清除浏览器数据 / 换设备 / 无痕模式都会导致录像不可用。
 */
window.MediaStore = (function () {
  const DB_NAME = "aimianjing", STORE = "videos", VERSION = 1;

  function open() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("当前浏览器不支持本地存储(IndexedDB)")); return; }
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("无法打开本地数据库"));
    });
  }

  async function put(key, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  async function get(key) {
    if (!key) return null;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => { db.close(); resolve(r.result || null); };
      r.onerror = () => { db.close(); reject(r.error); };
    });
  }

  async function del(key) {
    if (!key) return true;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  // 尝试申请持久化存储，降低被浏览器自动清理的概率（失败不影响功能）
  function requestPersist() {
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* ignore */ }
  }

  // 约定：记录里的 video_url 以 "local:" 前缀表示本地录像，后接 key
  const PREFIX = "local:";
  return {
    put, get, del, requestPersist,
    PREFIX,
    isLocalRef: (ref) => typeof ref === "string" && ref.startsWith(PREFIX),
    keyOf: (ref) => (typeof ref === "string" && ref.startsWith(PREFIX)) ? ref.slice(PREFIX.length) : null,
    refOf: (key) => PREFIX + key,
  };
})();
