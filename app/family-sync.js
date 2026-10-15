(function (root) {
  "use strict";

  // テレビの画面から家族のしくみ（この PC の 127.0.0.1:<テレビ向けのポート>、指示書 4.6.2）につなぐ部品。URL に family=<ポート> があるときだけ使う。
  // 名簿（PIN はハッシュの PinRecord だけ）・写し・受け取り箱・写真・ペアリング・端末の一覧。
  // 秘密（PIN・端末の合言葉・ペアリングの番号）と返事の中身は、コンソールにもどこにも書かない
  const POLL_MS = 15000;
  const RETRY_MS = 30000;
  const SNAPSHOT_DELAY_MS = 1500;
  const TIMEOUT_MS = 10000;

  // ?family=8791（1〜65535）。?familyPoll=<ミリ秒>（200 以上）は自動テスト用：受け取り箱を見る間隔と、届かなかったときのやり直しを短くする
  function readConfig(search) {
    const params = new URLSearchParams(typeof search === "string" ? search : "");
    const text = params.get("family") || "";
    const port = /^\d{1,5}$/.test(text) ? Number(text) : 0;
    if (port < 1 || port > 65535) return null;
    const poll = Number(params.get("familyPoll"));
    const testPoll = Number.isFinite(poll) && poll >= 200 ? Math.round(poll) : null;
    return {
      port,
      base: `http://127.0.0.1:${port}`,
      pollMs: testPoll || POLL_MS,
      retryMs: testPoll ? Math.max(1000, testPoll * 2) : RETRY_MS,
      snapshotDelayMs: SNAPSHOT_DELAY_MS
    };
  }

  // 失敗：status（届かなかったときは 0）と code（家族のしくみの error。届かなかったときは "offline"）
  function failure(status, code) {
    const error = new Error(`family ${code}`);
    error.status = status;
    error.code = code;
    return error;
  }

  function createClient(config, { fetchImpl = (...args) => root.fetch(...args), timeoutMs = TIMEOUT_MS } = {}) {
    async function request(method, path, { json, as = "json" } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(`${config.base}${path}`, {
            method, cache: "no-store", signal: controller.signal,
            headers: json === undefined ? {} : { "Content-Type": "application/json" },
            body: json === undefined ? undefined : JSON.stringify(json)
          });
        } catch (error) {
          throw failure(0, "offline");
        }
        if (!response.ok) {
          let code = "error";
          try { code = String((await response.json()).error || code); } catch (error) { /* 中身のない失敗 */ }
          throw failure(response.status, code);
        }
        if (response.status === 204) return null;
        try {
          return as === "blob" ? await response.blob() : await response.json();
        } catch (error) {
          throw failure(0, "offline");
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const id = (value) => encodeURIComponent(String(value));
    return {
      status: () => request("GET", "/api/tv/status"),
      putPeople: (body) => request("PUT", "/api/tv/people", { json: body }),
      deletePerson: (personId) => request("DELETE", `/api/tv/persons/${id(personId)}`),
      putSnapshot: (personId, snapshot) => request("PUT", `/api/tv/persons/${id(personId)}/snapshot`, { json: snapshot }),
      inbox: (after) => request("GET", `/api/tv/inbox?after=${Math.max(0, Math.floor(Number(after) || 0))}`),
      ack: (upTo) => request("POST", "/api/tv/inbox/ack", { json: { upTo } }),
      photo: (photoId) => request("GET", `/api/tv/photos/${id(photoId)}`, { as: "blob" }),
      voice: (voiceId) => request("GET", `/api/tv/voices/${id(voiceId)}`, { as: "blob" }),
      pairing: (personId) => request("POST", `/api/tv/persons/${id(personId)}/pairing`),
      devices: (personId) => request("GET", `/api/tv/persons/${id(personId)}/devices`),
      deleteDevice: (deviceId) => request("DELETE", `/api/tv/devices/${id(deviceId)}`),
      feedback: (body) => request("POST", "/api/tv/feedback", { json: body })
    };
  }

  // 1つの送り物（名簿・ある人の写し）を送る係。schedule(delay) で delay ミリ秒後に send() を呼ぶ（前の予定は取り消して、新しい中身で送る）。
  // 送れなければ retryMs ごとにやり直す。送っている間に schedule されたら、送り終えてからもう一度送る
  function createSender(send, { retryMs = RETRY_MS } = {}) {
    let timer = null;
    let running = false;
    let again = false;
    async function run() {
      timer = null;
      running = true;
      again = false;
      let sent = false;
      try {
        await send();
        sent = true;
      } catch (error) { /* 下でやり直す */ }
      running = false;
      if (again) schedule(0);
      else if (!sent) timer = setTimeout(run, retryMs);
    }
    function schedule(delay = 0) {
      if (running) {
        again = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    }
    return { schedule };
  }

  root.MotionLinkFamilySync = { POLL_MS, RETRY_MS, SNAPSHOT_DELAY_MS, readConfig, createClient, createSender };
})(typeof globalThis !== "undefined" ? globalThis : this);
