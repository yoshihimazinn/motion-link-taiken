(function () {
  "use strict";

  const Logic = window.MotionLinkLogic;
  const LocalSensor = window.MotionLinkLocalSensor;
  // PIN のハッシュ（pin-hash.js）と、声・写真の置き場所（media-store.js の IndexedDB）
  const PinHash = window.MotionLinkPinHash;
  const MediaStore = window.MotionLinkMediaStore;
  // 元気の木の絵（plant-view.js。家族のページと同じ描き方）と、家族のしくみにつなぐ部品（family-sync.js）
  const PlantView = window.MotionLinkPlantView;
  const FamilySync = window.MotionLinkFamilySync;
  // index.html で app.js に付けた ?v=（更新のたびに変える）。後から読む motion-ai.js にも付けて、古いファイルを使わない
  const assetVersion = (() => {
    try { return new URL(document.currentScript?.src || "", location.href).searchParams.get("v") || ""; } catch { return ""; }
  })();
  // ?sensor=local のときは端末サービス（深度カメラ）から関節を受け取り、ブラウザではカメラを開かない
  const localSensorConfig = LocalSensor ? LocalSensor.readConfig(window.location.search) : null;
  // ?family=<ポート>：この PC の家族のしくみに、名簿と写しを送り、受け取り箱（届いた写真・呼び名の変更・安全の知らせ）を見る（F1・F2）。
  // なければ null で、家族の端末のことは何もしない（画面も文も今のまま）
  // ?trial=1：ほかの人の PC に配る体験版（配る一式の「Motion-Linkをはじめる」が付ける）。運動と写真あそびだけ。
  // 「設定・運営」は出さず（設定は一切変えられない）、家族のしくみにはつながない。写真あそびは何回でもできる。感想はファイルにして保存する
  const trialMode = new URLSearchParams(window.location.search).get("trial") === "1";
  const familyConfig = FamilySync && !trialMode ? FamilySync.readConfig(window.location.search) : null;
  const familyClient = familyConfig ? FamilySync.createClient(familyConfig) : null;
  const pageParams = new URLSearchParams(window.location.search);
  // ?debug=1：開発・ご家族の確認用。運動画面に細かい数値（体の数値を含む）と「カメラなしで1回」ボタンを出す。本人に案内はしない
  const debugMode = pageParams.has("debug");
  // ?testPose=1：自動テスト用。window.__motionLinkTestPoseEngine（台本どおりの関節を返す偽の骨格AI）を使う。
  // フラグとその偽物の両方があるときだけ働き、数えた回数はデモ扱い（実績・植物・家族への通知に入らない）
  const testPoseMode = pageParams.has("testPose") && !localSensorConfig;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const ADMIN_DEMO_PIN = "2026";
  // 写真あそび：くもりの残りを、写真を小さくした面（QUEST_MASK_WIDTH×QUEST_MASK_HEIGHT）の、実際にふき取った所で数える。
  // ほぼ全部（QUEST_CLEAR_THRESHOLD）ふけたらできあがり（前は、ふいた点の近くのます目で数えていて、ふいた丸より広く数え、
  // 写真が半分ほどくもったままできあがった。よしさん 2026-10-11）
  const QUEST_MASK_WIDTH = 90;
  const QUEST_MASK_HEIGHT = 60;
  const QUEST_CLEAR_THRESHOLD = .95;
  // 写真の画面のカメラの1行（本人が読む。数字・専門用語を出さない）
  const QUEST_CAMERA_TEXT = {
    preparing: "カメラ準備中",
    live: "カメラで見ています",
    away: "カメラの前に座りましょう",
    reconnecting: "カメラをつなぎ直しています",
    paused: "カメラはお休み中です・写真を直接なぞれます",
    finger: "カメラなし・写真を直接なぞれます",
    // 手は動いているのに、くもった所がしばらく減らない（同じ高さだけをふいている）とき。くもりの残る所へ手を向けてもらう
    stalled: "くもっている所へ、手を動かしてみましょう",
    stopped: "カメラを止めました"
  };
  // 写真の画面（端末サービス）：人が映らないまま、これだけたつと座るように言う
  const QUEST_AWAY_MS = 3000;
  // 写真の画面（端末サービス）：手を動かしている時間がこれだけたまっても、くもった所が減らなければ QUEST_CAMERA_TEXT.stalled
  const QUEST_STALL_MS = 5000;
  const QUEST_STALL_GAIN = .01;
  // 写真ができあがってから、次のボタンの所まで画面を送るまで（きれいになった写真をまず見せる）
  const QUEST_DONE_SCROLL_MS = 2000;
  // 骨格AIの準備（モデルの読み込み）をこれ以上待たない。過ぎたら簡易判定で続け、準備ができたら次の運動から使う
  const POSE_LOAD_TIMEOUT_MS = 15000;
  // 本人に見せる画面に出してはいけない文（体の数値・距離・「調整」）。ロジックからの文がこれに当たったら出さない（念のための見張り）
  const FORBIDDEN_FOR_PERSON = /\d\s*(cm|°|度|秒|%|％|fps|m(?![a-zA-Z]))|調整/;
  // 本人をせかす・もっと動かせようとする文（「もう少し高く」など。目標を押しつけない ML-MOTION-05）。当たったら出さず、運動中は今の段階の案内を出す。
  // 「もう少し近づいてください」（位置の案内）は当たらない
  const PUSHY_FOR_PERSON = /(もっと|もう少し).{0,8}(高く|大きく|速く|強く|上げ|伸ば|開)/;
  // ロジックからの文のうち、言いかえれば本人に出せる専門的なことば
  const PLAIN_WORDS_FOR_PERSON = [[/骨格の線/g, "体の線"], [/を認識中/g, "が見えています"]];
  // 端末サービスの camera_status.reason_code → テレビに出す短い文。reason（英語の開発者向けの文）は画面に出さない
  const CAMERA_PROBLEM_TEXT = {
    camera_not_found: "カメラが見つかりません",
    camera_busy: "カメラがほかで使われています",
    camera_disconnected: "カメラとの接続が切れました",
    camera_stalled: "カメラの映像が止まりました",
    sdk_unavailable: "カメラの準備ができません",
    permission_denied: "カメラを使う許可がありません",
    internal: "カメラが使えません"
  };
  // ブラウザのカメラを開けなかったときの文（getUserMedia のエラー名ごと）
  const BROWSER_CAMERA_PROBLEM_TEXT = {
    NotAllowedError: "カメラを使う許可がありません",
    SecurityError: "カメラを使う許可がありません",
    NotFoundError: "カメラが見つかりません",
    OverconstrainedError: "カメラが見つかりません",
    NotReadableError: "カメラがほかで使われています"
  };

  // 判定の版が変わって、覚えていた体の分析を捨てたか（読み込み後に一度だけ知らせる）。loadState より前に宣言する
  let profileDroppedOnLoad = false;
  // 読めなかった保存データ（壊れた JSON など）。上書きする前に控えを残し、家族だけに知らせる（本人には出さない）。loadState より前に宣言する
  let unreadableStorage = null;
  // 運動する人の名簿（F0）。記録は、いま選んでいる人のキー（activePerson().storageKey）に保存する。loadState より前に読む
  let people = loadPeople();
  let state = loadState();
  let selectedIndex = 0;
  let activeSession = null;
  let cameraStream = null;
  let sessionTimer = null;
  let animationFrame = null;
  let demoAnimationFrame = null;
  let previousFrame = null;
  let trackedMotionCenter = { x: .5, y: .48 };
  let motionEnergySmoothed = 0;
  let motionNoiseFloor = 1.5;
  let motionArmed = true;
  let lastLowMotion = 0;
  let lastDetectedRep = 0;
  let poseEngine = null;
  let poseEnginePromise = null;
  // 体の動きを読む仕組み（motion-ai.js）の今の様子。ご家族の欄（管理者PINの先）に1行で出す。
  // idle まだ準備していない / loading 準備中 / ready 使える / missing ファイルが足りない（missingFiles） / failed ほかのわけで動かない
  let poseEngineStatus = { state: "idle", missingFiles: [] };
  let poseConnections = [];
  let poseMode = "idle";
  let poseCounter = null;
  let lastPoseInference = 0;
  let lastPoseLandmarks = null;
  let lastWorldLandmarks = null;
  let filteredPoseLandmarks = null;
  let filteredWorldLandmarks = null;
  let filteredAt = null;
  let lastVideoTime = -1;
  let cameraSourceText = "通常カメラ";
  let poseFpsWindowStart = 0;
  let poseInferenceCount = 0;
  let measuredPoseFps = 0;
  let finishing = false;
  let finishTimer = null;
  let localSensorClient = null;
  let localClockOffset = null;
  let localLastFrame = null;
  let localFrameSize = null;
  // 骨格推定はカメラの新しいコマごとに1回（requestVideoFrameCallback）。推定にかかる時間の移動平均でコマを間引く
  let videoFrameRequest = null;
  let detectCostMs = 0;
  let detectSamples = 0;
  let detectFailures = [];
  // 1回数えたときの合図（短い音・回数のはずみ・映像のふちの光）
  let audioContext = null;
  let repRingTimer = null;
  // 数えた直後の「N回できました」を少しのあいだ残す（次のコマの案内ですぐ消さない）
  let repMessageUntil = 0;
  // 「カメラなしで1回」ボタン：カメラが使えないときだけ出す（?debug=1 では常に出す）
  let demoInputAvailable = false;
  // 位置案内：表示のちらつきを防ぐため、同じ判定が続いたときだけ切り替える
  const emptyPositionGuide = () => ({ shown: null, candidate: null, candidateSince: 0, divergedSince: null, shownSince: 0, textAt: 0,
    firstAt: null, spokenAt: 0, spokenStatus: null });
  let positionGuide = emptyPositionGuide();
  let encouragementAudio = null;
  let guideUtterance = null;
  // 最後に声を出した時刻（performance.now）。節目のひとことは、前の声から少しあけて言う
  let lastVoiceAt = -Infinity;
  let questCameraGeneration = 0;
  let mediaRecorder = null;
  let recordingStream = null;
  let recordedChunks = [];
  let alarmCheckTimer = null;
  let lastAlarmKey = "";
  // 「5分後にもう一度鳴らす」：1つだけ。鳴る時刻を設定画面に出し、「やめる」で取り消せる（このページの中だけ。保存しない）
  let snoozeTimer = null;
  let snoozeUntil = null;
  let toastTimer = null;
  let questCameraStream = null;
  let questAnimationFrame = null;
  let questPreviousFrame = null;
  let questPhotoImage = null;
  let questPointerActive = false;
  let questCompleting = false;
  let questDemoStep = 0;
  // 「デモでふき取る」（?debug=1 だけ）を使った写真は、ためしのふき取り。アルバムには入るが、元気の木はそだてない
  let questUsedDemo = false;
  // くもりの残り（写真と同じふき方で消していく、小さな面）と、ふき取った割合
  let questMask = null;
  // 運営の設定「写真あそびを何回でもできる」で、ふき終えた写真をもう一度ふいている（木もアルバムも変えない）
  let questReplay = false;
  // 写真あそびが終わっているか（もう一度ふいている間は、終わっていないとみなす）
  const questDone = () => state.dailyQuest.completed && !questReplay;
  let questClearedShare = 0;
  // 端末サービス（?sensor=local）のとき：写真の画面のための接続、手首の動きの続き（Logic.questWipeFromPose の state）、
  // 関節が届きはじめた時刻・人を最後に見た時刻（しばらく人がいなければ座るように言う）。
  // カメラがお休み・使えない間はふかない（questSensorHalt に camera_status の state "disabled_by_admin" / "error"。動いていれば null）。
  // 前のコマが届いた時刻と、手が動いているのに、くもった所が減らないままの時間（減れば wipeQuestAt が 0 に戻す）
  let questSensorClient = null;
  let questHandState = null;
  let questLiveAt = null;
  let questPersonSeenAt = null;
  let questSensorHalt = null;
  let questFrameAt = null;
  let questCloudyMovingMs = 0;
  let questStallShare = 0; // 「進まない」の時間をため始めたときの、ふけた割合

  const views = {
    landing: $("#view-landing"),
    home: $("#view-home"),
    session: $("#view-session"),
    quest: $("#view-quest"),
    result: $("#view-result"),
    dashboard: $("#view-dashboard"),
    settings: $("#view-settings")
  };

  // 名簿を読む。はじめて（名簿がない）なら、1人目の記録（今の STORAGE_KEY）を読むだけで、その呼び名とカメラの一時停止を写した名簿を作る。
  // 1人目の記録は書きかえない（キーも中身も同じ）。名簿が読めないときは、控えを残してから、記録のキー（1人目と .p2 …）で見つけた人で作り直す
  // （2人目からの記録を名簿から外さない。次に足す人がその記録を上書きしない）。
  // カメラの一時停止は、読めなかった名簿の tv が読めればその値、読めなければ（はじめて作るときも）1人目の記録の値（止めていたカメラを黙って動かさない）
  function loadPeople() {
    let raw = null;
    let parsed;
    try {
      raw = localStorage.getItem(Logic.PEOPLE_KEY);
      parsed = raw ? JSON.parse(raw) : null;
      const loaded = Logic.hydratePeople(parsed);
      if (loaded) return loaded;
    } catch (error) { /* 下で作り直す */ }
    if (raw) {
      try { localStorage.setItem(`${Logic.PEOPLE_KEY}.unreadable`, raw); } catch (copyError) { /* 容量不足など。名簿は作り直す */ }
    }
    const records = personRecordsInStorage();
    const first = records.find((entry) => entry.id === "p1")?.record;
    const tv = parsed && typeof parsed === "object" ? parsed.tv : null;
    const paused = tv && typeof tv === "object" && typeof tv.cameraTemporarilyDisabled === "boolean" ? tv.cameraTemporarilyDisabled : first?.cameraTemporarilyDisabled === true;
    const created = Logic.rebuildPeople(records.map(({ id, record }) => ({ id, userName: record?.userName })), { cameraTemporarilyDisabled: paused, activeId: parsed?.activeId });
    writePeople(created);
    return created;
  }

  // localStorage にある人ごとの記録（1人目の STORAGE_KEY と、STORAGE_KEY.p2 など。読めなかった控えの .unreadable は除く）：[{ id, record（読めなければ null） }]
  function personRecordsInStorage() {
    const prefix = `${Logic.STORAGE_KEY}.`;
    let keys = [];
    try { keys = Object.keys(localStorage); } catch (error) { keys = []; }
    const found = [];
    for (const key of keys) {
      const id = key === Logic.STORAGE_KEY ? "p1" : key.startsWith(prefix) ? key.slice(prefix.length) : null;
      if (!id || Logic.personStorageKey(id) !== key || !/^p[1-9][0-9]{0,5}$/.test(id)) continue;
      let record = null;
      try { record = JSON.parse(localStorage.getItem(key)); } catch (error) { record = null; }
      found.push({ id, record: record && typeof record === "object" && !Array.isArray(record) ? record : null });
    }
    return found;
  }

  // その記録のキー（か読めなかった控え）がもう localStorage にあるか（人を足すとき、その番号をとばす）
  function storageKeyInUse(key) {
    try {
      return localStorage.getItem(key) !== null || localStorage.getItem(`${key}.unreadable`) !== null;
    } catch (error) { return false; }
  }

  // 同じテレビの画面をいくつか開いたとき：ほかの画面が保存した名簿に合わせる（ほかの画面で足した人を消さない・同じ番号で上書きしない）。
  // 名簿を変える前と、ほかの画面が名簿を変えたとき（storage）に呼ぶ。この画面で選んでいる人はそのまま。
  // その人がほかの画面で消されていれば、最初の人の記録を読む（運動中・写真あそびなら、記録せずに運動選択へもどる）。名簿が読めなければこの画面の名簿のまま。
  // 選んでいる人が変わったら true
  function syncPeople() {
    let stored = null;
    try { stored = Logic.hydratePeople(JSON.parse(localStorage.getItem(Logic.PEOPLE_KEY) || "null")); } catch (error) { stored = null; }
    if (!stored) return false;
    const lost = !stored.people.some((person) => person.id === people.activeId);
    stored.activeId = lost ? stored.people[0].id : people.activeId;
    people = stored;
    if (!lost) {
      // 名前がほかの画面で変わっていれば、呼び名もそろえる（名簿が正）
      state.userName = activePerson().name;
      return false;
    }
    if (activeSession || views.quest.classList.contains("is-active")) navigate("home");
    if (familyNotesUnlocked) hideFamilyNotes();
    cancelSnooze();
    state = loadState();
    selectedIndex = 0;
    todayPickDay = null;
    settleLoadedState();
    return true;
  }

  // ほかの画面が名簿を変えた：合わせて、いま見えている画面を描き直す（人を選ぶ画面は閉じる。並びが変わるため）
  function onPeopleChangedElsewhere(event) {
    if (event.key !== null && event.key !== Logic.PEOPLE_KEY) return;
    const wasPaused = cameraPaused();
    const switched = syncPeople();
    // ほかの画面でカメラを一時停止にした：この画面のカメラもその場で止める
    if (!wasPaused && cameraPaused()) stopCamerasForPause();
    if ($("#person-picker").open) $("#person-picker").close();
    if (views.home.classList.contains("is-active")) {
      if (switched) applyTodayPick();
      renderHome();
    }
    if (views.settings.classList.contains("is-active")) renderSettings();
    if (switched && views.dashboard.classList.contains("is-active")) renderDashboard();
  }

  function writePeople(value) {
    try {
      localStorage.setItem(Logic.PEOPLE_KEY, JSON.stringify(value));
      return true;
    } catch (error) { return false; }
  }

  function savePeople() {
    if (!writePeople(people)) {
      showToast("保存容量を超えました。音声を短くするか小さいファイルを選んでください。");
      return;
    }
    sendPeopleSoon();
  }

  function activePerson() {
    return people.people.find((person) => person.id === people.activeId) || people.people[0];
  }

  // カメラの一時停止はテレビ全体で1つ（名簿の tv。D-20）
  const cameraPaused = () => people.tv.cameraTemporarilyDisabled;

  // 運営の設定（テレビ全体で1つ。logic.js ADMIN_OPTIONS_KEY）。読めないときは、どれも「しない」
  function loadAdminOptions() {
    try {
      const options = Logic.hydrateAdminOptions(JSON.parse(localStorage.getItem(Logic.ADMIN_OPTIONS_KEY) || "null"));
      return trialMode ? { ...options, photoReplay: true } : options;
    } catch (error) { return trialMode ? { ...Logic.hydrateAdminOptions(null), photoReplay: true } : Logic.hydrateAdminOptions(null); }
  }
  let adminOptions = loadAdminOptions();

  // いま選んでいる人の記録を読む。呼び名は名簿の名前にそろえる（名簿が正。前の版で変えた呼び名は、名簿を作るときに写している）
  function loadState() {
    const person = activePerson();
    let raw = null;
    let loaded = null;
    profileDroppedOnLoad = false;
    try {
      raw = localStorage.getItem(person.storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      loaded = Logic.hydrateState(parsed);
      profileDroppedOnLoad = Boolean(parsed?.bodyProfile) && !loaded.bodyProfile;
    } catch (error) {
      // 読めない保存データは、次の保存で消えてしまう前に別の場所（その人のキー＋.unreadable）へ写しておく（1つだけ。新しい方で置きかえる）
      if (raw) {
        const key = `${person.storageKey}.unreadable`;
        let copied = false;
        try {
          localStorage.setItem(key, raw);
          copied = true;
        } catch (copyError) { /* 容量不足など。家族へのお知らせでそう伝える */ }
        unreadableStorage = { copied, key };
      }
      loaded = Logic.makeDefaultState();
    }
    loaded.userName = person.name;
    return loaded;
  }

  // 読めなかった保存データのことを、家族だけに届くお知らせに入れる（設定の「ご家族・運営の方へ」の PIN の先だけで見える）
  function noteUnreadableStorage() {
    if (!unreadableStorage) return;
    const message = unreadableStorage.copied
      ? `保存していた記録を読み込めませんでした。記録は最初からになります。\n読めなかったデータは、このブラウザの「${unreadableStorage.key}」に残しています。`
      : "保存していた記録を読み込めませんでした。記録は最初からになります。\n読めなかったデータの控えも、容量が足りず残せませんでした。";
    const now = new Date();
    state.notifications.unshift({ id: `family-${now.getTime()}-storage`, timestamp: now.toISOString(), audience: "family", kind: "watch", topic: "storage", important: true, immediate: true, message });
    unreadableStorage = null;
    saveState();
  }

  function saveState() {
    try {
      localStorage.setItem(activePerson().storageKey, JSON.stringify(state));
    } catch (error) {
      showToast("保存容量を超えました。音声を短くするか小さいファイルを選んでください。");
      return;
    }
    scheduleSnapshot(activePerson().id);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    // テレビから離れて読むので、長い文ほど長く出す（短くても4.5秒）
    toastTimer = setTimeout(hideToast, Math.max(4500, message.length * 110));
  }

  // 古い知らせを残さない（PIN が通ったあとの「違います」、前の画面の知らせなど）
  function hideToast() {
    clearTimeout(toastTimer);
    toastTimer = null;
    $("#toast").classList.remove("is-visible");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // 本人に見せる説明（お手本・運動の説明）は、文節の切れ目にだけ折り返す。切れ目に <wbr> を入れ、CSS（.phrase-text の word-break: keep-all）で
  // それ以外では折り返さない（「も｜どします」のように言葉の途中で行を分けない。ブラウザの word-break: auto-phrase でも分かれた）。
  // 切れ目：Intl.Segmenter（日本語の辞書）で分けた語の、句読点・空白のあとと、ひらがなだけの語（助詞・送り仮名）のあとに漢字・カタカナ・英数字で
  // 始まる語が来たところ。Intl.Segmenter がなければ切れ目を入れない（1つの塊が行より長いときだけ、CSS の overflow-wrap で途中で折る）
  const phraseSegmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("ja", { granularity: "word" }) : null;
  function phraseHtml(text) {
    const words = phraseSegmenter ? [...phraseSegmenter.segment(String(text))].map((item) => item.segment) : [String(text)];
    return words.map((word, index) => {
      const prev = words[index - 1];
      const cut = prev !== undefined && (/[、。\s]$/.test(prev) || (/^[ぁ-ゟー]+$/.test(prev) && /^[^ぁ-ゟー、。\s]/.test(word)));
      return `${cut ? "<wbr>" : ""}${escapeHtml(word)}`;
    }).join("");
  }
  // 文が変わったときだけ書きかえる（お手本の見出しは毎フレーム呼ばれる）
  function setPhraseText(element, text) {
    if (element.dataset.phrase === text) return;
    element.innerHTML = phraseHtml(text);
    element.dataset.phrase = text;
  }

  function navigate(viewName) {
    if (!views[viewName] || (trialMode && viewName === "settings")) viewName = "landing";
    // 前の画面の知らせを次の画面（運動中など）へ持ち越さない
    hideToast();
    if (viewName !== "session" && viewName !== "result" && activeSession) {
      cleanupSession();
      activeSession = null;
      showToast("運動を終わりました。");
    }
    if (viewName !== "quest") cleanupQuestCamera();
    $("#home-notice").hidden = true;
    Object.entries(views).forEach(([name, element]) => element.classList.toggle("is-active", name === viewName));
    if (viewName !== "settings" && familyNotesUnlocked) hideFamilyNotes();
    if (viewName !== "settings" && peopleAdminUnlocked) hidePeopleAdmin();
    $(".app-header").classList.toggle("is-landing", viewName === "landing");
    // 運動中は上のメニュー（押すと運動が終わる）を隠し、画面を運動だけにする
    document.body.classList.toggle("is-session-view", viewName === "session");
    $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === viewName || (["result", "quest"].includes(viewName) && button.dataset.view === "home")));
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (viewName === "home") {
      applyTodayPick();
      renderHome();
      preloadPoseEngine();
      refreshQuestQueue();
    }
    renderFamilyTexts();
    if (viewName === "dashboard") requestAnimationFrame(renderDashboard);
    if (viewName === "settings") renderSettings();
    focusView(viewName);
  }

  // 画面が変わったら、その画面の最初に使うボタン（なければ見出し）を選んでおく。リモコン・キーボードで上のメニューからたどらなくてよい
  const VIEW_FOCUS = { home: "#start-exercise", result: "#go-dashboard", session: "#session-title" };
  function focusView(viewName) {
    const view = views[viewName];
    const preferred = VIEW_FOCUS[viewName] ? view.querySelector(VIEW_FOCUS[viewName]) : null;
    const target = preferred && !preferred.disabled ? preferred : view.querySelector("h1, h2");
    target?.focus({ preventScroll: true });
    // 選んだボタンが画面の外なら見える所まで送る（リモコンの決定で、見えないボタンを押させない）
    if (target && target.getBoundingClientRect().bottom > window.innerHeight) target.scrollIntoView({ block: "end" });
  }

  function starText(difficulty) {
    return `${difficulty} ${"★".repeat(difficulty)}${"☆".repeat(5 - difficulty)}`;
  }

  // 運動の丸は解放の順に1列（端でつながらない）。選べる運動と、その次の1つ（「つぎの運動」）まで。それより先は数だけ知らせる
  function lastSelectableIndex() {
    const count = homeExerciseCount();
    const lastUnlocked = state.exercises.reduce((last, exercise, index) => exercise.unlocked && index < count ? index : last, 0);
    return Math.min(count - 1, lastUnlocked + 1);
  }

  // 選ぶ画面に出す運動の数（一覧の頭から）。立ってする運動（一覧の最後にまとめてある）は、運営の設定「立ってする運動も出す」のときだけ
  function homeExerciseCount() {
    if (adminOptions.showStanding) return state.exercises.length;
    const firstStanding = state.exercises.findIndex((exercise) => exercise.standing);
    return firstStanding < 0 ? state.exercises.length : Math.max(1, firstStanding);
  }

  // 選んだ丸からの位置 [x, y, 大きさ, 濃さ]。手前（両どなり）と、その外の丸まで描く（それより遠い丸は描かない）
  function relativePosition(index) {
    const delta = index - selectedIndex;
    const narrow = window.innerWidth < 680;
    const positions = narrow
      ? { "-2": [-205, 32, .56, .45], "-1": [-112, -28, .76, .82], "0": [0, 8, 1, 1], "1": [112, -28, .76, .82], "2": [205, 32, .56, .45] }
      : { "-2": [-370, 42, .64, .5], "-1": [-205, -42, .82, .86], "0": [0, 10, 1, 1], "1": [205, -42, .82, .86], "2": [370, 42, .64, .5] };
    return positions[String(delta)] || null;
  }

  // 丸の名前が名前の箱に入らないとき（「肩の上げ下げ」「立ってかかと」など6字の名前を、字の幅の広い書体で）：まず字を小さくする（見える大きさで 20px まで。
  // scale は丸を描く倍率）。それでも入らなければ、字の間を少しだけ詰める（1字あたり最大 1.5px）
  const ORBIT_NAME_MIN_PX = 20;
  function fitOrbitName(name, scale) {
    if (!name) return;
    name.style.fontSize = "";
    name.style.letterSpacing = "";
    if (name.scrollWidth <= name.clientWidth) return;
    const size = parseFloat(getComputedStyle(name).fontSize);
    const floor = Math.ceil(ORBIT_NAME_MIN_PX / scale * 100) / 100;
    if (size > floor) name.style.fontSize = `${Math.max(floor, Math.floor(size * name.clientWidth / name.scrollWidth * 100) / 100)}px`;
    const overflow = name.scrollWidth - name.clientWidth;
    const chars = name.textContent.length;
    if (overflow > 0 && chars > 1) name.style.letterSpacing = `calc(-.02em - ${Math.min(1.5, overflow / chars).toFixed(2)}px)`;
  }

  // かぎの絵（絵文字ではなく線で描く。テレビでも同じ形に見える）
  const LOCK_ICON = '<svg class="lock-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  // 運動の丸の絵：お手本の「動かしきった形」を、動かす所の色つきで
  const ICON_POSE = { phase: 1, progress: 1, inverse: 0, side: "left", rising: true };

  function renderHome() {
    const orbit = $("#exercise-orbit");
    orbit.innerHTML = "";
    const lastIndex = lastSelectableIndex();
    selectedIndex = Math.min(selectedIndex, lastIndex);
    // 「つぎの運動」より先に、まだいくつ運動があるか（名前は出さない）
    const waiting = homeExerciseCount() - 1 - lastIndex;
    state.exercises.forEach((exercise, index) => {
      const position = index <= lastIndex ? relativePosition(index) : null;
      if (!position) return;
      const [x, y, scale, opacity] = position;
      const far = Math.abs(index - selectedIndex) === 2;
      const near = Math.abs(index - selectedIndex) === 1;
      const button = document.createElement("button");
      button.type = "button";
      // 丸はクリック・タッチで選ぶ。リモコン・キーボードは ←→ で選ぶので、丸にはフォーカスを止めない
      button.tabIndex = -1;
      button.className = `orbit-card${index === selectedIndex ? " is-selected" : ""}${exercise.unlocked ? "" : " is-locked is-next"}${near ? " is-near" : ""}${far ? " is-far" : ""}`;
      button.style.setProperty("--x", `${x}px`);
      button.style.setProperty("--y", `${y}px`);
      button.style.setProperty("--scale", scale);
      button.style.setProperty("--opacity", opacity);
      button.dataset.index = String(index);
      button.setAttribute("aria-label", exercise.unlocked ? `${exercise.name} 難易度${exercise.difficulty}` : "つぎの運動 まだ選べません");
      const drawn = Boolean(DEMO_DRAWINGS[exercise.id]);
      // まだ選べない運動は、かぎと「つぎの運動」だけ（名前・難易度は透けさせない。選んだときに下の説明で名前が出る）。
      // 字は、小さく描かれる遠くの丸では読めないので、手前の丸だけ
      button.innerHTML = exercise.unlocked
        ? `<span class="difficulty-badge">${exercise.difficulty} ${"★".repeat(exercise.difficulty)}</span><span class="orbit-body">${drawn ? '<canvas class="exercise-pose" aria-hidden="true"></canvas>' : `<span class="exercise-icon" aria-hidden="true">${exercise.icon}</span>`}<span class="name">${escapeHtml(exercise.shortName || exercise.name)}</span></span>`
        : `<span class="lock-cover">${LOCK_ICON}${scale >= .8 ? "つぎの運動" : ""}</span>`;
      button.addEventListener("click", () => {
        selectedIndex = index;
        renderHome();
        if (!$("#start-exercise").disabled) $("#start-exercise").focus({ preventScroll: true });
      });
      orbit.appendChild(button);
      fitOrbitName(button.querySelector(".name"), scale);
      const canvas = button.querySelector(".exercise-pose");
      if (canvas) drawPose(canvas, exercise.id, ICON_POSE, { icon: true });
      // 「つぎの運動」が手前（となり）にあるときは、その下に、このあとの運動の数を1行
      if (!exercise.unlocked && waiting > 0 && Math.abs(index - selectedIndex) === 1) {
        const note = document.createElement("p");
        note.className = "orbit-rest-note";
        note.style.setProperty("--x", `${x}px`);
        note.textContent = waitingText(waiting);
        orbit.appendChild(note);
      }
    });

    const exercise = state.exercises[selectedIndex];
    const status = exercise.unlocked
      ? exercise.cleared
        ? `<div class="status-row"><p class="status-copy">クリア済み・最高 ${exercise.bestCount}回</p><div class="goal-stepper"><button type="button" data-goal="down" aria-label="目標回数を減らす">−</button><span>目標 ${exercise.userGoal}回</span><button type="button" data-goal="up" aria-label="目標回数を増やす">＋</button></div></div>`
        : `<p class="status-copy">まずは ${exercise.clearThreshold}回</p>`
      : `<p class="status-copy locked-copy">前の運動をクリアすると選べます</p>${waiting > 0 ? `<p class="status-copy rest-copy">${waitingText(waiting)}</p>` : ""}`;
    $("#selected-exercise").innerHTML = `<p class="difficulty-label">難易度 ${starText(exercise.difficulty)}</p><h2>${exercise.name}</h2><p class="phrase-text">${phraseHtml(exercise.description)}</p>${status}`;
    $("#start-exercise").disabled = !exercise.unlocked;
    $("#start-exercise").textContent = exercise.unlocked ? "この運動をはじめる" : "まだ始められません";
    applyTodayRibbon();
    renderDailyQuestTeaser();
    renderVoiceArrival();
    renderPersonSwitch();
  }

  // きょうのおすすめ：実績に数える記録（練習は入れない）と、選べる運動だけを見る。
  // 1. 選べるのにまだ一度もしていない運動（いちばんやさしいもの） 2. きょうまだしていない運動のうち、前にしたのがいちばん前のもの
  // 3. どれもきょうした：最後にした運動（見出しは「きょうも できました」）
  function pickTodayExercise(current, now = new Date()) {
    const today = Logic.localDateKey(now);
    const last = new Map();
    for (const session of current.sessions) {
      const at = Date.parse(session.timestamp);
      if (!Logic.countsTowardProgress(session) || !Number.isFinite(at)) continue;
      if (!last.has(session.exercise_id) || last.get(session.exercise_id).at < at) last.set(session.exercise_id, { at, day: session.dateKey || Logic.localDateKey(new Date(at)) });
    }
    const shown = current === state ? homeExerciseCount() : current.exercises.length;
    const open = current.exercises.map((exercise, index) => ({ id: exercise.id, index })).filter(({ index }) => index < shown && current.exercises[index].unlocked);
    const fresh = open.find(({ id }) => !last.has(id));
    if (fresh) return { index: fresh.index, reason: "new" };
    const waiting = open.filter(({ id }) => last.get(id).day !== today).sort((a, b) => last.get(a.id).at - last.get(b.id).at);
    if (waiting.length) return { index: waiting[0].index, reason: "rest" };
    const latest = open.reduce((best, item) => (!best || last.get(item.id).at > last.get(best.id).at ? item : best), null);
    return { index: latest ? latest.index : 0, reason: "again" };
  }

  // その日はじめて運動選択を開いたときと、運動の結果のあとは、きょうのおすすめを選んでおく（←→ ではいつでも自由に選べる）
  let todayPickDay = null;
  let todayPickPending = false;
  function applyTodayPick() {
    const today = Logic.localDateKey(new Date());
    if (!todayPickPending && todayPickDay === today) return;
    selectedIndex = pickTodayExercise(state).index;
    todayPickDay = today;
    todayPickPending = false;
  }

  const TODAY_RIBBON = "きょうのおすすめ";
  const TODAY_LINE = "きょうは この運動は いかがですか";
  const HOME_EYEBROW = "きょうも、無理なく一歩ずつ";
  const HOME_EYEBROW_AGAIN = "きょうも できました。またいつでも どうぞ";
  // おすすめの丸に札をつけ、おすすめを選んでいる間だけ説明に1行。どれもきょうした日は見出しの上の1行を変える。
  // 札は選んだ丸・となりの丸だけ（遠くの丸は名前と同じく字を出さない。札が丸の入れ物の下で切れる）
  function applyTodayRibbon() {
    const pick = pickTodayExercise(state);
    $("#view-home .hero-copy .eyebrow").textContent = pick.reason === "again" ? HOME_EYEBROW_AGAIN : HOME_EYEBROW;
    const card = $(`#exercise-orbit .orbit-card[data-index="${pick.index}"]`);
    if (card && !card.classList.contains("is-far")) {
      card.classList.add("is-today");
      const ribbon = document.createElement("span");
      ribbon.className = "today-ribbon";
      ribbon.textContent = TODAY_RIBBON;
      card.appendChild(ribbon);
    }
    if (pick.index === selectedIndex) {
      const line = document.createElement("p");
      line.className = "today-copy";
      line.textContent = TODAY_LINE;
      $("#selected-exercise").prepend(line);
    }
  }

  // 孫からの写真の知らせ。きれいにしたあとは「今日」と言い続けず、アルバムへの1行だけにする（毎日の写真は届かないので）。
  // 家族の端末から届いた写真（F2）は送る人の名前で。ふいたすぐあとに次の写真があれば「つぎの写真も届いています」。
  // ごほうびの欄は、木が育つときだけ（同梱の写真は3回分、家族の写真はその日はじめての1枚で1回分。D-08）
  function renderDailyQuestTeaser() {
    const quest = state.dailyQuest;
    const family = quest.source === "family";
    const teaser = $("#daily-quest-teaser");
    const replayable = quest.completed && adminOptions.photoReplay;
    teaser.classList.toggle("is-complete", quest.completed);
    $("#daily-quest-teaser-title").textContent = quest.completed
      ? (family ? "写真はアルバムにあります" : "孫の写真はアルバムにあります")
      : !family ? "孫から写真が届きました" : questNextAfterWipe === quest.id ? "つぎの写真も届いています" : `${quest.sender}から 写真が届きました`;
    $("#daily-quest-teaser-detail").textContent = replayable ? "もう一度くもらせて、ふき取って遊べます。" : quest.completed ? "" : "カメラの前で手を動かして、写真のくもりをふき取りましょう。";
    $("#start-daily-quest").textContent = replayable ? "もう一度ふく" : quest.completed ? "アルバムを見る" : "写真をきれいにする";
    const reward = quest.completed ? "" : questRewardText();
    $(".quest-teaser-reward strong").textContent = reward;
    $(".quest-teaser-reward").hidden = !quest.completed && !reward;
  }
  // 写真あそびのごほうびの1行。木が育たない家族の写真（その日2枚目から・クリアした実績の回の数に届いた。D-08）は ""
  function questRewardText() {
    if (state.dailyQuest.source !== "family") return "木が3回分そだちます";
    return Logic.familyPhotoGrowth(state, Date.now()) ? "木が1回分そだちます" : "";
  }

  // 回数が0回で終えたとき：運動選択の見出しの場所に、やさしいひとことを出す（次に画面が変わると消える）
  function showHomeNotice() {
    $("#home-notice").hidden = false;
  }

  const waitingText = (count) => `このあと ${count} つの運動が まっています`;

  // ←→：はじめの運動で止まり、「つぎの運動」で止まる（端から反対の端へ飛ばない）。
  // 押したあとも選んでいる所は変えない（←→のボタンを押したらそのボタン、キーなら「この運動をはじめる」）
  function changeSelection(delta, pressed = null) {
    selectedIndex = Math.max(0, Math.min(lastSelectableIndex(), selectedIndex + delta));
    renderHome();
    const start = $("#start-exercise");
    (pressed || (start.disabled ? $("#previous-exercise") : start)).focus({ preventScroll: true });
  }

  // リモコンの矢印だけで選べるように。運動中は見えているボタンを左から順に
  const SESSION_ROW = ["#back-home", "#camera-view", "#pause-session", "#finish-session", "#camera-retry", "#demo-rep"];
  // 運動中の画面の上の帯（使い方のカードに隠れない）
  const SESSION_TOP_ROW = SESSION_ROW.slice(0, 4);
  const ARROW_STEPS = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  const usableButtons = (selectors) => selectors.map((selector) => $(selector)).filter((button) => button && !button.disabled && button.getClientRects().length);

  // 並びの中で隣へ（端で止まる）。並びの外を選んでいるときは、決めたボタン（start）から
  function moveFocusAlong(buttons, step, start) {
    const index = buttons.indexOf(document.activeElement);
    const target = index < 0 ? start : buttons[Math.max(0, Math.min(buttons.length - 1, index + step))];
    target?.focus({ preventScroll: true });
  }

  // 運動選択の ↑↓ は「{名前}」（2人以上のとき）→「つかい方」→「この運動をはじめる」（押せないときは ←）→「写真をきれいにする」の順
  function moveHomeFocus(step) {
    const start = $("#start-exercise");
    const middle = start.disabled ? "#previous-exercise" : "#start-exercise";
    moveFocusAlong(usableButtons(["#person-switch", "#replay-intro", middle, "#start-daily-quest", "#play-arrival"]), step, $(middle));
    document.activeElement?.scrollIntoView({ block: "nearest" });
  }

  // 運動中は「一時停止」（いちばん使うボタン）から
  function moveSessionFocus(step) {
    moveFocusAlong(usableButtons(SESSION_ROW), step, $("#pause-session"));
  }

  function updateGoal(delta) {
    const exercise = state.exercises[selectedIndex];
    if (!exercise.cleared) return;
    exercise.userGoal = Math.max(1, Math.min(99, exercise.userGoal + delta));
    saveState();
    renderHome();
  }

  async function beginSession() {
    // 二度押し・リモコンの決定キーで2つ始めない（カメラやタイマーが二重になる）
    if (activeSession || views.session.classList.contains("is-active")) return;
    const exercise = state.exercises[selectedIndex];
    if (!exercise.unlocked) return;
    // 音はボタンを押した操作の中で用意する（ブラウザは操作なしに音を出させない）
    try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); } catch { audioContext = null; }
    const target = Logic.getTarget(exercise);
    activeSession = {
      exerciseId: exercise.id,
      startedAt: Date.now(),
      count: 0,
      target,
      paused: false,
      pausedAt: 0,
      pausedTotal: 0,
      usedCamera: false,
      poseFrames: 0,
      validPoseFrames: 0,
      poseQualitySum: 0,
      poseQualitySamples: 0,
      rangeQualitySum: 0,
      rangeQualitySamples: 0,
      cycleDurationSum: 0,
      cycleDurationSamples: 0,
      usedHighAccuracyPose: false,
      halfwayPlayed: false,
      // 声：カメラが見はじめたときの「始めます」・節目のひとこと・「椅子にすわって」・「カメラが使えません」は、それぞれ1回だけ
      startLine: `${exercise.name}を始めます。無理せず、ゆっくりいきましょう。`,
      liveAt: null,
      milestones: {},
      seatPromptSpoken: false,
      unavailableSpoken: false,
      demoInstruction: exercise.demoInstruction,
      // 開始時点の運営基準と方式を固定する（途中で設定が変わっても判定に使わない）
      clearThreshold: exercise.clearThreshold,
      practiceClears: adminOptions.practiceClears,
      repSources: { pose: 0, rgbd: 0, mock: 0, fallback: 0, demo: 0 },
      // 簡易判定になったわけ（files-missing / engine-failed / engine-late）。練習の記録のわけとしてご家族の欄だけに出す
      fallbackReason: null,
      poseModel: "",
      spatialMode: "",
      // 体の分析の下書き（座って足踏み）：この人向けのしきい値（開始時に固定）、pose/rgbd で数えた1回ごとの数値、
      // 座って静止している間の体の大きさ、計測の質。終了時に learnMarchSession で確定する（途中では何も変えない）
      limitsSnapshot: exercise.id === "chair-march" ? Logic.marchOverridesFromProfile(state.bodyProfile) : {},
      learned: [],
      bodySamples: [],
      bodySampleTick: 0,
      quality: Logic.emptyMarchQuality()
    };
    finishing = false;
    previousFrame = null;
    trackedMotionCenter = { x: .5, y: .48 };
    motionEnergySmoothed = 0;
    motionNoiseFloor = 1.5;
    motionArmed = true;
    lastLowMotion = Date.now();
    lastDetectedRep = 0;
    poseMode = "idle";
    poseCounter = Logic.createPoseCounter(exercise.id, performance.now(), { limits: activeSession.limitsSnapshot });
    localClockOffset = null;
    lastPoseInference = 0;
    lastPoseLandmarks = null;
    lastWorldLandmarks = null;
    filteredPoseLandmarks = null;
    filteredWorldLandmarks = null;
    lastVideoTime = -1;
    cameraSourceText = "通常カメラ";
    poseFpsWindowStart = performance.now();
    poseInferenceCount = 0;
    measuredPoseFps = 0;
    $("#session-title").textContent = exercise.name;
    $("#session-difficulty").textContent = `難易度 ${starText(exercise.difficulty)}`;
    setPhraseText($("#demo-instruction-title"), exercise.demoInstruction);
    setPhraseText($("#demo-instruction-detail"), exercise.demoDetail);
    $("#target-count").textContent = target;
    $("#current-count").textContent = "0";
    $("#session-progress").style.width = "0%";
    $("#motion-feedback").textContent = "";
    repMessageUntil = 0;
    resetDemoPose();
    $("#pause-session").textContent = "一時停止";
    views.session.classList.remove("is-paused");
    setCameraStage("starting");
    setCameraState("preparing", "カメラ準備中");
    $("#tracking-confidence").textContent = "準備中";
    demoInputAvailable = false;
    syncDemoButton();
    syncCameraView();
    resetPrecisionPanel();
    renderAnalysisPill();
    navigate("session");
    clearInterval(sessionTimer);
    sessionTimer = setInterval(updateSessionTimer, 500);
    demoAnimationFrame = requestAnimationFrame(animateDemoStickman);
    updateSessionTimer();
    // はじめての運動では、映像の上に使い方を出す（数えるのは下で始まっている）
    if (!introSeen()) showIntro();
    // カメラの準備に1秒より長くかかるときだけ、待つよう声で知らせる（すぐ見はじめたら「始めます」から。setCameraState）。
    // カメラが使えない・ご家族が止めている・つなぎ直し中なら言わない
    const session = activeSession;
    setTimeout(() => {
      if (activeSession === session && session.liveAt === null && cameraStateKind === "preparing" && !session.paused) speakQueued(placeVoice(session.exerciseId).wait);
    }, WAIT_VOICE_DELAY_MS);
    await setupCamera();
  }

  // はじめての使い方：3枚のカードを1枚ずつ。見たかどうかは運動の記録とは別のキーに覚える（「試作データを初期化」で消す）。
  // 保存できないブラウザでも、開いている間は二度出さない
  const INTRO_KEY = "motion-link-intro-seen";
  // 文は区切り（｜）の所でだけ折り返す（「正｜面」のような語の途中で折り返さない）
  const INTRO_CARDS = [
    "テレビの上の｜カメラの正面に、｜椅子を置いて すわります",
    "あなたの姿に 体の線が出たら 準備OK",
    "1回できると 音が鳴って 数字が増えます"
  ];
  // 運動中の使い方は、位置案内が「ちょうどいい位置です」の間だけ自分で進む（もう座れている）。
  // 1枚目は「ちょうどいい位置です」が2秒続いたら、2枚目・3枚目は読む時間（ms）ののちに次へ。3枚目のあとで閉じて、見たことにする
  const INTRO_AUTO_MS = [2000, 4000, 5000];
  let introSeenHere = false;
  let introCard = -1;
  let introCardAt = 0;
  let introReturnFocus = null;
  const introOpen = () => introCard >= 0;
  // 運動中の映像の上に出ている使い方（運動選択の「つかい方」から開いたものではない）
  const sessionIntroOpen = () => introOpen() && !$("#intro").classList.contains("is-standalone");

  function introSeen() {
    if (introSeenHere) return true;
    try { return localStorage.getItem(INTRO_KEY) === "1"; } catch { return false; }
  }

  function markIntroSeen() {
    introSeenHere = true;
    try { localStorage.setItem(INTRO_KEY, "1"); } catch { /* 保存できなくても、開いている間は出さない */ }
  }

  // standalone：運動選択の「つかい方」から（画面のまん中に）。そうでなければ運動中の映像の上に重ねる
  function showIntro(standalone = false) {
    const intro = $("#intro");
    const host = standalone ? document.body : $(".camera-panel");
    if (intro.parentElement !== host) host.appendChild(intro);
    intro.classList.toggle("is-standalone", standalone);
    introReturnFocus = standalone ? document.activeElement : null;
    intro.hidden = false;
    showIntroCard(0);
    $("#intro-next").focus({ preventScroll: true });
  }

  function showIntroCard(index) {
    introCard = index;
    introCardAt = performance.now();
    $("#intro-text").innerHTML = INTRO_CARDS[index].split("｜").map(escapeHtml).join("<wbr>");
    $$("#intro [data-card]").forEach((picture) => picture.toggleAttribute("hidden", Number(picture.dataset.card) !== index));
    $$("#intro .intro-dots i").forEach((dot, dotIndex) => dot.classList.toggle("is-current", dotIndex === index));
    $("#intro-next").textContent = index < INTRO_CARDS.length - 1 ? "次へ" : "わかった";
    // 3枚目：数えたときの音を1回だけ聞かせる
    if (index === INTRO_CARDS.length - 1) playRepChime();
  }

  function advanceIntro() {
    if (!introOpen()) return;
    if (introCard < INTRO_CARDS.length - 1) showIntroCard(introCard + 1);
    else closeIntro(true);
  }

  // seen：最後まで見た・とばした・座れて自分で閉じた。運動が途中で終わって閉じるときは覚えない（次の運動でまた出す）
  function closeIntro(seen) {
    if (!introOpen()) return;
    const intro = $("#intro");
    const hadFocus = intro.contains(document.activeElement);
    introCard = -1;
    intro.hidden = true;
    if (seen) markIntroSeen();
    if (!hadFocus) return;
    const target = introReturnFocus && introReturnFocus.isConnected ? introReturnFocus : views.session.classList.contains("is-active") ? $("#session-title") : null;
    target?.focus({ preventScroll: true });
    introReturnFocus = null;
  }

  // 取得や読込を待っている間に、離脱・別セッション開始・管理者停止が起きていないか確認する。
  function isCurrentCameraRequest(session) {
    return Boolean(session) && activeSession === session && !cameraPaused() && views.session.classList.contains("is-active");
  }

  function stopStream(stream) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  // ブラウザのカメラを開く。理想の大きさ・コマ数で開けないカメラ（暗い部屋で15コマしか出ない等）は、条件なしでもう一度だけ試す
  async function openBrowserCamera() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, facingMode: "user" },
        audio: false
      });
    } catch (error) {
      if (!["OverconstrainedError", "NotReadableError"].includes(error?.name)) throw error;
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    }
  }

  async function setupCamera() {
    const session = activeSession;
    if (cameraPaused()) {
      showCameraUnavailable("管理者設定でカメラを一時停止中", { paused: true });
      return;
    }
    if (localSensorConfig) {
      await setupLocalSensor(session);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraUnavailable("このブラウザではカメラを利用できません");
      return;
    }
    let requestedStream = null;
    try {
      requestedStream = await openBrowserCamera();
      if (!isCurrentCameraRequest(session)) {
        stopStream(requestedStream);
        if (activeSession === session && cameraPaused()) showCameraUnavailable("管理者設定でカメラを一時停止中", { paused: true });
        return;
      }
      cameraStream = requestedStream;
      const video = $("#camera-video");
      video.srcObject = cameraStream;
      await video.play();
      if (!isCurrentCameraRequest(session) || cameraStream !== requestedStream) {
        stopStream(requestedStream);
        if (cameraStream === requestedStream) {
          cameraStream = null;
          video.srcObject = null;
        }
        return;
      }
      const videoTrack = requestedStream.getVideoTracks()[0];
      const trackSettings = videoTrack?.getSettings?.() || {};
      const trackLabel = videoTrack?.label || "";
      const isGeminiCamera = /orbbec|gemini\s*335/i.test(trackLabel);
      cameraSourceText = isGeminiCamera
        ? "Gemini 335・RGB"
        : `${trackSettings.width || video.videoWidth || "—"}×${trackSettings.height || video.videoHeight || "—"}・RGB`;
      $("#sensor-source").textContent = cameraSourceText;
      activeSession.usedCamera = true;
      // 「もう一度ためす」でカメラが開いたら、「カメラなしで1回」（と Space）はしまう。押せば本物の運動が練習の記録になってしまう
      activeSession.cameraUnavailable = false;
      demoInputAvailable = false;
      syncDemoButton();
      syncCameraView();
      // 2回目からは骨格AIが用意済みなので、待ちの案内は出さない
      setCameraStage(poseEngine ? "hidden" : "loading");
      setCameraState("preparing", "高精度骨格を準備中");
      resizeOverlay();
      poseMode = "loading";
      animationFrame = requestAnimationFrame(processCameraFrame);
      startVideoFrameInference(video, session, requestedStream);
      const engine = await loadPoseEngineWithTimeout();
      if (!isCurrentCameraRequest(session) || cameraStream !== requestedStream) return;
      setCameraStage("hidden");
      if (engine) usePoseEngine(engine);
      else {
        switchToFallback(fallbackReasonFor(engine));
        if (engine === undefined) takeOverWhenPoseReady(session, requestedStream);
      }
    } catch (error) {
      // 映像を再生できなかったときも、カメラは必ず止める（「カメラなし」と出しながら動かし続けない）
      stopStream(requestedStream);
      if (requestedStream && cameraStream === requestedStream) {
        cameraStream = null;
        $("#camera-video").srcObject = null;
      }
      if (activeSession === session) {
        showCameraUnavailable("カメラなし・デモ入力で体験できます", { title: BROWSER_CAMERA_PROBLEM_TEXT[error?.name], retry: true });
      }
    }
  }

  function usePoseEngine(engine) {
    poseMode = "pose";
    // 前の運動で続けて失敗した骨格AIをまた使うときも、今は使えている
    setPoseEngineStatus("ready");
    activeSession.usedHighAccuracyPose = true;
    activeSession.poseModel = `${engine.model}/${engine.delegate}`;
    setCameraState("pose", `骨格AI・RGB推定 ${engine.model}（${engine.delegate}）`);
  }

  // 骨格AIを使えないとき：画像の動きの大きさで数える（練習の記録になる）。reason は練習になったわけ（ご家族の欄だけに出す）
  function switchToFallback(reason) {
    poseMode = "fallback";
    activeSession.fallbackReason = reason;
    hidePositionGuide();
    setCameraState("fallback", "照明補正つき簡易判定");
    $("#tracking-confidence").textContent = "簡易";
  }

  async function setupLocalSensor(session) {
    const client = new LocalSensor.LocalSensorClient(localSensorConfig, {
      onFrame: (frame) => handleLocalFrame(session, client, frame),
      onStatus: (status) => handleLocalStatus(session, client, status),
      // 新しい接続部品だけが呼ぶ（古い local-sensor.js は呼ばない）。つなぎ直している間は回数が止まり、戻れば続きから数える
      onReconnecting: () => {
        if (activeSession !== session || localSensorClient !== client) return;
        localStreaming = false;
        showCameraReconnecting("端末サービスへ再接続中");
        syncCameraView();
      },
      // 起動し直した端末サービスの hello で、色つき映像を出せるかを決め直す（出せなくなったらボタンを隠して線だけ）
      onReconnected: (hello) => {
        if (activeSession === session && localSensorClient === client) {
          localPreviewOffer = hello?.color_preview || null;
          setCameraStage("starting");
          setCameraState("preparing", "端末サービスに再接続しました");
          syncCameraView();
        }
      },
      onDisconnect: () => {
        if (activeSession !== session || localSensorClient !== client) return;
        localSensorClient = null;
        client.close();
        showCameraUnavailable("端末サービスとの接続が切れました", { title: CAMERA_PROBLEM_TEXT.camera_disconnected, retry: true });
      }
    });
    localSensorClient = client;
    setCameraState("preparing", "端末サービスに接続中");
    let hello;
    try {
      hello = await client.connect();
    } catch (error) {
      if (localSensorClient === client) {
        localSensorClient = null;
        if (activeSession === session) showCameraUnavailable("端末サービスに接続できません・デモ入力で体験できます", { title: "カメラにつながりません", retry: true });
      }
      client.close();
      return;
    }
    if (!isCurrentCameraRequest(session) || localSensorClient !== client) {
      client.close();
      return;
    }
    activeSession.usedCamera = true;
    poseMode = "local";
    // 端末サービスでは motion-ai.js を読み込まないので、骨格の線と描画領域の大きさをここで用意する
    if (!poseConnections.length) poseConnections = LocalSensor.CONNECTIONS;
    resizeOverlay();
    // --color-preview の端末サービスだけ、色つき映像を出せる（ない・古い端末サービスでは線だけ）
    localPreviewOffer = hello?.color_preview || null;
    client.start(activeSession.exerciseId);
    syncCameraView();
  }

  function handleLocalStatus(session, client, status) {
    if (activeSession !== session || localSensorClient !== client) return;
    localStreaming = status.state === "streaming";
    const demoText = status.is_demo ? "（模擬）" : "";
    if (status.state === "streaming") {
      session.localHalt = null;
      setCameraStage("hidden");
      setCameraState(status.is_demo ? "mock" : "rgbd", `深度カメラ・端末サービス${demoText}`);
      // カメラが戻ったら「カメラなしで1回」はしまう
      activeSession.cameraUnavailable = false;
      demoInputAvailable = false;
      syncDemoButton();
    } else if (status.state === "disabled_by_admin") {
      session.localHalt = "disabled_by_admin";
      showCameraUnavailable("端末側でカメラを一時停止中", { paused: true });
    } else if (status.state === "enabled_idle" && session.localHalt === "disabled_by_admin" && !finishing) {
      // 端末側の一時停止が解けた。運動の画面を開いたときにもう止まっていたなら、端末サービスはこの接続のカメラを始めていないので、始め直す
      // （動いている間に止められたときは、端末サービスが自分で始め直す。送り直しても同じカメラのまま）
      session.localHalt = null;
      setCameraStage("starting");
      setCameraState("preparing", `深度カメラを準備中${demoText}`);
      client.start(session.exerciseId);
    } else if (status.state === "reconnecting") {
      showCameraReconnecting(`深度カメラを再接続中（${cameraProblemCode(status)}）`);
    } else if (status.state === "error") {
      // reason は開発者向けの英文なので、どこにも出さない。reason_code だけを決まった日本語に置きかえる
      const code = cameraProblemCode(status);
      showCameraUnavailable(`カメラを使えません（${code}）`, { title: CAMERA_PROBLEM_TEXT[code] });
    } else if (status.state === "starting") {
      setCameraStage("starting");
      setCameraState("preparing", `深度カメラを準備中${demoText}`);
    }
    syncCameraView();
  }

  // 知らない reason_code（古い・新しい端末サービス）は internal として扱う
  function cameraProblemCode(status) {
    return Object.hasOwn(CAMERA_PROBLEM_TEXT, status?.reason_code) ? status.reason_code : "internal";
  }

  function handleLocalFrame(session, client, frame) {
    if (activeSession !== session || localSensorClient !== client || !isCurrentCameraRequest(session)) return;
    if (activeSession.paused || finishing) return;
    localFrameSize = frame.image ? { width: frame.image.width, height: frame.image.height } : null;
    if (!activeSession.poseModel) activeSession.poseModel = String(frame.model_id || "").slice(0, 40);
    const { landmarks, world } = LocalSensor.toLandmarks(frame);
    cameraSourceText = frame.is_demo ? "模擬RGB-D" : `RGB-D ${frame.image?.width || "—"}×${frame.image?.height || "—"}`;
    const depthMeters = LocalSensor.medianDepth(frame, Logic.FRAMING_JOINTS[activeSession.exerciseId] || []);
    handlePoseLandmarks(landmarks, world, localFrameTime(frame), frame.is_demo ? "mock" : "rgbd", { depthMeters, fyN: LocalSensor.normalizedFy(frame) });
    drawDetectedPose(lastPoseLandmarks);
  }

  // 端末サービスのフレームは、届いた時刻ではなく撮った時刻（monotonic_ms）で数える。画面が固まってフレームがまとめて届いても、
  // ひざを上げていた時間を正しく測れる。時計の差は最初のフレームで合わせる。遅れて届いただけでは合わせ直さず、
  // 撮った時刻そのものが戻った、または届いた間隔より1秒以上先へ進んだ（端末の再起動など）ときだけ合わせ直す。時刻は戻さない
  function localFrameTime(frame) {
    const arrivedAt = performance.now();
    const capturedMs = frame.monotonic_ms;
    const last = localClockOffset === null ? null : localLastFrame;
    let frameTime = arrivedAt;
    if (Number.isFinite(capturedMs)) {
      if (!last || !Number.isFinite(last.capturedMs) || capturedMs < last.capturedMs
        || capturedMs - last.capturedMs > arrivedAt - last.arrivedAt + 1000) localClockOffset = arrivedAt - capturedMs;
      frameTime = capturedMs + localClockOffset;
    }
    if (last) frameTime = Math.max(frameTime, last.frameTime);
    localLastFrame = { capturedMs, arrivedAt, frameTime };
    return frameTime;
  }

  // ---- 見せ方（映像と線・映像だけ・線だけ） ----
  // 選んだ見せ方はテレビ（このブラウザ）ごとに覚える。数え方は変えない：数える入力元・関節の流れ・registerRep は同じで、描くものだけが変わる。
  // 映像が出せないとき（端末サービスが色つき映像を出さない・カメラが使えない）はボタンを隠して線だけで見せる。覚えた見せ方は消さない
  const CAMERA_VIEW_KEY = "motion-link-camera-view";
  const CAMERA_VIEW_ORDER = ["both", "video", "lines"];
  const CAMERA_VIEW_TEXT = {
    both: ["見え方：映像と線", "画面の見え方を変えます。いまは、映像と体の線"],
    video: ["見え方：映像だけ", "画面の見え方を変えます。いまは、映像だけ"],
    lines: ["見え方：線だけ", "画面の見え方を変えます。いまは、体の線だけ"]
  };
  // 端末サービスの絵（--color-preview）がこの間とどかないときは、線だけで見せる（ボタンは残す。絵がまた来たら戻る）
  const PREVIEW_STALE_MS = 3000;
  let cameraView = loadCameraView();
  // いま画面に出している見せ方（映像が出せないときは lines）
  let cameraViewShown = "lines";
  let localPreviewOffer = null;
  let localStreaming = false;
  let previewClient = null;
  let previewDrawing = false;
  let previewShownAt = -Infinity;
  let previewStaleTimer = null;
  let previewRetryTimer = null;

  function loadCameraView() {
    try {
      const saved = localStorage.getItem(CAMERA_VIEW_KEY);
      return CAMERA_VIEW_ORDER.includes(saved) ? saved : "both";
    } catch { return "both"; }
  }

  // 押すたびに 映像と線 → 映像だけ → 線だけ → 映像と線。知らせは出さない（画面が変わるのが答え）。選んだままにする（続けて押せる）
  function nextCameraView() {
    cameraView = CAMERA_VIEW_ORDER[(CAMERA_VIEW_ORDER.indexOf(cameraView) + 1) % CAMERA_VIEW_ORDER.length];
    try { localStorage.setItem(CAMERA_VIEW_KEY, cameraView); } catch { /* 覚えられなくても、開いている間は切り替わる */ }
    syncCameraView();
  }

  function videoAvailable() {
    if (!activeSession || activeSession.cameraUnavailable) return false;
    return localSensorConfig ? Boolean(localPreviewOffer && localSensorClient) : Boolean(cameraStream);
  }

  function syncCameraView() {
    const available = videoAvailable();
    const button = $("#camera-view");
    if (!available && document.activeElement === button && views.session.classList.contains("is-active")) $("#pause-session").focus({ preventScroll: true });
    button.hidden = !available;
    const [label, aria] = CAMERA_VIEW_TEXT[cameraView];
    setTextIfChanged(button, label);
    button.setAttribute("aria-label", aria);
    const previewFresh = performance.now() - previewShownAt <= PREVIEW_STALE_MS;
    cameraViewShown = available && (!localSensorConfig || previewFresh) ? cameraView : "lines";
    const panel = $(".camera-panel");
    CAMERA_VIEW_ORDER.forEach((view) => panel.classList.toggle(`view-${view}`, view === cameraViewShown));
    panel.classList.toggle("uses-preview", Boolean(localSensorConfig));
    if (cameraViewShown === "video") clearPoseOverlay();
    syncPreviewClient();
  }

  // 端末サービスの絵は、選んだ見せ方が映像を使い、カメラが映っている間だけ受け取る（線だけ・止まった・運動の終わりで閉じる）
  function syncPreviewClient() {
    const session = activeSession;
    const wanted = Boolean(session && localPreviewOffer && localSensorClient && localStreaming && cameraView !== "lines"
      && !session.cameraUnavailable && isCurrentCameraRequest(session));
    if (!wanted) {
      closePreview();
      return;
    }
    if (previewClient) return;
    clearTimeout(previewRetryTimer);
    previewRetryTimer = null;
    const client = new LocalSensor.PreviewClient(localSensorConfig, {
      onImage: (blob) => { if (previewClient === client) drawPreviewImage(client, blob); },
      // 端末サービスの側から閉じた（カメラを止めた・送れなかった）：まだ映っていれば、少し待って開き直す
      onClose: () => {
        if (previewClient !== client) return;
        previewClient = null;
        previewRetryTimer = setTimeout(() => {
          previewRetryTimer = null;
          if (activeSession === session) syncCameraView();
        }, 1000);
      }
    });
    previewClient = client;
    client.open();
  }

  function closePreview() {
    clearTimeout(previewRetryTimer);
    previewRetryTimer = null;
    previewClient?.close();
    previewClient = null;
  }

  // 絵を描くだけ（保存しない。toDataURL・toBlob・getImageData は使わない）。前の絵を描いている途中なら、新しい1枚は捨てる。
  // 関節の線は同じ縦横比の画像の座標なので、同じ CSS（object-fit: contain・左右を返す）で映像とそろう
  async function drawPreviewImage(client, blob) {
    if (previewDrawing) return;
    previewDrawing = true;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
      if (previewClient !== client) return;
      const canvas = $("#camera-preview");
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      previewShownAt = performance.now();
      clearTimeout(previewStaleTimer);
      previewStaleTimer = setTimeout(syncCameraView, PREVIEW_STALE_MS + 100);
      if (cameraViewShown !== cameraView) syncCameraView();
    } catch (error) {
      // 読めない絵は捨てる（線はそのまま）
    } finally {
      bitmap?.close();
      previewDrawing = false;
    }
  }

  function clearCameraPreview() {
    closePreview();
    clearTimeout(previewStaleTimer);
    previewStaleTimer = null;
    previewShownAt = -Infinity;
    localPreviewOffer = null;
    localStreaming = false;
    const canvas = $("#camera-preview");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }

  async function ensurePoseEngine() {
    if (poseEngine) return poseEngine;
    if (!poseEnginePromise) {
      setPoseEngineStatus("loading");
      poseEnginePromise = testPoseMode && "__motionLinkTestPoseEngine" in window
        ? Promise.resolve(window.__motionLinkTestPoseEngine).then((engine) => {
          poseConnections = LocalSensor?.CONNECTIONS || [];
          return engine || null;
        })
        : import(`./motion-ai.js${assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : ""}`)
          .then(async (module) => {
            poseConnections = module.POSE_CONNECTIONS;
            return module.createPoseEngine();
          })
          .catch(async (error) => {
            console.warn("端末内AI骨格を初期化できませんでした。簡易判定へ切り替えます。", error);
            // ファイルが足りない（git から作った zip には入らない）のか、ほかのわけかを分けて、ご家族の欄と練習の記録のわけに出す
            const missingFiles = await findMissingPoseFiles();
            setPoseEngineStatus(missingFiles.length ? "missing" : "failed", missingFiles);
            return null;
          });
    }
    const pending = poseEnginePromise;
    const engine = await pending;
    // 待っている間に作り直しが始まっていたら、古い結果で上書きしない
    if (poseEnginePromise !== pending) return engine;
    poseEngine = engine;
    if (engine) setPoseEngineStatus("ready");
    // 失敗を保持し続けないよう、次の運動開始で再試行できるようにする
    if (!poseEngine) poseEnginePromise = null;
    return poseEngine;
  }

  function setPoseEngineStatus(stateName, missingFiles = []) {
    poseEngineStatus = { state: stateName, missingFiles };
    if (familyNotesUnlocked) renderFamilyPractice();
  }

  // 読み込みに失敗したとき（と、まだ準備していないときのご家族の欄）に、ファイルがあるかを HEAD で確かめる（中身は読まない）。返すのは無い・空のファイル。
  // 確かめられなかったもの（つながらない・HEAD を受けないサーバー）は、足りないとは言わない
  async function findMissingPoseFiles() {
    const missing = await Promise.all(Logic.POSE_ASSET_FILES.map(async (file) => {
      try {
        const response = await fetch(new URL(file, document.baseURI), { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout?.(3000) });
        return response.status === 404 || response.status === 410 || (response.ok && response.headers.get("Content-Length") === "0");
      } catch {
        return false;
      }
    }));
    return Logic.POSE_ASSET_FILES.filter((file, index) => missing[index]);
  }

  // 簡易判定に切り替えるわけ。engine が undefined なら待ち時間に間に合わなかった、null なら始められなかった
  function fallbackReasonFor(engine) {
    if (engine === undefined) return "engine-late";
    return poseEngineStatus.state === "missing" ? "files-missing" : "engine-failed";
  }

  // 運動を選んでいる間に骨格AIの準備を始めておく（朝いちばんの準備は時間がかかるので、「はじめる」を押してから待たせない）。
  // 端末サービスのとき（motion-ai.js を使わない）と、カメラを止めているときは準備しない
  function preloadPoseEngine() {
    if (localSensorConfig || poseEngine || poseEnginePromise || cameraPaused()) return;
    ensurePoseEngine();
  }

  // 準備が待ち時間に間に合わず簡易判定で始めた運動でも、準備ができたところで骨格AIに切り替える（そこからは正しく数える）。
  // 簡易判定で1回も数えていなければ、その運動は本物の記録になる。数えた回数があれば、回数はそのまま（減らさない）で練習の記録になる
  function takeOverWhenPoseReady(session, stream) {
    ensurePoseEngine().then((engine) => {
      if (!isCurrentCameraRequest(session) || cameraStream !== stream || poseMode !== "fallback") return;
      // 待っている間に始められないとわかったら、練習になったわけをそちらにする（ファイルが足りないなど）
      if (!engine) session.fallbackReason = fallbackReasonFor(engine);
      else usePoseEngine(engine);
    });
  }

  // 骨格AIの準備を待つのは決めた時間まで。間に合わなければ undefined（読み込みは続け、できたらその運動の途中か次の運動から使う）
  function loadPoseEngineWithTimeout() {
    const testTimeout = testPoseMode ? Number(window.__motionLinkTestPoseLoadTimeoutMs) : NaN;
    const timeoutMs = Number.isFinite(testTimeout) && testTimeout > 0 ? testTimeout : POSE_LOAD_TIMEOUT_MS;
    const startedAt = performance.now();
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
    return Promise.race([ensurePoseEngine(), timeout]).then((engine) => {
      clearTimeout(timer);
      if (engine === undefined) console.warn(`骨格AIの準備が${Math.round(performance.now() - startedAt)}msで終わらないため、簡易判定で続けます。`);
      return engine;
    });
  }

  // 運動画面の大きな案内（カメラの上）。starting 準備中 / loading 骨格AIの準備 / reconnecting つなぎ直し / error 使えない / hidden 案内なし
  const CAMERA_STAGE_TEXT = {
    starting: ["カメラを準備しています", "そのままお待ちください"],
    loading: ["もうすこしお待ちください", "体を見る準備をしています"],
    reconnecting: ["カメラをつなぎ直しています", "そのままお待ちください"],
    error: [CAMERA_PROBLEM_TEXT.internal, "ご家族に知らせてください"]
  };
  function setCameraStage(kind, options = {}) {
    const guide = $("#camera-guide");
    const [title, detail] = CAMERA_STAGE_TEXT[kind] || ["", ""];
    guide.classList.toggle("is-hidden", kind === "hidden");
    guide.classList.toggle("is-loading", kind === "loading");
    guide.classList.toggle("is-error", kind === "error");
    if (kind !== "hidden") {
      setTextIfChanged($("#camera-guide-title"), options.title || title);
      setTextIfChanged($("#camera-guide-detail"), options.detail ?? detail);
    }
    $("#camera-retry").hidden = !(kind === "error" && options.retry);
  }

  // カメラの状態は2か所に出す：本人向けのことば（見出しの右）と、開発・ご家族の確認用の細かい表示（#camera-status、?debug=1 で見える）
  const CAMERA_STATE_LABEL = {
    preparing: ["準備中", ""],
    pose: ["カメラで見ています", "is-live"],
    rgbd: ["奥行きカメラで見ています", "is-live"],
    mock: ["ためしのカメラです", "is-live"],
    fallback: ["動きの大きさで見ています", "is-live"],
    reconnecting: ["つなぎ直しています", ""],
    paused: ["カメラ 停止中", "is-off"],
    none: ["カメラなし", "is-off"],
    // 本人が「一時停止」を押している間（カメラの状態より先に出す。「見ています」と同時に出さない）
    holding: ["一時停止中", "is-hold"]
  };
  let cameraStateKind = "preparing";
  function setCameraState(kind, detail) {
    cameraStateKind = kind;
    renderCameraStateLabel();
    const [, tone] = CAMERA_STATE_LABEL[kind] || CAMERA_STATE_LABEL.none;
    // カメラがはじめて見はじめたときに「始めます」（家族の声があればそれ）。待ちの案内を読んでいれば、そのあとに
    if (tone === "is-live" && activeSession && activeSession.liveAt === null) {
      activeSession.liveAt = performance.now();
      playEncouragement("start", activeSession.startLine, { queue: true });
    }
    const status = $("#camera-status");
    status.classList.toggle("is-live", tone === "is-live");
    status.innerHTML = `<span></span> ${escapeHtml(detail)}`;
  }

  function renderCameraStateLabel() {
    const kind = activeSession?.paused ? "holding" : cameraStateKind;
    const [label, tone] = CAMERA_STATE_LABEL[kind] || CAMERA_STATE_LABEL.none;
    const element = $("#camera-state-label");
    element.className = `camera-state-label${tone ? ` ${tone}` : ""}`;
    setTextIfChanged(element.querySelector("b"), label);
  }

  // カメラが使えないとき：大きな案内で知らせ、「カメラなしで1回」ボタンを出す（ボタンで数えた回数は練習の記録）
  function showCameraUnavailable(detail, options = {}) {
    hidePositionGuide();
    clearPoseOverlay();
    if (activeSession) activeSession.cameraUnavailable = true;
    // 使い方のカードで案内と「もう一度ためす」を隠さない（見たことにはしない。次の運動でまた出す）
    if (sessionIntroOpen()) closeIntro(false);
    setCameraStage("error", options.paused
      ? { title: "カメラはお休み中です", detail: "ご家族がカメラを止めています" }
      : { title: options.title || CAMERA_PROBLEM_TEXT.internal, retry: Boolean(options.retry) });
    // リモコンの決定キーですぐ「もう一度ためす」を押せるように（ほかのボタンを選んでいるときは動かさない）
    const retry = $("#camera-retry");
    if (!retry.hidden && views.session.classList.contains("is-active") && [null, document.body, $("#session-title")].includes(document.activeElement)) retry.focus({ preventScroll: true });
    setCameraState(options.paused ? "paused" : "none", detail);
    // 声でも1回だけ知らせる（もう一度ためして、また使えなくても言い直さない）。ご家族が止めているときは言わない
    if (activeSession && !options.paused && !activeSession.unavailableSpoken) {
      activeSession.unavailableSpoken = true;
      speakQueued("カメラが使えません。ご家族に知らせてください");
    }
    $("#motion-feedback").textContent = "";
    $("#motion-level").textContent = "カメラなし";
    $("#tracking-confidence").textContent = "—";
    resetPrecisionPanel();
    demoInputAvailable = true;
    syncDemoButton();
    syncCameraView();
  }

  // 端末サービスがカメラをつなぎ直している間（USBの一瞬の抜け・映像の止まり）
  function showCameraReconnecting(detail) {
    hidePositionGuide();
    clearPoseOverlay();
    if (sessionIntroOpen()) closeIntro(false);
    setCameraStage("reconnecting");
    setCameraState("reconnecting", detail);
    $("#motion-feedback").textContent = "";
  }

  // もう一度ためす：カメラも端末サービスもつながっていないときだけ（取得中・使用中に二重に開かない）
  function retryCamera() {
    if (!activeSession || activeSession.paused || finishing || cameraStream || localSensorClient || cameraPaused()) return;
    activeSession.cameraUnavailable = false;
    setCameraStage("starting");
    setCameraState("preparing", "カメラ準備中");
    setupCamera();
  }

  const demoInputAllowed = () => debugMode || demoInputAvailable;
  function syncDemoButton() {
    $("#demo-rep").hidden = !demoInputAllowed();
  }

  function resizeOverlay() {
    const panel = $(".camera-panel");
    const canvas = $("#pose-overlay");
    canvas.width = Math.max(1, Math.round(panel.clientWidth));
    canvas.height = Math.max(1, Math.round(panel.clientHeight));
  }

  function processCameraFrame(timestamp) {
    if (!activeSession || !cameraStream) return;
    const video = $("#camera-video");
    if (activeSession.paused) {
      // 一時停止中は推論・回数判定・品質集計を進めない
      const overlay = $("#pose-overlay");
      overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
      animationFrame = requestAnimationFrame(processCameraFrame);
      return;
    }
    const fallback = poseMode === "pose" ? { energy: 0 } : analyzeMotionFrame(video);

    if (poseMode === "pose" && poseEngine && video.readyState >= 2) {
      // カメラのコマごとの推定（requestVideoFrameCallback）が使えないブラウザだけ、描画のたびに間隔を見て推定する
      if (videoFrameRequest === null) {
        const inferenceInterval = poseEngine.delegate === "GPU" ? 40 : 66;
        if (timestamp - lastPoseInference >= inferenceInterval && video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          runPoseInference(video, timestamp);
        }
      }
      drawDetectedPose(lastPoseLandmarks);
    } else {
      drawFallbackMotionOverlay(trackedMotionCenter, fallback.energy, timestamp);
      if (poseMode === "fallback" && !activeSession.paused && previousFrame) evaluateMotion(fallback.energy, timestamp);
    }
    animationFrame = requestAnimationFrame(processCameraFrame);
  }

  // カメラの新しいコマが出るたびに1回だけ推定する（画面のリフレッシュではなくカメラのコマ数に合わせる）。
  // 使えないブラウザでは何もしない（processCameraFrame の間隔での推定になる）
  function startVideoFrameInference(video, session, stream) {
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onVideoFrame = (now) => {
      videoFrameRequest = null;
      if (activeSession !== session || cameraStream !== stream) return;
      if (poseMode === "pose" && poseEngine && !activeSession.paused && !finishing) runPoseInference(video, now);
      videoFrameRequest = video.requestVideoFrameCallback(onVideoFrame);
    };
    videoFrameRequest = video.requestVideoFrameCallback(onVideoFrame);
  }

  function stopVideoFrameInference() {
    if (videoFrameRequest === null) return;
    $("#camera-video").cancelVideoFrameCallback?.(videoFrameRequest);
    videoFrameRequest = null;
  }

  function runPoseInference(video, now) {
    // 推定がコマの間隔より遅いときは、遅いぶんだけコマを飛ばす（追いつかないのに詰め込まない）
    if (now - lastPoseInference < detectCostMs) return;
    // 骨格AIへ渡す時刻は必ず前より後にする
    const timestamp = Math.max(now, lastPoseInference + 1);
    lastPoseInference = timestamp;
    const startedAt = performance.now();
    let detection;
    try {
      detection = poseEngine.detect(video, timestamp);
    } catch (error) {
      handleDetectError(error, timestamp);
      return;
    }
    // 最初の推定はGPUの準備（数百ms）を含むことがあるので、間引きの目安には入れない。そのあとも1回の遅れが目安を
    // 大きく引き上げないよう、1回ぶんは今の目安の3倍まで（目安がないうちは100msまで）として平均する
    const cost = performance.now() - startedAt;
    detectSamples += 1;
    if (detectSamples > 1) {
      const sample = Math.min(cost, detectCostMs ? detectCostMs * 3 : 100);
      detectCostMs = detectCostMs ? detectCostMs * .8 + sample * .2 : sample;
    }
    detectFailures = [];
    poseInferenceCount += 1;
    if (timestamp - poseFpsWindowStart >= 1000) {
      measuredPoseFps = Math.round(poseInferenceCount * 1000 / (timestamp - poseFpsWindowStart));
      poseFpsWindowStart = timestamp;
      poseInferenceCount = 0;
      $("#sensor-source").textContent = `${cameraSourceText}・${poseEngine.model}・${measuredPoseFps}fps`;
    }
    handlePoseLandmarks(detection?.landmarks || null, detection?.worldLandmarks || null, timestamp, "pose");
  }

  // 骨格AIの一時的な失敗（1コマの不具合など）では方式を変えない。2秒以内に3回失敗したら骨格AIを一度だけ作り直し、
  // それでもだめなときだけ簡易判定にする（簡易判定の回数は練習の記録になるので、すぐには切り替えない）
  function handleDetectError(error, now) {
    console.warn("骨格解析でエラーが出たため、このコマを飛ばします。", error);
    detectFailures = detectFailures.filter((at) => now - at < 2000);
    detectFailures.push(now);
    if (detectFailures.length < 3) return;
    detectFailures = [];
    if (activeSession.poseEngineRestarted) {
      console.warn("骨格解析が続けて失敗したため簡易判定へ切り替えます。");
      setPoseEngineStatus("failed");
      switchToFallback("engine-failed");
      return;
    }
    restartPoseEngine();
  }

  async function restartPoseEngine() {
    const session = activeSession;
    const stream = cameraStream;
    session.poseEngineRestarted = true;
    poseMode = "loading";
    try { poseEngine?.close?.(); } catch { /* 閉じられなくても作り直す */ }
    poseEngine = null;
    poseEnginePromise = null;
    detectCostMs = 0;
    detectSamples = 0;
    const engine = await loadPoseEngineWithTimeout();
    if (activeSession !== session || cameraStream !== stream) return;
    if (engine) usePoseEngine(engine);
    else {
      switchToFallback(fallbackReasonFor(engine));
      if (engine === undefined) takeOverWhenPoseReady(session, stream);
    }
  }

  // 自動テストの偽の骨格AI（?testPose=1）で数えた回数は、実績に入らないデモ扱いにする
  function countedSource(repSource) {
    return testPoseMode && repSource === "pose" ? "demo" : repSource;
  }

  // repSource: pose（ブラウザ内RGB推定）/ rgbd（端末サービスの深度カメラ）/ mock（模擬センサー）
  function handlePoseLandmarks(landmarks, worldLandmarks, timestamp, repSource, options) {
    if (landmarks) {
      const dtMs = filteredPoseLandmarks && Number.isFinite(filteredAt) ? timestamp - filteredAt : 33;
      filteredAt = timestamp;
      filteredPoseLandmarks = Logic.smoothLandmarks(landmarks, filteredPoseLandmarks, null, dtMs);
      filteredWorldLandmarks = worldLandmarks
        ? Logic.smoothLandmarks(worldLandmarks, filteredWorldLandmarks, landmarks, dtMs)
        : null;
      lastPoseLandmarks = filteredPoseLandmarks;
      lastWorldLandmarks = filteredWorldLandmarks;
    } else {
      lastPoseLandmarks = null;
      lastWorldLandmarks = null;
      filteredPoseLandmarks = null;
      filteredWorldLandmarks = null;
    }
    // 回数判定に使う3D座標は、深度カメラ（端末サービス）のものだけ。ブラウザのRGB推定の3D座標は実データで確かめていないので、画像の座標で数える
    const countingWorld = repSource === "pose" ? null : lastWorldLandmarks;
    const measurement = Logic.measurePoseForExercise(activeSession.exerciseId, lastPoseLandmarks, countingWorld, { fyN: options?.fyN, limits: poseCounter?.limits,
      aspect: imageAspect(), depthMeters: options?.depthMeters });
    const assessment = Logic.assessPosition(activeSession.exerciseId, lastPoseLandmarks,
      { depthMeters: options?.depthMeters, aspect: imageAspect(), worldLandmarks: countingWorld });
    updatePositionGuide(assessment, performance.now());
    const details = Logic.measurePoseDetails(activeSession.exerciseId, lastPoseLandmarks, lastWorldLandmarks, measurement);
    // 端末サービスの3D座標は深度を対応付けたもの。RGBだけの推定と表示を分ける
    if (details.valid && details.spatialMode === "RGB推定3D" && repSource !== "pose") details.spatialMode = "深度対応3D";
    if (details.valid && details.spatialMode !== "2D") activeSession.spatialMode = details.spatialMode;
    else if (details.valid && !activeSession.spatialMode) activeSession.spatialMode = details.spatialMode;
    const update = Logic.updatePoseCounter(poseCounter, measurement, timestamp);
    // 体の大きさ（肩幅・肩からひざ・いつもの距離）：深度カメラで、座って静止しているフレームを6枚に1枚、最大600個。
    // ブラウザの推定の3D座標は腰が原点で距離が出ないので使わない
    if (repSource === "rgbd" && activeSession.exerciseId === "chair-march" && countingWorld) {
      activeSession.bodySampleTick += 1;
      if (activeSession.bodySampleTick % 6 === 0 && activeSession.bodySamples.length < 600) {
        const spans = Logic.sampleBodySpans(poseCounter, countingWorld);
        if (spans) activeSession.bodySamples.push(spans);
      }
    }
    activeSession.poseFrames += 1;
    if (measurement.valid) activeSession.validPoseFrames += 1;
    if (update.quality > 0) {
      activeSession.poseQualitySum += update.quality;
      activeSession.poseQualitySamples += 1;
    }
    updatePoseFeedback(measurement, update, details, repSource);
  }

  function updatePositionGuide(assessment, now) {
    if (!activeSession || activeSession.paused || finishing) return;
    const guide = positionGuide;
    if (guide.firstAt === null) guide.firstAt = now;
    // 同じ判定が0.6秒続いたら切り替える。判定が細かく入れ替わり続けるときも、1.5秒たったら最新の判定に切り替え、
    // 表示中の古い案内を残し続けない
    if (assessment.status !== guide.candidate) {
      guide.candidate = assessment.status;
      guide.candidateSince = now;
    }
    if (assessment.status === guide.shown) guide.divergedSince = null;
    else if (guide.divergedSince === null) guide.divergedSince = now;
    const stable = guide.shown === null || now - guide.candidateSince >= 600 || now - guide.divergedSince >= 1500;
    if (assessment.status !== guide.shown && !stable) return;
    const changed = assessment.status !== guide.shown;
    if (changed) {
      guide.shown = assessment.status;
      guide.shownSince = now;
      guide.divergedSince = null;
    }
    const element = $("#position-guide");
    element.hidden = false;
    element.classList.toggle("is-ok", assessment.status === "ok");
    element.classList.toggle("is-searching", assessment.status === "no-person");
    // 「ちょうどいい位置です」が3秒続いたら、小さな ✓ の丸にする（運動の邪魔をしない）。位置がずれたら元の大きさに戻る
    element.classList.toggle("is-compact", guide.shown === "ok" && now - guide.shownSince >= 3000);
    // 文言は切替時と1.5秒ごとにだけ書き換える（ちらつきと、読み上げソフトの読み直しを防ぐ）。距離は読み上げ対象外で毎回更新
    if (changed || now - guide.textAt >= 1500) {
      guide.textAt = now;
      const arrow = element.querySelector(".position-guide-arrow");
      setTextIfChanged(arrow, assessment.arrow === "left" ? "←" : assessment.arrow === "right" ? "→" : "");
      arrow.classList.toggle("is-left", assessment.arrow === "left");
      setTextIfChanged($("#position-guide-title"), textForPerson(assessment.title));
      setTextIfChanged($("#position-guide-detail"), textForPerson(assessment.detail));
    }
    setTextIfChanged($("#position-guide-distance"), Number.isFinite(assessment.distanceMeters) ? `約${assessment.distanceMeters.toFixed(1)}m` : "");
    // 声でも案内する。同じ案内が1.5秒続いたら、8秒以上あけて読み上げる。
    // 開始直後の声かけや家族の声と重ねない（途中で切らない）よう、開始5秒間と再生中は読まない
    const needsVoice = !["ok", "no-person"].includes(guide.shown);
    if (needsVoice && now - guide.shownSince >= 1500 && now - guide.spokenAt >= 8000 && guide.spokenStatus !== guide.shown
      && now - guide.firstAt >= 5000 && !isVoiceBusy()) {
      guide.spokenAt = now;
      guide.spokenStatus = guide.shown;
      speakGuide(assessment.title, guide.shown);
    }
    if (guide.shown === "ok") guide.spokenStatus = null;
    if (guide.shown === "ok" && sessionIntroOpen() && now - Math.max(guide.shownSince, introCardAt) >= INTRO_AUTO_MS[introCard]) advanceIntro();
    // カメラが見はじめてから、だれも映らないまま6秒たったら、一度だけ声で座る場所を知らせる
    const session = activeSession;
    if (guide.shown === "no-person" && session.liveAt !== null && !session.seatPromptSpoken
      && now - Math.max(guide.shownSince, session.liveAt) >= 6000 && !isVoiceBusy()) {
      session.seatPromptSpoken = true;
      speakQueued(placeVoice(session.exerciseId).seat);
    }
  }

  // 運動中に出す、いまの段階のひとこと（rest 楽な姿勢で待つ / go 動かす / back 戻す）。
  // 左右の言葉は使わない（画面は鏡に映したように見せているので、どちらの側かはお手本の絵で見せる）。せかす言葉も使わない
  const SEATED_REST = "楽な姿勢で すわりましょう";
  const SLOW_BACK = "ゆっくり戻しましょう";
  const PROMPTS_BY_EXERCISE = {
    "chair-march": { rest: SEATED_REST, go: "ひざを ゆっくり上げましょう", back: SLOW_BACK },
    "knee-open-close": { rest: SEATED_REST, go: "ひざを ゆっくり ひらきましょう", back: SLOW_BACK },
    "shoulder-shrug": { rest: SEATED_REST, go: "肩を ゆっくり上げましょう", back: SLOW_BACK },
    "arm-raise": { rest: SEATED_REST, go: "腕を ゆっくり上げましょう", back: SLOW_BACK },
    // 腕の開閉は、胸の前で手を合わせたところから始める（手をももに置いて座っているだけでは始まらない）
    "arm-open-close": { rest: "手を 胸の前で 合わせましょう", go: "腕を 横へ ひらきましょう", back: SLOW_BACK },
    "seated-twist": { rest: SEATED_REST, go: "体を ゆっくり ひねりましょう", back: SLOW_BACK },
    "side-bend": { rest: SEATED_REST, go: "体を ゆっくり 横へ たおしましょう", back: SLOW_BACK },
    "seated-heel-raise": { rest: SEATED_REST, go: "かかとを ゆっくり上げましょう", back: SLOW_BACK },
    "standing-heel-raise": { rest: "背もたれに 手を置いて 立ちましょう", go: "かかとを ゆっくり上げましょう", back: SLOW_BACK },
    "knee-extend": { rest: SEATED_REST, go: "ひざを ゆっくり のばしましょう", back: SLOW_BACK },
    "seated-leg-out": { rest: SEATED_REST, go: "足を ゆっくり 横へ 出しましょう", back: SLOW_BACK },
    "side-step": { rest: "まっすぐ 立ちましょう", go: "横へ 一歩 ふみだしましょう", back: "元の場所へ 戻りましょう" },
    "mini-squat": { rest: "椅子の前に 立ちましょう", go: "腰を 少し 下ろしましょう", back: "ゆっくり もどしましょう" },
    "sit-stand": { rest: "椅子に すわりましょう", go: "ゆっくり 立ちましょう", back: "ゆっくり すわりましょう" }
  };
  const STEP_MARKS = { rest: "○", go: "↑", back: "↓" };
  // 下へ動かしてから戻す運動（浅いスクワット）は、動かすが ↓、戻すが ↑
  const DOWN_FIRST_STEP_MARKS = { rest: "○", go: "↓", back: "↑" };
  const DOWN_FIRST_EXERCISES = new Set(["mini-squat"]);
  // 横へ動かす運動（開く・倒す・ひねる・横へ一歩）は上下の矢印にしない（動きと逆を指して見える）。戻すは楽な姿勢と同じ ○（色で分ける）
  const SIDEWAYS_STEP_MARKS = { rest: "○", go: "↔", back: "○" };
  const SIDEWAYS_EXERCISES = new Set(["knee-open-close", "seated-leg-out", "arm-open-close", "seated-twist", "side-bend", "side-step"]);
  const stepMark = (exerciseId, step) => (SIDEWAYS_EXERCISES.has(exerciseId) ? SIDEWAYS_STEP_MARKS : DOWN_FIRST_EXERCISES.has(exerciseId) ? DOWN_FIRST_STEP_MARKS : STEP_MARKS)[step];
  // カメラの準備を待つ間（wait）と、だれも映らないとき（seat）の声。立って行う運動では「すわって」と言わない（段階のひとこと rest と同じ姿勢）
  const PLACE_VOICES = {
    seated: { wait: "カメラの準備をしています。椅子にすわって、少しお待ちください", seat: "テレビの前の椅子に すわってください" },
    standing: { wait: "カメラの準備をしています。少しお待ちください", seat: "テレビの前に 立ってください" }
  };
  const STANDING_EXERCISES = new Set(["standing-heel-raise", "side-step", "mini-squat"]);
  // 椅子を使って立つ運動は、立つ場所を椅子で言う（背もたれに手を置く・椅子の前に立つ）
  const STANDING_SEAT_VOICES = { "standing-heel-raise": "椅子の 背もたれに 手を置いて 立ってください", "mini-squat": "椅子の 前に 立ってください" };
  const placeVoice = (exerciseId) => STANDING_EXERCISES.has(exerciseId)
    ? { ...PLACE_VOICES.standing, seat: STANDING_SEAT_VOICES[exerciseId] || PLACE_VOICES.standing.seat }
    : PLACE_VOICES.seated;
  // 座ったままのとき、ロジックは「立って、ゆっくり動きましょう」と返す。椅子を使って立つ運動では、立つ文を椅子の言い方にする（立ち上がる時がいちばん危ない）
  const STAND_UP_MESSAGE = /^(?!.*椅子).*立って/;
  const WAIT_VOICE_DELAY_MS = 1000;
  // ロジックの文のうち、いまの様子を言うだけの文（「〜を確認しています」「〜が見えています」など）と、段階のひとことと同じことを言う文
  // （座って足踏みの「左ひざが上がりました。ゆっくり下ろしてください」。画面は鏡なので左右の言葉も出さない）
  const STATUS_LINE = /確認しています|確認。|認識中|が見えています|が上がりました|ゆっくり(下ろ|戻)してください/;
  const PROMPT_HOLD_MS = 1200;
  let promptShownAt = 0;

  function setTextIfChanged(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  // ロジックから届く文を本人の画面に出す前の見張り：体の数値（cm・度・秒・%）や「調整」、せかす文は出さない
  function textForPerson(text) {
    if (typeof text !== "string" || FORBIDDEN_FOR_PERSON.test(text) || PUSHY_FOR_PERSON.test(text)) return "";
    return PLAIN_WORDS_FOR_PERSON.reduce((plain, [pattern, word]) => plain.replace(pattern, word), text);
  }

  // 運動中の下のひとこと：ロジックの文を、その運動の言い方にしてから見張りを通す
  function feedbackForPerson(exerciseId, text) {
    return textForPerson(STANDING_SEAT_VOICES[exerciseId] && STAND_UP_MESSAGE.test(text) ? STANDING_SEAT_VOICES[exerciseId] : text);
  }

  function isVoiceBusy() {
    const synthBusy = "speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending);
    return synthBusy || Boolean(encouragementAudio && !encouragementAudio.paused && !encouragementAudio.ended);
  }

  function makeUtterance(text) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = .9;
    utterance.pitch = 1.05;
    return utterance;
  }

  // ほかの声を止めずに読む（読んでいる声があれば、そのあとに続く）
  function speakQueued(text) {
    if (!("speechSynthesis" in window)) return;
    lastVoiceAt = performance.now();
    speechSynthesis.speak(makeUtterance(text));
  }

  // 回数の節目のひとこと（はじめの1回）。ほかの声を止めず、声が出ている間と、前の声から6秒たっていないときは言わない。同じ節目は1回だけ
  function speakMilestone(key, text) {
    if (!activeSession || activeSession.milestones[key]) return;
    activeSession.milestones[key] = true;
    if (isVoiceBusy() || performance.now() - lastVoiceAt < 6000) return;
    speakQueued(text);
  }

  // 位置案内の読み上げ。speakText と違い、ほかの声を止めない。
  // 途中で止められたら（励ましの声など）、同じ案内をあとでもう一度読めるようにする
  function speakGuide(text, status) {
    if (!("speechSynthesis" in window)) return;
    lastVoiceAt = performance.now();
    const utterance = makeUtterance(text);
    utterance.onend = () => { if (guideUtterance === utterance) guideUtterance = null; };
    utterance.onerror = () => {
      if (guideUtterance === utterance) guideUtterance = null;
      if (positionGuide.spokenStatus === status) positionGuide.spokenStatus = null;
    };
    guideUtterance = utterance;
    speechSynthesis.speak(utterance);
  }

  function imageAspect() {
    const video = $("#camera-video");
    const width = video.videoWidth || localFrameSize?.width;
    const height = video.videoHeight || localFrameSize?.height;
    return width && height ? width / height : null;
  }

  function clearPoseOverlay() {
    const canvas = $("#pose-overlay");
    canvas?.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }

  function hidePositionGuide() {
    positionGuide = emptyPositionGuide();
    const element = $("#position-guide");
    if (element) element.hidden = true;
  }

  // 簡易判定で動きを見る画面の縦の範囲（上端, 下端）。腕や上体の運動は上、脚の運動は顔より下だけを見る
  const MOTION_REGION = {
    "arm-raise": [0, .72],
    "shoulder-shrug": [0, .72],
    "arm-open-close": [0, .72],
    "seated-twist": [0, .72],
    "side-bend": [0, .72],
    "chair-march": [.25, 1],
    "knee-open-close": [.25, 1],
    "seated-heel-raise": [.25, 1],
    "knee-extend": [.25, 1],
    "seated-leg-out": [.25, 1],
    "sit-stand": [.25, 1],
    "side-step": [.25, 1],
    // 立ってするかかと上げ・浅いスクワットは体全体が上下する
    "standing-heel-raise": [0, 1],
    "mini-squat": [0, 1]
  };

  function analyzeMotionFrame(video) {
    const sampler = $("#motion-sampler");
    const context = sampler.getContext("2d", { willReadFrequently: true });
    if (video.readyState < 2) return { energy: 0 };
    context.drawImage(video, 0, 0, sampler.width, sampler.height);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    const gray = new Uint8Array(sampler.width * sampler.height);
    const [topRatio, bottomRatio] = MOTION_REGION[activeSession?.exerciseId] || [0, 1];
    let signedDifference = 0;
    let roiCount = 0;

    for (let i = 0, pixel = 0; i < pixels.length; i += 4, pixel += 1) {
      const value = (pixels[i] * 3 + pixels[i + 1] * 6 + pixels[i + 2]) / 10;
      gray[pixel] = value;
      if (!previousFrame) continue;
      const yRatio = Math.floor(pixel / sampler.width) / sampler.height;
      if (yRatio < topRatio || yRatio > bottomRatio) continue;
      signedDifference += value - previousFrame[pixel];
      roiCount += 1;
    }

    let rawEnergy = 0;
    let weightedX = 0;
    let weightedY = 0;
    let weightTotal = 0;
    if (previousFrame && roiCount) {
      const lightingShift = signedDifference / roiCount;
      for (let pixel = 0; pixel < gray.length; pixel += 1) {
        const y = Math.floor(pixel / sampler.width);
        const yRatio = y / sampler.height;
        if (yRatio < topRatio || yRatio > bottomRatio) continue;
        const difference = Math.abs((gray[pixel] - previousFrame[pixel]) - lightingShift);
        rawEnergy += difference;
        if (difference > 18) {
          const x = pixel % sampler.width;
          weightedX += x * difference;
          weightedY += y * difference;
          weightTotal += difference;
        }
      }
      rawEnergy /= roiCount;
      if (rawEnergy < motionNoiseFloor + 3.5) motionNoiseFloor = motionNoiseFloor * .96 + rawEnergy * .04;
    }
    previousFrame = gray;

    const adjustedEnergy = Math.max(0, rawEnergy - motionNoiseFloor * 1.25);
    motionEnergySmoothed = motionEnergySmoothed * .74 + adjustedEnergy * .26;
    if (weightTotal > 0) {
      const center = { x: weightedX / weightTotal / sampler.width, y: weightedY / weightTotal / sampler.height };
      trackedMotionCenter.x = trackedMotionCenter.x * .78 + center.x * .22;
      trackedMotionCenter.y = trackedMotionCenter.y * .78 + center.y * .22;
    }
    return { energy: motionEnergySmoothed };
  }

  function updatePoseFeedback(measurement, update, details, repSource) {
    if (!activeSession || activeSession.paused || finishing) return;
    // ここから2行は開発・ご家族の確認用の欄（?debug=1）。本人の画面には出ない
    setTextIfChanged($("#tracking-confidence"), measurement.valid ? `${update.quality}%` : "部位不足");
    setTextIfChanged($("#motion-level"), measurement.valid ? measurement.visiblePart : "見えていません");
    updatePrecisionPanel(details, update);
    if (update.rep) {
      activeSession.rangeQualitySum += Math.min(100, update.rangePercent || 0);
      activeSession.rangeQualitySamples += 1;
      if (update.cycleDurationMs) {
        activeSession.cycleDurationSum += update.cycleDurationMs;
        activeSession.cycleDurationSamples += 1;
      }
      // 体の分析の下書き（pose / rgbd だけ。デモボタン・Spaceキー・簡易判定はここを通らない）。確定は finishSession
      const source = countedSource(repSource || "pose");
      if (activeSession.exerciseId === "chair-march") {
        const learnable = Logic.pickLearnableRep(update, source);
        if (learnable) activeSession.learned.push(learnable);
      }
      registerRep(source);
      renderAnalysisPill();
      releaseDemoPose(update.side, performance.now());
      return;
    }
    const now = performance.now();
    const step = promptStep(update);
    followDemoStep(step, now);
    if (now < repMessageUntil) return;
    const feedback = $("#motion-feedback");
    // 人が映らなくなったフレーム：位置案内が「カメラの前に来てください」に変わるまでは、いまのひとことのまま（その間だけ「少し動いてみてください」を出さない）
    if (positionGuide.candidate === "no-person" && positionGuide.shown !== "no-person") return;
    // 位置案内が「ここへ動いて」と出している間は、案内をひとつにする（下のひとことは出さない）
    if (positionGuide.shown && positionGuide.shown !== "ok") {
      setTextIfChanged(feedback, "");
      return;
    }
    const message = feedbackForPerson(activeSession.exerciseId, update.message);
    // いまの様子を言うだけの文（と、見張りで消えた文）は、段階のひとことに置きかえる。ほかの案内（足を下ろして など）はそのまま出す
    const usePrompt = Boolean(step && PROMPTS_BY_EXERCISE[activeSession.exerciseId]) && (!message || STATUS_LINE.test(update.message));
    // 段階のひとことは、出してから少なくとも1.2秒は変えない（ちらつかせない）
    const shown = feedback.querySelector(".feedback-step")?.dataset.step;
    if (shown && now - promptShownAt < PROMPT_HOLD_MS && !(usePrompt && step === shown)) return;
    if (usePrompt) showPrompt(feedback, step, now);
    else setTextIfChanged(feedback, message);
  }

  // 段階：update.cue（あれば先に使う）か、数え方の段階から。rest＝楽な姿勢で待つ / go＝動かす / back＝戻す。
  // 今の位置を測れないフレーム（quality 0。見えない間のあとに、座って止まっているかを確かめている間など）は、上げたままの段階でも「戻す」と言わない
  // （見えない間に戻して休んでいる人に「戻しましょう」と言わない。上げたままの人には、楽な姿勢のひとことで戻すことを伝える）
  function promptStep(update) {
    if (update.cue === "rest") return "go";
    if (update.cue === "reached") return "back";
    if (update.quality === 0 && update.phase === "returning") return "rest";
    return { "seeking-low": "rest", ready: "go", returning: "back" }[update.phase] || null;
  }

  // ひとことの前に段階の印（○ 楽な姿勢・↑ 動かす・↓ 戻す。横へ動かす運動は ↔ 動かす・○ 戻す、浅いスクワットは ↓ 動かす・↑ 戻す）。印は読み上げない
  function showPrompt(feedback, step, now) {
    let mark = feedback.querySelector(".feedback-step");
    let text = feedback.querySelector(".feedback-text");
    if (!mark || !text) {
      mark = document.createElement("span");
      mark.className = "feedback-step";
      mark.setAttribute("aria-hidden", "true");
      text = document.createElement("span");
      text.className = "feedback-text";
      feedback.replaceChildren(mark, text);
    }
    if (mark.dataset.step !== step) {
      mark.dataset.step = step;
      promptShownAt = now;
    }
    setTextIfChanged(mark, stepMark(activeSession.exerciseId, step));
    setTextIfChanged(text, PROMPTS_BY_EXERCISE[activeSession.exerciseId][step]);
  }

  // 運動画面の「体の分析」の表示（座って足踏みだけ）。回数は、これまで覚えた足踏み＋今日の下書き
  function renderAnalysisPill() {
    const pill = $("#analysis-pill");
    if (!pill) return;
    if (!activeSession || activeSession.exerciseId !== "chair-march") {
      pill.hidden = true;
      pill.textContent = "";
      return;
    }
    const analysis = Logic.getAnalysisLevel(state.bodyProfile);
    const today = activeSession.learned.length;
    pill.hidden = false;
    // デモ・模擬・簡易の入力が混ざった運動は（植物と同じく）覚えないので、覚えると約束しない
    const source = activeSession.count > 0 ? Logic.resolveInputSource(activeSession.repSources) : null;
    if (source && Logic.INPUT_SOURCES[source]?.countsTowardProgress === false) {
      pill.textContent = `体の分析 ${analysis.level ? `レベル${analysis.level}` : "はじめまして"}・練習の運動は覚えません`;
      return;
    }
    pill.textContent = analysis.level
      ? `体の分析 レベル${analysis.level}・足踏み ${analysis.reps + today}回ぶん`
      : "体の分析 はじめまして・今日の足踏みから覚えます";
  }

  function resetPrecisionPanel() {
    $("#joint-angle-label").textContent = "動作角度";
    $("#joint-angle").textContent = "—";
    $("#range-of-motion").textContent = "0%";
    $("#posture-state").textContent = "—";
    $("#balance-state").textContent = "—";
    $("#motion-tempo").textContent = "測定中";
    $("#sensor-source").textContent = "カメラ準備中";
  }

  function updatePrecisionPanel(details, update) {
    if (!details?.valid) {
      $("#joint-angle-label").textContent = "動作角度";
      $("#joint-angle").textContent = "—";
      $("#posture-state").textContent = "部位待ち";
      $("#balance-state").textContent = "—";
    } else {
      // 座って足踏みは、座った姿勢からのひざの上げ幅（深度カメラなら実測のcm、画像だけなら目安）を出す
      const liftKnown = Number.isFinite(update.liftCm);
      $("#joint-angle-label").textContent = liftKnown ? "ひざの上げ幅" : details.angleLabel;
      $("#joint-angle").textContent = liftKnown ? `${update.liftSource === "3d" ? "" : "約"}${update.liftCm}cm` : details.angleText;
      $("#posture-state").textContent = details.postureDegrees === null ? details.postureText : `${details.postureText} ${Math.round(details.postureDegrees)}°`;
      $("#balance-state").textContent = details.balanceText;
      const fpsText = measuredPoseFps ? `・${measuredPoseFps}fps` : "";
      $("#sensor-source").textContent = `${cameraSourceText}・${details.spatialMode}${fpsText}`;
    }
    $("#range-of-motion").textContent = `${Math.min(100, update.rangePercent || 0)}%`;
    if (update.cycleDurationMs) $("#motion-tempo").textContent = `${(update.cycleDurationMs / 1000).toFixed(1)}秒/回`;
  }

  function drawDetectedPose(landmarks) {
    const canvas = $("#pose-overlay");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    // 「映像だけ」では線を描かない（数えるのは続いている）
    if (!activeSession || activeSession.paused || !Array.isArray(landmarks) || cameraViewShown === "video") return;
    const video = $("#camera-video");
    const sourceWidth = video.videoWidth || localFrameSize?.width || w;
    const sourceHeight = video.videoHeight || localFrameSize?.height || h;
    // 映像は切らずに全体を見せている（object-fit: contain）ので、骨格の線も同じ「全体が入る」大きさで重ねる
    const scale = Math.min(w / sourceWidth, h / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const offsetX = (w - drawWidth) / 2;
    const offsetY = (h - drawHeight) / 2;
    const point = (landmark) => [offsetX + landmark.x * drawWidth, offsetY + landmark.y * drawHeight];
    const isVisible = (landmark) => Logic.visible(landmark);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(244,202,71,.35)";
    ctx.shadowBlur = 8;
    ctx.strokeStyle = "rgba(244, 202, 71, .96)";
    ctx.lineWidth = Math.max(3, Math.min(w, h) * .007);
    poseConnections.forEach(([fromIndex, toIndex]) => {
      const from = landmarks[fromIndex];
      const to = landmarks[toIndex];
      if (!isVisible(from) || !isVisible(to)) return;
      const a = point(from);
      const b = point(to);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    });
    landmarks.forEach((landmark, index) => {
      if (!isVisible(landmark) || (index < 11 && index !== 0)) return;
      const [x, y] = point(landmark);
      ctx.fillStyle = "rgba(72, 169, 151, .98)";
      ctx.beginPath(); ctx.arc(x, y, index === 0 ? 5 : 4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.shadowBlur = 0;
  }

  function drawFallbackMotionOverlay(center, energy, timestamp) {
    const canvas = $("#pose-overlay");
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!activeSession || activeSession.paused || energy < .8 || cameraViewShown === "video") return;
    const pulse = 28 + Math.sin(timestamp / 170) * 5 + Math.min(34, energy * 3);
    ctx.strokeStyle = "rgba(244, 202, 71, .94)";
    ctx.fillStyle = "rgba(72, 169, 151, .9)";
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 7]);
    ctx.beginPath(); ctx.arc(w * center.x, h * center.y, pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(w * center.x, h * center.y, 6, 0, Math.PI * 2); ctx.fill();
  }

  // お手本の動き。カメラの準備中・カメラが使えない・一時停止中は、楽な姿勢で止めて薄く描く。
  // 骨格AI・深度カメラで見ているときは、本人の段階に合わせる：待っている間はゆっくりくり返し、戻す段階では上げた形で待ち、
  // 数えたらゆっくり元へ戻ってくり返しに戻る。簡易判定（段階が分からない）では、くり返すだけ
  // mode: frozen 止める / loop くり返し / reach 上げた形へ / release 数えたあと元へ / free 簡易判定のくり返し
  const DEMO_LOOP_MS = 670;
  const DEMO_REACH_MS = 400;
  const DEMO_RELEASE_MS = 600;
  // 片側ずつ動かす運動：次に動かす側（数えた側の反対）を描く
  const SIDE_FOLLOWING = new Set(["chair-march", "knee-extend", "seated-leg-out", "side-bend"]);
  const OTHER_SIDE = { left: "right", right: "left" };
  let demoPose = { mode: "frozen", progress: 0, side: null, from: 0, at: 0, loopStart: 0 };
  const smoothStep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
  // 動きを減らす設定：お手本はなめらかに動かさず、楽な姿勢と動かしきった形を2秒ごとに切り替える
  const REDUCED_STEP_MS = 2000;
  const reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function resetDemoPose() {
    demoPose = { mode: "frozen", progress: 0, side: null, from: 0, at: 0, loopStart: 0 };
  }

  // 段階のひとこと（rest / go / back）に合わせる。戻す段階では上げた形へ、戻す前に段階が戻ったら（数えずに下ろした）元へ
  function followDemoStep(step, now) {
    if (!["loop", "reach"].includes(demoPose.mode)) return;
    if (step === "back" && demoPose.mode === "loop") Object.assign(demoPose, { mode: "reach", from: demoPose.progress, at: now });
    else if (step && step !== "back" && demoPose.mode === "reach") Object.assign(demoPose, { mode: "release", from: demoPose.progress, at: now });
  }

  // 数えたとき：ゆっくり元へ戻し、次に動かす側へ
  function releaseDemoPose(side, now) {
    if (OTHER_SIDE[side]) demoPose.side = OTHER_SIDE[side];
    if (["loop", "reach"].includes(demoPose.mode)) Object.assign(demoPose, { mode: "release", from: demoPose.progress, at: now });
  }

  function currentDemoPose(timestamp) {
    const waitingForCamera = ["preparing", "reconnecting"].includes(cameraStateKind);
    // 準備中は、お手本の下の説明も「待つ」ことを言う
    setPhraseText($("#demo-instruction-title"), waitingForCamera ? "カメラの準備ができたら はじまります" : activeSession.demoInstruction);
    // 止めるのは、一時停止・カメラの準備中・ご家族がカメラを止めているとき。カメラが使えなくても「カメラなしで1回」を出している間は、
    // 動きを見せる（それをまねして押す）
    if (activeSession.paused || waitingForCamera || cameraStateKind === "paused" || (cameraStateKind === "none" && !demoInputAvailable)) {
      Object.assign(demoPose, { mode: "frozen", progress: 0 });
      return { phase: 0, progress: 0, inverse: 1, side: null, still: true, alpha: .45 };
    }
    const free = poseMode === "fallback";
    if (free) demoPose.mode = "free";
    else if (["frozen", "free"].includes(demoPose.mode)) Object.assign(demoPose, { mode: "loop", loopStart: timestamp });
    let progress;
    let rising;
    if (reducedMotion?.matches) {
      // 数えた側・段階に合わせるのは同じ。上げた形へは切り替えて止め、戻すときはすぐ楽な姿勢に
      if (demoPose.mode === "release" && timestamp - demoPose.at >= DEMO_RELEASE_MS) Object.assign(demoPose, { mode: "loop", loopStart: timestamp });
      progress = demoPose.mode === "reach" ? 1 : demoPose.mode === "release" ? 0 : Math.floor((timestamp - demoPose.loopStart) / REDUCED_STEP_MS) % 2;
      rising = progress === 0;
    } else if (demoPose.mode === "free") {
      progress = (Math.sin(timestamp / DEMO_LOOP_MS) + 1) / 2;
      rising = Math.cos(timestamp / DEMO_LOOP_MS) > 0;
    } else if (demoPose.mode === "reach") {
      progress = demoPose.from + (1 - demoPose.from) * smoothStep((timestamp - demoPose.at) / DEMO_REACH_MS);
      rising = progress < 1;
    } else if (demoPose.mode === "release") {
      progress = demoPose.from * (1 - smoothStep((timestamp - demoPose.at) / DEMO_RELEASE_MS));
      rising = false;
      if (timestamp - demoPose.at >= DEMO_RELEASE_MS) Object.assign(demoPose, { mode: "loop", loopStart: timestamp });
    } else {
      // くり返しは楽な姿勢（0）から始める（数えて戻ったところから、とばずにつながる）
      progress = (1 - Math.cos((timestamp - demoPose.loopStart) / DEMO_LOOP_MS)) / 2;
      rising = Math.sin((timestamp - demoPose.loopStart) / DEMO_LOOP_MS) > 0;
    }
    demoPose.progress = progress;
    const side = SIDE_FOLLOWING.has(activeSession.exerciseId) ? demoPose.side : null;
    return { phase: progress * 2 - 1, progress, inverse: 1 - progress, side, rising };
  }

  function animateDemoStickman(timestamp) {
    if (!activeSession) return;
    drawPose($("#demo-stickman"), activeSession.exerciseId, currentDemoPose(timestamp));
    demoAnimationFrame = requestAnimationFrame(animateDemoStickman);
  }

  // お手本の棒人間。180×180 の座標で描き、表示の大きさ×画面の倍率（devicePixelRatio）の画素に拡大するので、テレビでもぼやけない
  const DEMO_SIZE = 180;
  const DEMO_INK = "#1c2b26";
  // 動かす所の色（白地で 4.48:1）
  const DEMO_MOVING = "#c4560f";
  const DEMO_CHAIR = "#ead9bb";
  const DEMO_ARROW = "#1d6b4e";
  // pose.pair：左右の脚の動き [左, 右]。次に動かす側が分かっていればその側だけ、分からなければ交互、止めているときは両方とも下ろす
  const legPair = ({ side, progress, inverse, still }) => side === "left" ? [progress, 0] : side === "right" ? [0, progress] : still ? [0, 0] : [progress, inverse];
  // 動かす側の関節の名前（分からなければ両側）
  const sideJoints = (side, parts) => (side ? [side] : ["left", "right"]).flatMap((name) => parts.map((part) => `${name}${part}`));
  const mixPoint = (a, b, amount) => [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount];
  // 運動ごとのお手本（正面から見た形。カメラに映る向きと同じ）。表にない運動は、動かない「座った姿」を出す（別の運動の動きは見せない）
  // d.person(関節, 動かす関節の名前) で、動かす関節につながる線を DEMO_MOVING の色で描く
  const DEMO_DRAWINGS = {
    // 座って足踏み：正面から見ると、上げたほうのひざと足が上へ動く（手は座面のわきに置く）
    "chair-march": (d, pose) => {
      const [left, right] = legPair(pose);
      d.frontChair();
      d.person({
        ...SEATED_UPPER_BODY, ...SEATED_HANDS_ON_SEAT,
        leftKnee: [74, 116 - left * 20], leftFoot: [74, 158 - left * 26],
        rightKnee: [102, 116 - right * 20], rightFoot: [102, 158 - right * 26]
      }, sideJoints(pose.side, ["Knee", "Foot"]));
    },
    // 座ってひざの開閉：両ひざを外へ開いて、閉じる（足先はほぼそのまま）
    "knee-open-close": (d, { progress }) => {
      d.frontChair();
      const open = progress * 18;
      d.person({
        ...SEATED_UPPER_BODY,
        leftHand: [72 - open * .8, 112], rightHand: [104 + open * .8, 112],
        leftElbow: [66 - open * .3, 86], rightElbow: [110 + open * .3, 86],
        leftKnee: [72 - open, 116], leftFoot: [76 - open * .3, 158],
        rightKnee: [104 + open, 116], rightFoot: [100 + open * .3, 158]
      }, ["leftKnee", "rightKnee"]);
    },
    // 肩の上げ下げ：両肩が耳のほうへ上がり、ひじと手もいっしょに少し上がる（頭と腰はそのまま）。上げている間は肩の上に小さな矢印
    "shoulder-shrug": (d, { progress, rising }) => {
      d.frontChair();
      const shoulderY = 57 - progress * 11;
      d.person({
        head: [88, 34], neck: [88, 50 - progress * 2], hip: [88, 99],
        leftShoulder: [74, shoulderY], rightShoulder: [102, shoulderY],
        leftElbow: [64, 80 - progress * 10], leftHand: [62, 102 - progress * 10],
        rightElbow: [112, 80 - progress * 10], rightHand: [114, 102 - progress * 10],
        ...SEATED_FRONT_LEGS
      }, ["leftShoulder", "rightShoulder"]);
      if (rising) {
        d.arrow(66, shoulderY - 4, -1);
        d.arrow(110, shoulderY - 4, -1);
      }
    },
    "arm-raise": (d, { progress }) => {
      const handY = 107 - progress * 82;
      const handX = 49 - progress * 7;
      d.person({
        head: [90, 34], neck: [90, 51], hip: [90, 101],
        leftShoulder: [76, 59], rightShoulder: [104, 59],
        leftElbow: [64 - progress * 7, 82 - progress * 31], leftHand: [handX, handY],
        rightElbow: [116 + progress * 7, 82 - progress * 31], rightHand: [180 - handX, handY],
        leftKnee: [77, 130], leftFoot: [70, 160], rightKnee: [103, 130], rightFoot: [110, 160]
      }, ["leftElbow", "leftHand", "rightElbow", "rightHand"]);
    },
    // 座って腕の開閉：胸の前で合わせた手を、両腕ごと横へ開いて、もどす
    "arm-open-close": (d, { progress }) => {
      d.frontChair();
      d.person({
        ...SEATED_UPPER_BODY, ...SEATED_FRONT_LEGS,
        leftElbow: mixPoint([70, 74], [48, 62], progress), leftHand: mixPoint([85, 66], [26, 64], progress),
        rightElbow: mixPoint([106, 74], [128, 62], progress), rightHand: mixPoint([91, 66], [150, 64], progress)
      }, ["leftElbow", "leftHand", "rightElbow", "rightHand"]);
    },
    // 座って体ひねり：腰と脚は前を向いたまま、肩（上体）を左右へまわす
    "seated-twist": (d, { phase }) => {
      d.frontChair();
      const turn = phase * 40 * Math.PI / 180;
      const half = 14 * Math.cos(turn);
      const shift = Math.sin(turn) * 6;
      const neck = [88 + shift * .5, 50];
      const leftShoulder = [88 - half + shift, 57];
      const rightShoulder = [88 + half + shift, 57];
      d.person({
        head: [88 + shift * .8, 34], neck, hip: [88, 99],
        leftShoulder, rightShoulder,
        // 腕は胸の前で組む（肩といっしょにまわる）
        leftElbow: [leftShoulder[0] - 4, 74], leftHand: [88 + shift * 1.6 + 6, 70],
        rightElbow: [rightShoulder[0] + 4, 74], rightHand: [88 + shift * 1.6 - 6, 70],
        ...SEATED_FRONT_LEGS
      }, ["leftShoulder", "rightShoulder", "leftElbow", "rightElbow"]);
      d.turnArrow(88, 20, phase);
    },
    // 座って体の横倒し：腰・脚・椅子はそのまま、頭から腕までを腰を中心に横へ倒す（次に倒す側が分かればその側へ、分からなければ交互）
    "side-bend": (d, pose) => {
      d.frontChair();
      const lean = pose.side ? pose.progress * (pose.side === "left" ? -1 : 1) : pose.still ? 0 : pose.phase;
      const angle = lean * 18 * Math.PI / 180;
      const hip = [88, 99];
      const tilt = ([x, y]) => [hip[0] + (x - hip[0]) * Math.cos(angle) - (y - hip[1]) * Math.sin(angle), hip[1] + (x - hip[0]) * Math.sin(angle) + (y - hip[1]) * Math.cos(angle)];
      const head = tilt([88, 34]);
      d.person({
        head, neck: tilt([88, 50]), hip,
        leftShoulder: tilt([74, 57]), rightShoulder: tilt([102, 57]),
        leftElbow: tilt([66, 80]), leftHand: tilt([64, 101]), rightElbow: tilt([110, 80]), rightHand: tilt([112, 101]),
        ...SEATED_FRONT_LEGS
      }, ["head", "neck", "leftShoulder", "rightShoulder"]);
      d.turnArrow(head[0], 15, lean);
    },
    // 座ってかかと上げ：正面から見ると、両ひざと足先が少しだけ上がる（つま先は床）。正面では小さいので、左下の丸に横から見た足を大きく描く
    "seated-heel-raise": (d, { progress, rising }) => {
      d.frontChair();
      const lift = progress * 6;
      d.person({
        ...SEATED_UPPER_BODY, ...SEATED_HANDS_ON_SEAT,
        leftKnee: [74, 116 - lift * .7], leftFoot: [74, 158 - lift],
        rightKnee: [102, 116 - lift * .7], rightFoot: [102, 158 - lift]
      }, ["leftKnee", "leftFoot", "rightKnee", "rightFoot"]);
      d.footInset(progress, rising);
    },
    // 立ってかかと上げ：椅子の横に立ち、椅子に近いほうの手を背もたれに置いたまま、体全体が少し上がる。左下の丸に横から見た足
    "standing-heel-raise": (d, { progress, rising }) => {
      d.sideChair();
      const up = progress * 7;
      d.person({
        head: [80, 31 - up], neck: [80, 48 - up], hip: [80, 99 - up],
        leftShoulder: [66, 57 - up], rightShoulder: [94, 57 - up],
        leftElbow: [56, 78 - up], leftHand: [53, 99 - up],
        // 背もたれの上に置いた手は動かない（ひじが少し曲がる）
        rightElbow: [112, 76 - up * .5], rightHand: [131, 86],
        leftKnee: [71, 129 - up], leftFoot: [70, 160 - up * .6],
        rightKnee: [89, 129 - up], rightFoot: [90, 160 - up * .6]
      }, ["leftFoot", "rightFoot"]);
      d.footInset(progress, rising);
    },
    // 浅いスクワット：椅子の前に立ち、椅子に座るように腰を少しだけ下ろす（座りきらない）。下ろしている間は腰の横に下向きの矢印
    "mini-squat": (d, { progress, rising }) => {
      d.standingFrontChair();
      const down = progress * 12;
      d.person({
        head: [88, 21 + down], neck: [88, 37 + down], hip: [88, 78 + down],
        leftShoulder: [74, 44 + down], rightShoulder: [102, 44 + down],
        leftElbow: [64, 63 + down], leftHand: [66, 84 + down], rightElbow: [112, 63 + down], rightHand: [110, 84 + down],
        leftKnee: [78 - progress * 4, 121 + down * .2], leftFoot: [76, 160],
        rightKnee: [98 + progress * 4, 121 + down * .2], rightFoot: [100, 160]
      }, ["hip", "leftKnee", "rightKnee"]);
      if (rising) {
        d.arrow(56, 70 + down, 1);
        d.arrow(120, 70 + down, 1);
      }
    },
    // ひざ伸ばし：正面から見ると、ひざの位置はそのままで、伸ばしたほうの足先がひざの高さまで上がってくる
    "knee-extend": (d, pose) => {
      const [left, right] = legPair(pose);
      d.frontChair();
      d.person({
        ...SEATED_UPPER_BODY, ...SEATED_HANDS_ON_SEAT,
        leftKnee: [74, 116 - left * 3], leftFoot: [74, 158 - left * 34],
        rightKnee: [102, 116 - right * 3], rightFoot: [102, 158 - right * 34]
      }, sideJoints(pose.side, ["Foot"]));
    },
    // 座って足を横へ：片足を床の上で横へすべらせる（足先が外へ、ひざはその半分外へ。足の高さはそのまま）
    "seated-leg-out": (d, pose) => {
      const [left, right] = legPair(pose);
      d.frontChair();
      d.person({
        ...SEATED_UPPER_BODY, ...SEATED_HANDS_ON_SEAT,
        leftKnee: [74 - left * 12, 116], leftFoot: [74 - left * 28, 158],
        rightKnee: [102 + right * 12, 116], rightFoot: [102 + right * 28, 158]
      }, sideJoints(pose.side, ["Foot"]));
    },
    "side-step": (d, { phase }) => {
      const x = 90 + phase * 14;
      const spread = 14 + Math.abs(phase) * 23;
      d.person({
        head: [x, 31], neck: [x, 48], hip: [x, 99],
        leftShoulder: [x - 15, 57], rightShoulder: [x + 15, 57],
        leftElbow: [x - 29, 78], leftHand: [x - 38, 99], rightElbow: [x + 29, 78], rightHand: [x + 38, 99],
        leftKnee: [x - spread * .6, 129], leftFoot: [x - spread, 160],
        rightKnee: [x + spread * .6, 129], rightFoot: [x + spread, 160]
      }, ["leftFoot", "rightFoot"]);
    },
    // 椅子から立つ：正面から見ると、体全体が上下する（座るとひざが少し開いて前に出る）。椅子は後ろに
    "sit-stand": (d, { inverse }) => {
      const drop = inverse * 26;
      d.frontChair();
      d.person({
        head: [88, 21 + drop], neck: [88, 37 + drop], hip: [88, 78 + drop],
        leftShoulder: [74, 44 + drop], rightShoulder: [102, 44 + drop],
        leftElbow: [66, 64 + drop], leftHand: [70, 86 + drop], rightElbow: [110, 64 + drop], rightHand: [106, 86 + drop],
        leftKnee: [79 - inverse * 5, 121 - inverse * 5], leftFoot: [76, 160],
        rightKnee: [97 + inverse * 5, 121 - inverse * 5], rightFoot: [100, 160]
      }, ["hip"]);
    }
  };
  // 正面から見た座った姿（上体と脚）。新しい運動と、表にない運動の「動かないお手本」に使う
  const SEATED_UPPER_BODY = {
    head: [88, 34], neck: [88, 50], hip: [88, 99],
    leftShoulder: [74, 57], rightShoulder: [102, 57]
  };
  const SEATED_FRONT_LEGS = {
    leftKnee: [74, 116], leftFoot: [74, 158], rightKnee: [102, 116], rightFoot: [102, 158]
  };
  // 手は座面のわきに置く（ひざや足の動きに重ならない）
  const SEATED_HANDS_ON_SEAT = {
    leftElbow: [64, 80], leftHand: [62, 102], rightElbow: [112, 80], rightHand: [114, 102]
  };
  function drawSeatedStill(d) {
    d.frontChair();
    d.person({
      ...SEATED_UPPER_BODY, ...SEATED_FRONT_LEGS,
      leftElbow: [66, 84], leftHand: [74, 110], rightElbow: [110, 84], rightHand: [102, 110]
    });
  }

  // 表示の大きさに合わせて、キャンバスの画素数を（表示の大きさ×画面の倍率）にそろえる
  function fitCanvasToDisplay(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const side = Math.round(Math.min(canvas.clientWidth || DEMO_SIZE, canvas.clientHeight || canvas.clientWidth || DEMO_SIZE) * ratio);
    const size = Math.max(DEMO_SIZE, Math.min(1600, side));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  // 時刻だけで描くお手本（ずっとくり返す。自動テストが運動ごとの絵を比べるのにも使う）
  function drawDemoStickman(timestamp, exerciseId) {
    const phase = Math.sin(timestamp / DEMO_LOOP_MS);
    const progress = (phase + 1) / 2;
    drawPose($("#demo-stickman"), exerciseId, { phase, progress, inverse: 1 - progress, side: null, rising: Math.cos(timestamp / DEMO_LOOP_MS) > 0 });
  }

  // ひとつの形を描く。pose：phase（-1〜1）・progress（0 楽な姿勢〜1 動かしきった形）・inverse・side（次に動かす側）・still（止めている）・
  // rising（上げている途中）・alpha（薄く描く）。look.icon：運動選択の丸の絵（体のまわりだけを大きく、線を太く）
  function drawPose(canvas, exerciseId, pose, look = {}) {
    const ctx = canvas.getContext("2d");
    fitCanvasToDisplay(canvas);
    // 運動選択の丸では、体のまわり（12〜164）だけを描く
    const [from, span] = look.icon ? [12, 152] : [0, DEMO_SIZE];
    const scale = canvas.width / span;
    const limbWidth = look.icon ? 9 : 7;
    // 毎回の絶対指定（scale を重ねがけしない）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, -from * scale, -from * scale);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const line = (a, b, color = DEMO_INK, width = limbWidth) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    };
    const arrowHead = (tip, back, wing) => {
      ctx.fillStyle = DEMO_ARROW;
      ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(back[0], back[1]); ctx.lineTo(wing[0], wing[1]); ctx.closePath(); ctx.fill();
    };
    const d = {
      person(points, moving = []) {
        const isMoving = (name) => moving.includes(name);
        ctx.strokeStyle = isMoving("head") ? DEMO_MOVING : DEMO_INK;
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(points.head[0], points.head[1], 13, 0, Math.PI * 2); ctx.stroke();
        [["neck", "hip"], ["leftShoulder", "rightShoulder"], ["leftShoulder", "leftElbow"], ["leftElbow", "leftHand"], ["rightShoulder", "rightElbow"], ["rightElbow", "rightHand"], ["hip", "leftKnee"], ["leftKnee", "leftFoot"], ["hip", "rightKnee"], ["rightKnee", "rightFoot"]]
          .forEach(([a, b]) => line(points[a], points[b], isMoving(a) || isMoving(b) ? DEMO_MOVING : DEMO_INK));
      },
      // 正面から見た椅子：背もたれ・座面・脚をひとつのやわらかい形で、人の後ろに
      frontChair() {
        ctx.fillStyle = DEMO_CHAIR;
        ctx.beginPath();
        ctx.roundRect(61, 42, 54, 64, 8);
        ctx.roundRect(54, 99, 68, 12, 6);
        ctx.roundRect(56, 104, 8, 58, 4);
        ctx.roundRect(112, 104, 8, 58, 4);
        ctx.fill();
      },
      // 立った人の後ろの椅子（正面から）：立った人の大きさに合わせ、座面はひざの高さ、背もたれの上は腰のあたり（座った人用の椅子だと、座って見える）
      standingFrontChair() {
        ctx.fillStyle = DEMO_CHAIR;
        ctx.beginPath();
        ctx.roundRect(64, 88, 48, 36, 7);
        ctx.roundRect(58, 119, 60, 10, 5);
        ctx.roundRect(60, 124, 7, 38, 3);
        ctx.roundRect(109, 124, 7, 38, 3);
        ctx.fill();
      },
      // 体をまわす・倒す向きの矢印（頭の上の弧）。amount の正負で向きが変わる
      turnArrow(cx, cy, amount) {
        if (Math.abs(amount) < .15) return;
        const dir = Math.sign(amount);
        const end = cx + dir * 26 * Math.min(1, Math.abs(amount) * 1.2);
        ctx.strokeStyle = DEMO_ARROW;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(cx - dir * 10, cy + 2); ctx.quadraticCurveTo(cx, cy - 8, end, cy + 2); ctx.stroke();
        arrowHead([end + dir * 6, cy + 3], [end - dir * 3, cy - 4], [end - dir * 1, cy + 9]);
      },
      // 上（dir -1）か下（dir 1）へ向かう小さな矢印（肩の上げ下げ・浅いスクワット）
      arrow(x, y, dir) {
        line([x, y], [x, y + dir * 9], DEMO_ARROW, 3);
        arrowHead([x, y + dir * 15], [x - 5, y + dir * 8], [x + 5, y + dir * 8]);
      },
      // 横から見た椅子：人の右に、背もたれを人の側に向けて置く（背もたれの上に手を置く）
      sideChair() {
        ctx.fillStyle = DEMO_CHAIR;
        ctx.beginPath();
        ctx.roundRect(126, 84, 9, 78, 4);
        ctx.roundRect(126, 116, 42, 9, 4);
        ctx.roundRect(159, 120, 8, 42, 4);
        ctx.fill();
      },
      // 横から見た足（左下の丸）：足の指の付け根から先は床につけたまま、かかとが上がる。正面の絵では小さいかかとの動きを大きく見せる
      footInset(progress, rising) {
        const [cx, cy, r] = [39, 131, 27];
        const floor = cy + 17;
        ctx.save();
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "rgba(23,53,45,.35)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.clip();
        line([cx - r, floor + 4], [cx + r, floor + 4], "rgba(23,53,45,.3)", 2);
        // 指の付け根を中心に、かかとから付け根までを傾ける（上げきって約40°）。すねは少し前へ傾く
        const angle = progress * 40 * Math.PI / 180;
        const ball = [cx + 8, floor];
        const heel = [ball[0] - 20 * Math.cos(angle), ball[1] - 20 * Math.sin(angle)];
        const ankle = [heel[0] + 4 * Math.cos(angle) + 9 * Math.sin(angle), heel[1] + 4 * Math.sin(angle) - 9 * Math.cos(angle)];
        line([ankle[0] - 6 + progress * 4, cy - r - 4], ankle, DEMO_MOVING, 6);
        line(heel, ankle, DEMO_MOVING, 6);
        line(heel, ball, DEMO_MOVING, 6);
        line(ball, [ball[0] + 10, floor], DEMO_MOVING, 6);
        if (rising) this.arrow(heel[0] - 7, heel[1] - 2, -1);
        ctx.restore();
      }
    };

    // 床の線（運動の丸の小さな絵では描かない）
    if (!look.icon) {
      ctx.strokeStyle = "rgba(23,53,45,.14)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(18, 163); ctx.lineTo(162, 163); ctx.stroke();
    }
    (DEMO_DRAWINGS[exerciseId] || drawSeatedStill)(d, pose);
    // 薄く描くときは、描いたあとで全体を同じ濃さにする（線を1本ずつ薄くすると、重なった関節だけ濃くなる）
    if (pose.alpha !== undefined && pose.alpha < 1) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.globalAlpha = pose.alpha;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  }

  function evaluateMotion(energy, now) {
    const level = energy < 1.4 ? "静止" : energy < 3.8 ? "小さな動き" : energy < 7.5 ? "良い動き" : "大きな動き";
    $("#motion-level").textContent = level;
    if (energy < 1.8) {
      if (!lastLowMotion) lastLowMotion = now;
      if (now - lastLowMotion > 420) motionArmed = true;
    } else {
      lastLowMotion = 0;
    }
    if (energy > 5.5 && motionArmed && now - lastDetectedRep > 950) {
      motionArmed = false;
      lastDetectedRep = now;
      registerRep("fallback");
    }
  }

  function registerRep(source) {
    if (!activeSession || activeSession.paused || finishing) return;
    activeSession.count += 1;
    if (activeSession.repSources[source] !== undefined) activeSession.repSources[source] += 1;
    renderAnalysisPill();
    const count = activeSession.count;
    const percent = Math.min(100, Math.round(count / activeSession.target * 100));
    $("#current-count").textContent = count;
    $("#session-progress").style.width = `${percent}%`;
    const firstLine = "はじめの1回、できました";
    $("#motion-feedback").textContent = count >= activeSession.target
      ? "できました！おつかれさまでした"
      : count === 1
        ? firstLine
        : count % 3 === 0
          ? "いい調子です。そのままゆっくり"
          : source === "demo" ? `${count}回 数えました` : `${count}回できました`;
    repMessageUntil = performance.now() + 1200;
    showRepCue();
    // 1回できたら、使い方はもう要らない（骨格が出ない簡易判定でも閉じる。見たことにする）
    if (sessionIntroOpen()) closeIntro(true);
    const halfway = !activeSession.halfwayPlayed && count >= Math.ceil(activeSession.target / 2);
    // はじめの1回は声でも（半分・目標と同じ回なら、そちらの声だけ）。半分の声も、読んでいる声を止めずにそのあとに
    if (count === 1 && count < activeSession.target && !halfway) speakMilestone("first", firstLine);
    if (halfway) {
      activeSession.halfwayPlayed = true;
      playEncouragement("progress", "半分まできました。いい調子です。", { queue: true });
    }
    if (count >= activeSession.target) {
      finishing = true;
      const session = activeSession;
      clearTimeout(finishTimer);
      finishTimer = setTimeout(() => {
        finishTimer = null;
        if (activeSession === session) finishSession(true);
      }, 650);
      // 目標に届いたお祝いの紙吹雪（練習でも出す。D-12）。結果の画面への流れ（650ms）はそのまま
      celebrate();
    }
  }

  // 1回数えた合図：回数の欄が 0.8秒 橙の地に、映像のふちに橙の線、短い音（動いてよいときは回数がはずむ）。合図が失敗しても数えることは止めない
  const REP_CUE_MS = 800;
  function showRepCue() {
    try {
      const countElement = $("#current-count");
      countElement.classList.remove("is-bump");
      void countElement.offsetWidth;
      countElement.classList.add("is-bump");
      countElement.addEventListener("animationend", () => countElement.classList.remove("is-bump"), { once: true });
      const panels = [$(".camera-panel"), $(".count-card"), $("#motion-feedback")].filter(Boolean);
      panels.forEach((panel) => {
        panel.classList.remove("is-rep");
        void panel.offsetWidth;
        panel.classList.add("is-rep");
      });
      clearTimeout(repRingTimer);
      repRingTimer = setTimeout(() => panels.forEach((panel) => panel.classList.remove("is-rep")), REP_CUE_MS);
    } catch { /* 表示の合図が出なくても数えは続ける */ }
    playRepChime();
  }

  // 短い2音（この端末で作る音。ファイルやネットワークは使わない）。設定「1回ごとに音で知らせる」で止められる。
  // 読み上げ（位置案内・家族の声）は止めない
  function playRepChime() {
    if (state.repSound === false || !audioContext) return;
    try {
      if (audioContext.state === "suspended") audioContext.resume();
      const startAt = audioContext.currentTime + .01;
      [[880, 0], [1175, .11]].forEach(([frequency, offset]) => {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(.2, startAt + offset);
        gain.gain.exponentialRampToValueAtTime(.001, startAt + offset + .11);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(startAt + offset);
        oscillator.stop(startAt + offset + .12);
      });
    } catch { /* 音が出なくても数えは止めない */ }
  }

  // 紙吹雪：目標の回数に届いたときのお祝い。この端末で描く（ライブラリ・ネットは使わない）。
  // body の直下（.view の外）に重ねるので、結果の画面へ移っても続く。押す所はふさがない（pointer-events: none）
  const CONFETTI_PIECES = 140;
  const CONFETTI_MS = 2600;
  // 最後の0.6秒で、だんだん薄くする（ぱっと消さない）
  const CONFETTI_FADE_MS = 600;
  // 落ちはじめてから、空気でおさえられた一定の速さに近づくまでの目安（秒）
  const CONFETTI_SETTLE_S = .3;
  // 黄・緑・橙・水色・桃・白
  const CONFETTI_COLORS = ["#f4ca47", "#2f805e", "#f0a92c", "#7cc4e8", "#e98aa0", "#ffffff"];
  // 白い紙は明るい地でも見えるよう、うすいふちをつける
  const CONFETTI_WHITE_EDGE = "rgba(28, 43, 38, .3)";
  let confetti = null;

  function stopConfetti() {
    if (!confetti) return;
    cancelAnimationFrame(confetti.frame);
    confetti.canvas.remove();
    confetti = null;
  }

  // 1枚の紙（四角か細長い形）。位置は経った時間の式で決めるので、コマが落ちても速さは変わらない。
  // 画面の上の外から落ち、左右にゆれ、回る。裏返りは1秒に1.2回まで（細くなって見えなくなるのは1秒に2.4回まで。1秒に3回をこえる点滅にしない）
  function makeConfettiPiece(width, height) {
    const unit = Math.max(8, Math.min(width, height) / 60);
    const size = unit * (.8 + Math.random() * .5);
    const long = Math.random() < .45;
    return {
      x: -width * .05 + Math.random() * width * 1.1,
      y: -size * 2 - Math.random() * height * .6,
      // 空気でおさえられた一定の落ちる速さ（1秒に画面の高さの 0.5〜0.8）
      fall: height * (.5 + Math.random() * .3),
      drift: (Math.random() - .5) * width * .06,
      sway: unit * (1.5 + Math.random() * 2.5),
      swayRate: Math.PI * 2 * (.4 + Math.random() * .5),
      phase: Math.random() * Math.PI * 2,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() < .5 ? -1 : 1) * (1 + Math.random() * 3),
      flipRate: Math.PI * 2 * (.5 + Math.random() * .7),
      w: long ? size * .45 : size,
      h: long ? size * 1.8 : size,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]
    };
  }

  function drawConfetti(run, now) {
    try {
      if (confetti !== run) return;
      const elapsed = now - run.startedAt;
      if (elapsed >= CONFETTI_MS) {
        stopConfetti();
        return;
      }
      const { context, ratio, height } = run;
      const t = Math.max(0, elapsed) / 1000;
      // 止まった所から重さで落ちはじめ、一定の速さに近づく（落ちた量を、一定の速さで落ちた時間にしたもの）
      const fallen = t - CONFETTI_SETTLE_S * (1 - Math.exp(-t / CONFETTI_SETTLE_S));
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, run.canvas.width, run.canvas.height);
      context.globalAlpha = Math.min(1, (CONFETTI_MS - elapsed) / CONFETTI_FADE_MS);
      context.strokeStyle = CONFETTI_WHITE_EDGE;
      context.lineWidth = 1;
      for (const piece of run.pieces) {
        const y = piece.y + piece.fall * fallen;
        if (y - piece.h > height) continue;
        const x = piece.x + piece.drift * t + piece.sway * Math.sin(piece.swayRate * t + piece.phase);
        const angle = piece.angle + piece.spin * t;
        const flip = Math.cos(piece.flipRate * t + piece.phase);
        const cos = Math.cos(angle) * ratio;
        const sin = Math.sin(angle) * ratio;
        // 回して、縦に縮めて裏返る形に（画面の倍率もここでかける）
        context.setTransform(cos, sin, -sin * flip, cos * flip, x * ratio, y * ratio);
        context.fillStyle = piece.color;
        context.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
        if (piece.color === "#ffffff") context.strokeRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      }
      run.frame = requestAnimationFrame((time) => drawConfetti(run, time));
    } catch {
      if (confetti === run) stopConfetti();
    }
  }

  // 動きを減らす設定・見えていない画面では出さない。続けて目標に届いたら、前の紙吹雪を止めて新しく始める。
  // 失敗しても、数えること・結果の画面は止めない
  function celebrate() {
    try {
      stopConfetti();
      if (reducedMotion?.matches || document.hidden) return;
      const width = document.documentElement.clientWidth || window.innerWidth;
      const height = document.documentElement.clientHeight || window.innerHeight;
      // テレビでもぼやけないよう画面の倍率で描く。重くならないよう 1.5 倍まで
      const ratio = Math.min(1.5, window.devicePixelRatio || 1);
      const canvas = document.createElement("canvas");
      canvas.id = "confetti-layer";
      canvas.setAttribute("aria-hidden", "true");
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      const run = { canvas, context, ratio, height, frame: 0, startedAt: performance.now(),
        pieces: Array.from({ length: CONFETTI_PIECES }, () => makeConfettiPiece(width, height)) };
      confetti = run;
      document.body.appendChild(canvas);
      run.frame = requestAnimationFrame((time) => drawConfetti(run, time));
    } catch {
      stopConfetti();
    }
  }

  function elapsedSeconds() {
    if (!activeSession) return 0;
    const end = activeSession.paused ? activeSession.pausedAt : Date.now();
    return Math.max(0, Math.floor((end - activeSession.startedAt - activeSession.pausedTotal) / 1000));
  }

  function updateSessionTimer() {
    const seconds = elapsedSeconds();
    $("#session-time").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function togglePause() {
    if (!activeSession || finishing) return;
    activeSession.paused = !activeSession.paused;
    views.session.classList.toggle("is-paused", activeSession.paused);
    renderCameraStateLabel();
    repMessageUntil = 0;
    if (activeSession.paused) {
      activeSession.pausedAt = Date.now();
      hidePositionGuide();
      clearPoseOverlay();
      $("#pause-session").textContent = "再開する";
      $("#motion-feedback").textContent = "一時停止中です";
    } else {
      activeSession.pausedTotal += Date.now() - activeSession.pausedAt;
      activeSession.pausedAt = 0;
      // 停止前の途中状態を持ち越さず、下げた位置の確認からやり直す（計測の質は足しておく。この人向けのしきい値は運動の間ずっと同じ）
      if (poseCounter) Logic.mergeMarchQuality(activeSession.quality, Logic.marchQualitySnapshot(poseCounter));
      poseCounter = Logic.createPoseCounter(activeSession.exerciseId, performance.now(), { limits: activeSession.limitsSnapshot });
      localClockOffset = null;
      filteredPoseLandmarks = null;
      filteredWorldLandmarks = null;
      previousFrame = null;
      motionArmed = false;
      lastLowMotion = 0;
      $("#pause-session").textContent = "一時停止";
      // カメラが使えないときは大きな案内が出ているので、ひとことは重ねない
      $("#motion-feedback").textContent = activeSession.cameraUnavailable ? "" : "ゆっくり再開しましょう";
      repMessageUntil = performance.now() + 1500;
    }
  }

  function cleanupSession() {
    if (sessionIntroOpen()) closeIntro(false);
    clearTimeout(finishTimer);
    finishTimer = null;
    stopVideoFrameInference();
    detectFailures = [];
    views.session.classList.remove("is-paused");
    demoInputAvailable = false;
    if (localSensorClient) localSensorClient.close();
    localSensorClient = null;
    localFrameSize = null;
    clearCameraPreview();
    hidePositionGuide();
    clearInterval(sessionTimer);
    sessionTimer = null;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    if (demoAnimationFrame) cancelAnimationFrame(demoAnimationFrame);
    demoAnimationFrame = null;
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $("#camera-video").srcObject = null;
    poseMode = "idle";
    poseCounter = null;
    lastPoseLandmarks = null;
    lastWorldLandmarks = null;
    filteredPoseLandmarks = null;
    filteredWorldLandmarks = null;
    previousFrame = null;
    const overlay = $("#pose-overlay");
    overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
    syncCameraView();
  }

  function finishSession(completedTarget) {
    if (!activeSession) return;
    if (poseCounter) Logic.mergeMarchQuality(activeSession.quality, Logic.marchQualitySnapshot(poseCounter));
    const draft = { ...activeSession };
    // 家族への見守り：回数 0 で終えた座って足踏みも、本物のカメラ（端末サービスの深度カメラ / ブラウザの骨格AI）だったときだけ「試み」として覚える（cleanupSession が poseMode を戻す前に見る）
    const attemptSource = draft.usedCamera && !testPoseMode && !cameraSourceText.startsWith("模擬") ? (poseMode === "local" ? "rgbd" : poseMode === "pose" ? "pose" : null) : null;
    finishing = true;
    cleanupSession();
    if (draft.count === 0 && !completedTarget) {
      if (draft.exerciseId === "chair-march" && attemptSource) {
        try {
          const attempt = Logic.recordMarchAttempt(state, { source: attemptSource, quality: draft.quality, bodySamples: draft.bodySamples, target: draft.clearThreshold, now: Date.now(),
            trackingQuality: draft.poseQualitySamples ? draft.poseQualitySum / draft.poseQualitySamples : null, validRatio: draft.poseFrames ? draft.validPoseFrames / draft.poseFrames : null });
          if (attempt.recorded) {
            state = attempt.state;
            saveState();
          }
        } catch (error) { /* 見守りが失敗しても、本人の画面はいつも通り */ }
      }
      activeSession = null;
      finishing = false;
      // 「0回」「保存しませんでした」とは言わない。同じ運動が選ばれたままなので、もう一度は「この運動をはじめる」で
      navigate("home");
      showHomeNotice();
      speakText("おつかれさまでした。またいつでも、ゆっくりどうぞ。");
      return;
    }
    const trackingRatio = draft.poseFrames ? draft.validPoseFrames / draft.poseFrames : 0;
    const averageQuality = draft.poseQualitySamples ? draft.poseQualitySum / draft.poseQualitySamples : 0;
    const averageRange = draft.rangeQualitySamples ? draft.rangeQualitySum / draft.rangeQualitySamples : 0;
    const averageTempoMs = draft.cycleDurationSamples ? draft.cycleDurationSum / draft.cycleDurationSamples : 0;
    const inputSource = Logic.resolveInputSource(draft.repSources);
    const score = ["pose", "rgbd", "mock"].includes(inputSource) && draft.poseFrames
      ? Math.min(98, Math.round(50 + Math.min(20, draft.count * 2) + trackingRatio * 12 + averageQuality * .08 + Math.min(100, averageRange) * .08))
      : Math.min(92, 64 + Math.min(22, draft.count * 2) + (draft.usedCamera ? 3 : 0));
    // 体の分析：座って足踏みで、実績に数える入力元（pose / rgbd）のときだけ覚える（デモ・模擬・簡易・混在は植物と同じく使わない）
    const teaches = draft.exerciseId === "chair-march" && Logic.INPUT_SOURCES[inputSource]?.countsTowardProgress === true && draft.count > 0;
    // 学習や見守りが失敗しても運動の記録は残す（learning が null なら体の分析は変えない）
    let learning = null;
    if (teaches) {
      try {
        learning = Logic.learnMarchSession(state.bodyProfile, {
          learned: draft.learned, bodySamples: draft.bodySamples, quality: draft.quality, now: Date.now(), watch: state.watch,
          // 家族への見守り：目標（運営のクリア基準、開始時に固定）に届いたか、追跡の質、有効なフレームの割合
          completed: Boolean(completedTarget) || draft.count >= draft.clearThreshold, target: draft.clearThreshold,
          trackingQuality: averageQuality, validRatio: trackingRatio
        });
      } catch (error) {
        learning = null;
      }
    }
    // 元気の木の段階：記録の前と後（育ったら結果の画面で育つところを見せる）
    const plantBefore = Logic.getPlantStage(state);
    const result = Logic.completeSession(state, {
      exerciseId: draft.exerciseId,
      count: draft.count,
      durationSec: Math.max(1, elapsedSeconds()),
      score,
      trackingQuality: averageQuality,
      rangeScore: averageRange,
      averageTempoSec: averageTempoMs ? averageTempoMs / 1000 : 0,
      sensorMode: cameraSourceText,
      inputSource,
      repSources: draft.repSources,
      // 練習の記録になったわけ（ご家族の欄だけに出す）。実績に数える記録には付かない
      practiceReason: Logic.practiceReason(draft.repSources, draft.fallbackReason),
      // 運営の設定：練習でも目標に届けばクリアにする（運動を始めたときの設定）
      practiceClears: draft.practiceClears === true,
      clearThreshold: draft.clearThreshold,
      poseModel: draft.poseModel,
      spatialMode: draft.spatialMode,
      startedAt: draft.startedAt,
      bodyProfile: learning ? learning.profile : null,
      learnedReps: learning ? learning.learnedReps : 0,
      attestedReps: learning ? learning.attested : 0,
      liftMeters: draft.limitsSnapshot?.liftMeters ?? Logic.MARCH_LIMITS.liftMeters,
      limitsSnapshot: draft.limitsSnapshot,
      kneeDepthAdoption: learning ? learning.kneeDepthAdoption : null,
      restSdM: learning ? learning.restSdM : null,
      // 家族だけに届くお知らせ（レベル・数え方の調整・見守り）と見守りの履歴は completeSession が state に入れる
      learning
    });
    result.learning = learning;
    result.plantBefore = plantBefore;
    result.plantAfter = Logic.getPlantStage(result.state);
    state = result.state;
    saveState();
    activeSession = null;
    finishing = false;
    renderResult(result);
    // 結果のあと運動選択へ戻ったら、きょうのおすすめを選び直す
    todayPickPending = true;
    navigate("result");
    playEncouragement("finish", "おつかれさまでした。今日の運動、完了です。");
  }

  function renderResult(result) {
    const session = result.session;
    $("#result-count").textContent = `${session.count}回`;
    $("#result-duration").textContent = `${session.duration_sec}秒`;
    $("#result-score").textContent = `${session.motion_score}点`;
    // 可動域（%）や1回あたりの秒数は体の数値なので本人には出さない（記録には残る。よしさん 2026-10-06）
    // 練習の記録（ボタン・簡易判定・ためしのカメラ）は家族へ何も届かないので、お知らせの欄ごと隠す（方式の名前も本人には出さない）
    const practice = result.countsTowardProgress === false;
    $("#result-message").textContent = `${session.exercise_name}を${session.count}回行いました。${practice ? "きょうは練習として、このPCに記録しました。" : "記録はこのPCに保存されました。"}`;
    const unlockedShown = Boolean(result.unlockedExercise) && state.exercises.findIndex((exercise) => exercise.id === result.unlockedExercise.id) < homeExerciseCount();
    if (result.practiceClear && unlockedShown) $("#result-message").textContent += "運営の設定で、次の運動も選べるようにしました。";
    if (practice && session.exercise_id === "chair-march") $("#result-message").textContent += "練習の記録なので、体の分析には使いません。";
    // 家族へのお知らせは、ダッシュボードのお知らせと同じ1行（スコアや届け方の言葉は出さない）
    $("#line-message").textContent = practice ? "" : `${session.exercise_name}を ${session.count}回 しました`;
    $(".line-preview").hidden = practice;
    // 体の分析（一緒に育つ）：今日ぶん覚えた回数と、次のレベルまでの残り。レベルが上がったときはそれだけ言う
    const learning = result.learning || null;
    const analysis = Logic.getAnalysisLevel(state.bodyProfile);
    $("#result-analysis").textContent = analysis.level ? `レベル${analysis.level}` : "はじめまして";
    let analysisNote;
    if (session.exercise_id !== "chair-march") analysisNote = "座って足踏みで育ちます";
    else if (practice) analysisNote = "練習なので 体の分析は そのままです";
    else if (learning?.levelUp) analysisNote = `体の分析が レベル${learning.after.level}に なりました`;
    else if (learning && learning.learnedReps > 0 && !learning.otherPerson) {
      analysisNote = `今日の${learning.learnedReps}回ぶん覚えました${analysis.next ? `。${Logic.nextLevelText(analysis)}` : ""}`;
    } else analysisNote = "今日の足踏みも記録しました";
    $("#result-analysis-note").textContent = analysisNote;
    // 数え方をこの人に合わせた知らせ・体の数値・見守りのお知らせは本人には出さない（家族だけに届く通知へ。よしさん 2026-10-06）
    renderResultTree(result, practice);
    renderUnlockCard(result.unlockedExercise);
  }

  // 結果の元気の木。段階が上がったときだけ、育つ動き（動きを減らす設定では動かさない）と「元気の木が ○○に なりました」を、声でも1回。
  // 練習の記録では木はそのままで「練習でした」
  function renderResultTree(result, practice) {
    const before = result.plantBefore || Logic.getPlantStage(state);
    const after = practice ? before : (result.plantAfter || before);
    const svg = $("#result-plant");
    PlantView.renderPlantInto(svg, after);
    $("#result-plant-label").textContent = after.label;
    const grew = !practice && after.level > before.level;
    svg.classList.remove("is-growing");
    if (grew) {
      void svg.getBoundingClientRect();
      svg.classList.add("is-growing");
    }
    const line = $("#result-grow");
    line.classList.toggle("is-practice", practice);
    line.textContent = grew ? `元気の木が ${after.label}に なりました` : practice ? "練習でした" : "";
    line.hidden = !line.textContent;
    if (grew) speakWhenQuiet(line.textContent);
  }

  // 新しく選べるようになった運動：その運動の絵（動かしきった形）と、運動選択でその運動を選んでおくボタン
  function renderUnlockCard(unlocked) {
    const card = $("#unlock-message");
    // 選ぶ画面に出ない運動（運営の設定で隠している立ってする運動）は知らせない
    const found = unlocked ? state.exercises.findIndex((exercise) => exercise.id === unlocked.id) : -1;
    const index = found < homeExerciseCount() ? found : -1;
    card.hidden = index < 0;
    if (index < 0) return;
    const exercise = state.exercises[index];
    $("#unlock-name").textContent = exercise.name;
    card.dataset.index = String(index);
    drawPose($("#unlock-pose"), exercise.id, ICON_POSE, { icon: true });
  }

  function showUnlockedExercise() {
    const index = Number($("#unlock-message").dataset.index);
    if (!state.exercises[index]?.unlocked) return;
    selectedIndex = index;
    todayPickDay = Logic.localDateKey(new Date());
    todayPickPending = false;
    navigate("home");
  }

  // 結果の声（「おつかれさまでした」など）が終わってから1回だけ読む。ほかの声は止めない。5秒待っても話し中なら読まない
  function speakWhenQuiet(text, waitMs = 5000) {
    const since = performance.now();
    const attempt = () => {
      if (!views.result.classList.contains("is-active") || performance.now() - since > waitMs) return;
      if (isVoiceBusy()) {
        setTimeout(attempt, 250);
        return;
      }
      speakQueued(text);
    };
    setTimeout(attempt, 250);
  }

  // 家族の声が終わるのを待つのは長くて1分（250ms ごとに見る）。それでも鳴っていれば（こわれた再生など）、新しい声は言わずにやめる
  const FAMILY_VOICE_WAIT_TICKS = 240;
  // options.queue：ほかの声を止めない（読んでいる案内があれば、読み終わってから）。
  // 鳴っている家族の声（録音）は、どの声のためにも途中で止めない（終わるまで待つ。その間に運動・画面が変わったら言わない）
  function playEncouragement(kind, fallbackText, options = {}) {
    lastVoiceAt = performance.now();
    const voice = voiceUrl();
    if (voice) {
      const familyPlaying = Boolean(encouragementAudio && !encouragementAudio.paused && !encouragementAudio.ended);
      if (familyPlaying || (options.queue && isVoiceBusy())) {
        const waited = options.waited || 0;
        if (waited >= FAMILY_VOICE_WAIT_TICKS) return;
        const session = activeSession;
        const view = Object.values(views).find((element) => element.classList.contains("is-active"));
        setTimeout(() => {
          // 待ったあとは、ほかの声（そのあいだに始まった読み上げなど）も止めずに続ける
          if (activeSession === session && view?.classList.contains("is-active")) playEncouragement(kind, fallbackText, { ...options, queue: true, waited: waited + 1 });
        }, 250);
        return;
      }
      const audio = new Audio(voice);
      audio.volume = kind === "finish" ? .85 : .7;
      encouragementAudio = audio;
      // 位置案内の読み上げと家族の声を重ねない（止めた案内はあとで読み直す）
      if (guideUtterance && "speechSynthesis" in window) speechSynthesis.cancel();
      audio.play().catch(() => (options.queue ? speakQueued : speakText)(fallbackText));
    } else if (options.queue) {
      speakQueued(fallbackText);
    } else {
      speakText(fallbackText);
    }
  }

  function speakText(text) {
    if (!("speechSynthesis" in window)) return;
    lastVoiceAt = performance.now();
    speechSynthesis.cancel();
    speechSynthesis.speak(makeUtterance(text));
  }

  function drawImageCover(context, image, width, height) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  async function startDailyQuest() {
    questReplay = state.dailyQuest.completed && adminOptions.photoReplay;
    if (questDone()) {
      navigate("dashboard");
      requestAnimationFrame(() => $("#family-album").scrollIntoView({ behavior: "smooth", block: "start" }));
      return;
    }
    navigate("quest");
    questCompleting = false;
    questPointerActive = false;
    questDemoStep = 0;
    questUsedDemo = false;
    questClearedShare = 0;
    questStallShare = 0;
    // 見出しの上の1行とごほうび（家族の写真は送る人の名前。木が育たないときはごほうびを出さない）
    const quest = state.dailyQuest;
    $("#view-quest .quest-heading .eyebrow").textContent = quest.source === "family" ? `${quest.sender}から届いた写真` : "孫から届いた写真";
    const reward = questReplay ? "" : questRewardText();
    $(".quest-reward-pill strong").textContent = reward;
    $(".quest-reward-pill").hidden = !reward;
    $("#quest-complete-panel").hidden = true;
    $("#quest-photo-status").textContent = "まだぼやけています";
    $("#quest-progress").style.width = "0%";
    try {
      await prepareQuestPhoto();
      await setupQuestCamera();
    } catch (error) {
      showToast("写真を読み込めませんでした。ページを開き直してください。");
    }
  }

  async function prepareQuestPhoto() {
    const source = await questPhotoSource(state.dailyQuest.photo);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        questPhotoImage = image;
        const base = $("#quest-photo-base");
        const overlay = $("#quest-photo-overlay");
        overlay.classList.remove("is-cleared");
        const baseContext = base.getContext("2d");
        const overlayContext = overlay.getContext("2d");
        baseContext.clearRect(0, 0, base.width, base.height);
        drawImageCover(baseContext, image, base.width, base.height);

        const pixelCanvas = document.createElement("canvas");
        pixelCanvas.width = 36;
        pixelCanvas.height = 24;
        const pixelContext = pixelCanvas.getContext("2d");
        drawImageCover(pixelContext, image, pixelCanvas.width, pixelCanvas.height);
        overlayContext.clearRect(0, 0, overlay.width, overlay.height);
        overlayContext.imageSmoothingEnabled = false;
        overlayContext.drawImage(pixelCanvas, 0, 0, overlay.width, overlay.height);
        overlayContext.fillStyle = "rgba(225, 235, 231, .34)";
        overlayContext.fillRect(0, 0, overlay.width, overlay.height);
        questMask = document.createElement("canvas");
        questMask.width = QUEST_MASK_WIDTH;
        questMask.height = QUEST_MASK_HEIGHT;
        const maskContext = questMask.getContext("2d", { willReadFrequently: true });
        maskContext.fillStyle = "#000";
        maskContext.fillRect(0, 0, questMask.width, questMask.height);
        questClearedShare = 0;
        questStallShare = 0;
        resolve();
      };
      image.onerror = reject;
      image.src = source;
    });
  }
  // 写真あそびの写真の場所。家族の写真（idb:<photoId>）は、IndexedDB の写真（なければ家族のしくみから取る）の object URL（前の URL は捨てる）
  let questPhotoUrl = null;
  async function questPhotoSource(photo) {
    if (questPhotoUrl) URL.revokeObjectURL(questPhotoUrl);
    questPhotoUrl = null;
    if (!String(photo).startsWith("idb:")) return photo;
    questPhotoUrl = URL.createObjectURL(await familyPhotoBlob(photo.slice(4)));
    return questPhotoUrl;
  }

  function wipeQuestAt(normalizedX, normalizedY) {
    if (questCompleting || questDone() || !questPhotoImage) return;
    const x = Math.max(0, Math.min(1, normalizedX));
    const y = Math.max(0, Math.min(1, normalizedY));
    const overlay = $("#quest-photo-overlay");
    // 写真と、くもりの残りを数える小さな面を、同じ丸でふく（小さな面は写真の大きさに合わせて縮める）
    [[overlay, 1], [questMask, questMask.width / overlay.width]].forEach(([canvas, scale]) => {
      const context = canvas.getContext("2d");
      const cx = x * canvas.width;
      const cy = y * canvas.height;
      context.save();
      context.globalCompositeOperation = "destination-out";
      const gradient = context.createRadialGradient(cx, cy, 22 * scale, cx, cy, 92 * scale);
      gradient.addColorStop(0, "rgba(0,0,0,1)");
      gradient.addColorStop(.72, "rgba(0,0,0,.92)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(cx, cy, 94 * scale, 0, Math.PI * 2);
      context.fill();
      context.restore();
    });
    const share = questMaskShare();
    // 「進まない」の時間は、ため始めてから QUEST_STALL_GAIN より多くふけたときだけ 0 に戻す（ふいた所の縁を何度もなぞるだけの、わずかな増えでは戻さない）
    if (share - questStallShare > QUEST_STALL_GAIN) {
      questCloudyMovingMs = 0;
      questStallShare = share;
    }
    questClearedShare = share;
    // 進み具合は帯だけで見せる（% の数字は出さない）。できあがりの手前で帯がいっぱいにならないよう、できあがりまでの割合で
    $("#quest-progress").style.width = `${Math.min(100, Math.floor(share / QUEST_CLEAR_THRESHOLD * 100))}%`;
    if (share >= QUEST_CLEAR_THRESHOLD) completeQuest();
  }

  // くもりの残りの面の、ふき取った（半分より薄くなった）所の割合。region を渡すと、その範囲（0〜1 の x0, x1, y0, y1）だけ
  function questMaskShare(region = { x0: 0, x1: 1, y0: 0, y1: 1 }) {
    if (!questMask) return 0;
    const { data } = questMask.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, questMask.width, questMask.height);
    let cleared = 0;
    let total = 0;
    for (let row = Math.floor(region.y0 * questMask.height); row < Math.ceil(region.y1 * questMask.height); row += 1) {
      for (let column = Math.floor(region.x0 * questMask.width); column < Math.ceil(region.x1 * questMask.width); column += 1) {
        total += 1;
        if (data[(row * questMask.width + column) * 4 + 3] < 128) cleared += 1;
      }
    }
    return total ? cleared / total : 0;
  }

  // 手を動かしているのに進まないときの1行。くもりが残っている所（写真を3つに分けた上・まんなか・下、左・まんなか・右）を言う
  // （写真は画面のとおりの向き。まだ広く残っているときや、ばらばらに残っているときは場所を言わない）
  function questStalledText() {
    const thirds = [[0, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1]];
    const cloudy = (region) => 1 - questMaskShare(region) > .1;
    const rows = thirds.map(([y0, y1], index) => cloudy({ x0: 0, x1: 1, y0, y1 }) && ["上", "まんなか", "下"][index]).filter(Boolean);
    const columns = thirds.map(([x0, x1], index) => cloudy({ x0, x1, y0: 0, y1: 1 }) && ["左", "まんなか", "右"][index]).filter(Boolean);
    let where = "";
    if (rows.length === 1 && columns.length === 1) where = rows[0] === "まんなか" && columns[0] === "まんなか" ? "まんなか" : `${columns[0] === "まんなか" ? "" : columns[0]}${rows[0] === "まんなか" ? "" : rows[0]}`;
    else if (rows.length && rows.length < 3 && columns.length === 3) where = rows.join("や");
    else if (columns.length && columns.length < 3 && rows.length === 3) where = columns.join("や");
    return `${where ? `${where}の` : ""}${QUEST_CAMERA_TEXT.stalled}`;
  }

  function wipeQuestFromPointer(event) {
    const canvas = $("#quest-photo-overlay");
    const rect = canvas.getBoundingClientRect();
    wipeQuestAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  }

  function demoQuestSwipe() {
    if (!debugMode || questCompleting || questDone()) return;
    questUsedDemo = true;
    // 3回押すと、写真のすみまで全部ふける（上から2段ずつ）
    const rows = [[0, .1, .2, .3], [.4, .5, .6], [.7, .8, .9, 1]];
    const columns = Array.from({ length: 11 }, (_, index) => index / 10);
    rows[Math.min(questDemoStep, rows.length - 1)].forEach((y) => columns.forEach((x) => wipeQuestAt(x, y)));
    questDemoStep += 1;
  }

  async function setupQuestCamera() {
    cleanupQuestCamera();
    // 写真を読み込んでいる間に画面を離れた・もうできあがった：カメラを始めない（家の画面などで動き続けない）
    if (!views.quest.classList.contains("is-active") || questDone()) return;
    const generation = questCameraGeneration;
    const guide = $("#quest-camera-guide");
    if (cameraPaused()) {
      setQuestCameraStatus(QUEST_CAMERA_TEXT.paused, false);
      guide.classList.remove("is-hidden");
      return;
    }
    if (localSensorConfig) {
      await setupQuestLocalSensor(generation);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setQuestCameraStatus(QUEST_CAMERA_TEXT.finger, false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
      if (generation !== questCameraGeneration || !views.quest.classList.contains("is-active") || questDone() || cameraPaused()) {
        stopStream(stream);
        return;
      }
      questCameraStream = stream;
      const video = $("#quest-camera-video");
      video.srcObject = stream;
      await video.play();
      if (generation !== questCameraGeneration || questCameraStream !== stream) {
        stopStream(stream);
        return;
      }
      // 体の動きを読む仕組みが使えれば、手のひらだけでふく（端末サービスと同じ。映像の動きでふくと、ひざや体の動きでもふけてしまう）。
      // 使えないときだけ、映像の動いた所でふく
      setQuestCameraStatus(QUEST_CAMERA_TEXT.preparing, false);
      const engine = await ensurePoseEngine();
      if (generation !== questCameraGeneration || questCameraStream !== stream) return;
      if (engine) {
        questAnimationFrame = requestAnimationFrame(processQuestPoseFrame);
        return;
      }
      guide.classList.add("is-hidden");
      setQuestCameraStatus(QUEST_CAMERA_TEXT.live, true);
      questAnimationFrame = requestAnimationFrame(processQuestCameraFrame);
    } catch (error) {
      setQuestCameraStatus(QUEST_CAMERA_TEXT.finger, false);
    }
  }

  // ブラウザのカメラを体の動きを読む仕組みで見る（端末サービスの関節と同じに扱う）。推定は 66ms ごとまで
  function processQuestPoseFrame() {
    if (!questCameraStream || questCompleting || !poseEngine) return;
    const video = $("#quest-camera-video");
    const now = performance.now();
    if (video.readyState >= 2 && video.videoWidth && now - lastPoseInference >= 66) {
      const timestamp = Math.max(now, lastPoseInference + 1);
      lastPoseInference = timestamp;
      let landmarks = null;
      try {
        landmarks = poseEngine.detect(video, timestamp).landmarks;
      } catch (error) {
        landmarks = null;
      }
      handleQuestPose(landmarks, video.videoWidth / video.videoHeight, timestamp, false);
      if (questCompleting) return;
    }
    questAnimationFrame = requestAnimationFrame(processQuestPoseFrame);
  }

  function processQuestCameraFrame() {
    if (!questCameraStream || questCompleting) return;
    const video = $("#quest-camera-video");
    const sampler = $("#quest-motion-sampler");
    const context = sampler.getContext("2d", { willReadFrequently: true });
    if (video.readyState >= 2) {
      context.drawImage(video, 0, 0, sampler.width, sampler.height);
      const imageData = context.getImageData(0, 0, sampler.width, sampler.height);
      const pixels = imageData.data;
      let changed = 0;
      let weightedX = 0;
      let weightedY = 0;
      if (questPreviousFrame) {
        for (let index = 0; index < pixels.length; index += 4) {
          const difference = (Math.abs(pixels[index] - questPreviousFrame[index]) + Math.abs(pixels[index + 1] - questPreviousFrame[index + 1]) + Math.abs(pixels[index + 2] - questPreviousFrame[index + 2])) / 3;
          if (difference > 24) {
            const pixelIndex = index / 4;
            changed += 1;
            weightedX += pixelIndex % sampler.width;
            weightedY += Math.floor(pixelIndex / sampler.width);
          }
        }
      }
      questPreviousFrame = new Uint8ClampedArray(pixels);
      const energy = changed / (sampler.width * sampler.height) * 100;
      if (changed && energy > 1.8 && energy < 55) {
        const x = 1 - weightedX / changed / sampler.width;
        const y = weightedY / changed / sampler.height;
        const cursor = $("#quest-motion-cursor");
        placeQuestCursor(cursor, x, y);
        cursor.classList.add("is-visible");
        wipeQuestAt(x, y);
      }
    }
    questAnimationFrame = requestAnimationFrame(processQuestCameraFrame);
  }

  // 写真の画面のカメラの1行
  function setQuestCameraStatus(text, live) {
    const status = $("#quest-camera-status");
    status.classList.toggle("is-live", live);
    if (status.textContent !== ` ${text}`) status.innerHTML = `<span></span> ${escapeHtml(text)}`;
  }

  // 端末サービス（?sensor=local）のとき：カメラは端末サービスが持つ。写真の画面も自分の接続で関節を受け取り、手首の動きで写真をふく。
  // 腕を上げても体を見る範囲（--pose-roi）から手が外れないよう、腕上げとして始めてもらう（回数は数えない）
  async function setupQuestLocalSensor(generation) {
    const current = () => generation === questCameraGeneration && questSensorClient === client;
    const client = new LocalSensor.LocalSensorClient(localSensorConfig, {
      onFrame: (frame) => { if (current()) handleQuestLocalFrame(frame); },
      onStatus: (status) => { if (current()) handleQuestLocalStatus(status); },
      // つなぎ直している間はふかない。つながれば camera.start を送り直してくれるので、関節が届くのを待つ
      onReconnecting: () => {
        if (!current()) return;
        clearQuestHands();
        setQuestCameraStatus(QUEST_CAMERA_TEXT.reconnecting, false);
      },
      onReconnected: () => { if (current()) setQuestCameraStatus(QUEST_CAMERA_TEXT.preparing, false); },
      onDisconnect: () => {
        if (!current()) return;
        questSensorClient = null;
        client.close();
        clearQuestHands();
        setQuestCameraStatus(`${CAMERA_PROBLEM_TEXT.camera_disconnected}・写真を直接なぞれます`, false);
      }
    });
    questSensorClient = client;
    setQuestCameraStatus(QUEST_CAMERA_TEXT.preparing, false);
    $("#quest-camera-guide").classList.remove("is-hidden");
    try {
      await client.connect();
    } catch (error) {
      if (current()) {
        questSensorClient = null;
        setQuestCameraStatus(QUEST_CAMERA_TEXT.finger, false);
      }
      client.close();
      return;
    }
    if (!current()) {
      client.close();
      return;
    }
    client.start("arm-raise");
  }

  function handleQuestLocalStatus(status) {
    if (status.state === "streaming") {
      questSensorHalt = null;
    } else if (status.state === "enabled_idle" && questSensorHalt === "disabled_by_admin") {
      // 端末側の一時停止が解けた。写真の画面を開いたときにもう止まっていたなら、端末サービスはこの接続のカメラを始めていないので、始め直す
      questSensorHalt = null;
      setQuestCameraStatus(QUEST_CAMERA_TEXT.preparing, false);
      questSensorClient.start("arm-raise");
    } else if (status.state === "starting") {
      setQuestCameraStatus(QUEST_CAMERA_TEXT.preparing, false);
    } else if (status.state === "reconnecting") {
      clearQuestHands();
      setQuestCameraStatus(QUEST_CAMERA_TEXT.reconnecting, false);
    } else if (status.state === "disabled_by_admin" || status.state === "error") {
      // 端末側でカメラが止まっている・使えない：ふかない（写真は指でなぞれる）
      questSensorHalt = status.state;
      clearQuestHands();
      setQuestCameraStatus(status.state === "error" ? `${CAMERA_PROBLEM_TEXT[cameraProblemCode(status)]}・写真を直接なぞれます` : QUEST_CAMERA_TEXT.paused, false);
    }
  }

  function handleQuestLocalFrame(frame) {
    // 写真の画面を離れた後に届いたコマ・カメラが止まっている間・できあがった後は使わない
    if (!views.quest.classList.contains("is-active") || questSensorHalt || questCompleting || questDone()) return;
    const aspect = frame.image?.width && frame.image?.height ? frame.image.width / frame.image.height : 4 / 3;
    const { landmarks } = LocalSensor.toLandmarks(frame);
    // 手首の動きの間は、撮った時刻（monotonic_ms）で見る（届いた時刻はまとめて届くとつまる）
    handleQuestPose(landmarks, aspect, Number.isFinite(frame.monotonic_ms) ? frame.monotonic_ms : performance.now(), frame.is_demo);
  }

  // 関節（端末サービス・ブラウザの体の動きを読む仕組み）で写真をふく。t：撮った時刻（ms）。isDemo：模擬カメラ
  function handleQuestPose(landmarks, aspect, t, isDemo) {
    const now = performance.now();
    const elapsed = questFrameAt === null ? 0 : Math.min(now - questFrameAt, 250);
    questFrameAt = now;
    const result = Logic.questWipeFromPose(landmarks, aspect, questHandState, t);
    questHandState = result.state;
    // 両肩が見えていれば、人が映っている
    if (questLiveAt === null) questLiveAt = now;
    if (result.body) questPersonSeenAt = now;
    const away = now - (questPersonSeenAt ?? questLiveAt) > QUEST_AWAY_MS;
    $("#quest-camera-guide").classList.toggle("is-hidden", questPersonSeenAt !== null && !away);
    drawQuestPose(landmarks, aspect, result.body);
    showQuestHands(result.hands);
    // 手が動いている間の時間をためる（くもった所が減れば wipeQuestAt が 0 に戻す）
    if (result.hands.left?.moving || result.hands.right?.moving) questCloudyMovingMs += elapsed;
    if (result.points.length) {
      // 模擬カメラ（端末サービスの --camera mock）でふいた写真は、ためしのふき取り（アルバムには入るが、元気の木はそだてない）
      if (isDemo) questUsedDemo = true;
      result.points.forEach((point) => wipeQuestAt(point.x, point.y));
      // できあがった（カメラを止めて「カメラを止めました」と出した）
      if (questCompleting) return;
    }
    // 同じ高さだけをふいていると、くもりが残ったまま進まない：くもりの残る所へ手を向けるよう、やさしく言う
    const text = away ? QUEST_CAMERA_TEXT.away
      : questCloudyMovingMs >= QUEST_STALL_MS ? questStalledText()
        : `${QUEST_CAMERA_TEXT.live}${isDemo ? "（模擬）" : ""}`;
    setQuestCameraStatus(text, !away);
  }

  // 写真の上の手の印を置く。写真の端でも印の丸が切れないよう、中心を端から印の半径（--quest-cursor-reach）より内側に
  function placeQuestCursor(cursor, x, y) {
    cursor.style.left = `clamp(var(--quest-cursor-reach), ${x * 100}%, calc(100% - var(--quest-cursor-reach)))`;
    cursor.style.top = `clamp(var(--quest-cursor-reach), ${y * 100}%, calc(100% - var(--quest-cursor-reach)))`;
  }

  // 写真の上に、動いている手の印（止まっている手・見えない手は出さない）
  function showQuestHands(hands) {
    [["#quest-motion-cursor", hands.right], ["#quest-motion-cursor-other", hands.left]].forEach(([selector, hand]) => {
      const cursor = $(selector);
      cursor.classList.toggle("is-visible", Boolean(hand?.moving));
      if (hand?.moving) placeQuestCursor(cursor, hand.x, hand.y);
    });
  }

  // カメラの枠に、映っている人の上半身の線・手首の丸と、手を動かすと写真に届く範囲のうすい枠。端末サービスは映像を送らないので、
  // 人を枠の真ん中に大きく描く（肩幅を枠の幅の .28 に。肩より上は届かないので、頭は肩の上の丸）。CSS で鏡のように左右を返す
  function drawQuestPose(landmarks, aspect, body) {
    const fitted = fitCanvasToBox($("#quest-pose-overlay"));
    if (!fitted) return;
    const { ctx, width, height } = fitted;
    if (!landmarks || !body) return;
    const unit = width * .28;
    const originX = width / 2;
    const originY = height * .42;
    const point = (landmark) => [originX + (landmark.x * aspect - body.x) / body.scale * unit, originY + (landmark.y - body.y) / body.scale * unit];
    const { side, up, down } = Logic.QUEST_WIPE_LIMITS;
    ctx.fillStyle = "rgba(255, 255, 255, .5)";
    ctx.strokeStyle = "rgba(23, 85, 62, .45)";
    ctx.lineWidth = Math.max(2, unit * .02);
    ctx.setLineDash([unit * .08, unit * .06]);
    ctx.beginPath(); ctx.roundRect(originX - side * unit, originY - up * unit, 2 * side * unit, (up + down) * unit, unit * .08); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#17553e";
    ctx.lineWidth = Math.max(4, unit * .09);
    ctx.beginPath(); ctx.arc(originX, originY - unit * .8, unit * .27, 0, Math.PI * 2); ctx.stroke();
    LocalSensor.CONNECTIONS.filter(([from, to]) => from <= Logic.LANDMARK.rightHip && to <= Logic.LANDMARK.rightHip).forEach(([from, to]) => {
      if (!Logic.visible(landmarks[from]) || !Logic.visible(landmarks[to])) return;
      const a = point(landmarks[from]);
      const b = point(landmarks[to]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    });
    ctx.fillStyle = "rgba(204, 233, 123, .95)";
    ctx.strokeStyle = "white";
    ctx.lineWidth = Math.max(3, unit * .04);
    [Logic.LANDMARK.leftWrist, Logic.LANDMARK.rightWrist].forEach((index) => {
      if (!Logic.visible(landmarks[index])) return;
      const [x, y] = point(landmarks[index]);
      ctx.beginPath(); ctx.arc(x, y, unit * .14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }

  // 手の印・人の線・手首の動きの続きを消す（つなぎ直し・カメラが止まったとき・写真の画面を離れるとき）。
  // カメラの枠は空の灰色にせず、手の動かし方の案内に戻す
  function clearQuestHands() {
    questHandState = null;
    questLiveAt = null;
    questPersonSeenAt = null;
    questFrameAt = null;
    questCloudyMovingMs = 0;
    questStallShare = 0;
    $$(".quest-motion-cursor").forEach((cursor) => cursor.classList.remove("is-visible"));
    drawQuestPose(null, 4 / 3, null);
    $("#quest-camera-guide").classList.remove("is-hidden");
  }

  function cleanupQuestCamera() {
    questCameraGeneration += 1;
    if (questAnimationFrame) cancelAnimationFrame(questAnimationFrame);
    questAnimationFrame = null;
    questPreviousFrame = null;
    if (questCameraStream) questCameraStream.getTracks().forEach((track) => track.stop());
    questCameraStream = null;
    const video = $("#quest-camera-video");
    if (video) video.srcObject = null;
    // 端末サービスの接続を閉じる（camera.stop を送る。ほかの画面の接続はそのまま）
    if (questSensorClient) questSensorClient.close();
    questSensorClient = null;
    questSensorHalt = null;
    clearQuestHands();
  }

  function completeQuest() {
    if (questCompleting || questDone()) return;
    questCompleting = true;
    if (questReplay) {
      finishQuestScreen();
      $("#quest-complete-detail").textContent = "もう一度ふいた写真です。元気の木とアルバムはそのままです。";
      playEncouragement("finish", "写真がきれいになりました。");
      showToast("写真がきれいになりました。");
      return;
    }
    const practice = questUsedDemo;
    // ためしのふき取り（デモ）は練習：写真はアルバムに入れるが、木も家族の写真のごほうびの記録も変えない（logic.js が決める）
    const result = Logic.completeDailyQuest(state, Date.now(), { practice });
    state = result.state;
    saveState();
    if (result.albumItem?.photoId) markFamilyPhotoRevealed(result.albumItem.photoId);
    const growth = result.growth;
    finishQuestScreen();
    $("#quest-complete-detail").textContent = practice ? "ためしのふき取りなので、元気の木はそのままです。" : growth ? `元気の木が${growth}回分そだちました。` : "写真をアルバムに入れました。";
    renderDailyQuestTeaser();
    playEncouragement("finish", growth ? "写真がきれいになりました。アルバムに入れました。元気の木もそだちました。" : "写真がきれいになりました。アルバムに入れました。");
    showToast(growth ? `写真をアルバムに入れました。元気の木が${growth}回分そだちました！` : "写真をアルバムに入れました。");
    // まだふいていない家族の写真があれば、次の写真あそびにする（D-23）
    refreshQuestQueue({ afterWipe: true });
  }

  // できあがった写真の画面：カメラを止め、くもりを消して、できあがりの欄を出す（文はよびだし側）
  function finishQuestScreen() {
    // カメラで見ていたなら、止めたことを出す（「見ています」のまま残さない）。端末側で止まっていた・使えなかったなら、その表示のまま
    const cameraWasOn = Boolean(questCameraStream || (questSensorClient && !questSensorHalt));
    cleanupQuestCamera();
    if (cameraWasOn) {
      setQuestCameraStatus(QUEST_CAMERA_TEXT.stopped, false);
      // できあがった後は、手の動かし方の案内を出さない
      $("#quest-camera-guide").classList.add("is-hidden");
    }
    const overlay = $("#quest-photo-overlay");
    overlay.classList.add("is-cleared");
    setTimeout(() => overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height), 280);
    $("#quest-progress").style.width = "100%";
    $("#quest-photo-status").textContent = "きれいになりました";
    $("#quest-complete-panel").hidden = false;
    // 手だけでできあがると画面にさわらないので、きれいになった写真を少し見せてから、次の「アルバムと植物を見る」が画面の下に隠れないよう
    // 見える所まで送る（フォーカスは動かさない）
    setTimeout(() => {
      const panel = $("#quest-complete-panel");
      if (views.quest.classList.contains("is-active") && !panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, QUEST_DONE_SCROLL_MS);
  }

  function showQuestAlbum() {
    navigate("dashboard");
    requestAnimationFrame(() => $("#family-album").scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // 4枚のカードの数（今日・継続・今月・平均。実績に数える記録だけ）は logic.js getDashboardSummary（家族の端末へ送る写しと同じ数）。
  // 「回」はどのカードでも数えた回数の意味にそろえる
  function renderDashboard() {
    const now = new Date();
    const summary = Logic.getDashboardSummary(state, now);
    // 練習の記録はカードの数に入らない。練習だけがあるときは「記録はまだありません」と言わず、練習だけと書く（下の最近の記録と食い違わない）
    const noRecordText = (practiceOnly) => practiceOnly ? "練習だけです" : "記録はまだありません";
    const cards = [
      ["今日の運動回数", `${summary.todayCount}回`, summary.todaySessions ? `きょう 運動を${summary.todaySessions}つしました` : noRecordText(summary.practiceOnlyToday), "#dbece3"],
      ["継続日数", `${summary.streakDays}日`, summary.streakDays ? "続いています" : "今日から始めましょう", "#f5deb3"],
      ["今月の運動", `${summary.monthCount}回`, summary.monthDays ? `${summary.monthDays}日 運動しました` : noRecordText(summary.practiceOnlyMonth), "#dce6f5"],
      ["平均スコア", summary.hasCounted ? `${summary.averageScore}点` : "—", summary.hasCounted ? "これまでの平均" : noRecordText(summary.practiceOnlyAny), "#eadcf3"],
      analysisCard()
    ];
    $("#summary-cards").innerHTML = cards.map(([label, value, note, color]) => `<article class="summary-card" style="--card-accent:${color}"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
    renderWeek(now);
    renderChart();
    renderPlant();
    renderHistory();
    renderNotifications();
    renderAlbum();
  }

  // 家族の画面の「体の分析（一緒に育つ）」カード（説明の文は logic.js analysisNote。家族の端末へ送る写しと同じ）
  function analysisCard() {
    const analysis = Logic.getAnalysisLevel(state.bodyProfile);
    const note = analysis.level ? `${analysis.name}・${Logic.analysisNote(analysis)}` : Logic.analysisNote(analysis);
    return ["体の分析（一緒に育つ）", analysis.level ? `レベル${analysis.level}` : "はじめまして", note, "#e3f0e8"];
  }

  // 元気の木の説明に添える体の分析。レベルと足踏みの回数だけ：体の数値や数え方の調整は本人の見る画面には出さず、家族だけに届くお知らせに回す（よしさん 2026-10-06）
  function analysisDetailText() {
    const analysis = Logic.getAnalysisLevel(state.bodyProfile);
    if (!analysis.level) return "";
    return `一緒に育った体の分析：レベル${analysis.level}・足踏み ${analysis.reps}回ぶん`;
  }

  // この1週間（きょうまでの7日）：選べる運動ごとの行、日ごとの列。実績の記録がある日は ✓、練習だけの日は点線の丸、ない日は空き。回数は書かない。
  // 印は logic.js getWeekMarks（家族の端末へ送る写しと同じ）
  const WEEKDAYS = "日月火水木金土";
  function renderWeek(now) {
    const days = Array.from({ length: 7 }, (_, offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + offset));
    const week = Logic.getWeekMarks(state, now);
    const todayClass = (index) => index === days.length - 1 ? ' class="is-today"' : "";
    const head = `<thead><tr><td></td>${days.map((day, index) => `<th scope="col"${todayClass(index)} aria-label="${day.getMonth() + 1}月${day.getDate()}日${index === days.length - 1 ? " きょう" : ""}">${WEEKDAYS[day.getDay()]}</th>`).join("")}</tr></thead>`;
    const rows = week.rows.map((row) => {
      const cells = days.map((day, index) => {
        const mark = row.marks[index];
        const label = `${day.getMonth() + 1}月${day.getDate()}日 ${row.name} ${mark === "done" ? "できました" : mark === "practice" ? "練習" : "お休み"}`;
        return `<td${todayClass(index)}><span class="week-mark${mark ? ` is-${mark}` : ""}" role="img" aria-label="${escapeHtml(label)}">${mark === "done" ? "✓" : ""}</span></td>`;
      }).join("");
      return `<tr><th scope="row"><div class="week-name"><canvas class="week-pose" data-exercise="${escapeHtml(row.exerciseId)}" aria-hidden="true"></canvas><span>${escapeHtml(row.name)}</span></div></th>${cells}</tr>`;
    }).join("");
    const grid = $("#week-grid");
    grid.innerHTML = `${head}<tbody>${rows}</tbody>`;
    grid.querySelectorAll(".week-pose").forEach((canvas) => drawPose(canvas, canvas.dataset.exercise, ICON_POSE, { icon: true }));
  }

  function renderChart() {
    const canvas = $("#history-chart");
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.round(rect.width * ratio));
    canvas.height = Math.round(230 * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    const data = Logic.getChartData(state, new Date(), 30);
    // 目盛りの文字はテレビから読める大きさ（18px）
    const margin = { left: 48, right: 8, top: 12, bottom: 40 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    // 目盛りは整数で、5本の線がそのままの数を指すようにする（0・1.25・2.5… を丸めた数を書かない）
    const step = Math.ceil(Math.max(4, ...data.map((item) => item.value)) / 4);
    const max = step * 4;

    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#efe4cf";
    ctx.fillStyle = "#4a5852";
    ctx.font = "18px 'BIZ UDPGothic', 'Meiryo', 'Yu Gothic UI', sans-serif";
    ctx.textAlign = "right";
    for (let line = 0; line <= 4; line += 1) {
      const y = margin.top + plotH - plotH * line / 4;
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(width - margin.right, y); ctx.stroke();
      ctx.fillText(String(step * line), margin.left - 8, y + 6);
    }
    const slot = plotW / data.length;
    data.forEach((item, index) => {
      const barH = item.value / max * plotH;
      const x = margin.left + index * slot + slot * .18;
      const y = margin.top + plotH - barH;
      const barW = Math.max(3, slot * .64);
      ctx.fillStyle = item.value ? "#1d6b4e" : "#efe4cf";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, Math.max(3, barH), 3);
      else ctx.rect(x, y, barW, Math.max(3, barH));
      ctx.fill();
      if (index % 5 === 0 || index === data.length - 1) {
        ctx.fillStyle = "#4a5852";
        ctx.textAlign = "center";
        ctx.fillText(item.label, x + barW / 2, height - 8);
      }
    });
  }

  function renderPlant() {
    const stage = Logic.getPlantStage(state);
    PlantView.renderPlantInto($("#plant-svg"), stage);
    // 段階の名前だけ（体の分析のレベルは下の説明とカードにある）
    $("#plant-level").textContent = stage.label;
    const lines = [stage.message];
    // 家族の写真で育ったことがあれば、写真の出どころを言わない文（plantBonus に家族の写真の分も入る。F2）
    if (state.plantBonus) lines.push(state.photoReward.total >= 1 ? `写真のごほうび${state.plantBonus}回分も加わっています。` : `孫の写真のごほうび${state.plantBonus}回分も加わっています。`);
    const detail = analysisDetailText();
    if (detail) lines.push(detail);
    // ひとつの文ずつ行を分ける（続けて書くと読みにくい）
    $("#plant-message").textContent = lines.join("\n");
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
  }

  // 記録の日：きょう／きのう／「10/4(土)」と時刻。読めない日時の行があっても一覧ごと消えないように "" を返す
  function historyDay(timestamp, now = new Date()) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "";
    const key = Logic.localDateKey(date);
    const time = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (key === Logic.localDateKey(now)) return `きょう ${time}`;
    if (key === Logic.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return `きのう ${time}`;
    return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(date);
  }

  // 最近の記録：日・運動・回数だけを大きく。練習の記録は「練習」の札だけ（方式の名前やスコアは出さない）
  function renderHistory() {
    const body = $("#history-body");
    if (!state.sessions.length) {
      body.innerHTML = `<p class="history-empty">運動を完了すると、ここに記録が表示されます。</p>`;
      return;
    }
    const now = new Date();
    body.innerHTML = state.sessions.slice(0, 6).map((session) => {
      const practice = session.counts_toward_progress === false;
      return `<div class="history-row${practice ? " is-practice" : ""}"><span class="history-day">${historyDay(session.timestamp, now)}</span><span class="history-name">${escapeHtml(session.exercise_name)}${practice ? '<i class="history-tag">練習</i>' : ""}</span><strong class="history-count">${Number(session.count) || 0}回</strong></div>`;
    }).join("");
  }

  // 家族ダッシュボードはテレビで本人も見るので、共有の知らせ（audience: shared）だけを出す。家族だけに届くお知らせは設定画面の管理者PINの先だけ。
  // この試作は家族へ何も送らない（画面の札「送っていません」）。届け方の言葉（即時通知・翌朝サマリー）は出さない
  function renderNotifications() {
    const list = $("#notification-list");
    const shared = state.notifications.filter((item) => item.audience === "shared");
    if (!shared.length) {
      list.innerHTML = `<div class="notification-item"><strong>お知らせはまだありません</strong><p>運動を終えると、家族へのお知らせがここに出ます。</p></div>`;
      return;
    }
    list.innerHTML = shared.slice(0, 6).map((item) => `<div class="notification-item"><p>${sharedNoticeHtml(item)}</p></div>`).join("");
  }

  // 共有のお知らせの1行：「10/7 座って足踏みを 8回 しました」。日付のあとの文は logic.js sharedNoticeLine（家族の端末へ送る写しと同じ文）
  function sharedNoticeHtml(item) {
    const date = new Date(item.timestamp);
    const day = Number.isFinite(date.getTime()) ? `<strong>${date.getMonth() + 1}/${date.getDate()}</strong> ` : "";
    return day + escapeHtml(Logic.sharedNoticeLine(item, state.sessions));
  }

  // 家族だけに届くお知らせ（設定画面「ご家族・運営の方へ」）。本人の画面には出さないので、その人のご家族用のPINか管理用のPINを入れたときだけ中身を出し、
  // 操作がないまま60秒たったとき（さわっていれば延びるが、開いてから最長5分）・画面を離れたとき・運動の開始で隠す。
  // 件数も出さない（テレビで本人が「増えた」と気づかないように）。PIN を3回間違えると30秒待つ（PIN を聞く確認画面とも同じ数え方）
  const FAMILY_NOTES_IDLE_MS = 60000;
  const FAMILY_NOTES_MAX_MS = 300000;
  let familyNotesUnlocked = false;
  let familyPoseStatusTimer = null;
  const FAMILY_POSE_STATUS_MS = 1000;
  let familyNotesTimer = null;
  let familyNotesOpenedAt = 0;
  // 前に開いた時刻（これより新しいお知らせに「新着」）。開いた時点で決めて、開いている間は変えない
  let familyNotesNewSince = null;
  function familyNotes() {
    return state.notifications.filter((item) => item.audience === "family");
  }
  // PIN の確かめ（F0）。personId の人のご家族用のPIN（allowAdmin なら管理用のPINでも通る。D-15・D-20）か、personId がなければ管理用のPINだけ。
  // 記録が null（はじめのまま）なら、はじめの PIN（ADMIN_DEMO_PIN）と比べる。これはテレビの中だけ（家族のしくみは null の PIN を使わない。D-16）。
  // ただし管理用のPINがはじめのまま（null）の間、自分のPINに変えた人の所（その人の欄・カメラの一時停止・その人の「いまのPIN」）では、管理用のPINとして
  // はじめの PIN を受けつけない（はじめの PIN は README とソースに見えている。D-16 と同じ考え）。はじめのままの人と「運動する人」のカードは今どおり開く。
  // まちがいは、入れる所（その人の欄・管理用の欄）ごとに数え、3回で30秒待つ（ページのメモリの中だけ）。"ok" / "wrong" / "locked"。
  // ハッシュを比べる間に次の PIN が来ても、1つずつ順に確かめる（数えまちがえない）
  const pinGates = new Map();
  let pinQueue = Promise.resolve();
  function checkPin(pin, { personId = null, allowAdmin = false } = {}) {
    const result = pinQueue.then(() => checkPinNow(pin, personId, allowAdmin));
    pinQueue = result.catch(() => {});
    return result;
  }
  async function checkPinNow(pin, personId, allowAdmin) {
    const gateKey = personId ? `person:${personId}` : "admin";
    if (!pinGates.has(gateKey)) pinGates.set(gateKey, { failures: 0, lockedUntil: 0 });
    const gate = pinGates.get(gateKey);
    if (Date.now() < gate.lockedUntil) return "locked";
    const person = personId ? people.people.find((item) => item.id === personId) : null;
    const adminUsable = !personId || (allowAdmin && (Boolean(people.adminPin) || !person?.pin));
    const records = [...(person ? [person.pin] : []), ...(adminUsable ? [people.adminPin] : [])];
    let matched = false;
    for (const record of records) {
      if (await pinMatches(pin, record)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      gate.failures += 1;
      if (gate.failures < 3) return "wrong";
      gate.failures = 0;
      gate.lockedUntil = Date.now() + 30000;
      return "locked";
    }
    gate.failures = 0;
    return "ok";
  }
  async function pinMatches(pin, record) {
    if (!record) return pin === ADMIN_DEMO_PIN;
    try {
      return await PinHash.verifyPin(pin, record);
    } catch (error) { return false; }
  }
  const PIN_PROBLEM_TEXT = { wrong: "PINが違います。", locked: "しばらくしてからお試しください。" };
  // いまの人の「ご家族・運営の方へ」と、カメラの一時停止で使う PIN（その人のPINか管理用のPIN）
  const personPinGate = () => ({ personId: activePerson().id, allowAdmin: true });
  function hideFamilyNotes() {
    familyNotesUnlocked = false;
    clearInterval(familyPoseStatusTimer);
    familyPoseStatusTimer = null;
    closeCameraCheck();
    familyNotesNewSince = null;
    clearTimeout(familyNotesTimer);
    familyNotesTimer = null;
    renderFamilyNotes();
  }
  // カメラの映り方を確かめている間と、家族の端末をつなぐ番号・QR を出している間（スマホを取りに行っている間も出しておく）は、
  // さわらなくても隠さない（確かめは自分の時間で閉じ、番号は出してから5分で消える。開いてから最長5分は同じ）
  function scheduleFamilyNotesHide() {
    clearTimeout(familyNotesTimer);
    const remaining = familyNotesOpenedAt + FAMILY_NOTES_MAX_MS - Date.now();
    if (remaining <= 0) {
      hideFamilyNotes();
      return;
    }
    const keepOpen = () => cameraCheck || !$("#family-pairing").hidden;
    familyNotesTimer = setTimeout(() => (keepOpen() ? scheduleFamilyNotesHide() : hideFamilyNotes()), Math.min(FAMILY_NOTES_IDLE_MS, remaining));
  }
  function renderFamilyNotes() {
    const list = $("#family-notes-list");
    const form = $("#family-notes-form");
    const close = $("#family-notes-close");
    const nameForm = $("#user-name-form");
    if (!list || !form || !close || !nameForm) return;
    const person = activePerson();
    $("#family-notes-pin-label").textContent = `ご家族用のPIN（${person.name}）`;
    form.hidden = familyNotesUnlocked;
    close.hidden = !familyNotesUnlocked;
    list.hidden = !familyNotesUnlocked;
    nameForm.hidden = !familyNotesUnlocked;
    $("#camera-check-open").hidden = !familyNotesUnlocked;
    // PIN がはじめのままの人には、家族の端末をつなぐ前に変えるよう出す（D-16）。変えると消える
    $("#pin-initial-note").hidden = !familyNotesUnlocked || Boolean(person.pin);
    $("#pin-change").hidden = !familyNotesUnlocked;
    renderFamilyPractice();
    renderFamilyAccuracy();
    renderFamilyDevices();
    if (!familyNotesUnlocked) {
      list.innerHTML = "";
      $("#user-name").value = "";
      clearPinForm("#pin-change");
      return;
    }
    syncPinFormAvailability("#pin-change");
    if (document.activeElement !== $("#user-name")) $("#user-name").value = state.userName || "";
    const notes = familyNotes();
    list.innerHTML = notes.length
      ? notes.slice(0, 20).map((item) => {
        const isNew = familyNotesNewSince !== null && Date.parse(item.timestamp) > familyNotesNewSince;
        return `<div class="notification-item${item.important ? " is-important" : ""}${isNew ? " is-new" : ""}"><strong>${formatDate(item.timestamp)}・${Logic.familyNoteLabel(item)}${isNew ? '<span class="note-tag">新着</span>' : ""}</strong><p>${escapeHtml(item.message)}</p></div>`;
      }).join("")
      : `<div class="notification-item"><strong>まだありません</strong><p>体の分析のレベルが上がったとき、数え方を本人に合わせたとき、足踏みの様子がいつもと大きく違ったときに、ここに届きます。</p></div>`;
  }
  // ご家族の欄：体の動きを読む仕組みの今の様子（1行）と、最近の練習の記録のわけ。本人の画面には出さない（本人には「練習」とだけ言う）。
  // ご家族にもわかる言葉で（「AI」とは言わない）。ファイルの名前だけはここに出す
  const POSE_STATUS_TEXT = {
    idle: "まだ準備していません（運動を選ぶ画面を開くと準備します）。",
    loading: "準備しています。",
    ready: "使えます。",
    // ファイルはあるのにこわれている（コピーが途中で止まったなど）ときもここになる。開き直しても直らないので、確かめ方を言う
    failed: "うまく動きませんでした。このままブラウザのカメラで運動すると、練習の記録になります。ページを開き直してください。開き直しても同じときは、ファイルがこわれていることがあります。README.md の「確かめ方」で、4つのファイルが DEPENDENCIES.txt と同じかを確かめてください。"
  };
  function poseStatusText() {
    if (localSensorConfig) return "体の動きを読む仕組み：端末サービス（奥行きカメラ）の方で動かします。";
    // カメラを止めている間は、運動を選ぶ画面を開いても準備しない（preloadPoseEngine）
    if (poseEngineStatus.state === "idle" && cameraPaused()) return "体の動きを読む仕組み：カメラを止めている間は準備しません（カメラを再開すると、運動を選ぶ画面で準備します）。";
    if (poseEngineStatus.state === "missing") {
      const names = poseEngineStatus.missingFiles.map((file) => file.split("/").pop()).join("、");
      return `体の動きを読む仕組み：ファイルが足りないため使えません（${names}）。置くまでは、ブラウザのカメラで運動すると練習の記録になります。README.md と DEPENDENCIES.txt を見て置いてください。`;
    }
    return `体の動きを読む仕組み：${POSE_STATUS_TEXT[poseEngineStatus.state]}`;
  }
  const FAMILY_PRACTICE_ROWS = 5;
  function renderFamilyPractice() {
    const box = $("#family-practice");
    box.hidden = !familyNotesUnlocked;
    if (!familyNotesUnlocked) {
      $("#family-practice-list").innerHTML = "";
      return;
    }
    setTextIfChanged($("#family-pose-status"), poseStatusText());
    const now = new Date();
    const practice = state.sessions.filter((session) => !Logic.countsTowardProgress(session)).slice(0, FAMILY_PRACTICE_ROWS);
    $("#family-practice-list").innerHTML = practice.length
      ? practice.map((session) => `<div class="notification-item"><strong>${historyDay(session.timestamp, now)}・${escapeHtml(session.exercise_name)} ${Number(session.count) || 0}回</strong><p>${escapeHtml(Logic.practiceReasonText(session))}</p></div>`).join("")
      : `<div class="notification-item"><p>練習の記録はありません。</p></div>`;
  }
  // まだ準備していないとき（運動を選ぶ画面を開く前）は、ファイルがあるかを確かめる（中身は読まない）。
  // 足りないファイルがあれば、その場で準備してみて、今の様子は本当に読み込めたかで決める
  // （予備のファイル（heavy の .task・SIMD のないブラウザ用の .wasm）だけが無いときは、ほかのファイルで使えることがある）
  function checkPoseFilesForFamily() {
    if (localSensorConfig || cameraPaused() || poseEngineStatus.state !== "idle") return;
    findMissingPoseFiles().then((missingFiles) => {
      if (missingFiles.length && poseEngineStatus.state === "idle") preloadPoseEngine();
    });
  }

  async function openFamilyNotes(event) {
    event.preventDefault();
    const input = $("#family-notes-pin");
    const pin = input.value;
    input.value = "";
    const personId = activePerson().id;
    const check = await checkPin(pin, personPinGate());
    if (familyNotesUnlocked) return;
    // 確かめている間（重い PC では数秒）に人を変えた・設定の画面を離れたなら開かない（前の人の PIN で次の人の欄を開かない）
    if (activePerson().id !== personId || !views.settings.classList.contains("is-active")) return;
    if (check !== "ok") {
      showToast(PIN_PROBLEM_TEXT[check]);
      return;
    }
    // 直前の「PINが違います」を残さない
    hideToast();
    // 前に開いた時刻より新しいお知らせに「新着」。はじめて開いたときは付けない
    const seenAt = Date.parse(state.familySeenAt);
    familyNotesNewSince = Number.isFinite(seenAt) ? seenAt : null;
    state.familySeenAt = new Date().toISOString();
    saveState();
    familyNotesOpenedAt = Date.now();
    familyNotesUnlocked = true;
    renderFamilyNotes();
    // 開いている間も、体の動きを読む仕組みの1行を今の様子にする（準備ができた・カメラを止めた／再開した。前は PIN を入れ直すまで変わらなかった）
    clearInterval(familyPoseStatusTimer);
    familyPoseStatusTimer = setInterval(() => { if (familyNotesUnlocked) setTextIfChanged($("#family-pose-status"), poseStatusText()); }, FAMILY_POSE_STATUS_MS);
    loadFamilyDevices();
    checkPoseFilesForFamily();
    scheduleFamilyNotesHide();
  }
  // 本人の呼び名（家族へのお知らせの文に使う）。空なら変えない。最長12文字。名簿の名前も同じにする（名簿のほかの人と同じ名前は断る）
  function saveUserName(event) {
    event.preventDefault();
    if (!familyNotesUnlocked) return;
    const name = $("#user-name").value.trim().slice(0, 12);
    // ほかの画面でこの人が消されていた（欄も閉じた）なら、次の人の名前を変えない
    if (syncPeople()) return;
    const result = name ? Logic.renamePerson(people, activePerson().id, name) : { ok: false, reason: "name" };
    if (!result.ok) {
      $("#user-name").value = state.userName || "";
      showToast(result.reason === "taken" ? "同じ名前の人がいます。ほかの名前にしてください。" : "呼び名を入れてください。");
      return;
    }
    people = result.people;
    savePeople();
    state.userName = result.person.name;
    saveState();
    $("#user-name").blur();
    renderFamilyNotes();
    renderPeople();
    showToast(`呼び名を「${result.person.name}」にしました。次のお知らせから使います。`);
  }

  // ---- PIN を変える（F0）。その人のご家族用のPIN（「ご家族・運営の方へ」を開いている間）と、管理用のPIN（設定の「運動する人」） ----
  // いまのPIN・新しいPIN・もう一度。新しい PIN は塩を足したハッシュ（PinRecord）だけを名簿に保存し、数字はどこにも出さない・残さない（入れた欄も空にする）。
  // ハッシュを作れない画面（WebCrypto がない。LAN の IP で開いたときなど）では変えられない
  const NEW_PIN_PROBLEM_TEXT = {
    length: "新しいPINは4〜8けたの数字にしてください。",
    simple: "同じ数字だけや、1234のような続き番号は使えません。",
    initial: "はじめのPINとは違う数字にしてください。",
    mismatch: "新しいPINが2つで違います。",
    wrong: "いまのPINが違います。",
    locked: "しばらくしてからお試しください。"
  };
  const PIN_CHANGE_UNAVAILABLE = "この画面では PIN を変えられません";
  const PIN_CHANGED_TEXT = "PINを変えました。家族の端末でも、新しいPINを使ってください。";
  // 人の PIN を変えたとき、管理用のPINがまだはじめのままなら続けて出す（はじめの PIN で「運動する人」を開けるため）
  const ADMIN_PIN_INITIAL_AFTER_CHANGE = "管理用のPINがはじめのままです。設定の「運動する人」で変えてください。";
  const pinFields = (form) => ["current", "next", "again"].map((name) => $(`${form} [data-pin="${name}"]`));
  function clearPinForm(form) {
    pinFields(form).forEach((input) => { input.value = ""; });
    $(`${form} .pin-change-status`).textContent = "";
  }
  function syncPinFormAvailability(form) {
    const usable = Boolean(PinHash?.available());
    $(`${form} button[type=submit]`).disabled = !usable;
    if (!usable) $(`${form} .pin-change-status`).textContent = PIN_CHANGE_UNAVAILABLE;
  }
  // gate：いまの PIN の確かめ方（checkPin と同じ）。apply：新しい PinRecord を名簿に入れる（入れる前に、ほかの画面の名簿に合わせる）
  let pinChanging = false;
  async function submitPinChange(form, gate, apply) {
    if (pinChanging) return;
    const status = $(`${form} .pin-change-status`);
    status.textContent = "";
    const [current, next, again] = pinFields(form).map((input) => input.value);
    pinFields(form).forEach((input) => { input.value = ""; });
    if (!PinHash?.available()) {
      status.textContent = PIN_CHANGE_UNAVAILABLE;
      return;
    }
    const problem = Logic.validateNewPin(next, { initialPin: ADMIN_DEMO_PIN }) || (next !== again ? "mismatch" : null);
    if (problem) {
      status.textContent = NEW_PIN_PROBLEM_TEXT[problem];
      return;
    }
    pinChanging = true;
    try {
      const check = await checkPin(current, gate);
      if (check !== "ok") {
        status.textContent = NEW_PIN_PROBLEM_TEXT[check];
        return;
      }
      const record = await PinHash.hashPin(next);
      syncPeople();
      if (!apply(record)) return;
      savePeople();
      status.textContent = form === "#pin-change" && !people.adminPin ? `${PIN_CHANGED_TEXT}${ADMIN_PIN_INITIAL_AFTER_CHANGE}` : PIN_CHANGED_TEXT;
    } catch (error) {
      status.textContent = PIN_CHANGE_UNAVAILABLE;
    } finally {
      pinChanging = false;
    }
  }
  function changePersonPin(event) {
    event.preventDefault();
    if (!familyNotesUnlocked) return;
    const personId = activePerson().id;
    submitPinChange("#pin-change", personPinGate(), (record) => {
      const person = people.people.find((item) => item.id === personId);
      if (!person || !familyNotesUnlocked) return false;
      person.pin = record;
      $("#pin-initial-note").hidden = true;
      // 「家族の端末をつなぐ」を押せるようにする（はじめのままの PIN では押せない）
      renderFamilyDevices();
      return true;
    });
  }
  function changeAdminPin(event) {
    event.preventDefault();
    if (!peopleAdminUnlocked) return;
    submitPinChange("#admin-pin-change", {}, (record) => {
      if (!peopleAdminUnlocked) return false;
      people.adminPin = record;
      $("#admin-pin-initial-note").hidden = true;
      return true;
    });
  }

  // アルバム。家族の写真（idb:<photoId>）は、IndexedDB の写真（なければ家族のしくみから取る）を object URL で出す（描き直すとき前の URL は捨てる）
  let albumUrls = [];
  let albumRender = 0;
  function renderAlbum() {
    const grid = $("#album-grid");
    const run = ++albumRender;
    albumUrls.forEach((url) => URL.revokeObjectURL(url));
    albumUrls = [];
    $("#album-count").textContent = `${state.album.length}枚`;
    if (!state.album.length) {
      grid.innerHTML = `<div class="album-empty"><span aria-hidden="true">□</span><div><strong>アルバムはまだ空です</strong><p>孫から届いた写真をきれいにすると、ここに入ります。</p></div></div>`;
      return;
    }
    grid.innerHTML = state.album.map((item) => {
      const photo = String(item.photo || "");
      const source = photo.startsWith("idb:") ? `data-photo-id="${escapeHtml(photo.slice(4))}"` : `src="${escapeHtml(item.photo)}"`;
      return `<figure class="album-item"><img ${source} alt="${escapeHtml(item.title)}"><figcaption><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.sender)}から・${formatDate(item.savedAt)}</span></figcaption></figure>`;
    }).join("");
    grid.querySelectorAll("img[data-photo-id]").forEach(async (image) => {
      try {
        const blob = await familyPhotoBlob(image.dataset.photoId);
        if (run !== albumRender) return;
        const url = URL.createObjectURL(blob);
        albumUrls.push(url);
        image.src = url;
      } catch (error) { /* 写真が見つからない：題と送る人だけ出す */ }
    });
  }

  // ---- 家族の端末（F1・F2）。家族のしくみとのやりとりは ?family=<ポート> のときだけ ----
  // 届いた写真は IndexedDB（media-store.js）に入れる。IndexedDB が使えないブラウザでは、このページを開いている間だけ写真の番号を覚え、
  // 写真そのものは家族のしくみから毎回取る
  const memoryPhotos = new Map();
  // その人のまだふいていない家族の写真 [{ photoId, sender, sentAt }]（古い順は logic.js が並べる）
  async function waitingPhotosOf(personId) {
    try {
      return (await MediaStore.listPhotos(personId, { status: "waiting" })).map(({ photoId, sender, sentAt }) => ({ photoId, sender, sentAt }));
    } catch (error) {
      return [...memoryPhotos.values()].filter((item) => item.personId === personId && item.status === "waiting")
        .map(({ photoId, sender, sentAt }) => ({ photoId, sender, sentAt }));
    }
  }
  async function familyPhotoBlob(photoId) {
    try {
      const record = await MediaStore.getPhoto(photoId);
      if (record?.blob) return record.blob;
    } catch (error) { /* IndexedDB が使えない：家族のしくみから取る */ }
    if (!familyClient) throw new Error("写真が見つかりません");
    return familyClient.photo(photoId);
  }
  // ふいた写真は "revealed"（アルバムの写真として残す）
  function markFamilyPhotoRevealed(photoId) {
    const memory = memoryPhotos.get(photoId);
    if (memory) memory.status = "revealed";
    Promise.resolve().then(() => MediaStore.markRevealed(photoId, new Date().toISOString())).catch(() => {});
  }

  // 写真あそびの次の1枚（logic.js nextFamilyQuest。D-23）：起動・人の切り替え・運動選択にもどったとき・写真が届いたとき・ふいたあと。
  // 写真の画面でふいている間は入れかえない。ふいたすぐあとに次の写真になったら、運動選択の札は「つぎの写真も届いています」
  let questQueueRun = 0;
  let questNextAfterWipe = null;
  async function refreshQuestQueue({ afterWipe = false } = {}) {
    const run = ++questQueueRun;
    const personId = activePerson().id;
    const waiting = await waitingPhotosOf(personId);
    if (run !== questQueueRun || personId !== activePerson().id) return;
    if (views.quest.classList.contains("is-active") && !questCompleting) return;
    const next = Logic.nextFamilyQuest(state, waiting);
    if (!next.changed) return;
    state = next.state;
    if (afterWipe && state.dailyQuest.source === "family" && !state.dailyQuest.completed) questNextAfterWipe = state.dailyQuest.id;
    saveState();
    if (views.home.classList.contains("is-active")) renderDailyQuestTeaser();
  }

  // 写し（人ごと。logic.js buildFamilySnapshot）：保存のあと1.5秒まとめて送る。届かなければ30秒ごとにやり直す（4.6.5）。本人には何も出さない
  const snapshotSenders = new Map();
  function scheduleSnapshot(personId, delay = familyConfig?.snapshotDelayMs) {
    if (!familyClient) return;
    let sender = snapshotSenders.get(personId);
    if (!sender) {
      sender = FamilySync.createSender(() => sendSnapshot(personId), { retryMs: familyConfig.retryMs });
      snapshotSenders.set(personId, sender);
    }
    sender.schedule(delay);
  }
  async function sendSnapshot(personId) {
    const person = people.people.find((item) => item.id === personId);
    if (!person) return;
    const waitingPhotos = await waitingPhotosOf(personId);
    const record = person.id === activePerson().id ? state : readPersonState(person);
    if (!record) return;
    await familyClient.putSnapshot(personId, Logic.buildFamilySnapshot(record, { now: new Date(), personId, waitingPhotos }));
  }
  // いま選んでいない人の記録（その人のキー。呼び名は名簿の名前）。読めなければ null（書きかえない）
  function readPersonState(person) {
    try {
      const record = Logic.hydrateState(JSON.parse(localStorage.getItem(person.storageKey) || "null"));
      record.userName = person.name;
      return record;
    } catch (error) {
      return null;
    }
  }

  // 名簿（PIN は塩を足したハッシュだけ）：起動のときと、PIN の変更・人の追加と削除・名前の変更のあと。届かなければ30秒ごとにやり直す。
  // 消した人は、家族のしくみからも消す（その人の端末・写し・写真）。消したことは、家族のしくみが DELETE に答える（204 か 404）まで
  // このテレビ（localStorage）に覚えておく。?family= なしで開いた画面で消した人も、家族のしくみが止まっている間に消した人も、
  // 画面を開き直したあとで ?family= で開いたときに消す。覚えておけないとき（容量不足など）は、このページの中だけで覚えておく
  const FAMILY_REMOVALS_KEY = "motion-link-family-removals-v1";
  const memoryRemovals = new Set();
  function familyRemovals() {
    let stored = [];
    try {
      const list = JSON.parse(localStorage.getItem(FAMILY_REMOVALS_KEY) || "[]");
      stored = Array.isArray(list) ? list.filter((id) => typeof id === "string" && /^p[1-9][0-9]{0,5}$/.test(id)) : [];
    } catch (error) { stored = []; }
    return [...new Set([...stored, ...memoryRemovals])];
  }
  function writeFamilyRemovals(ids) {
    try {
      if (ids.length) localStorage.setItem(FAMILY_REMOVALS_KEY, JSON.stringify(ids));
      else localStorage.removeItem(FAMILY_REMOVALS_KEY);
      return true;
    } catch (error) { return false; }
  }
  function rememberFamilyRemoval(id) {
    const ids = familyRemovals();
    if (!ids.includes(id)) ids.push(id);
    if (writeFamilyRemovals(ids)) memoryRemovals.delete(id);
    else memoryRemovals.add(id);
  }
  function forgetFamilyRemoval(id) {
    memoryRemovals.delete(id);
    writeFamilyRemovals(familyRemovals().filter((item) => item !== id));
  }
  const peopleSender = familyClient ? FamilySync.createSender(sendPeople, { retryMs: familyConfig.retryMs }) : null;
  function sendPeopleSoon() {
    if (peopleSender) peopleSender.schedule(0);
  }
  async function sendPeople() {
    for (const id of familyRemovals()) {
      try {
        await familyClient.deletePerson(id);
      } catch (error) {
        if (error?.code !== "not_found") throw error;
      }
      forgetFamilyRemoval(id);
    }
    await familyClient.putPeople({ people: people.people.map((person) => ({ id: person.id, name: person.name, pin: person.pin || null })), adminPin: people.adminPin || null });
  }
  // 家族のしくみに端末が残っている人のうち、このテレビの名簿にいない人（このテレビが出した番号だけ。テレビの記録を消したあとなど）を消す。
  // 名簿は保存されたものも見る（同じテレビのほかの画面で足した人を消さない）。ほかのブラウザで開いた画面の名簿の人（まだ出していない番号）は消さない
  function findFamilyLeftovers() {
    let stored = null;
    try { stored = Logic.hydratePeople(JSON.parse(localStorage.getItem(Logic.PEOPLE_KEY) || "null")); } catch (error) { stored = null; }
    const known = new Set([...people.people, ...(stored?.people || [])].map((person) => person.id));
    const issuedBelow = Math.max(people.nextNumber, stored?.nextNumber || 0);
    const pending = familyRemovals();
    const leftovers = Object.keys(familyDeviceCounts).filter((id) => /^p[1-9][0-9]{0,5}$/.test(id) && !known.has(id) && Number(id.slice(1)) < issuedBelow && !pending.includes(id));
    if (!leftovers.length) return;
    leftovers.forEach(rememberFamilyRemoval);
    sendPeopleSoon();
  }
  // 人を足すとき、その番号を使わない：記録のキーがある・家族のしくみからまだ消せていない・家族のしくみにその番号の端末が残っている
  // （前にいた人の端末に、新しく足した人の記録を見せない）
  function personNumberInUse(key) {
    if (storageKeyInUse(key)) return true;
    const used = [...familyRemovals(), ...Object.keys(familyDeviceCounts)];
    return used.some((id) => /^p[1-9][0-9]{0,5}$/.test(id) && Logic.personStorageKey(id) === key);
  }

  // 受け取り箱と、人ごとのつないだ端末の数を見る（15秒ごと）。日付が変わったら全員の写しを送り直す（「きょう」の数が変わるため。起動のときも送る）
  let familyDeviceCounts = {};
  let familyInboxAfter = 0;
  let familySnapshotDay = null;
  // 家族のしくみが止まっていた（前の回は届かなかった）か。動き出したら、名簿と全員の写しを送り直す
  let familyWasOffline = false;
  function startFamilySync() {
    if (!familyClient) return;
    sendPeopleSoon();
    const tick = async () => {
      await pollFamily();
      setTimeout(tick, familyConfig.pollMs);
    };
    tick();
  }
  async function pollFamily() {
    let reachable = true;
    let known = null;
    try {
      const status = await familyClient.status();
      familyDeviceCounts = status?.devices && typeof status.devices === "object" ? status.devices : {};
      known = Number.isInteger(status?.people) ? status.people : null;
    } catch (error) {
      reachable = false;
      familyDeviceCounts = {};
    }
    renderFamilyTexts();
    const day = Logic.localDateKey(new Date());
    // 家族のしくみが動き出した・名簿をなくしている（保存フォルダを消して起動し直したなど。status の people が 0）：名簿と全員の写しを送り直す
    const resend = reachable && (familyWasOffline || known === 0);
    familyWasOffline = !reachable;
    if (familySnapshotDay !== day || resend) {
      familySnapshotDay = day;
      people.people.forEach((person) => scheduleSnapshot(person.id, 0));
    }
    if (resend) sendPeopleSoon();
    if (!reachable) return;
    findFamilyLeftovers();
    if (familyNotesUnlocked) loadFamilyDevices();
    try {
      await takeFamilyInbox();
    } catch (error) { /* 次の回にもう一度 */ }
  }
  // 受け取り箱の品を古い順に取り込み、取り込めたところまでを ack。届かなくなったら、そこで止めて次の回に続ける
  async function takeFamilyInbox() {
    const inbox = await familyClient.inbox(familyInboxAfter);
    const items = (Array.isArray(inbox?.items) ? inbox.items : []).filter((item) => item && Number.isInteger(item.seq)).sort((a, b) => a.seq - b.seq);
    let upTo = null;
    for (const item of items) {
      try {
        await takeFamilyItem(item);
      } catch (error) {
        if (error?.code === "offline") break;
      }
      upTo = item.seq;
    }
    if (upTo === null) return;
    familyInboxAfter = upTo;
    await familyClient.ack(upTo);
  }
  function takeFamilyItem(item) {
    const person = people.people.find((entry) => entry.id === item.personId);
    if (!person) return null;
    if (item.type === "photo") return takeFamilyPhoto(item, person);
    if (item.type === "voice") return takeFamilyVoice(item, person);
    if (item.type === "rename") takeFamilyRename(item, person.id);
    if (item.type === "voice-name") takeFamilyVoiceName(item, person.id);
    if (item.type === "security" && item.what === "pin-locked") {
      updatePersonRecord(person.id, (record) => addFamilyDeviceNote(record, item, `家族の端末からPINが何度も違いました（${familyDeviceName(item)}）`, true));
    }
    return null;
  }
  // 届いた写真：家族のしくみから取って IndexedDB へ（同じ写真は入れない）。いまの人なら写真あそびの列を見直す。
  // いま選んでいない人の写真は、その人を選んだときに写真あそびになる
  async function takeFamilyPhoto(item, person) {
    if (typeof item.photoId !== "string" || !/^[0-9a-f]{16}$/.test(item.photoId)) return;
    const known = memoryPhotos.has(item.photoId) || Boolean(await MediaStore.getPhoto(item.photoId).catch(() => null));
    if (!known) {
      const blob = await familyClient.photo(item.photoId);
      const now = new Date().toISOString();
      const record = {
        photoId: item.photoId, personId: person.id, sender: String(item.sender || ""), deviceName: String(item.deviceName || ""),
        sentAt: typeof item.sentAt === "string" ? item.sentAt : now, receivedAt: now
      };
      const saved = await MediaStore.putPhoto({ ...record, blob }).then(() => true, () => false);
      if (!saved) memoryPhotos.set(item.photoId, { ...record, status: "waiting", revealedAt: null });
    }
    if (person.id === activePerson().id) await refreshQuestQueue();
    scheduleSnapshot(person.id);
  }
  // 届いた声（2段目）：家族のしくみから取って、その人の IndexedDB に入れ、声の一覧に足す（鳴らす声は変えない。テレビで「この声を使う」を
  // 選んだときだけ運動で鳴る）。ホームに「○○から 声が届きました」を出す。IndexedDB に書けない PC では取り込まない（記録があふれるので）
  async function takeFamilyVoice(item, person) {
    if (typeof item.voiceId !== "string" || !/^[0-9a-f]{16}$/.test(item.voiceId) || !MediaStore) return;
    const id = `f-${item.voiceId}`;
    const record = person.id === activePerson().id ? state : readPersonState(person);
    if (!record || record.voices.some((voice) => voice.id === id)) return;
    const blob = await familyClient.voice(item.voiceId);
    const sender = typeof item.sender === "string" && item.sender.trim() ? item.sender.trim().slice(0, 12) : "ご家族";
    // 送る人が付けた名前があれば使う（なければ「○○の声」）
    const given = typeof item.name === "string" ? item.name.trim().slice(0, Logic.VOICE_NAME_LIMIT) : "";
    const name = given || `${sender}の声`;
    const savedAt = typeof item.sentAt === "string" ? item.sentAt : new Date().toISOString();
    if (!(await MediaStore.putVoice(person.id, { id, name, blob, savedAt }).catch(() => false))) return;
    let removed = [];
    updatePersonRecord(person.id, (target) => {
      const added = Logic.addVoice(target, { id, name, ref: "idb", consent: true, savedAt }, { select: false });
      removed = added.removed;
      Object.assign(target, Logic.noteVoiceArrival(added.state, { id, sender, at: new Date().toISOString() }));
    });
    removed.forEach((voice) => { if (voice.ref === "idb") MediaStore.deleteVoice(person.id, voice.id).catch(() => {}); });
    if (person.id !== activePerson().id) return;
    if (views.home.classList.contains("is-active")) renderVoiceArrival();
    if (views.settings.classList.contains("is-active")) renderSettings();
  }
  // 家族の端末で声の名前を変えた（テレビが受け取ったあと）。一覧にない声（消した・入れ替わった）は何もしない
  function takeFamilyVoiceName(item, personId) {
    if (typeof item.voiceId !== "string" || !/^[0-9a-f]{16}$/.test(item.voiceId)) return;
    updatePersonRecord(personId, (target) => Object.assign(target, Logic.renameVoice(target, `f-${item.voiceId}`, item.name)));
    if (personId === activePerson().id && views.settings.classList.contains("is-active")) renderSettings();
  }
  // 感想を送る（家族のしくみがあるときだけ出す）。種類を1つ選び、ひとことは書かなくてもよい。家族のしくみの PC の中にためる
  let feedbackKind = null;
  function openFeedback() {
    if (!familyClient && !trialMode) return;
    feedbackKind = null;
    document.querySelectorAll("[data-feedback-kind]").forEach((button) => button.setAttribute("aria-pressed", "false"));
    $("#feedback-text").value = "";
    $("#feedback-error").hidden = true;
    $("#feedback-error").classList.remove("is-done");
    $("#feedback-send").disabled = false;
    $("#feedback-send").hidden = false;
    $("#feedback-send").textContent = familyClient ? "送る" : "ファイルに保存する";
    $("#feedback-file-note").hidden = Boolean(familyClient);
    $("#feedback-cancel").textContent = "やめる";
    $("#feedback-dialog").showModal();
    $("[data-feedback-kind]").focus();
  }
  function chooseFeedbackKind(kind) {
    feedbackKind = kind;
    document.querySelectorAll("[data-feedback-kind]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.feedbackKind === kind)));
    $("#feedback-error").hidden = true;
  }
  async function sendFeedback() {
    const error = $("#feedback-error");
    if (!feedbackKind) {
      error.textContent = "当てはまるものを1つ選んでください。";
      error.hidden = false;
      return;
    }
    const view = (document.querySelector("main > .view.is-active")?.id || "").replace(/^view-/, "");
    if (!familyClient) {
      saveFeedbackFile(feedbackKind, $("#feedback-text").value.trim().slice(0, 500), view);
      return;
    }
    $("#feedback-send").disabled = true;
    try {
      await familyClient.feedback({ kind: feedbackKind, text: $("#feedback-text").value.trim().slice(0, 500), personId: activePerson().id, view });
      $("#feedback-dialog").close();
      showToast("感想を送りました。ありがとうございます。");
    } catch (problem) {
      error.textContent = "感想を送れませんでした。家族のしくみ（窓3）が動いているか確かめてください。";
      error.hidden = false;
    } finally {
      $("#feedback-send").disabled = false;
    }
  }
  // 体験版：感想をテキストのファイルにして保存する（ブラウザの「ダウンロード」へ）。送るのは使った人が、配った人へ
  const FEEDBACK_LABELS = { good: "よかった", confusing: "わかりにくい", broken: "うまく動かない", idea: "こうしてほしい" };
  function saveFeedbackFile(kind, text, view) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const body = ["Motion-Link 体験版の感想", `日時：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      `種類：${FEEDBACK_LABELS[kind] || kind}`, `画面：${view}`, `版：${assetVersion}`, "ひとこと：", text || "（なし）", ""].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    // ファイル名は英数字だけ（日本語の名前は、ブラウザや送る手段によって「download」などに変わることがある）
    link.download = `Motion-Link-feedback_${stamp}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const done = $("#feedback-error");
    done.textContent = `感想をファイルにしました（「ダウンロード」の「Motion-Link-feedback_${stamp}.txt」）。このファイルを、Motion-Link を配った人に送ってください。`;
    done.classList.add("is-done");
    done.hidden = false;
    $("#feedback-send").hidden = true;
    $("#feedback-cancel").textContent = "閉じる";
    $("#feedback-cancel").focus();
  }
  // ホームの「○○から 声が届きました」。いちばん新しい、まだ聞いていない声を1つ
  function renderVoiceArrival() {
    const arrival = (state.voiceArrivals || [])[0];
    $("#voice-arrival").hidden = !arrival;
    if (arrival) $("#voice-arrival-title").textContent = `${arrival.sender || "ご家族"}から 声が届きました`;
  }
  // 「きく」：届いた声を鳴らし、聞いた声として知らせを消す（声は一覧に残る）
  async function playArrival() {
    const arrival = (state.voiceArrivals || [])[0];
    if (!arrival) return;
    const personId = people.activeId;
    let url = null;
    try {
      const saved = await MediaStore.getVoice(personId, arrival.id);
      if (!saved?.blob) throw new Error("no voice");
      url = URL.createObjectURL(saved.blob);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      showToast("声を再生できませんでした。");
      return;
    }
    if (people.activeId !== personId) return;
    state = Logic.clearVoiceArrival(state, arrival.id);
    saveState();
    renderVoiceArrival();
    if (!$("#voice-arrival").hidden) $("#play-arrival").focus({ preventScroll: true });
  }
  // 呼び名の変更：名簿と、その人の記録の呼び名を変え、家族だけのお知らせに残す。今の呼び名と同じ（前に送った変更の打ち消し）なら何もしない。
  // 名簿のほかの人と同じ名前は取り込まない（家族のしくみの名簿が古いと、すり抜けることがある）
  function takeFamilyRename(item, personId) {
    const name = typeof item.userName === "string" ? item.userName.trim() : "";
    syncPeople();
    const current = people.people.find((entry) => entry.id === personId);
    if (!current || !name || name === current.name) return;
    const device = familyDeviceName(item);
    const result = Logic.renamePerson(people, personId, name);
    if (!result.ok) {
      if (result.reason === "taken") {
        updatePersonRecord(personId, (record) => addFamilyDeviceNote(record, item, `家族の端末からの呼び名の変更（${name}）は、同じ名前の人がいるので取りやめました（${device}）`, false));
      }
      return;
    }
    people = result.people;
    savePeople();
    updatePersonRecord(personId, (record) => {
      record.userName = result.person.name;
      addFamilyDeviceNote(record, item, `家族の端末で呼び名を「${result.person.name}」にしました（${device}）`, false);
    });
    renderPersonSwitch();
    if (views.settings.classList.contains("is-active")) renderPeople();
  }
  const familyDeviceName = (item) => (typeof item.deviceName === "string" && item.deviceName.trim() ? item.deviceName.trim().slice(0, 20) : "名前のない端末");
  // 家族の端末からの知らせ（家族だけのお知らせ。見出しは「家族の端末」）。番号は受け取り箱の品の種類と時刻から作り、同じ知らせを2つ入れない
  function addFamilyDeviceNote(record, item, message, important) {
    const parsed = Date.parse(item.at);
    const at = Number.isFinite(parsed) ? new Date(parsed) : new Date();
    const id = `family-device-${item.type}-${at.getTime()}`;
    if (record.notifications.some((note) => note.id === id)) return;
    record.notifications = Logic.capNotifications([
      { id, timestamp: at.toISOString(), audience: "family", kind: "watch", topic: "family-device", important, immediate: important, message },
      ...record.notifications
    ]);
  }
  // その人の記録を変える：いまの人は state、ほかの人はその人のキーの記録（いまの state にはさわらない。読めない記録は書きかえない）
  function updatePersonRecord(personId, change) {
    if (personId === activePerson().id) {
      change(state);
      saveState();
      if (views.settings.classList.contains("is-active")) renderFamilyNotes();
      return;
    }
    const person = people.people.find((item) => item.id === personId);
    const record = person ? readPersonState(person) : null;
    if (!record) return;
    change(record);
    try {
      localStorage.setItem(person.storageKey, JSON.stringify(record));
    } catch (error) {
      return;
    }
    scheduleSnapshot(personId);
  }

  // 家族のしくみがあるときの文（F1 の表）。上の帯・最初の画面・保存先と、その人につないだ端末が1つ以上あるときのお知らせの札。
  // 家族のしくみがないときは index.html の今の文のまま
  function renderFamilyTexts() {
    if (!familyClient) return;
    $(".local-badge").lastChild.textContent = " このPCと家族の端末";
    $(".landing-privacy").textContent = "カメラの映像はこのPCの外へ出しません。運動の記録は、登録したご家族の端末にだけ届きます。";
    $(".data-controls span").textContent = "履歴・設定・体の分析はこのブラウザに保存します。ご家族の端末に見せる写しと届いた写真は、このPCの中に置きます。";
    const delivered = Number(familyDeviceCounts[activePerson().id]) > 0;
    $(".line-preview .sent-badge").textContent = delivered ? "家族の端末に届けます" : "家族へは送っていません";
    $(".notification-panel .prototype-tag").textContent = delivered ? "家族の端末に届けます" : "送っていません";
  }

  // 「ご家族・運営の方へ」の欄「家族の端末」（家族のしくみがあるとき・PIN を入れている間だけ）：「家族の端末をつなぐ」で QR・アドレス・番号を
  // 最長5分だけ出す（PIN がはじめのままの人は押せない）。つないだ端末の一覧と「外す」
  const FAMILY_OFFLINE_TEXT = "家族の端末のしくみが動いていません";
  const PAIRING_PROBLEM_TEXT = {
    pin_not_ready: "PINがはじめのままなので、まだつなげません。先にこの人のPINを変えてください。",
    too_many_devices: "この人につなげる端末は10台までです。使っていない端末を外してください。"
  };
  const FAMILY_PAIRING_MAX_MS = 300000;
  let familyDevicesList = null;
  let familyDevicesRun = 0;
  let familyPairingTimer = null;
  function renderFamilyDevices() {
    const box = $("#family-devices");
    box.hidden = !familyClient || !familyNotesUnlocked;
    if (box.hidden) {
      clearFamilyPairing();
      familyDevicesList = null;
      $("#family-device-list").innerHTML = "";
      $("#family-devices-status").textContent = "";
      return;
    }
    $("#family-pair").disabled = !activePerson().pin;
  }
  async function loadFamilyDevices() {
    if (!familyClient || !familyNotesUnlocked) return;
    const run = ++familyDevicesRun;
    const personId = activePerson().id;
    let list = null;
    try {
      list = await familyClient.devices(personId);
    } catch (error) {
      list = null;
    }
    if (run !== familyDevicesRun || !familyNotesUnlocked || activePerson().id !== personId) return;
    familyDevicesList = Array.isArray(list) ? list.filter((device) => device && typeof device.deviceId === "string") : null;
    const status = $("#family-devices-status");
    if (!familyDevicesList) status.textContent = FAMILY_OFFLINE_TEXT;
    else if (status.textContent === FAMILY_OFFLINE_TEXT) status.textContent = "";
    $("#family-device-list").innerHTML = !familyDevicesList ? "" : familyDevicesList.length
      ? familyDevicesList.map((device) => `<li><div><strong>${escapeHtml(device.name || "名前のない端末")}</strong><span>送る人：${escapeHtml(device.sender || "—")}・最後に見た日時：${device.lastSeenAt ? formatDate(device.lastSeenAt) : "まだありません"}</span></div><button class="text-button danger" type="button" data-device-id="${escapeHtml(device.deviceId)}">外す</button></li>`).join("")
      : `<li class="family-device-empty">つないだ端末はまだありません。</li>`;
  }
  async function startFamilyPairing() {
    if (!familyClient || !familyNotesUnlocked) return;
    const personId = activePerson().id;
    const status = $("#family-devices-status");
    status.textContent = "";
    clearFamilyPairing();
    $("#family-pair").disabled = true;
    try {
      // PIN を変えたばかりでも、家族のしくみが新しい PIN を知ってから番号を出す
      await sendPeople();
      const pairing = await familyClient.pairing(personId);
      if (familyNotesUnlocked && activePerson().id === personId) showFamilyPairing(pairing);
    } catch (error) {
      if (familyNotesUnlocked) status.textContent = PAIRING_PROBLEM_TEXT[error?.code] || FAMILY_OFFLINE_TEXT;
    } finally {
      $("#family-pair").disabled = !familyNotesUnlocked || !activePerson().pin;
    }
  }
  function showFamilyPairing(pairing) {
    const qr = $("#family-pairing-qr");
    qr.hidden = typeof pairing?.qrPng !== "string" || !pairing.qrPng;
    if (!qr.hidden) qr.src = `data:image/png;base64,${pairing.qrPng}`;
    $("#family-pairing-code").textContent = String(pairing?.code || "");
    $("#family-pairing-urls").innerHTML = (Array.isArray(pairing?.urls) ? pairing.urls : []).map((url) => `<li>${escapeHtml(url)}</li>`).join("");
    $("#family-pairing").hidden = false;
    const until = Date.parse(pairing?.expiresAt);
    const remaining = Number.isFinite(until) ? Math.min(FAMILY_PAIRING_MAX_MS, until - Date.now()) : FAMILY_PAIRING_MAX_MS;
    familyPairingTimer = setTimeout(clearFamilyPairing, Math.max(0, remaining));
  }
  // 番号・QR・アドレスを消す（5分たった・欄を閉じた・人を変えた）。画面の中にも残さない
  function clearFamilyPairing() {
    clearTimeout(familyPairingTimer);
    familyPairingTimer = null;
    $("#family-pairing").hidden = true;
    $("#family-pairing-qr").removeAttribute("src");
    $("#family-pairing-code").textContent = "";
    $("#family-pairing-urls").innerHTML = "";
  }
  async function removeFamilyDevice(deviceId) {
    const device = (familyDevicesList || []).find((item) => item.deviceId === deviceId);
    if (!device || !familyNotesUnlocked) return;
    const name = device.name || "名前のない端末";
    const confirmed = await askDialog({ message: `「${name}」の登録を外しますか？その端末では見られなくなります。`, yesLabel: "外す", danger: true });
    if (!confirmed || !familyNotesUnlocked) return;
    const status = $("#family-devices-status");
    try {
      await familyClient.deleteDevice(deviceId);
      status.textContent = `「${name}」を外しました。`;
    } catch (error) {
      status.textContent = error?.code === "not_found" ? `「${name}」はもう外れています。` : FAMILY_OFFLINE_TEXT;
    }
    loadFamilyDevices();
  }

  // 数え方がこの人に合っているか（F5。家族だけ：「ご家族・運営の方へ」で PIN を入れている間だけ。logic.js getAccuracyView。
  // 家族のページの PIN の先と同じ文。家族向けなので数を出す）
  const ACCURACY_SEEN_TEXT = { good: "よく見えています", fair: "ときどき見えにくい", poor: "見えにくい" };
  const ACCURACY_CAMERA_TEXT = { depth: "奥行きカメラ", browser: "ブラウザのカメラ" };
  function renderFamilyAccuracy() {
    const box = $("#family-accuracy");
    box.hidden = !familyNotesUnlocked;
    const body = $("#family-accuracy-body");
    if (!familyNotesUnlocked) {
      body.innerHTML = "";
      return;
    }
    const view = Logic.getAccuracyView(state, new Date());
    const march = view.march;
    const cm = (value) => String(Math.round(Number(value) * 10) / 10);
    const paragraph = (text) => `<p>${escapeHtml(text)}</p>`;
    const list = (lines) => `<ul>${lines.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`;
    // 次のレベルまでの残りは、残りのある所だけ（レベル0の「左右それぞれ あと0回」を出さない）。家族のページ（family.js accuracyNodes）と同じ
    const left = march.next ? [[march.next.repsLeft, `足踏み あと${march.next.repsLeft}回`], [march.next.eachLeft, `左右それぞれ あと${march.next.eachLeft}回`],
      [march.next.sessionsLeft, `あと${march.next.sessionsLeft}回の運動`]].filter(([value]) => value > 0).map(([, text]) => text) : [];
    const parts = [paragraph(`体の分析：レベル${march.level}（${march.levelName}）。${march.next
      ? (left.length ? `次のレベルまで：${left.join("・")}` : "")
      : "いちばん上のレベルです"}`)];
    if (march.adaptEnabled === false) parts.push(paragraph("この人に合わせる仕組みは止めています。"));
    else if (march.tuned) parts.push(paragraph(`座って足踏みは、この人に合わせています：ひざが${cm(march.countHeightCm)}cm上がったら1回（標準は${cm(march.standardCm)}cm）。`));
    else if (march.ready) parts.push(paragraph(`この人に合わせる準備はそろいました。この人の足踏みには、標準の数え方（ひざが${cm(march.standardCm)}cm上がったら1回）が合っています。`));
    else {
      parts.push(paragraph(`座って足踏みは、まだ標準の数え方です（ひざが${cm(march.standardCm)}cm上がったら1回）。この人に合わせる準備：`));
      parts.push(list(march.steps.map((step) => `${step.label} ${step.have}/${step.need}回`)));
    }
    if (march.depthUsed === false && !march.tuned) parts.push(paragraph("ブラウザのカメラだけのときは、合わせる準備は進みません（奥行きカメラで進みます）。"));
    const recent = view.recent.slice(0, 5);
    if (recent.length) {
      parts.push(paragraph("最近5回の映り方"));
      parts.push(list(recent.map((item) => {
        const date = typeof item.at === "string" ? new Date(item.at) : null;
        const head = `${date && Number.isFinite(date.getTime()) ? `${date.getMonth() + 1}/${date.getDate()} ` : ""}${item.exerciseName}`;
        // 練習のわけは「。」で終わる文（かっこの中に入れると「。）」になる）
        if (item.practice) return `${head}：練習${item.reason ? `。${item.reason}` : ""}`;
        const seen = ACCURACY_SEEN_TEXT[item.seen] || "";
        const camera = ACCURACY_CAMERA_TEXT[item.camera] ? `（${ACCURACY_CAMERA_TEXT[item.camera]}）` : "";
        return seen ? `${head}：${seen}${camera}` : `${head}${camera}`;
      })));
    }
    parts.push(paragraph(`この30日の記録 ${view.practice30.total}回のうち、練習は${view.practice30.practice}回でした。`));
    parts.push(paragraph("ほかの運動は、どの人にも同じ標準の数え方です（この人に合わせるのは座って足踏みだけです）。"));
    body.innerHTML = parts.join("");
  }

  // ---- カメラの映り方の確認（ご家族向け。「ご家族・運営の方へ」で PIN を入れている間だけ） ----
  // いま映っている人の関節から、頭・肩・腰・ひざ・足首が画面の中に見えているか（直近の数秒）を ✓ / △ と短い助言で出す。
  // 回数は数えず、記録・植物・お知らせ・体の分析には何も入れない。映像も関節も保存しない（直近の数秒だけを覚えて、閉じたら捨てる）
  const CAMERA_CHECK_PARTS = [
    { key: "head", label: "頭" },
    { key: "shoulders", label: "肩", joints: [11, 12] },
    { key: "hips", label: "腰", joints: [23, 24] },
    { key: "knees", label: "ひざ", joints: [25, 26] },
    { key: "ankles", label: "足首", joints: [27, 28] }
  ];
  // 助言を出す順（数え方に大事な所から）。画面の並びは頭から足首
  const CAMERA_CHECK_ADVICE_ORDER = ["shoulders", "hips", "head", "knees", "ankles"];
  const CAMERA_CHECK = {
    windowMs: 3000, // 直近3秒を見る
    settleMs: 1500, // 見はじめてからこの長さがたつまでは「確かめています」
    okShare: .8, // 直近のコマのうち、この割合で見えていれば ✓
    edge: .02, // 画面のふちから、この幅の中は「出ている」
    noseTop: .06, // 鼻がこれより上なら頭の上が切れている（ブラウザのカメラ）
    shoulderTop: .12, // 鼻の届かない端末サービスでは、肩がこれより上なら頭が切れている
    sampleMs: 66, // 骨格を見る間隔（ブラウザのカメラ）
    renderMs: 500, // 表示を書きかえる間隔
    maxMs: 180000 // 開いたままでも3分で閉じる（カメラを使い続けない）
  };
  const CAMERA_CHECK_STATE_TEXT = { ok: "映っています", top: "画面の上から出ています", bottom: "画面の下から出ています", side: "画面の横から出ています", hidden: "よく見えません" };
  // 助言（家族が読む。数値は出さない。カメラは下へ向けない：向けると数え方と見守りが変わる）
  const CAMERA_CHECK_ADVICE = {
    "head:top": "頭が画面の上から出ています。椅子を少し後ろへ下げてください。カメラは まっすぐ前へ向けてください。",
    "knees:bottom": "ひざが画面の下から出ています。椅子を少し後ろへ下げるか、カメラを少し低い所に置いてください。カメラは下へ向けず、まっすぐ前へ向けてください。",
    "ankles:bottom": "足首が画面の下から出ています。椅子を少し後ろへ下げるか、カメラを少し低い所に置くと、足の運動が数えやすくなります。カメラは下へ向けず、まっすぐ前へ向けてください。"
  };
  const cameraCheckAdvice = (part, reason) => CAMERA_CHECK_ADVICE[`${part.key}:${reason}`] || {
    top: `${part.label}が画面の上から出ています。椅子を少し後ろへ下げてください。カメラは まっすぐ前へ向けてください。`,
    bottom: `${part.label}が画面の下から出ています。椅子を少し後ろへ下げてください。カメラは まっすぐ前へ向けてください。`,
    side: `${part.label}が画面の横から出ています。カメラの正面に座ってください。`,
    hidden: `${part.label}がよく見えません。${part.label}の前に物があればよけて、部屋を明るくしてください。`
  }[reason];
  const CAMERA_CHECK_ALL_OK = "頭から足首まで映っています。このままで大丈夫です。";
  const CAMERA_CHECK_SIT = "椅子に座って、足を床につけてください。";

  // 1つの関節：ok / top / bottom / side（画面のふちから出ている）/ hidden（見つからない・よく見えない）
  function cameraCheckJoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return "hidden";
    if (point.y > 1 - CAMERA_CHECK.edge) return "bottom";
    if (point.y < CAMERA_CHECK.edge) return "top";
    if (point.x < CAMERA_CHECK.edge || point.x > 1 - CAMERA_CHECK.edge) return "side";
    return Logic.landmarkConfidence(point) >= .52 ? "ok" : "hidden";
  }
  // 1つの部位（左右の両方が見えて ok）。出ている理由があれば、見えない理由より先に返す
  function cameraCheckPart(landmarks, part) {
    if (part.key === "head") {
      const nose = landmarks[0];
      if (nose && Number.isFinite(nose.x) && Number.isFinite(nose.y)) {
        const state = cameraCheckJoint(nose);
        return state === "ok" && nose.y < CAMERA_CHECK.noseTop ? "top" : state;
      }
      // 端末サービスは肩より上の関節を送らない：両肩の高さで見る
      const shoulders = cameraCheckPart(landmarks, CAMERA_CHECK_PARTS[1]);
      if (shoulders !== "ok") return shoulders === "top" ? "top" : "hidden";
      return (landmarks[11].y + landmarks[12].y) / 2 < CAMERA_CHECK.shoulderTop ? "top" : "ok";
    }
    const states = part.joints.map((index) => cameraCheckJoint(landmarks[index]));
    if (states.every((state) => state === "ok")) return "ok";
    return states.find((state) => state !== "ok" && state !== "hidden") || "hidden";
  }
  // 直近の数コマ（{ at, landmarks }。landmarks が null のコマは人が映っていない）から、部位ごとの ✓ / △ と助言
  function assessCameraView(samples, startedAt, now) {
    const recent = samples.filter((sample) => now - sample.at <= CAMERA_CHECK.windowMs);
    if (now - startedAt < CAMERA_CHECK.settleMs || !recent.length) return { status: "checking", parts: [], advice: "" };
    const people = recent.filter((sample) => sample.landmarks);
    if (people.length < recent.length / 2) return { status: "no-person", parts: [], advice: "" };
    const parts = CAMERA_CHECK_PARTS.map((part) => {
      const states = people.map((sample) => cameraCheckPart(sample.landmarks, part));
      const okShare = states.filter((state) => state === "ok").length / states.length;
      if (okShare >= CAMERA_CHECK.okShare) return { key: part.key, label: part.label, state: "ok" };
      const tally = new Map();
      states.filter((state) => state !== "ok").forEach((state) => tally.set(state, (tally.get(state) || 0) + 1));
      const reason = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { key: part.key, label: part.label, state: reason, advice: cameraCheckAdvice(part, reason) };
    });
    const first = CAMERA_CHECK_ADVICE_ORDER.map((key) => parts.find((part) => part.key === key)).find((part) => part.state !== "ok");
    return { status: first ? "adjust" : "ok", parts, advice: first ? first.advice : CAMERA_CHECK_ALL_OK };
  }

  let cameraCheck = null;
  function openCameraCheck() {
    if (!familyNotesUnlocked || cameraCheck) return;
    const check = { startedAt: performance.now(), samples: [], stream: null, client: null, videoRequest: null, lastSampleAt: 0, aspect: 4 / 3, problem: "", latest: null, renderTimer: null, maxTimer: null };
    cameraCheck = check;
    const dialog = $("#camera-check");
    $("#camera-check-video").hidden = true;
    dialog.showModal();
    $("#camera-check-close").focus();
    check.renderTimer = setInterval(() => renderCameraCheck(check), CAMERA_CHECK.renderMs);
    check.maxTimer = setTimeout(closeCameraCheck, CAMERA_CHECK.maxMs);
    if (cameraPaused()) check.problem = "カメラは一時停止中です。";
    else if (localSensorConfig) startCameraCheckLocal(check);
    else startCameraCheckBrowser(check);
    renderCameraCheck(check);
  }

  function closeCameraCheck() {
    const check = cameraCheck;
    if (!check) return;
    cameraCheck = null;
    clearInterval(check.renderTimer);
    clearTimeout(check.maxTimer);
    const video = $("#camera-check-video");
    if (check.videoRequest !== null) video.cancelVideoFrameCallback?.(check.videoRequest);
    stopStream(check.stream);
    video.srcObject = null;
    check.client?.close();
    check.samples = [];
    const dialog = $("#camera-check");
    if (dialog.open) dialog.close();
    if (familyNotesUnlocked) {
      $("#camera-check-open").focus({ preventScroll: true });
      scheduleFamilyNotesHide();
    }
  }

  function addCameraCheckSample(check, landmarks, at) {
    if (cameraCheck !== check) return;
    check.samples.push({ at, landmarks: Array.isArray(landmarks) ? landmarks : null });
    check.samples = check.samples.filter((sample) => at - sample.at <= CAMERA_CHECK.windowMs);
    check.latest = Array.isArray(landmarks) ? landmarks : null;
    drawCameraCheckPose(check);
  }

  async function startCameraCheckBrowser(check) {
    if (!navigator.mediaDevices?.getUserMedia) {
      check.problem = "このブラウザではカメラを利用できません。";
      return;
    }
    try {
      const stream = await openBrowserCamera();
      if (cameraCheck !== check) {
        stopStream(stream);
        return;
      }
      check.stream = stream;
      const video = $("#camera-check-video");
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      if (cameraCheck !== check) return;
      check.aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : check.aspect;
      const engine = await ensurePoseEngine();
      if (cameraCheck !== check) return;
      if (!engine || typeof video.requestVideoFrameCallback !== "function") {
        check.problem = poseEngineStatus.state === "missing" ? "体の動きを読む仕組みのファイルが足りないため、体を見られません。" : "体を見る準備ができませんでした。";
        return;
      }
      check.startedAt = performance.now();
      const onFrame = (now) => {
        check.videoRequest = null;
        if (cameraCheck !== check) return;
        if (now - check.lastSampleAt >= CAMERA_CHECK.sampleMs) {
          check.lastSampleAt = now;
          // 骨格AIへ渡す時刻は運動中と同じく、いつも前より後にする
          const timestamp = Math.max(now, lastPoseInference + 1);
          lastPoseInference = timestamp;
          try {
            addCameraCheckSample(check, engine.detect(video, timestamp)?.landmarks || null, now);
          } catch (error) {
            console.warn("カメラの映り方の確認で骨格を見られなかったコマがあります。", error);
          }
        }
        check.videoRequest = video.requestVideoFrameCallback(onFrame);
      };
      check.videoRequest = video.requestVideoFrameCallback(onFrame);
    } catch (error) {
      if (cameraCheck !== check) return;
      check.problem = `${BROWSER_CAMERA_PROBLEM_TEXT[error?.name] || CAMERA_PROBLEM_TEXT.internal}。`;
    }
  }

  // 端末サービスが模擬（--camera mock）で動いているときは、作りものの全身が届く。映り方を確かめたことにしない
  const CAMERA_CHECK_MOCK_TEXT = "端末サービスは模擬の映像で動いています。本物のカメラで確かめてください。";
  async function startCameraCheckLocal(check) {
    const client = new LocalSensor.LocalSensorClient(localSensorConfig, {
      onFrame: (frame) => {
        if (frame.is_demo) {
          check.problem = CAMERA_CHECK_MOCK_TEXT;
          return;
        }
        if (frame.image?.width && frame.image?.height) check.aspect = frame.image.width / frame.image.height;
        if (!check.live) {
          check.live = true;
          check.startedAt = performance.now();
        }
        addCameraCheckSample(check, LocalSensor.toLandmarks(frame).landmarks, performance.now());
      },
      onStatus: (status) => {
        if (status.state === "error") check.problem = `${CAMERA_PROBLEM_TEXT[cameraProblemCode(status)]}。`;
        else if (status.state === "disabled_by_admin") check.problem = "カメラは端末側で一時停止中です。";
        else if (status.is_demo) check.problem = CAMERA_CHECK_MOCK_TEXT;
        else if (status.state === "streaming") check.problem = "";
      },
      onDisconnect: () => { check.problem = `${CAMERA_PROBLEM_TEXT.camera_disconnected}。`; }
    });
    check.client = client;
    try {
      await client.connect();
    } catch (error) {
      if (cameraCheck === check) check.problem = "カメラにつながりません。";
      client.close();
      return;
    }
    if (cameraCheck !== check) return;
    // 足踏みと同じ全身の見方で送ってもらう（回数は数えない）
    client.start("chair-march");
  }

  function renderCameraCheck(check) {
    if (cameraCheck !== check) return;
    const now = performance.now();
    const view = check.problem ? { status: "problem", parts: [], advice: "" } : check.stream || check.live ? assessCameraView(check.samples, check.startedAt, now) : { status: "preparing", parts: [], advice: "" };
    const lead = { problem: check.problem, preparing: "カメラを準備しています。", checking: `${CAMERA_CHECK_SIT}確かめています。`, "no-person": `カメラの前で、${CAMERA_CHECK_SIT}` }[view.status] || CAMERA_CHECK_SIT;
    setTextIfChanged($("#camera-check-lead"), lead);
    const rows = CAMERA_CHECK_PARTS.map((part) => {
      const found = view.parts.find((item) => item.key === part.key);
      const mark = found ? (found.state === "ok" ? "✓" : "△") : "…";
      const text = found ? CAMERA_CHECK_STATE_TEXT[found.state] : "";
      return `<li class="camera-check-part is-${found ? (found.state === "ok" ? "ok" : "adjust") : "waiting"}" data-part="${part.key}"><b aria-hidden="true">${mark}</b><span>${part.label}</span><small>${text}</small></li>`;
    }).join("");
    const list = $("#camera-check-parts");
    if (list.dataset.rows !== rows) {
      list.innerHTML = rows;
      list.dataset.rows = rows;
    }
    const advice = $("#camera-check-advice");
    setTextIfChanged(advice, view.advice);
    advice.classList.toggle("is-ok", view.status === "ok");
  }

  // 線を描くキャンバスを、表示の大きさ（画面の画素）にそろえて消す。ratio は CSS の1画素あたりの画素。まだ表示されていない（大きさ 0）なら null
  function fitCanvasToBox(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (!width || !height) return null;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height, ratio };
  }

  // 映っている人の線を、カメラの画面の枠の中に（運動中と同じく、映像と線は CSS で鏡のように左右を返す）。端末サービスでは映像はないので、枠と線だけ
  function drawCameraCheckPose(check) {
    const fitted = fitCanvasToBox($("#camera-check-overlay"));
    if (!fitted) return;
    const { ctx, width, height, ratio } = fitted;
    const scale = Math.min(width / check.aspect, height);
    const frameWidth = check.aspect * scale;
    const frameHeight = scale;
    const left = (width - frameWidth) / 2;
    const top = (height - frameHeight) / 2;
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = 3 * ratio;
    ctx.strokeRect(left, top, frameWidth, frameHeight);
    const landmarks = check.latest;
    if (!landmarks) return;
    const point = (landmark) => [left + landmark.x * frameWidth, top + landmark.y * frameHeight];
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, frameWidth, frameHeight); ctx.clip();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(244, 202, 71, .96)";
    ctx.lineWidth = Math.max(4, frameHeight * .012);
    LocalSensor.CONNECTIONS.forEach(([from, to]) => {
      if (!Logic.visible(landmarks[from]) || !Logic.visible(landmarks[to])) return;
      const a = point(landmarks[from]);
      const b = point(landmarks[to]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    });
    // 頭（ブラウザのカメラだけ。端末サービスは肩より上を送らない）：鼻のまわりに丸
    if (Logic.visible(landmarks[0]) && Logic.visible(landmarks[11]) && Logic.visible(landmarks[12])) {
      const [x, y] = point(landmarks[0]);
      const radius = Math.abs(point(landmarks[11])[0] - point(landmarks[12])[0]) * .35;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // テレビで読める大きさの確認画面（ブラウザの confirm / prompt の代わり）。pin（checkPin の確かめ方 { personId, allowAdmin } と、欄の名前 label）があれば PIN も聞く。
  // 「はい」で true、「やめる」・Esc で false。最初は「やめる」を選んでおく（うっかり決定キーを押しても消えない）。
  // danger: true（消す・やり直す）は「はい」を赤にする（緑は「どうぞ」の色なので、消すほうをすすめているように見せない）
  let dialogSettle = null;
  let dialogPinGate = null;
  function askDialog({ message, yesLabel = "はい", noLabel = "やめる", pin = null, danger = false }) {
    const dialog = $("#tv-dialog");
    if (dialog.open || dialogSettle) return Promise.resolve(false);
    const returnFocus = document.activeElement;
    $("#tv-dialog-text").textContent = message;
    $("#tv-dialog-yes").textContent = yesLabel;
    $("#tv-dialog-yes").classList.toggle("is-danger", danger);
    $("#tv-dialog-no").textContent = noLabel;
    dialogPinGate = pin;
    $("#tv-dialog-pin-row").hidden = !pin;
    $("#tv-dialog-pin-label").textContent = pin?.label || "";
    $("#tv-dialog-pin").value = "";
    $("#tv-dialog-error").hidden = true;
    return new Promise((resolve) => {
      dialogSettle = (answer) => {
        dialogSettle = null;
        dialogPinGate = null;
        if (dialog.open) dialog.close();
        $("#tv-dialog-pin").value = "";
        returnFocus?.focus?.({ preventScroll: true });
        resolve(answer);
      };
      dialog.showModal();
      (pin ? $("#tv-dialog-pin") : $("#tv-dialog-no")).focus();
    });
  }
  let dialogChecking = false;
  async function answerDialog(yes) {
    if (!dialogSettle || dialogChecking) return;
    if (!yes) {
      dialogSettle(false);
      return;
    }
    if (dialogPinGate) {
      const settle = dialogSettle;
      dialogChecking = true;
      const check = await checkPin($("#tv-dialog-pin").value, dialogPinGate).finally(() => { dialogChecking = false; });
      // 確かめている間に閉じた（Esc・やめる）
      if (dialogSettle !== settle) return;
      if (check !== "ok") {
        $("#tv-dialog-pin").value = "";
        $("#tv-dialog-error").textContent = PIN_PROBLEM_TEXT[check];
        $("#tv-dialog-error").hidden = false;
        $("#tv-dialog-pin").focus();
        return;
      }
    }
    hideToast();
    dialogSettle(true);
  }

  // 運営の設定のスイッチ：管理用のPINを入れたときだけ変える（「運動する人」を開いている間は聞かない）。やめたら元のまま
  async function changeAdminOption(input) {
    const name = input.dataset.adminOption;
    const wanted = input.checked;
    input.checked = adminOptions[name];
    if (!peopleAdminUnlocked) {
      const label = input.closest("label")?.querySelector("span")?.firstChild?.textContent || "運営の設定";
      const allowed = await askDialog({
        message: `「${label}」を${wanted ? "使います" : "やめます"}。\n管理用のPINを入れてください。`,
        yesLabel: wanted ? "使う" : "やめる",
        noLabel: "もどる",
        pin: { label: "管理用のPIN" }
      });
      if (!allowed) return;
    }
    adminOptions = { ...loadAdminOptions(), [name]: wanted };
    try {
      localStorage.setItem(Logic.ADMIN_OPTIONS_KEY, JSON.stringify(adminOptions));
    } catch (error) {
      showToast("設定を保存できませんでした。");
      adminOptions = loadAdminOptions();
    }
    renderSettings();
    adminOptionsChanged(name);
    showToast(`「${input.closest("label")?.querySelector("span")?.firstChild?.textContent || "運営の設定"}」を${adminOptions[name] ? "使います" : "やめました"}。`);
  }
  function renderAdminOptions() {
    $$("[data-admin-option]").forEach((input) => { input.checked = adminOptions[input.dataset.adminOption]; });
  }
  // 設定が変わった（この画面・ほかの画面）：運動の一覧・写真あそびの入口を描き直す
  function adminOptionsChanged() {
    if (views.home.classList.contains("is-active")) renderHome();
    renderDailyQuestTeaser();
  }

  // カメラの一時停止（テレビ全体で1つ）：管理用のPINか、いま選んでいる人のご家族用のPIN（D-20）
  async function toggleAdminCamera() {
    // 押したときに見えていた向き（止める／再開する）にする（聞いている間にほかの画面で変わっても、逆にしない）
    const pause = !cameraPaused();
    // 「ご家族・運営の方へ」・「運動する人」で PIN を入れている間は聞き直さない
    if (!familyNotesUnlocked && !peopleAdminUnlocked) {
      const allowed = await askDialog({
        message: cameraPaused() ? "カメラを再開します。\nご家族用のPINか管理用のPINを入れてください。" : "カメラを一時停止します。\nご家族用のPINか管理用のPINを入れてください。",
        yesLabel: cameraPaused() ? "再開する" : "一時停止する",
        pin: { ...personPinGate(), label: `ご家族用のPIN（${activePerson().name}）か管理用のPIN` }
      });
      if (!allowed) return;
    }
    syncPeople();
    people.tv.cameraTemporarilyDisabled = pause;
    savePeople();
    if (cameraPaused()) stopCamerasForPause();
    renderSettings();
    showToast(cameraPaused() ? "カメラを一時停止しました。" : "カメラを再開しました。");
  }

  // 一時停止にしたとき：取得中・使用中のカメラもその場で止める
  function stopCamerasForPause() {
    if (cameraStream) {
      stopStream(cameraStream);
      cameraStream = null;
      $("#camera-video").srcObject = null;
    }
    cleanupQuestCamera();
    if (localSensorClient) localSensorClient.close();
    localSensorClient = null;
  }

  // ---- 運動する人（F0）：切り替え（運動選択の名前のボタン・人を選ぶ画面。PIN は聞かない）と、設定のカード「運動する人」（管理用のPINの先） ----
  // 運動選択の上の名前のボタン：2人以上のときだけ（1人のときの運動選択の画面は今と同じ）
  function renderPersonSwitch() {
    const button = $("#person-switch");
    const many = people.people.length > 1;
    button.hidden = !many;
    if (!many) return;
    const name = activePerson().name;
    $("#person-switch-name").textContent = name;
    button.setAttribute("aria-label", `運動する人：${name}。押すと変えられます`);
  }

  // 人を選ぶ画面。運動中・写真あそびの間は開かない（ボタンも出ない）。はじめは今の人を選んでおく
  function openPersonPicker() {
    const dialog = $("#person-picker");
    if (dialog.open || activeSession || !views.home.classList.contains("is-active") || people.people.length < 2) return;
    const list = $("#person-picker-list");
    list.innerHTML = "";
    people.people.forEach((person) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "person-choice";
      button.dataset.personId = person.id;
      button.textContent = person.name;
      if (person.id === people.activeId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => switchPerson(person.id));
      list.appendChild(button);
    });
    dialog.showModal();
    list.querySelector('[aria-current="true"]')?.focus();
  }

  function closePersonPicker() {
    const dialog = $("#person-picker");
    if (dialog.open) dialog.close();
    if (!$("#person-switch").hidden) $("#person-switch").focus({ preventScroll: true });
  }

  // 人を選ぶ画面の矢印：↑←で前、↓→で次の名前（「やめる」まで。端で止まる）
  function movePersonPickerFocus(step) {
    moveFocusAlong([...$$("#person-picker .person-choice"), $("#person-picker-cancel")], step, $('#person-picker [aria-current="true"]'));
  }

  // 人を切り替える：今の人の記録を保存 → 名簿の activeId → 新しい人の記録を読む（読めないときの控えもその人のキーで）→ 描き直す。
  // 「ご家族・運営の方へ」が開いていれば閉じる
  function switchPerson(id) {
    $("#person-picker").close();
    // ほかの画面で名簿が変わっていれば合わせる（選んだ人が消されていれば切り替えない）
    if (syncPeople() && views.home.classList.contains("is-active")) {
      applyTodayPick();
      renderHome();
    }
    const target = people.people.find((person) => person.id === id);
    if (!target || activeSession || !views.home.classList.contains("is-active")) return;
    if (id !== people.activeId) {
      saveState();
      people.activeId = id;
      savePeople();
      if (familyNotesUnlocked) hideFamilyNotes();
      cancelSnooze();
      state = loadState();
      selectedIndex = 0;
      todayPickDay = null;
      const dropped = settleLoadedState();
      applyTodayPick();
      renderHome();
      renderSettings();
      showToast(dropped ? `${target.name}の記録にします。${PROFILE_DROPPED_TEXT}` : `${target.name}の記録にします`);
    }
    $("#person-switch").focus({ preventScroll: true });
  }

  // 読み込んだ人の記録の後始末（起動・切り替え・人を消したあと）：見守りの保留の片付け、読めなかった記録の知らせ、声の用意。
  // 判定の版が変わって体の分析を捨てたなら true（呼ぶ側が一度だけ知らせる）
  const PROFILE_DROPPED_TEXT = "判定を更新したので、体の分析をはじめから覚え直します。";
  function settleLoadedState() {
    try {
      const settled = Logic.settlePendingWatch(state, Date.now());
      if (settled.changed) {
        state = settled.state;
        saveState();
      }
    } catch (error) { /* 見守りが失敗しても続ける */ }
    noteUnreadableStorage();
    prepareVoice();
    // その人を選んでいない間に届いた家族の写真を、写真あそびにする（F2）
    refreshQuestQueue();
    if (!profileDroppedOnLoad) return false;
    profileDroppedOnLoad = false;
    saveState();
    return true;
  }

  // 設定のカード「運動する人」。名前の一覧はいつも見せ、足す・名前を変える・消す・管理用のPINを変えるは管理用のPINを入れている間だけ。
  // さわらないと60秒・開いてから最長5分で閉じる（「ご家族・運営の方へ」と同じ）。キーボードかマウスで使う所（リモコンの矢印では届かない）
  let peopleAdminUnlocked = false;
  let peopleAdminTimer = null;
  let peopleAdminOpenedAt = 0;
  const PERSON_NAME_PROBLEM_TEXT = {
    name: "名前は1〜12字で入れてください。",
    taken: "同じ名前の人がいます。ほかの名前にしてください。",
    limit: `運動する人は${Logic.PEOPLE_LIMIT}人まで登録できます。`,
    missing: "その人は見つかりません。",
    last: "最後の1人は消せません。",
    storage: "保存容量を超えました。音声を短くするか小さいファイルを選んでください。"
  };

  function setPeopleStatus(text) {
    $("#people-status").textContent = text;
  }

  function renderPeople() {
    const list = $("#people-list");
    list.innerHTML = "";
    people.people.forEach((person) => {
      const item = document.createElement("li");
      item.textContent = person.name;
      if (person.id === people.activeId) {
        const mark = document.createElement("span");
        mark.className = "people-current";
        mark.textContent = "いま選んでいる人";
        item.appendChild(mark);
      }
      list.appendChild(item);
    });
    $("#people-admin-form").hidden = peopleAdminUnlocked;
    $("#people-admin").hidden = !peopleAdminUnlocked;
    // 目覚ましは人ごとの設定（D-21）。2人以上のときだけ、そのことを目覚ましのカードに書く
    $("#alarm-person-note").hidden = people.people.length < 2;
    if (!peopleAdminUnlocked) {
      $("#people-rows").innerHTML = "";
      $("#person-add-name").value = "";
      clearPinForm("#admin-pin-change");
      return;
    }
    const full = people.people.length >= Logic.PEOPLE_LIMIT;
    $("#person-add-name").disabled = full;
    $("#person-add-form button[type=submit]").disabled = full;
    // 6人のときは、足せないわけを「人を足す」の下に出す（押せないボタンだけにしない）
    $("#person-add-full").hidden = !full;
    $("#person-add-full").textContent = PERSON_NAME_PROBLEM_TEXT.limit;
    // 管理用のPINがはじめのままなら、変えるように出す（はじめの PIN は README とソースに見えている）
    $("#admin-pin-initial-note").hidden = Boolean(people.adminPin);
    const rows = $("#people-rows");
    const focusedId = document.activeElement?.closest?.(".person-row")?.dataset.personId;
    rows.innerHTML = "";
    people.people.forEach((person) => {
      const row = document.createElement("form");
      row.className = "name-form person-row";
      row.dataset.personId = person.id;
      const label = document.createElement("label");
      label.textContent = "名前";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 12;
      input.autocomplete = "off";
      input.value = person.name;
      input.setAttribute("aria-label", `${person.name}の名前`);
      label.appendChild(input);
      const rename = document.createElement("button");
      rename.type = "submit";
      rename.className = "secondary-button compact";
      rename.textContent = "名前を変える";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger";
      remove.textContent = "消す";
      remove.disabled = people.people.length <= 1;
      remove.setAttribute("aria-label", `${person.name}を消す`);
      remove.addEventListener("click", () => removePersonFromCard(person.id));
      row.addEventListener("submit", (event) => {
        event.preventDefault();
        renamePersonFromCard(person.id, input.value);
      });
      row.append(label, rename, remove);
      rows.appendChild(row);
    });
    if (focusedId) rows.querySelector(`[data-person-id="${focusedId}"] input`)?.focus({ preventScroll: true });
    syncPinFormAvailability("#admin-pin-change");
  }

  async function openPeopleAdmin(event) {
    event.preventDefault();
    const input = $("#people-admin-pin");
    const pin = input.value;
    input.value = "";
    const check = await checkPin(pin, {});
    if (peopleAdminUnlocked) return;
    // 確かめている間に設定の画面を離れたなら開かない（もどったときに開いたままにしない）
    if (!views.settings.classList.contains("is-active")) return;
    if (check !== "ok") {
      showToast(PIN_PROBLEM_TEXT[check]);
      return;
    }
    hideToast();
    peopleAdminUnlocked = true;
    peopleAdminOpenedAt = Date.now();
    setPeopleStatus("");
    renderPeople();
    schedulePeopleAdminHide();
    $("#person-add-name").focus({ preventScroll: true });
  }

  function hidePeopleAdmin() {
    peopleAdminUnlocked = false;
    clearTimeout(peopleAdminTimer);
    peopleAdminTimer = null;
    setPeopleStatus("");
    renderPeople();
  }

  function schedulePeopleAdminHide() {
    clearTimeout(peopleAdminTimer);
    const remaining = peopleAdminOpenedAt + FAMILY_NOTES_MAX_MS - Date.now();
    if (remaining <= 0) {
      hidePeopleAdmin();
      return;
    }
    peopleAdminTimer = setTimeout(hidePeopleAdmin, Math.min(FAMILY_NOTES_IDLE_MS, remaining));
  }

  // 人を足す。新しい人の記録（呼び名は名簿の名前）をその人のキーに作ってから、名簿に入れる
  function addPersonFromCard(event) {
    event.preventDefault();
    if (!peopleAdminUnlocked) return;
    syncPeople();
    const result = Logic.addPerson(people, { name: $("#person-add-name").value, keyInUse: personNumberInUse });
    if (!result.ok) {
      setPeopleStatus(PERSON_NAME_PROBLEM_TEXT[result.reason]);
      return;
    }
    try {
      localStorage.setItem(result.person.storageKey, JSON.stringify({ ...Logic.makeDefaultState(), userName: result.person.name }));
    } catch (error) {
      setPeopleStatus(PERSON_NAME_PROBLEM_TEXT.storage);
      return;
    }
    people = result.people;
    savePeople();
    // 家族のしくみにも、その人の写し（はじめの記録）を送っておく（その人の端末をつなげるように）
    scheduleSnapshot(result.person.id);
    $("#person-add-name").value = "";
    renderPeople();
    renderPersonSwitch();
    setPeopleStatus(`「${result.person.name}」を足しました。運動を選ぶ画面の上の名前のボタンで切り替えられます。`);
  }

  // 名前を変える：名簿と、その人の記録の呼び名（いまの人は state。ほかの人は読むときに名簿の名前にそろう）
  function renamePersonFromCard(id, name) {
    if (!peopleAdminUnlocked) return;
    syncPeople();
    const result = Logic.renamePerson(people, id, name);
    if (!result.ok) {
      setPeopleStatus(PERSON_NAME_PROBLEM_TEXT[result.reason]);
      return;
    }
    people = result.people;
    savePeople();
    if (id === people.activeId) {
      state.userName = result.person.name;
      saveState();
    } else {
      // いま選んでいない人の写しの呼び名も新しくする
      scheduleSnapshot(id);
    }
    renderPeople();
    renderPersonSwitch();
    renderFamilyNotes();
    setPeopleStatus(`名前を「${result.person.name}」にしました。`);
  }

  // 人を消す：赤い「消す」の確かめのあと、その人の記録のキー・読めなかった控え・IndexedDB の写真と声を消す。いまの人なら最初の人を読む
  async function removePersonFromCard(id) {
    const person = people.people.find((item) => item.id === id);
    if (!peopleAdminUnlocked || !person || people.people.length <= 1) return;
    const confirmed = await askDialog({ message: `${person.name}の記録・元気の木・体の分析・アルバム・声をすべて消し、家族の端末の登録も外します。よろしいですか？`, yesLabel: "消す", danger: true });
    if (!confirmed || !peopleAdminUnlocked) return;
    syncPeople();
    const result = Logic.removePerson(people, id);
    if (!result.ok) {
      setPeopleStatus(PERSON_NAME_PROBLEM_TEXT[result.reason]);
      return;
    }
    const wasActive = people.activeId === id;
    if (wasActive && familyNotesUnlocked) hideFamilyNotes();
    try {
      localStorage.removeItem(person.storageKey);
      localStorage.removeItem(`${person.storageKey}.unreadable`);
    } catch (error) { /* 消せなくても名簿からは外す */ }
    MediaStore?.deletePerson(id).catch(() => {});
    pinGates.delete(`person:${id}`);
    rememberFamilyRemoval(id);
    snapshotSenders.delete(id);
    people = result.people;
    savePeople();
    if (wasActive) {
      cancelSnooze();
      state = loadState();
      selectedIndex = 0;
      todayPickDay = null;
      settleLoadedState();
    }
    renderSettings();
    renderPersonSwitch();
    setPeopleStatus(`「${person.name}」を消しました。`);
  }

  function renderSettings() {
    $("#voice-consent").checked = Boolean(state.voice?.consent || state.voices.some((voice) => voice.consent));
    renderVoices();
    $("#alarm-time").value = state.alarm.time;
    $("#alarm-volume").value = state.alarm.volume;
    $("#volume-output").textContent = `${state.alarm.volume}%`;
    $("#alarm-enabled").checked = state.alarm.enabled;
    $("#rep-sound-enabled").checked = state.repSound !== false;
    renderWeekdays();
    renderThresholds();
    renderIdeas();
    renderFamilyNotes();
    renderPeople();
    renderSnooze();
    $("#admin-camera-status").textContent = cameraPaused() ? "カメラは管理者設定で一時停止中です。" : "カメラは利用できます。";
    $("#admin-camera-toggle").textContent = cameraPaused() ? "カメラを再開" : "カメラを一時停止";
    $("#admin-camera-toggle").classList.toggle("is-paused", cameraPaused());
    renderAdminOptions();
  }

  function renderWeekdays() {
    const labels = ["日", "月", "火", "水", "木", "金", "土"];
    $("#weekday-options").innerHTML = labels.map((label, index) => `<label class="weekday-option"><input type="checkbox" value="${index}" ${state.alarm.weekdays.includes(index) ? "checked" : ""}><span>${label}</span></label>`).join("");
  }

  function renderThresholds() {
    $("#threshold-settings").innerHTML = state.exercises.map((exercise) => `<div class="threshold-row"><label for="threshold-${exercise.id}">${exercise.name}</label><input id="threshold-${exercise.id}" data-threshold-id="${exercise.id}" type="number" min="1" max="50" value="${exercise.clearThreshold}" aria-label="${exercise.name}のクリア基準回数"></div>`).join("");
  }

  function renderIdeas() {
    const list = $("#idea-list");
    if (!state.ideas.length) {
      list.innerHTML = "<li>アイデアはまだありません。</li>";
      return;
    }
    list.innerHTML = state.ideas.map((idea, index) => `<li><span>${escapeHtml(idea)}</span><button type="button" data-remove-idea="${index}" aria-label="${escapeHtml(idea)}を削除">削除</button></li>`).join("");
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  let renamingVoiceId = null;  // 名前を変えている声（一覧のその行を入力欄にする）
  // 家族の声の一覧（いま選んでいる人の分。8つまで）。1つを「使う声」に選ぶと、運動の途中・終わり・目覚ましで鳴らす。
  // 「声を使わない」を選ぶと、声の代わりに文を読み上げる。消すのは確かめてから（IndexedDB の中身も消す）
  function renderVoices() {
    const status = !state.voices.length ? "音声はまだ登録されていません。"
      : state.voice ? `使う声：${state.voice.name}` : "声は使いません（文を読み上げます）。";
    $("#voice-status").textContent = status;
    $("#play-voice").disabled = !state.voice;
    const list = $("#voice-list");
    list.hidden = !state.voices.length;
    list.innerHTML = state.voices.map((voice) => {
      const chosen = state.voiceId === voice.id;
      if (renamingVoiceId === voice.id) {
        return `<li class="voice-row${chosen ? " is-chosen" : ""}"><form class="voice-rename" data-voice-rename-form="${voice.id}">`
          + `<input type="text" aria-label="声の名前" maxlength="${Logic.VOICE_NAME_LIMIT}" value="${escapeHtml(voice.name || "")}" autocomplete="off">`
          + `<button type="submit" class="text-button">保存</button><button type="button" class="text-button" data-voice-rename-cancel="">やめる</button></form></li>`;
      }
      return `<li class="voice-row${chosen ? " is-chosen" : ""}"><span class="voice-name">${escapeHtml(voice.name || "名前のない声")}${chosen ? "<small>使う声</small>" : ""}</span>`
        + `<span class="voice-row-actions"><button type="button" class="text-button" data-voice-use="${voice.id}" aria-pressed="${chosen}">${chosen ? "使っています" : "この声を使う"}</button>`
        + `<button type="button" class="text-button" data-voice-rename="${voice.id}">名前を変える</button>`
        + `<button type="button" class="text-button" data-voice-play="${voice.id}">試聴</button>`
        + `<button type="button" class="text-button danger" data-voice-delete="${voice.id}">消す</button></span></li>`;
    }).join("") + (state.voices.length ? `<li class="voice-row${state.voice ? "" : " is-chosen"}"><span class="voice-name">声を使わない${state.voice ? "" : "<small>えらんでいます</small>"}</span>`
      + `<span class="voice-row-actions"><button type="button" class="text-button" data-voice-use="" aria-pressed="${!state.voice}">${state.voice ? "声を使わない" : "えらんでいます"}</button></span></li>` : "");
  }

  // 家族の声は、いま選んでいる人の分として IndexedDB に置く（D-17）。IndexedDB に書けないときは今までどおり記録の中（dataUrl）。
  // 足した声を「使う声」にする（前の声は一覧に残る）
  async function storeVoiceBlob(blob, name) {
    if (!$("#voice-consent").checked) {
      showToast("先に音声利用の同意を確認してください。");
      return;
    }
    if (blob.size > 1_500_000) {
      showToast("音声が大きすぎます。約1.5MB以下の短い音声を選んでください。");
      return;
    }
    const personId = people.activeId;
    const savedAt = new Date().toISOString();
    const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let stored = false;
    try {
      stored = Boolean(MediaStore) && await MediaStore.putVoice(personId, { id, name, blob, savedAt });
    } catch (error) { stored = false; }
    const dataUrl = stored ? null : await readFileAsDataUrl(blob);
    // 書いている間に人を切り替えた：前の人の記録には入れない（書いた声は消す）
    if (people.activeId !== personId) {
      if (stored) MediaStore.deleteVoice(personId, id).catch(() => {});
      return;
    }
    // IndexedDB に書けない PC では、記録（localStorage）があふれないよう、記録の中の声は1つだけにする（前の記録の中の声は外す）
    if (!stored) state.voices.filter((voice) => voice.dataUrl).forEach((voice) => { state = Logic.removeVoice(state, voice.id); });
    const added = Logic.addVoice(state, stored ? { id, name, ref: "idb", consent: true, savedAt } : { id, name, dataUrl, consent: true, savedAt });
    state = added.state;
    added.removed.forEach((voice) => { if (voice.ref === "idb") MediaStore?.deleteVoice(personId, voice.id).catch(() => {}); });
    if (stored) useVoiceBlob(personId, id, blob);
    else releaseVoiceUrl();
    saveState();
    renderSettings();
    showToast(added.removed.length ? `家族音声をこのPCに保存しました。${VOICE_FULL_TEXT}` : "家族音声をこのPCに保存しました。");
  }
  const VOICE_FULL_TEXT = `声は${Logic.VOICE_LIMIT}つまでなので、いちばん古い声を外しました。`;

  // 一覧の声を使う声にする（id が空なら声を使わない）
  function chooseVoice(id) {
    state = Logic.selectVoice(state, id || null);
    saveState();
    prepareVoice();
    renderSettings();
    showToast(state.voice ? `「${state.voice.name}」を使います。` : "声は使わず、文を読み上げます。");
  }

  // 一覧の声を試聴する（記録の中の声はそのまま、IndexedDB の声は読み出して鳴らす）
  async function playListedVoice(id) {
    const voice = state.voices.find((item) => item.id === id);
    if (!voice) return;
    try {
      let url = voice.dataUrl || null;
      let temporary = false;
      if (!url && voice.ref === "idb") {
        const saved = await MediaStore.getVoice(people.activeId, voice.id);
        if (!saved?.blob) throw new Error("no voice");
        url = URL.createObjectURL(saved.blob);
        temporary = true;
      }
      const audio = new Audio(url);
      if (temporary) audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch (error) {
      showToast("音声を再生できませんでした。");
    }
  }

  // 一覧の声を消す（確かめてから）。使う声を消したら、声は使わない（ほかの声を勝手に鳴らさない）
  async function deleteListedVoice(id) {
    const voice = state.voices.find((item) => item.id === id);
    if (!voice) return;
    const personId = people.activeId;
    if (!(await askDialog({ message: `「${voice.name || "名前のない声"}」を消しますか？\n消した声はもどせません。`, yesLabel: "消す", danger: true }))) return;
    if (people.activeId !== personId || !state.voices.some((item) => item.id === id)) return;
    const wasChosen = state.voiceId === id;
    state = Logic.removeVoice(state, id);
    if (voice.ref === "idb") MediaStore?.deleteVoice(personId, id).catch(() => {});
    if (wasChosen) releaseVoiceUrl();
    saveState();
    renderSettings();
    showToast(wasChosen ? "声を消しました。ほかの声を使うときは「この声を使う」を押してください。" : "声を消しました。");
  }

  // 家族の声の鳴らし方（いま選んでいる人の使う声だけ1つ持つ）。記録の中の dataUrl ならそのまま、IndexedDB（ref: "idb"）なら読んで object URL にする。
  // 人・使う声を切り替えたら捨てる。IndexedDB から読めないときは null（声の代わりに文を読み上げる）
  let voiceSource = { personId: null, id: null, url: null };
  function voiceUrl() {
    if (state.voice?.dataUrl) return state.voice.dataUrl;
    return state.voice?.ref === "idb" && voiceSource.personId === people.activeId && voiceSource.id === state.voice.id ? voiceSource.url : null;
  }
  function releaseVoiceUrl() {
    if (voiceSource.url) URL.revokeObjectURL(voiceSource.url);
    voiceSource = { personId: null, id: null, url: null };
  }
  function useVoiceBlob(personId, id, blob) {
    releaseVoiceUrl();
    voiceSource = { personId, id, url: URL.createObjectURL(blob) };
  }
  // 読み込んだ人の使う声を用意する。記録の中に dataUrl の声があれば IndexedDB へ移し、読み直して大きさが合ったら記録から dataUrl を消す（D-17）。
  // 書けない・合わないときは今のまま（dataUrl で鳴らす）
  async function prepareVoice() {
    releaseVoiceUrl();
    const personId = people.activeId;
    const voice = state.voice;
    if (!MediaStore || !voice) return;
    try {
      if (voice.dataUrl) {
        const blob = await (await fetch(voice.dataUrl)).blob();
        if (!(await MediaStore.putVoice(personId, { id: voice.id, name: voice.name, blob, savedAt: voice.savedAt }))) return;
        // 移している間に人を切り替えた・声を入れかえた
        if (people.activeId !== personId || state.voice !== voice) return;
        const moved = { id: voice.id, name: voice.name, consent: voice.consent, savedAt: voice.savedAt, ref: "idb" };
        state = { ...state, voices: state.voices.map((item) => (item.id === voice.id ? moved : item)), voice: moved };
        saveState();
        useVoiceBlob(personId, voice.id, blob);
        return;
      }
      const saved = await MediaStore.getVoice(personId, voice.id);
      if (saved?.blob && people.activeId === personId && state.voice === voice) useVoiceBlob(personId, voice.id, saved.blob);
    } catch (error) { /* IndexedDB が使えない：dataUrl の声はそのまま鳴る。ref: "idb" の声は文の読み上げになる */ }
  }

  async function startRecording() {
    if (!$("#voice-consent").checked) {
      showToast("先に音声利用の同意を確認してください。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
      showToast("このブラウザでは録音できません。音声ファイルを選んでください。");
      return;
    }
    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(recordingStream);
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordedChunks.push(event.data); };
      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        recordingStream.getTracks().forEach((track) => track.stop());
        recordingStream = null;
        await storeVoiceBlob(blob, `録音-${new Date().toLocaleString("ja-JP")}.webm`);
      };
      mediaRecorder.start();
      $("#record-voice").disabled = true;
      $("#stop-recording").disabled = false;
      $("#voice-status").textContent = "録音中です。短い応援メッセージを話してください。";
    } catch (error) {
      showToast("マイクを開始できませんでした。ブラウザの許可を確認してください。");
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    $("#record-voice").disabled = false;
    $("#stop-recording").disabled = true;
  }

  function saveAlarmSettings() {
    state.alarm.time = $("#alarm-time").value || "07:30";
    state.alarm.volume = Number($("#alarm-volume").value);
    state.alarm.enabled = $("#alarm-enabled").checked;
    state.alarm.weekdays = $$("#weekday-options input:checked").map((input) => Number(input.value));
    saveState();
  }

  function playAlarm() {
    const voice = voiceUrl();
    if (voice) {
      const audio = new Audio(voice);
      audio.volume = state.alarm.volume / 100;
      audio.play().catch(() => speakText("おはようございます。今日も元気にいきましょう。"));
    } else {
      speakText("おはようございます。今日も元気にいきましょう。");
    }
    showToast("目覚ましを再生しました。停止はブラウザの音声操作から行えます。");
  }

  function renderSnooze() {
    $("#snooze-status").hidden = !snoozeTimer;
    $("#snooze-text").textContent = snoozeUntil ? `${snoozeUntil.getHours()}:${String(snoozeUntil.getMinutes()).padStart(2, "0")} にもう一度鳴ります` : "";
  }
  function startSnooze() {
    clearTimeout(snoozeTimer);
    snoozeUntil = new Date(Date.now() + 5 * 60 * 1000);
    snoozeTimer = setTimeout(() => {
      snoozeTimer = null;
      snoozeUntil = null;
      renderSnooze();
      playAlarm();
    }, 5 * 60 * 1000);
    renderSnooze();
  }
  function cancelSnooze() {
    clearTimeout(snoozeTimer);
    snoozeTimer = null;
    snoozeUntil = null;
    renderSnooze();
  }

  function checkAlarm() {
    if (!state.alarm.enabled) return;
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const key = `${Logic.localDateKey(now)}-${time}`;
    if (state.alarm.weekdays.includes(now.getDay()) && time === state.alarm.time && lastAlarmKey !== key) {
      lastAlarmKey = key;
      playAlarm();
    }
  }

  function saveThresholds() {
    $$("[data-threshold-id]").forEach((input) => {
      const exercise = Logic.getExercise(state, input.dataset.thresholdId);
      exercise.clearThreshold = Math.max(1, Math.min(50, Number(input.value) || exercise.clearThreshold));
      if (!exercise.cleared) exercise.userGoal = exercise.clearThreshold;
    });
    saveState();
    renderSettings();
    showToast("クリア基準回数を保存しました。次の運動から使います。");
  }

  function bindEvents() {
    $$("[data-entry]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.entry)));
    $$(".nav-button").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    // 運動中はロゴを押しても運動を終わらせない（キーボードで選んだときも）
    $$("[data-nav]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); if (activeSession) return; navigate(link.dataset.nav); }));
    $("#previous-exercise").addEventListener("click", () => changeSelection(-1, $("#previous-exercise")));
    $("#next-exercise").addEventListener("click", () => changeSelection(1, $("#next-exercise")));
    $("#start-exercise").addEventListener("click", beginSession);
    $("#intro-next").addEventListener("click", advanceIntro);
    $("#intro-skip").addEventListener("click", () => closeIntro(true));
    $("#replay-intro").addEventListener("click", () => {
      // 3枚目の音を鳴らせるよう、押した操作の中で音を用意する
      try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); } catch { audioContext = null; }
      showIntro(true);
    });
    $("#start-daily-quest").addEventListener("click", startDailyQuest);
    $("#play-arrival").addEventListener("click", playArrival);
    $("#back-from-quest").addEventListener("click", () => navigate("home"));
    $("#quest-demo-swipe").addEventListener("click", demoQuestSwipe);
    $("#quest-view-album").addEventListener("click", showQuestAlbum);
    const questOverlay = $("#quest-photo-overlay");
    questOverlay.addEventListener("pointerdown", (event) => {
      questPointerActive = true;
      questOverlay.setPointerCapture?.(event.pointerId);
      wipeQuestFromPointer(event);
    });
    questOverlay.addEventListener("pointermove", (event) => { if (questPointerActive) wipeQuestFromPointer(event); });
    ["pointerup", "pointercancel"].forEach((eventName) => questOverlay.addEventListener(eventName, () => { questPointerActive = false; }));
    $("#selected-exercise").addEventListener("click", (event) => {
      if (event.target.dataset.goal === "down") updateGoal(-1);
      if (event.target.dataset.goal === "up") updateGoal(1);
    });
    // もどる：まだ1回も数えていなければ運動選択へ。数えた回数があれば「ここで終わる」と同じく記録を残して結果を出す（黙って消さない）
    $("#back-home").addEventListener("click", () => {
      if (!activeSession) return;
      if (activeSession.count > 0) {
        if (!finishing) finishSession(false);
        return;
      }
      cleanupSession();
      activeSession = null;
      navigate("home");
    });
    // 「カメラなしで1回」：カメラが使えないとき（と ?debug=1）だけ。見えないボタンを押しても数えない
    $("#demo-rep").addEventListener("click", () => { if (demoInputAllowed()) registerRep("demo"); });
    $("#camera-retry").addEventListener("click", retryCamera);
    $("#camera-view").addEventListener("click", nextCameraView);
    $("#pause-session").addEventListener("click", togglePause);
    $("#finish-session").addEventListener("click", () => finishSession(false));
    $("#go-dashboard").addEventListener("click", () => navigate("dashboard"));
    $("#unlock-try").addEventListener("click", showUnlockedExercise);
    $("#return-home").addEventListener("click", () => navigate("home"));
    $$("#dashboard-exercise, #dashboard-exercise-bottom").forEach((button) => button.addEventListener("click", () => navigate("home")));
    $("#record-voice").addEventListener("click", startRecording);
    $("#stop-recording").addEventListener("click", stopRecording);
    $("#voice-upload").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (file) await storeVoiceBlob(file, file.name);
      event.target.value = "";
    });
    $("#voice-list").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.voiceUse !== undefined) chooseVoice(button.dataset.voiceUse);
      else if (button.dataset.voicePlay) playListedVoice(button.dataset.voicePlay);
      else if (button.dataset.voiceDelete) deleteListedVoice(button.dataset.voiceDelete);
      else if (button.dataset.voiceRename) {
        renamingVoiceId = button.dataset.voiceRename;
        renderVoices();
        $("#voice-list .voice-rename input")?.focus();
      } else if (button.dataset.voiceRenameCancel !== undefined) {
        renamingVoiceId = null;
        renderVoices();
      }
    });
    // 体験版：「設定・運営」は出さない（設定は一切変えられない）
    if (trialMode) document.querySelectorAll('.nav-button[data-view="settings"]').forEach((button) => { button.hidden = true; });
    document.querySelectorAll("[data-feedback-open]").forEach((button) => {
      button.hidden = !familyClient && !trialMode;
      button.addEventListener("click", openFeedback);
    });
    document.querySelectorAll("[data-feedback-kind]").forEach((button) => button.addEventListener("click", () => chooseFeedbackKind(button.dataset.feedbackKind)));
    $("#feedback-send").addEventListener("click", sendFeedback);
    $("#feedback-cancel").addEventListener("click", () => $("#feedback-dialog").close());
    $("#voice-list").addEventListener("submit", (event) => {
      const form = event.target.closest("[data-voice-rename-form]");
      if (!form) return;
      event.preventDefault();
      const id = form.dataset.voiceRenameForm;
      const name = form.querySelector("input").value.trim();
      if (!name) {
        showToast("名前を入れてください。");
        return;
      }
      state = Logic.renameVoice(state, id, name);
      renamingVoiceId = null;
      saveState();
      renderSettings();
      showToast("声の名前を変えました。");
    });
    $("#play-voice").addEventListener("click", () => {
      const voice = voiceUrl();
      if (voice) new Audio(voice).play().catch(() => showToast("音声を再生できませんでした。"));
      else if (state.voice) showToast("音声を再生できませんでした。");
    });
    $("#alarm-time").addEventListener("change", saveAlarmSettings);
    $("#alarm-volume").addEventListener("input", () => { $("#volume-output").textContent = `${$("#alarm-volume").value}%`; saveAlarmSettings(); });
    $("#alarm-enabled").addEventListener("change", () => { saveAlarmSettings(); showToast($("#alarm-enabled").checked ? "目覚ましを有効にしました。" : "目覚ましを無効にしました。"); });
    $("#rep-sound-enabled").addEventListener("change", () => {
      state.repSound = $("#rep-sound-enabled").checked;
      saveState();
      showToast(state.repSound ? "1回ごとに音で知らせます。" : "1回ごとの音を止めました。");
    });
    $("#weekday-options").addEventListener("change", saveAlarmSettings);
    $("#test-alarm").addEventListener("click", playAlarm);
    $("#snooze-alarm").addEventListener("click", startSnooze);
    $("#snooze-cancel").addEventListener("click", cancelSnooze);
    $("#save-thresholds").addEventListener("click", saveThresholds);
    $("#admin-camera-toggle").addEventListener("click", toggleAdminCamera);
    $$("[data-admin-option]").forEach((input) => input.addEventListener("change", () => changeAdminOption(input)));
    // ほかの画面で運営の設定を変えた
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== Logic.ADMIN_OPTIONS_KEY) return;
      adminOptions = loadAdminOptions();
      if (views.settings.classList.contains("is-active")) renderAdminOptions();
      adminOptionsChanged();
    });
    $("#family-notes-form").addEventListener("submit", openFamilyNotes);
    $("#family-notes-close").addEventListener("click", hideFamilyNotes);
    $("#camera-check-open").addEventListener("click", openCameraCheck);
    $("#camera-check-close").addEventListener("click", closeCameraCheck);
    // Esc で閉じたとき（ブラウザが閉じる）も、カメラを止める
    $("#camera-check").addEventListener("close", closeCameraCheck);
    $("#user-name-form").addEventListener("submit", saveUserName);
    $("#pin-change").addEventListener("submit", changePersonPin);
    $("#family-pair").addEventListener("click", startFamilyPairing);
    $("#family-device-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-device-id]");
      if (button) removeFamilyDevice(button.dataset.deviceId);
    });
    // 開いている間にさわっていれば、隠れるまでの時間を延ばす（開いてから最長5分）。開くことはしない
    const familyCard = $(".family-notes-card");
    ["pointermove", "pointerdown", "keydown", "input"].forEach((name) => familyCard.addEventListener(name, () => { if (familyNotesUnlocked) scheduleFamilyNotesHide(); }));
    ["wheel", "scroll"].forEach((name) => familyCard.addEventListener(name, () => { if (familyNotesUnlocked) scheduleFamilyNotesHide(); }, { capture: true, passive: true }));
    // 運動する人（名前のボタン・人を選ぶ画面・設定のカード）
    $("#person-switch").addEventListener("click", openPersonPicker);
    $("#person-picker-cancel").addEventListener("click", closePersonPicker);
    const picker = $("#person-picker");
    picker.addEventListener("cancel", (event) => { event.preventDefault(); closePersonPicker(); });
    picker.addEventListener("keydown", (event) => {
      if (!ARROW_STEPS[event.key]) return;
      event.preventDefault();
      movePersonPickerFocus(ARROW_STEPS[event.key]);
    });
    $("#people-admin-form").addEventListener("submit", openPeopleAdmin);
    // 同じテレビの画面をほかにも開いていて、そちらで名簿が変わったとき
    window.addEventListener("storage", onPeopleChangedElsewhere);
    $("#people-admin-close").addEventListener("click", hidePeopleAdmin);
    $("#person-add-form").addEventListener("submit", addPersonFromCard);
    $("#admin-pin-change").addEventListener("submit", changeAdminPin);
    const peopleCard = $(".people-card");
    ["pointermove", "pointerdown", "keydown", "input"].forEach((name) => peopleCard.addEventListener(name, () => { if (peopleAdminUnlocked) schedulePeopleAdminHide(); }));
    // 大きな確認画面
    const dialog = $("#tv-dialog");
    $("#tv-dialog-yes").addEventListener("click", () => answerDialog(true));
    $("#tv-dialog-no").addEventListener("click", () => answerDialog(false));
    $("#tv-dialog-pin").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); answerDialog(true); } });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); answerDialog(false); });
    dialog.addEventListener("close", () => { if (dialogSettle) dialogSettle(false); });
    $("#idea-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#idea-input");
      const value = input.value.trim();
      if (!value) return;
      state.ideas.unshift(value);
      state.ideas = state.ideas.slice(0, 30);
      input.value = "";
      saveState();
      renderIdeas();
    });
    $("#idea-list").addEventListener("click", (event) => {
      const index = event.target.dataset.removeIdea;
      if (index === undefined) return;
      state.ideas.splice(Number(index), 1);
      saveState();
      renderIdeas();
    });
    $("#reset-profile").addEventListener("click", async () => {
      if (!(await askDialog({ message: "体の分析を、最初からやり直しますか？\n運動の記録と植物は残ります。", yesLabel: "やり直す", danger: true }))) return;
      state.bodyProfile = null;
      saveState();
      showToast("体の分析をやり直します。次の足踏みから覚え直します。");
    });
    // 「試作データを初期化」：いま選んでいる人の記録・声・写真だけを消す。名前・名簿の項目・PIN は残す
    $("#reset-data").addEventListener("click", async () => {
      const person = activePerson();
      if (!(await askDialog({ message: `${person.name}の運動の記録・設定・音声・写真を、すべて消しますか？`, yesLabel: "すべて消す", danger: true }))) return;
      if (people.activeId !== person.id) return;
      state = Logic.makeDefaultState();
      // 呼び名は名簿の名前のまま（名簿の名前と記録の呼び名をずらさない）
      state.userName = person.name;
      releaseVoiceUrl();
      MediaStore?.deletePerson(person.id).catch(() => {});
      memoryPhotos.forEach((item, photoId) => { if (item.personId === person.id) memoryPhotos.delete(photoId); });
      selectedIndex = 0;
      todayPickDay = null;
      // テレビ全体の印（使い方を見たか・見せ方）は、運動する人が1人のときだけ今どおり消す（2人以上なら、ほかの人の分でもある）。
      // 見せ方は既定（映像と線）にもどす。カメラの一時停止（PIN で決めるテレビ全体の設定）は変えない
      if (people.people.length === 1) {
        introSeenHere = false;
        try { localStorage.removeItem(INTRO_KEY); } catch { /* 消せなくても初期化は続ける */ }
        cameraView = "both";
        try { localStorage.removeItem(CAMERA_VIEW_KEY); } catch { /* 消せなくても初期化は続ける */ }
      }
      cancelSnooze();
      saveState();
      renderSettings();
      showToast("試作データを初期化しました。");
    });
    window.addEventListener("resize", () => {
      if (views.home.classList.contains("is-active")) renderHome();
      if (views.dashboard.classList.contains("is-active")) renderChart();
      if (views.session.classList.contains("is-active")) resizeOverlay();
    });
    window.addEventListener("beforeunload", () => { cleanupSession(); cleanupQuestCamera(); });
    document.addEventListener("keydown", (event) => {
      // 確認画面・カメラの映り方の確認・人を選ぶ画面が出ている間は、うしろの画面のキー操作（運動の開始など）をしない
      if ($("#tv-dialog").open || $("#camera-check").open || $("#person-picker").open || $("#feedback-dialog").open) return;
      const focused = document.activeElement?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(focused)) return;
      // ボタンやリンクを選んでいるときの決定キー（Enter・Space）は、そのボタンの役目だけにする（リモコンの決定で別の操作をしない）
      const onControl = ["BUTTON", "A"].includes(focused);
      // 運動中の使い方は映像の上だけに出るので、上の帯（もどる・見え方・一時停止・ここで終わる）は見えている。↑ でそこへ行き、帯の中は ←→、↓ で使い方へ戻る
      if (sessionIntroOpen() && ARROW_STEPS[event.key]) {
        const onTopRow = usableButtons(SESSION_TOP_ROW).includes(document.activeElement);
        if (event.key === "ArrowUp" || onTopRow) {
          event.preventDefault();
          if (event.key === "ArrowDown") $("#intro-next").focus({ preventScroll: true });
          else if (!onTopRow) $("#pause-session").focus({ preventScroll: true });
          else if (event.key !== "ArrowUp") moveFocusAlong(usableButtons(SESSION_TOP_ROW), ARROW_STEPS[event.key], $("#pause-session"));
          return;
        }
      }
      // 使い方が出ている間：← で「とばす」を選ぶ。→ は「次へ」を選び、「次へ」を選んでいれば次のカード。Enter はいま選んでいるボタン
      // （ボタン以外なら次へ）、Esc でとばす。うしろの画面のキー操作（運動の選択・開始）はしない
      if (introOpen()) {
        if (event.key === "ArrowLeft") { event.preventDefault(); $("#intro-skip").focus({ preventScroll: true }); }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          if (document.activeElement === $("#intro-next")) advanceIntro();
          else $("#intro-next").focus({ preventScroll: true });
        }
        if (event.key === "Enter" && !onControl) { event.preventDefault(); advanceIntro(); }
        if (event.key === "Escape") closeIntro(true);
        return;
      }
      if (views.home.classList.contains("is-active")) {
        if (event.key === "ArrowLeft") changeSelection(-1);
        if (event.key === "ArrowRight") changeSelection(1);
        if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveHomeFocus(event.key === "ArrowUp" ? -1 : 1); }
        if (event.key === "Enter" && !onControl) beginSession();
      }
      // 運動中：矢印キーで、見えているボタン（もどる・見え方・一時停止・ここで終わる・もう一度ためす・カメラなしで1回）を順に選ぶ
      if (views.session.classList.contains("is-active") && ARROW_STEPS[event.key]) {
        event.preventDefault();
        moveSessionFocus(ARROW_STEPS[event.key]);
      }
      // Space で「カメラなしで1回」：そのボタンが出ているときだけ
      if (views.session.classList.contains("is-active") && event.code === "Space" && !onControl && demoInputAllowed()) {
        event.preventDefault();
        registerRep("demo");
      }
    });
  }

  function init() {
    // 元気の木の骨組み（家族ダッシュボードと結果の画面。plant-view.js が作る。描き方は家族のページと同じ）
    PlantView.buildPlantSvg($("#plant-svg"), { gradientId: "leafGradient", glowId: "leafGlow", partIds: { stem: "plant-stem", leaves: "plant-leaves", flower: "plant-flower" } });
    PlantView.buildPlantSvg($("#result-plant"), { gradientId: "resultLeafGradient", glowId: "resultLeafGlow", growth: true, ground: PlantView.GROUND.result });
    bindEvents();
    $("#family-readouts").hidden = !debugMode;
    syncDemoButton();
    // 写真の「デモでふき取る」も開発・ご家族の確認用（?debug=1）だけ。距離の目安（約1.5m など）も同じ
    $("#quest-demo-swipe").hidden = !debugMode;
    document.body.classList.toggle("is-debug", debugMode);
    // 自動テスト用（?testPose=1 のときだけ）：お手本の絵を運動ごとに描いて比べる
    if (testPoseMode) window.__motionLinkTestHooks = { drawDemoStickman, drawPose, demoIds: Object.keys(DEMO_DRAWINGS),
      demoPose: () => ({ mode: demoPose.mode, progress: demoPose.progress, side: demoPose.side }), prompts: PROMPTS_BY_EXERCISE, stepMark, textForPerson, feedbackForPerson, forbiddenForPerson: FORBIDDEN_FOR_PERSON, pushyForPerson: PUSHY_FOR_PERSON };
    // 家族への見守り（保留にしたひざ上げの印が3日たっても次の運動がなければ、家族向けの翌朝サマリーにひと言）・読めなかった記録・声の用意
    const dropped = settleLoadedState();
    renderHome();
    renderSettings();
    if (dropped) showToast(PROFILE_DROPPED_TEXT);
    alarmCheckTimer = setInterval(checkAlarm, 15000);
    checkAlarm();
    renderFamilyTexts();
    startFamilySync();
  }

  init();
})();
