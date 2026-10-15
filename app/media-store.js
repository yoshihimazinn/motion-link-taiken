(function (root) {
  "use strict";

  // テレビのブラウザの IndexedDB「motion-link-media」（版 1、指示書 4.5.4）。人が増えても localStorage（1つの場所で約5MB）があふれないよう、
  // 大きなもの（家族の声・届いた写真）はここに置く。中身はこのブラウザの中だけで、どこへも送らない。
  //   photos：キー photoId。{photoId, personId, sender, deviceName, sentAt, receivedAt, status, revealedAt, blob}。personId の索引
  //   voices：キー "<personId>:<声の id>"（前の版の1つだけの声は id "cheer"）。{key, personId, voiceId, name, blob, savedAt}。personId の索引
  // IndexedDB が使えないブラウザでは、どの関数も失敗（reject）を返す。呼ぶ側は今までどおりの置き場所（声は記録の dataUrl）で続ける
  const DB_NAME = "motion-link-media";
  const DB_VERSION = 1;
  let opening = null;

  const promised = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const finished = (transaction) => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("aborted"));
  });

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!root.indexedDB) {
        reject(new Error("IndexedDB がありません"));
        return;
      }
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "photoId" }).createIndex("personId", "personId");
        if (!db.objectStoreNames.contains("voices")) db.createObjectStore("voices", { keyPath: "key" }).createIndex("personId", "personId");
      };
      request.onsuccess = () => {
        const db = request.result;
        // ほかのタブが版を上げるときは閉じて、次に使うときに開き直す
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB を開けません"));
    });
    // 開けなかったときは、次に呼ばれたときにもう一度ためす
    opening.catch(() => { opening = null; });
    return opening;
  }

  const voiceKey = (personId, id) => `${personId}:${id || "cheer"}`;

  // 家族の声（応援の声）を書く。書いたあと読み直して、大きさが合ったときだけ true（D-17：合わなければ呼ぶ側は今のまま）
  async function putVoice(personId, { id, name, blob, savedAt }) {
    const db = await open();
    const transaction = db.transaction("voices", "readwrite");
    transaction.objectStore("voices").put({ key: voiceKey(personId, id), personId, voiceId: id || "cheer", name, blob, savedAt });
    await finished(transaction);
    const saved = await getVoice(personId, id);
    return Boolean(saved?.blob) && saved.blob.size === blob.size;
  }

  // id を渡さなければ、前の版の置き場所（"cheer"）
  async function getVoice(personId, id) {
    const db = await open();
    return (await promised(db.transaction("voices").objectStore("voices").get(voiceKey(personId, id)))) || null;
  }

  async function deleteVoice(personId, id) {
    const db = await open();
    const transaction = db.transaction("voices", "readwrite");
    transaction.objectStore("voices").delete(voiceKey(personId, id));
    await finished(transaction);
  }

  // ---- 家族の端末から届いた写真（F2）。status は "waiting"（まだふいていない）か "revealed"（ふいた） ----
  // 届いた写真を入れる。同じ photoId がもうあれば入れない（ふいた写真を「まだ」にもどさない）。入れたら true
  async function putPhoto(record) {
    const db = await open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    let added = false;
    store.get(record.photoId).onsuccess = (event) => {
      if (event.target.result) return;
      store.add({ status: "waiting", revealedAt: null, ...record });
      added = true;
    };
    await finished(transaction);
    return added;
  }

  async function getPhoto(photoId) {
    const db = await open();
    return (await promised(db.transaction("photos").objectStore("photos").get(photoId))) || null;
  }

  // その人の写真（status を渡せばその写真だけ）。送った時刻の古い順
  async function listPhotos(personId, { status } = {}) {
    const db = await open();
    const all = await promised(db.transaction("photos").objectStore("photos").index("personId").getAll(personId));
    return all.filter((item) => !status || item.status === status).sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
  }

  // ふいた写真を "revealed" にする（アルバムの写真として残す）
  async function markRevealed(photoId, revealedAt) {
    const db = await open();
    const transaction = db.transaction("photos", "readwrite");
    const store = transaction.objectStore("photos");
    store.get(photoId).onsuccess = (event) => {
      const record = event.target.result;
      if (record && record.status !== "revealed") store.put({ ...record, status: "revealed", revealedAt });
    };
    await finished(transaction);
  }

  // その人の声と写真をすべて消す（「試作データを初期化」・人を消す）
  async function deletePerson(personId) {
    const db = await open();
    const transaction = db.transaction(["voices", "photos"], "readwrite");
    // 消すのは同じ transaction の中で（読んだ返事の中で続けて消す）
    for (const name of ["voices", "photos"]) {
      const store = transaction.objectStore(name);
      store.index("personId").getAllKeys(personId).onsuccess = (event) => event.target.result.forEach((key) => store.delete(key));
    }
    await finished(transaction);
  }

  root.MotionLinkMediaStore = { DB_NAME, DB_VERSION, open, putVoice, getVoice, deleteVoice, putPhoto, getPhoto, listPhotos, markRevealed, deletePerson };
})(typeof globalThis !== "undefined" ? globalThis : this);
