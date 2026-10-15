(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MotionLinkLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "motion-link-prototype-v1";
  const ALGORITHM_VERSION = "pose-counter-2026.10.5";
  // 回数の入力元。pose と rgbd だけが実績（解放・植物・家族通知）に数える対象。
  const INPUT_SOURCES = {
    pose: { label: "骨格AI（RGB）", countsTowardProgress: true },
    rgbd: { label: "深度カメラ（RGB-D）", countsTowardProgress: true },
    mock: { label: "模擬センサー", countsTowardProgress: false },
    fallback: { label: "簡易判定（画像差分）", countsTowardProgress: false },
    demo: { label: "デモ入力", countsTowardProgress: false },
    mixed: { label: "混在（デモ・簡易を含む）", countsTowardProgress: false },
    legacy: { label: "旧記録", countsTowardProgress: true }
  };
  // ブラウザのカメラで体の動きを読むためのファイル（大きいので git に入れない。DEPENDENCIES.txt・start.ps1 と同じもの）。
  // 読み込みに失敗したとき、これがそろっているかで、練習の記録になったわけを分ける（app.js）
  const POSE_ASSET_FILES = [
    "assets/mediapipe/wasm/vision_wasm_internal.wasm",
    "assets/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
    "assets/mediapipe/pose_landmarker_full.task",
    "assets/mediapipe/pose_landmarker_heavy.task"
  ];
  // 練習の記録になったわけ（記録の practice_reason）。ご家族の欄（管理者PINの先）だけに出す。本人の画面は「練習」とだけ言う
  const PRACTICE_REASONS = {
    "files-missing": "体の動きを読む仕組みのファイルが足りなかったため、動きの大きさで数えました。",
    "engine-failed": "体の動きを読む仕組みがうまく動かなかったため、動きの大きさで数えました。",
    "engine-late": "体の動きを読む仕組みの準備が間に合わず、そのあいだは動きの大きさで数えました。",
    mock: "ためしのカメラ（端末サービスの模擬）で数えました。",
    demo: "「カメラなしで1回」のボタン（Space キー）で数えました。"
  };

  // 運動の一覧。並び（配列の順）がそのまま解放の順（前の運動を初めてクリアすると次が選べる）。座ってする足の運動を先に、次に座ってする上半身の運動、
  // 立ってする運動（standing）は最後（外に出られない人の運動不足・フレイル・寝たきりを防ぐ、座ったままの足の運動が目玉。よしさん 2026-10-11）。
  // 立ってする運動は、運営の設定「立ってする運動も出す」のときだけ選ぶ画面に出す（app.js）
  // 名前・説明・難しさ・順番はいつもこの表から出す（保存した記録の古い文は使わない。hydrateState）
  const EXERCISES = [
    { id: "chair-march", name: "座って足踏み", shortName: "足踏み", difficulty: 1, icon: "🪑", description: "椅子に座り、左右の足を交互にゆっくり上げます。", demoInstruction: "椅子に座ったまま、左右のひざを交互に上げます。", demoDetail: "背中をまっすぐにして、無理のない高さで動きます。", clearThreshold: 5, order: 1, standing: false },
    { id: "knee-open-close", name: "座ってひざの開閉", shortName: "ひざの開閉", difficulty: 1, icon: "👖", description: "椅子に座り、両ひざをゆっくり開いて、閉じます。", demoInstruction: "座ったまま、両ひざを外へ開いて、もどします。", demoDetail: "足の裏は床につけたまま、痛くない広さで動きます。", clearThreshold: 6, order: 2, standing: false },
    { id: "seated-heel-raise", name: "座ってかかと上げ", shortName: "座ってかかと", difficulty: 2, icon: "🦶", description: "椅子に座り、両足のかかとをゆっくり上げて、下ろします。", demoInstruction: "座ったまま、つま先を床につけて、両方のかかとを上げます。", demoDetail: "つま先は床につけたまま、ゆっくり動きます。", clearThreshold: 6, order: 3, standing: false },
    { id: "knee-extend", name: "ひざ伸ばし", shortName: "ひざ伸ばし", difficulty: 3, icon: "🦵", description: "椅子に座ったまま、片脚ずつ前へ伸ばします。", demoInstruction: "椅子に座り、片脚ずつ前へゆっくり伸ばします。", demoDetail: "ひざを伸ばしたところで、一度止めて戻します。", clearThreshold: 8, order: 4, standing: false },
    { id: "seated-leg-out", name: "座って足を横へ", shortName: "足を横へ", difficulty: 2, icon: "🦶", description: "椅子に座り、片足ずつ、足を横へ出して、もどします。", demoInstruction: "座ったまま、片足を床の上で横へすべらせて、もどします。", demoDetail: "足の裏は床につけたまま、痛くない広さで動きます。", clearThreshold: 8, order: 5, standing: false },
    { id: "shoulder-shrug", name: "肩の上げ下げ", shortName: "肩の上げ下げ", difficulty: 1, icon: "🙆", description: "椅子に座り、両肩をゆっくり上げて、すとんと下ろします。", demoInstruction: "座ったまま、両肩を耳の方へ上げて、もどします。", demoDetail: "頭と腰は動かさず、息を止めずに動きます。", clearThreshold: 6, order: 6, standing: false },
    { id: "arm-raise", name: "ゆっくり腕上げ", shortName: "腕上げ", difficulty: 2, icon: "🙌", description: "呼吸を止めず、両腕を無理のない高さまで上げます。", demoInstruction: "両腕を体の横から、ゆっくり上げ下げします。", demoDetail: "肩に痛みが出ない高さまでで大丈夫です。", clearThreshold: 6, order: 7, standing: false },
    { id: "arm-open-close", name: "座って腕の開閉", shortName: "腕の開閉", difficulty: 2, icon: "👐", description: "胸の前で手を合わせ、両腕をゆっくり横へ開いて、もどします。", demoInstruction: "座ったまま、胸の前の手を左右へ開いて、前へもどします。", demoDetail: "肩に痛みが出ない広さまでで大丈夫です。", clearThreshold: 6, order: 8, standing: false },
    { id: "seated-twist", name: "座って体ひねり", shortName: "体ひねり", difficulty: 2, icon: "🔄", description: "椅子に座り、上半身をゆっくり左右にひねります。", demoInstruction: "座ったまま、肩を左へ、右へ、ゆっくり向けます。", demoDetail: "腰は正面のまま、息を止めずに、無理のない所まで動きます。", clearThreshold: 6, order: 9, standing: false },
    { id: "side-bend", name: "座って体の横倒し", shortName: "横倒し", difficulty: 2, icon: "🙇", description: "椅子に座り、上半身をゆっくり横へ倒して、もどします。", demoInstruction: "座ったまま、体を左へ、右へ、ゆっくり倒します。", demoDetail: "おしりは椅子につけたまま、無理のない所まで動きます。", clearThreshold: 6, order: 10, standing: false },
    { id: "standing-heel-raise", name: "立ってかかと上げ", shortName: "立ってかかと", difficulty: 3, icon: "👣", description: "椅子の横に立って背もたれに手を置き、かかとをゆっくり上げて、下ろします。", demoInstruction: "背もたれに手を置いたまま、両方のかかとを上げて、下ろします。", demoDetail: "ふらつく日は、座ってする運動にしましょう。", clearThreshold: 6, order: 11, standing: true },
    { id: "side-step", name: "立って横ステップ", shortName: "横ステップ", difficulty: 4, icon: "↔️", description: "つかまれる場所を確保し、左右へ小さく動きます。", demoInstruction: "左右へ小さく一歩ずつ移動します。", demoDetail: "転ばないよう、つかまれる場所の近くで動きます。", clearThreshold: 8, order: 12, standing: true },
    { id: "mini-squat", name: "浅いスクワット", shortName: "スクワット", difficulty: 4, icon: "⬇️", description: "椅子の前に立ち、椅子に座るように、腰を少しだけ下ろして、もどします。", demoInstruction: "後ろの椅子に座るように、ゆっくり腰を少し下ろして、もどします。", demoDetail: "楽な深さで大丈夫です。ふらつく日は、座ってする運動にしましょう。", clearThreshold: 6, order: 13, standing: true },
    { id: "sit-stand", name: "椅子から立つ", shortName: "立ち座り", difficulty: 5, icon: "🧍", description: "椅子を安定させ、ゆっくり立ってゆっくり座ります。", demoInstruction: "椅子へ座るように、ゆっくり腰を下げて立ち上がります。", demoDetail: "足元まで映し、背中をまっすぐにして動きます。", clearThreshold: 5, order: 14, standing: true }
  ];

  function localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // はじめの呼び名（名簿の1人目の名前にも使う）
  const DEFAULT_USER_NAME = "おばあちゃん";

  function makeDefaultState() {
    return {
      version: 1,
      userName: DEFAULT_USER_NAME,
      exercises: EXERCISES.map((exercise, index) => ({
        ...exercise,
        unlocked: index === 0,
        cleared: false,
        bestCount: 0,
        userGoal: exercise.clearThreshold
      })),
      sessions: [],
      notifications: [],
      album: [],
      plantBonus: 0,
      // 体の分析（この人の足踏みの数値だけ。映像・関節の座標の履歴は持たない）。null = まだ何も覚えていない
      bodyProfile: null,
      // 家族への見守り（セッションごとの数値の履歴と、知らせた記録。体の分析とは別に持つので「体の分析をやり直す」で消えない）
      watch: createWatch(),
      // カメラの一時停止はテレビ全体の設定なので、人ごとの記録ではなく名簿の tv に置く（PEOPLE_KEY。古い記録の値は名簿を作るときに写す）
      dailyQuest: {
        id: "photo-wipe-001",
        title: "孫から届いた写真をきれいにしよう",
        sender: "まご",
        photo: "assets/daily-quest-photo.png",
        rewardGrowth: 3,
        completed: false,
        completedAt: null,
        // "bundled"（同梱の1枚）か "family"（家族の写真）。photoId は家族の写真の番号
        source: "bundled",
        photoId: null
      },
      // 家族の写真で木が育った記録（D-08 の1日1回と、合計の上限に使う）と、同梱の写真を家族の写真のうしろに回しているか（D-23）
      photoReward: { lastDay: null, total: 0, bundledWaiting: false },
      ideas: ["家族から季節の写真を届ける", "運動後に一言メッセージを返す"],
      // 家族の声：voices はこの人の声の一覧（8つまで）、voiceId は鳴らす声（null は声を使わない）、voice はその声（voices の中の1つ）
      voices: [],
      voiceId: null,
      voice: null,
      // 家族の端末から届いて、まだテレビで聞いていない声（2段目）。[{id, sender, at}]。ホームに「○○から 声が届きました」と出す
      voiceArrivals: [],
      alarm: { enabled: false, time: "07:30", volume: 60, weekdays: [1, 2, 3, 4, 5] }
    };
  }

  // 保存した運動の記録から読み込むのは、進み具合（解放・クリア・最高回数）と、運営・本人が変えられる回数（クリア基準・目標）だけ。
  // 名前・説明・難しさ・順番・アイコンはいつも EXERCISES から（文を直したら、保存のある PC にも届くように）。
  // 解放は、保存した解放か、クリア済みか、一覧で1つ前の運動をクリア済みか、一覧で後ろのどれかが解放・クリア済みなら
  // （運動を途中に足しても、前をクリアした人には選べ、選べる運動の間に鍵のかかった運動を挟まない。
  // 例：足踏み・ひざの開閉をクリアして腕上げまで選べていた保存なら、間に入った「肩の上げ下げ」も選べる）
  function hydrateExercises(list, defaults) {
    const byId = new Map((Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => [item.id, item]));
    const count = (value, minimum, maximum, fallback) => {
      const number = Math.round(Number(value));
      return Number.isFinite(number) && number >= minimum ? Math.min(maximum, number) : fallback;
    };
    return defaults.map((item, index) => {
      const saved = byId.get(item.id) || {};
      const previous = index > 0 ? byId.get(defaults[index - 1].id) : null;
      const cleared = saved.cleared === true;
      const clearThreshold = count(saved.clearThreshold, 1, 50, item.clearThreshold);
      return {
        ...item,
        unlocked: index === 0 || saved.unlocked === true || cleared || previous?.cleared === true
          || defaults.slice(index + 1).some((later) => byId.get(later.id)?.unlocked === true || byId.get(later.id)?.cleared === true),
        cleared,
        bestCount: count(saved.bestCount, 0, 9999, 0),
        clearThreshold,
        userGoal: count(saved.userGoal, 1, 99, clearThreshold)
      };
    });
  }

  // 目覚ましの設定。形の崩れた値（曜日が配列でない・時刻が数・音量が文字）は既定に戻す（起動時の描画と、15秒ごとの確認が止まらないように）
  function hydrateAlarm(raw, defaults) {
    const alarm = raw && typeof raw === "object" ? raw : {};
    const time = typeof alarm.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(alarm.time) ? alarm.time : defaults.time;
    const volume = Math.round(Number(alarm.volume));
    const weekdays = Array.isArray(alarm.weekdays)
      ? Array.from(new Set(alarm.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort((a, b) => a - b)
      : [...defaults.weekdays];
    return { enabled: alarm.enabled === true, time, volume: Number.isFinite(volume) ? clamp(volume, 10, 100) : defaults.volume, weekdays };
  }

  function hydrateState(raw) {
    const defaults = makeDefaultState();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
    const state = { ...defaults, ...raw };
    state.exercises = hydrateExercises(raw.exercises, defaults.exercises);
    state.userName = typeof raw.userName === "string" && raw.userName.trim() ? raw.userName.slice(0, 40) : defaults.userName;
    state.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter((item) => item && typeof item === "object").slice(0, 250) : [];
    state.notifications = hydrateNotifications(raw.notifications);
    state.album = Array.isArray(raw.album) ? raw.album.slice(0, 100) : [];
    state.plantBonus = Math.max(0, Number(raw.plantBonus) || 0);
    state.bodyProfile = hydrateBodyProfile(raw.bodyProfile);
    state.watch = hydrateWatch(raw.watch);
    // 判定の版が変わって体の分析を捨てるとき：これまでの行はひざ上げの基準に使わない（別の判定で測った高さは比べられない）。回数の基準・知らせた記録は残す
    if (raw.bodyProfile && typeof raw.bodyProfile === "object" && raw.bodyProfile.algorithm !== ALGORITHM_VERSION && state.watch.history.length) {
      state.watch.liftFrom = Math.max(state.watch.liftFrom, state.watch.history[state.watch.history.length - 1].at + 1);
    }
    state.dailyQuest = { ...defaults.dailyQuest, ...(raw.dailyQuest && typeof raw.dailyQuest === "object" ? raw.dailyQuest : {}) };
    state.dailyQuest.source = state.dailyQuest.source === "family" ? "family" : "bundled";
    state.dailyQuest.photoId = typeof state.dailyQuest.photoId === "string" && PHOTO_ID.test(state.dailyQuest.photoId) ? state.dailyQuest.photoId : null;
    state.photoReward = hydratePhotoReward(raw.photoReward);
    state.ideas = Array.isArray(raw.ideas) ? raw.ideas.filter((idea) => typeof idea === "string").slice(0, 30) : defaults.ideas;
    Object.assign(state, hydrateVoices(raw));
    state.voiceArrivals = hydrateVoiceArrivals(raw.voiceArrivals, state.voices);
    state.alarm = hydrateAlarm(raw.alarm, defaults.alarm);
    return state;
  }

  // 家族の写真の番号（家族のしくみの secrets.token_hex(8)）
  const PHOTO_ID = /^[0-9a-f]{16}$/;
  // 写真のごほうびの記録。lastDay は localDateKey の形、total は0以上の整数
  function hydratePhotoReward(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const total = Math.floor(Number(value.total));
    return {
      lastDay: typeof value.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.lastDay) ? value.lastDay : null,
      total: Number.isFinite(total) && total > 0 ? total : 0,
      bundledWaiting: value.bundledWaiting === true
    };
  }
  // 家族の声：中身が IndexedDB にある（ref: "idb"、D-17）か、まだ移していない dataUrl。どちらでもなければ声はない
  // id は IndexedDB の置き場所の名前（"<人>:<id>"）。id のない前の版の声は "cheer"（前の版の置き場所 "<人>:cheer" のまま）
  const VOICE_ID = /^[a-z0-9-]{1,24}$/;
  const VOICE_LIMIT = 8;
  function hydrateVoice(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const base = { id: typeof raw.id === "string" && VOICE_ID.test(raw.id) ? raw.id : "cheer", name: typeof raw.name === "string" ? raw.name : "", consent: Boolean(raw.consent), savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null };
    if (raw.ref === "idb") return { ...base, ref: "idb" };
    if (typeof raw.dataUrl === "string" && raw.dataUrl.startsWith("data:")) return { ...base, dataUrl: raw.dataUrl };
    return null;
  }
  // 声の一覧と鳴らす声。前の版（voice だけ）の声は一覧の1つ目にして、鳴らす声にする。同じ id は前のものだけ残す
  function hydrateVoices(raw) {
    const voices = [];
    const add = (item) => {
      const voice = hydrateVoice(item);
      if (voice && !voices.some((other) => other.id === voice.id)) voices.push(voice);
    };
    (Array.isArray(raw.voices) ? raw.voices : []).forEach(add);
    const legacy = hydrateVoice(raw.voice);
    if (legacy && !voices.some((other) => other.id === legacy.id)) voices.unshift(legacy);
    voices.splice(VOICE_LIMIT);
    // 「声を使わない」の保存は voiceId も voice も null。voiceId が null でも voice があれば（前の版の声に新しい形の既定が混ざった）、その声を鳴らす
    const wanted = Object.hasOwn(raw, "voiceId") && raw.voiceId !== null ? raw.voiceId : legacy ? legacy.id : null;
    const voice = voices.find((item) => item.id === wanted) || null;
    return { voices, voiceId: voice ? voice.id : null, voice };
  }
  // 声を足して、鳴らす声にする（同じ id があれば入れかえる）。8つを超えたら、鳴らす声でない古いものから外す（外した声を返す。呼ぶ側が IndexedDB から消す）。
  // select: false（家族の端末から届いた声）は一覧に足すだけで、鳴らす声は変えない（テレビで「この声を使う」を選んだときだけ鳴らす）
  function addVoice(state, entry, { select = true } = {}) {
    const voice = hydrateVoice(entry);
    if (!voice) return { state, removed: [] };
    const voices = [voice, ...state.voices.filter((item) => item.id !== voice.id)];
    const keep = select ? voice.id : state.voiceId === voice.id ? voice.id : state.voiceId;
    const removed = [];
    for (let index = voices.length - 1; voices.length > VOICE_LIMIT && index >= 0; index -= 1) {
      if (voices[index].id !== keep && voices[index].id !== voice.id) removed.unshift(...voices.splice(index, 1));
    }
    const chosen = voices.find((item) => item.id === keep) || null;
    const arrivals = (state.voiceArrivals || []).filter((item) => voices.some((other) => other.id === item.id));
    return { state: { ...state, voices, voiceId: chosen ? chosen.id : null, voice: chosen, voiceArrivals: arrivals }, removed };
  }
  // 家族の端末から届いて、まだ聞いていない声。一覧にない声・同じ声は入れない（新しい順に8つまで）
  function hydrateVoiceArrivals(list, voices) {
    const arrivals = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.id !== "string" || !voices.some((voice) => voice.id === item.id) || arrivals.some((other) => other.id === item.id)) continue;
      arrivals.push({ id: item.id, sender: typeof item.sender === "string" ? item.sender.trim().slice(0, 12) : "", at: typeof item.at === "string" ? item.at : null });
    }
    return arrivals.slice(0, VOICE_LIMIT);
  }
  function noteVoiceArrival(state, arrival) {
    return { ...state, voiceArrivals: hydrateVoiceArrivals([arrival, ...(state.voiceArrivals || [])], state.voices) };
  }
  function clearVoiceArrival(state, id) {
    return { ...state, voiceArrivals: (state.voiceArrivals || []).filter((item) => item.id !== id) };
  }
  // 声の名前を変える（空なら変えない。20文字まで）。鳴らす声なら、鳴らす声の名前も変わる
  const VOICE_NAME_LIMIT = 20;
  function renameVoice(state, id, name) {
    const text = typeof name === "string" ? name.trim().slice(0, VOICE_NAME_LIMIT) : "";
    if (!text || !state.voices.some((item) => item.id === id)) return state;
    const voices = state.voices.map((item) => item.id === id ? { ...item, name: text } : item);
    const voice = state.voiceId ? voices.find((item) => item.id === state.voiceId) || null : null;
    return { ...state, voices, voice };
  }
  // 鳴らす声を選ぶ（null か一覧にない id は、声を使わない）
  function selectVoice(state, id) {
    const voice = state.voices.find((item) => item.id === id) || null;
    return { ...state, voiceId: voice ? voice.id : null, voice };
  }
  // 声を一覧から外す。鳴らす声を外したら、声を使わない（ほかの声を勝手に鳴らさない）
  function removeVoice(state, id) {
    const voices = state.voices.filter((item) => item.id !== id);
    const voice = state.voiceId === id ? null : state.voice;
    return { ...state, voices, voiceId: voice ? voice.id : null, voice, voiceArrivals: (state.voiceArrivals || []).filter((item) => item.id !== id) };
  }

  // 通知の読み込み。家族だけに届くもの（audience: "family"）が共有の画面に出ないよう、欠けた項目は家族側に倒す。audience も kind もない古い通知だけ共有（運動の完了の知らせ）とみなす
  const NOTIFICATION_KINDS = new Set(["session", "health", "adapt", "level", "watch"]);
  function hydrateNotifications(list) {
    if (!Array.isArray(list)) return [];
    return capNotifications(list.filter((item) => item && typeof item === "object" && typeof item.message === "string" && Number.isFinite(Date.parse(item.timestamp))).map((item) => {
      const legacy = item.audience === undefined && item.kind === undefined;
      const audience = legacy ? "shared" : item.audience === "shared" ? "shared" : "family";
      const kind = NOTIFICATION_KINDS.has(item.kind) ? item.kind : audience === "shared" ? "session" : "watch";
      return { ...item, audience, kind, immediate: Boolean(item.immediate), important: Boolean(item.important) };
    }));
  }

  // 残す通知の数（新しい順の一覧から）。共有の知らせ（運動の完了）と家族だけのお知らせは別に数え、毎日の共有の知らせが
  // 家族へのお知らせを押し出さないようにする。家族のお知らせは、大事なもの（いつもと違う足踏み等）を先に残し、ふつうのものは残りの枠で
  const NOTIFICATION_LIMITS = { shared: 40, family: 60 };
  function capNotifications(list) {
    const shared = list.filter((item) => item.audience === "shared").slice(0, NOTIFICATION_LIMITS.shared);
    const important = list.filter((item) => item.audience !== "shared" && item.important).slice(0, NOTIFICATION_LIMITS.family);
    const routine = list.filter((item) => item.audience !== "shared" && !item.important).slice(0, NOTIFICATION_LIMITS.family - important.length);
    const keep = new Set([...shared, ...important, ...routine]);
    return list.filter((item) => keep.has(item));
  }

  // 保存した記録が壊れていて読めなかったとき（app.js の loadState が JSON を読めない）：既定の状態に、家族だけのお知らせを1つ添える。
  // 読めなかった文字列は app.js が CORRUPT_STORAGE_KEY に1つだけ残す（上書きで消さないように）。本人の画面には何も出さない
  const CORRUPT_STORAGE_KEY = `${STORAGE_KEY}.corrupt`;
  function noteCorruptStorage(inputState, nowValue) {
    const state = hydrateState(inputState);
    const now = nowValue ? new Date(nowValue) : new Date();
    state.notifications = capNotifications([{
      id: `family-${now.getTime()}-storage`, timestamp: now.toISOString(), audience: "family", kind: "watch", immediate: true, important: true,
      message: "保存していた記録を読み込めなかったため、記録を新しく始めました。読み込めなかった記録は、この PC に別に残しています。"
    }, ...state.notifications]);
    return state;
  }

  // ---- 運動する人の名簿（テレビの localStorage PEOPLE_KEY。F0・4.5.1） ----
  // 1人目（p1）の記録のキーは今の STORAGE_KEY のまま（中身も変えない）。2人目からは後ろに .p2 のように足す（消した番号は使い直さない）。
  // PIN は塩を足したハッシュ（PinRecord、4.5.2）だけを持ち、null は「はじめのまま」（はじめの PIN は app.js が持つ。家族のしくみは null の PIN を使わない）。
  // カメラの一時停止はテレビ全体で1つなので tv に置く
  const PEOPLE_KEY = "motion-link-people-v1";
  // 運営の設定（テレビ全体で1つ。管理用のPINの先で変える。よしさん 2026-10-11）。
  //   practiceClears：カメラなし（「カメラなしで1回」・模擬カメラ・動きの大きさで数えた練習）でも、目標に届けばクリアにして次の運動を選べるようにする
  //   photoReplay：写真あそびを何回でもできるようにする（ふき終わった写真を、もう一度ふける。2回目からは木はそだたない）
  //   showStanding：立ってする4つの運動（立ってかかと上げ・横ステップ・浅いスクワット・椅子から立つ）を運動の一覧に出す（はじめは出さない）
  const ADMIN_OPTIONS_KEY = "motion-link-admin-options-v1";
  const ADMIN_OPTION_NAMES = ["practiceClears", "photoReplay", "showStanding"];
  function hydrateAdminOptions(raw) {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return Object.fromEntries(ADMIN_OPTION_NAMES.map((name) => [name, value[name] === true]));
  }
  const PEOPLE_LIMIT = 6; // D-15
  const PERSON_NAME_MAX = 12; // 足す・名前を変えるとき（呼び名と同じ長さ）
  const PERSON_NAME_STORED_MAX = 40; // 読み込むとき（記録の呼び名は40字まで読む。家族のしくみも40字まで）
  const PERSON_ID = /^p[1-9][0-9]{0,5}$/;
  const PIN_ALGO = "pbkdf2-sha256";

  function personStorageKey(id) {
    return id === "p1" ? STORAGE_KEY : `${STORAGE_KEY}.${id}`;
  }

  // 名前：制御文字（改行・タブなど。家族のしくみも断る）を除き、前後の空白を除いて 1〜max 字。合わなければ null
  function personNameFrom(value, max) {
    if (typeof value !== "string") return null;
    const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    const length = [...name].length;
    return length >= 1 && length <= max ? name : null;
  }

  // base64url の長さから、もとのバイト数（形が違えば -1）
  function base64urlBytes(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return -1;
    const body = text.replace(/=+$/, "");
    return body.length % 4 === 1 ? -1 : Math.floor(body.length * 3 / 4);
  }

  // PinRecord の形を確かめる（家族のしくみ auth.py の valid_pin_record と同じ決まり）。崩れていれば null（はじめのまま）
  function hydratePinRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.v !== 1 || raw.algo !== PIN_ALGO || !Number.isInteger(raw.iter) || raw.iter < 1000 || raw.iter > 2000000) return null;
    if (base64urlBytes(raw.salt) !== 16 || base64urlBytes(raw.hash) !== 32) return null;
    return { v: 1, algo: PIN_ALGO, iter: raw.iter, salt: raw.salt, hash: raw.hash, changedAt: typeof raw.changedAt === "string" && Number.isFinite(Date.parse(raw.changedAt)) ? raw.changedAt : null };
  }

  function isoOrNow(value) {
    const date = value === undefined || value === null ? new Date() : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }

  // はじめて名簿を作るとき：今の記録（1人目）の呼び名と、カメラの一時停止を写す
  function makeDefaultPeople({ name, now, cameraTemporarilyDisabled } = {}) {
    return {
      version: 1,
      activeId: "p1",
      nextNumber: 2,
      people: [{ id: "p1", name: personNameFrom(name, PERSON_NAME_STORED_MAX) || DEFAULT_USER_NAME, storageKey: STORAGE_KEY, createdAt: isoOrNow(now), pin: null }],
      adminPin: null,
      tv: { cameraTemporarilyDisabled: Boolean(cameraTemporarilyDisabled) }
    };
  }

  // 名簿の読み込み。形の崩れた人・同じ番号は除き（6人まで）、名前が読めない人は「運動する人{番号}」にする（記録のキーは番号から決まるので、人は消さない）。
  // activeId がいなければ最初の人。読める人が1人もいなければ null（呼ぶ側が1人目の記録から作り直す）
  function hydratePeople(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.people)) return null;
    const people = [];
    for (const item of raw.people) {
      if (people.length >= PEOPLE_LIMIT) break;
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !PERSON_ID.test(item.id) || people.some((person) => person.id === item.id)) continue;
      people.push({
        id: item.id,
        name: personNameFrom(item.name, PERSON_NAME_STORED_MAX) || `運動する人${item.id.slice(1)}`,
        storageKey: personStorageKey(item.id),
        createdAt: typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : null,
        pin: hydratePinRecord(item.pin)
      });
    }
    if (!people.length) return null;
    const highest = Math.max(...people.map((person) => Number(person.id.slice(1))));
    const nextNumber = Math.max(Number.isInteger(raw.nextNumber) ? raw.nextNumber : 0, highest + 1, 2);
    return {
      version: 1,
      activeId: people.some((person) => person.id === raw.activeId) ? raw.activeId : people[0].id,
      nextNumber,
      people,
      adminPin: hydratePinRecord(raw.adminPin),
      tv: { cameraTemporarilyDisabled: raw.tv && typeof raw.tv === "object" ? raw.tv.cameraTemporarilyDisabled === true : false }
    };
  }

  const clonePeople = (people) => hydratePeople(JSON.parse(JSON.stringify(people)));

  // 人を足す（6人まで。名前は1〜12字で、名簿のほかの人と同じ名前は断る）。{ ok, people, person } か { ok: false, reason: "limit"｜"name"｜"taken" }。
  // keyInUse(記録のキー)：そのキーがもう使われていれば true（呼ぶ側が localStorage を見る）。使われている番号はとばす
  // （同じテレビの画面を2つ開いてほかの画面で足した人や、名簿から外れた記録を、空の記録で上書きしない）
  function addPerson(inputPeople, { name, now, keyInUse } = {}) {
    const people = clonePeople(inputPeople);
    if (!people || people.people.length >= PEOPLE_LIMIT) return { ok: false, reason: "limit" };
    const clean = personNameFrom(name, PERSON_NAME_MAX);
    if (!clean) return { ok: false, reason: "name" };
    if (people.people.some((person) => person.name === clean)) return { ok: false, reason: "taken" };
    let number = people.nextNumber;
    while (PERSON_ID.test(`p${number}`) && typeof keyInUse === "function" && keyInUse(personStorageKey(`p${number}`))) number += 1;
    const id = `p${number}`;
    if (!PERSON_ID.test(id)) return { ok: false, reason: "limit" };
    const person = { id, name: clean, storageKey: personStorageKey(id), createdAt: isoOrNow(now), pin: null };
    people.people.push(person);
    people.nextNumber = number + 1;
    return { ok: true, people, person };
  }

  // 名簿を作り直す（名簿がない・読めないとき）。entries は記録のキーで見つけた人 [{ id, userName }]（id は p1・p2…。呼ぶ側が localStorage を見る）。
  // 番号の順に6人まで入れる。名前は記録の呼び名（読めなければ、1人目ははじめの呼び名、ほかは「運動する人{番号}」）。PIN ははじめのまま。
  // 1人も見つからなければ1人目だけ（はじめて開いたときと同じ）。1人目は記録があるときだけ（1人目を消したあとでも作り足さない）。
  // 番号は見つけた一番大きい番号の次から。activeId は残っている人なら使い、いなければ最初の人
  function rebuildPeople(entries, { now, cameraTemporarilyDisabled, activeId } = {}) {
    const found = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry.id === "string" && PERSON_ID.test(entry.id) && !found.has(entry.id)) found.set(entry.id, entry);
    }
    if (!found.size) return makeDefaultPeople({ now, cameraTemporarilyDisabled });
    const numbers = [...found.keys()].map((id) => Number(id.slice(1))).sort((a, b) => a - b);
    const createdAt = isoOrNow(now);
    const people = numbers.slice(0, PEOPLE_LIMIT).map((number) => {
      const id = `p${number}`;
      const name = personNameFrom(found.get(id).userName, PERSON_NAME_STORED_MAX) || (id === "p1" ? DEFAULT_USER_NAME : `運動する人${number}`);
      return { id, name, storageKey: personStorageKey(id), createdAt, pin: null };
    });
    return {
      version: 1,
      activeId: people.some((person) => person.id === activeId) ? activeId : people[0].id,
      nextNumber: Math.max(numbers[numbers.length - 1] + 1, 2),
      people,
      adminPin: null,
      tv: { cameraTemporarilyDisabled: Boolean(cameraTemporarilyDisabled) }
    };
  }

  // 名前を変える（1〜12字・ほかの人と同じ名前は断る）。{ ok, people, person } か { ok: false, reason: "missing"｜"name"｜"taken" }
  function renamePerson(inputPeople, id, name) {
    const people = clonePeople(inputPeople);
    const person = people?.people.find((item) => item.id === id);
    if (!person) return { ok: false, reason: "missing" };
    const clean = personNameFrom(name, PERSON_NAME_MAX);
    if (!clean) return { ok: false, reason: "name" };
    if (people.people.some((item) => item.id !== id && item.name === clean)) return { ok: false, reason: "taken" };
    person.name = clean;
    return { ok: true, people, person };
  }

  // 人を消す。最後の1人は消せない。いま選んでいる人を消したら最初の人を選ぶ。{ ok, people, removed } か { ok: false, reason: "missing"｜"last" }
  function removePerson(inputPeople, id) {
    const people = clonePeople(inputPeople);
    const removed = people?.people.find((item) => item.id === id);
    if (!removed) return { ok: false, reason: "missing" };
    if (people.people.length <= 1) return { ok: false, reason: "last" };
    people.people = people.people.filter((item) => item.id !== id);
    if (people.activeId === id) people.activeId = people.people[0].id;
    return { ok: true, people, removed };
  }

  // 新しい PIN の確かめ。null（使える）か理由：length（4〜8けたの数字でない）・simple（同じ数字だけ・1234 や 9876、7890 のような続き番号）・
  // initial（はじめの PIN と同じ）
  function validateNewPin(pin, { initialPin } = {}) {
    if (typeof pin !== "string" || !/^[0-9]{4,8}$/.test(pin)) return "length";
    const steps = [...pin].slice(1).map((digit, index) => (Number(digit) - Number(pin[index]) + 10) % 10);
    if ([0, 1, 9].some((step) => steps.every((value) => value === step))) return "simple";
    if (initialPin !== undefined && initialPin !== null && pin === String(initialPin)) return "initial";
    return null;
  }

  function getExercise(state, exerciseId) {
    return state.exercises.find((item) => item.id === exerciseId) || null;
  }

  function countsTowardProgress(session) {
    return !session || session.counts_toward_progress !== false;
  }

  function progressSessions(state) {
    return state.sessions.filter(countsTowardProgress);
  }

  // 各入力元の回数から、セッション全体の入力元を1つに決める。
  function resolveInputSource(repSources) {
    const used = Object.entries(repSources || {}).filter(([, value]) => Number(value) > 0).map(([key]) => key);
    if (!used.length) return "pose";
    if (used.length === 1 && INPUT_SOURCES[used[0]]) return used[0];
    return "mixed";
  }

  // 練習の記録になったわけを1つに決める。実績に数える記録は null。簡易判定の回数があれば、簡易判定になったわけ
  // （fallbackReason：files-missing / engine-failed / engine-late。直せることなので先に）、なければ模擬カメラ、ボタンの順
  function practiceReason(repSources, fallbackReason) {
    if (INPUT_SOURCES[resolveInputSource(repSources)].countsTowardProgress) return null;
    const used = (key) => Number(repSources?.[key]) > 0;
    if (used("fallback")) return ["files-missing", "engine-failed", "engine-late"].includes(fallbackReason) ? fallbackReason : "engine-failed";
    if (used("mock")) return "mock";
    if (used("demo")) return "demo";
    return null;
  }

  // ご家族の欄に出す、練習の記録のわけの文。わけを残していない前の版の記録は、方式から言えることだけ
  function practiceReasonText(session) {
    if (!session || countsTowardProgress(session)) return "";
    if (Object.hasOwn(PRACTICE_REASONS, session.practice_reason)) return PRACTICE_REASONS[session.practice_reason];
    if (session.input_source === "demo" || session.input_source === "mock") return PRACTICE_REASONS[session.input_source];
    return "くわしいわけは記録していません（前の版の記録です）。";
  }

  function getTarget(exercise) {
    return exercise.cleared ? exercise.userGoal : exercise.clearThreshold;
  }

  function completeSession(inputState, details) {
    const state = hydrateState(JSON.parse(JSON.stringify(inputState)));
    const exercise = getExercise(state, details.exerciseId);
    if (!exercise) throw new Error("Unknown exercise");

    const now = details.now ? new Date(details.now) : new Date();
    const count = Math.max(0, Math.round(Number(details.count) || 0));
    const durationSec = Math.max(1, Math.round(Number(details.durationSec) || 1));
    const score = Math.max(0, Math.min(100, Math.round(Number(details.score) || 0)));
    const inputSource = INPUT_SOURCES[details.inputSource] ? details.inputSource : "legacy";
    const countsProgress = INPUT_SOURCES[inputSource].countsTowardProgress;
    // 運動開始時に固定した基準を使う。途中で運営設定が変わっても判定は変えない。
    const startThreshold = Math.round(Number(details.clearThreshold));
    const thresholdSnapshot = startThreshold >= 1 ? startThreshold : exercise.clearThreshold;
    const reachedThreshold = count >= thresholdSnapshot;
    const clearStatus = countsProgress && reachedThreshold;
    // 運営の設定（practiceClears）：練習の記録でも目標に届けば、運動をクリアにして次を選べるようにする。
    // 記録は練習のまま（clear_status は付けない。木・家族へのお知らせ・体の分析には入れない）
    const practiceClear = !countsProgress && reachedThreshold && details.practiceClears === true;
    const firstClear = (clearStatus || practiceClear) && !exercise.cleared;
    let unlockedExercise = null;

    if (countsProgress) exercise.bestCount = Math.max(exercise.bestCount || 0, count);
    if (clearStatus || practiceClear) exercise.cleared = true;
    // 体の分析：実績に数えるセッション（pose / rgbd）だけ確定する。デモ・模擬・簡易・混在は植物と同じく何も学ばない（学習そのものは learnMarchSession）
    const learning = details.learning && typeof details.learning === "object" ? details.learning : null;
    const profileInput = details.bodyProfile ?? learning?.profile ?? null;
    const learnedProfile = countsProgress && profileInput ? hydrateBodyProfile(profileInput) : null;
    if (learnedProfile) state.bodyProfile = learnedProfile;
    // 家族への見守りの履歴（learnMarchSession が更新した写し）。実績に数えるセッションだけ確定する
    if (countsProgress && learning?.watch) state.watch = hydrateWatch(learning.watch);
    if (firstClear) {
      const currentIndex = state.exercises.findIndex((item) => item.id === exercise.id);
      const next = state.exercises[currentIndex + 1];
      if (next && !next.unlocked) {
        next.unlocked = true;
        unlockedExercise = { id: next.id, name: next.name };
      }
    }

    const session = {
      id: `session-${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now.toISOString(),
      dateKey: localDateKey(now),
      exercise_id: exercise.id,
      exercise_name: exercise.name,
      count,
      duration_sec: durationSec,
      motion_score: score,
      tracking_quality: clamp(Math.round(Number(details.trackingQuality) || 0), 0, 100),
      range_score: clamp(Math.round(Number(details.rangeScore) || 0), 0, 100),
      average_tempo_sec: Math.max(0, Math.round((Number(details.averageTempoSec) || 0) * 10) / 10),
      sensor_mode: String(details.sensorMode || "camera").slice(0, 80),
      clear_status: clearStatus,
      clear_threshold: thresholdSnapshot,
      input_source: inputSource,
      rep_sources: normalizeRepSources(details.repSources),
      counts_toward_progress: countsProgress,
      spatial_mode: String(details.spatialMode || "").slice(0, 40),
      pose_model: String(details.poseModel || "").slice(0, 40),
      // 練習の記録になったわけ（ご家族の欄だけに出す）。実績に数える記録には付けない（前の版の記録にもない）
      ...(!countsProgress && Object.hasOwn(PRACTICE_REASONS, details.practiceReason) ? { practice_reason: details.practiceReason } : {}),
      // 運営の設定で、練習の記録のままクリアにした
      ...(practiceClear ? { practice_clear: true } : {}),
      algorithm_version: ALGORITHM_VERSION,
      settings_snapshot_at: details.startedAt ? new Date(details.startedAt).toISOString() : null,
      // 体の分析（座って足踏み）：このセッションで覚えた回数（実績に数えた足踏み）とそのうち証拠にした回数、数えたときの上げ幅のしきい値（開始時に固定）、
      // この人向けの上書き、終了後の分析レベル、計測の質（ひざの深度が取れた割合、静止中の揺れ）
      learned_reps: learnedProfile && !learning?.otherPerson ? Math.max(0, Math.round(Number(details.learnedReps ?? learning?.learnedReps) || 0)) : 0,
      attested_reps: learnedProfile ? Math.max(0, Math.round(Number(details.attestedReps ?? learning?.attested) || 0)) : 0,
      lift_meters: exercise.id === "chair-march" ? (Number.isFinite(details.liftMeters) ? round3(details.liftMeters) : MARCH_LIMITS.liftMeters) : null,
      limits_snapshot: numericSnapshot(details.limitsSnapshot),
      analysis_level: getAnalysisLevel(state.bodyProfile).level,
      knee_depth_adoption: Number.isFinite(details.kneeDepthAdoption ?? learning?.kneeDepthAdoption) ? round3(details.kneeDepthAdoption ?? learning.kneeDepthAdoption) : null,
      rest_sd_m: Number.isFinite(details.restSdM ?? learning?.restSdM) ? round4(details.restSdM ?? learning.restSdM) : null,
      // 家族への見守り：別の人らしくて覚えなかったか、いつもと違う足踏みのお知らせを家族に出したか
      other_person: Boolean(learning?.otherPerson),
      watch_alert: false,
      user_id: "local-demo-user"
    };
    state.sessions.unshift(session);

    if (!countsProgress) {
      const reason = INPUT_SOURCES[inputSource].label;
      const message = `${reason}の記録のため、実績・植物・家族への通知には含めません。`;
      return { state, session, unlockedExercise, notificationMessage: message, reachedThreshold, countsTowardProgress: false, practiceClear, familyNotes: [], healthAlert: null };
    }

    const daySessions = progressSessions(state).filter((item) => item.dateKey === session.dateKey);
    const summary = getSummary(state, now);
    const immediate = daySessions.length === 1;
    const message = immediate
      ? `${state.userName}が「${exercise.name}」を${count}回行いました。継続${summary.streakDays}日、スコア${score}点です。`
      : `${state.userName}の本日${daySessions.length}回目の運動を翌朝サマリーへ追加しました。`;
    // 共有の知らせ（結果画面の「家族への通知（試作）」と家族ダッシュボードの通知プレビューに出るのはこれだけ）
    const shared = { id: `notice-${now.getTime()}-session`, timestamp: now.toISOString(), message, immediate, audience: "shared", kind: "session", important: false };
    state.notifications.unshift(shared);
    // 家族だけに届くお知らせ（体の数値・数え方の調整・見守り）。本人の画面には出さない（よしさん 2026-10-06）。作れなくても運動の記録は残す
    let familyNotes = [];
    try {
      familyNotes = learning ? familyNotesFromLearning(learning, state) : [];
    } catch (error) {
      session.watch_error = String(error && error.message || error).slice(0, 120);
    }
    familyNotes.forEach((note, index) => state.notifications.unshift({ id: `family-${now.getTime()}-${index}-${note.kind}`, timestamp: now.toISOString(), audience: "family", ...note }));
    state.notifications = capNotifications(state.notifications);
    const healthAlert = familyNotes.find((note) => note.kind === "health") || null;
    session.watch_alert = Boolean(healthAlert);

    return { state, session, unlockedExercise, notificationMessage: shared.message, reachedThreshold, countsTowardProgress: true, familyNotes, healthAlert };
  }

  // 記録に残す、この人向けのしきい値の上書き（数だけ、最大20項目）
  function numericSnapshot(value) {
    const output = {};
    if (!value || typeof value !== "object") return output;
    Object.entries(value).slice(0, 20).forEach(([key, item]) => { if (Number.isFinite(item)) output[String(key).slice(0, 40)] = item; });
    return output;
  }

  function normalizeRepSources(value) {
    const output = {};
    ["pose", "rgbd", "mock", "fallback", "demo"].forEach((key) => {
      const count = Math.max(0, Math.round(Number(value?.[key]) || 0));
      if (count) output[key] = count;
    });
    return output;
  }

  function getSummary(state, nowValue) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const today = localDateKey(now);
    const monthKey = today.slice(0, 7);
    const sessions = progressSessions(state);
    const todaySessions = sessions.filter((item) => item.dateKey === today);
    const monthSessions = sessions.filter((item) => String(item.dateKey || "").startsWith(monthKey));
    const uniqueDates = new Set(sessions.map((item) => item.dateKey).filter(Boolean));

    let streakDays = 0;
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!uniqueDates.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (uniqueDates.has(localDateKey(cursor))) {
      streakDays += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    const averageScore = sessions.length
      ? Math.round(sessions.reduce((sum, item) => sum + (Number(item.motion_score) || 0), 0) / sessions.length)
      : 0;
    return {
      todayCount: todaySessions.reduce((sum, item) => sum + (Number(item.count) || 0), 0),
      todaySessions: todaySessions.length,
      streakDays,
      monthSessions: monthSessions.length,
      averageScore
    };
  }

  function getChartData(state, nowValue, days) {
    const count = days || 30;
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const totals = new Map();
    for (const session of progressSessions(state)) {
      totals.set(session.dateKey, (totals.get(session.dateKey) || 0) + (Number(session.count) || 0));
    }
    const output = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const key = localDateKey(date);
      output.push({ key, label: `${date.getMonth() + 1}/${date.getDate()}`, value: totals.get(key) || 0 });
    }
    return output;
  }

  // 植物の段階（ML-PLANT-01：クリアした実績セッション数 1/3/6/10 ＋ クエストのボーナス）はそのまま。
  // 体の分析レベル（0〜4）を「つや（vigor）」として添える：段階は変えず、葉の大きさ・ふち・光で「一緒に育った」を見せる（描き方は app.js renderPlant）
  function getPlantStage(state) {
    const completed = clearedProgressCount(state) + Math.max(0, Number(state.plantBonus) || 0);
    const analysis = getAnalysisLevel(state.bodyProfile);
    const vigor = { vigor: analysis.level, vigorLabel: analysis.level ? `分析レベル${analysis.level}` : null, analysis };
    if (completed >= 10) return { level: 4, label: "満開", message: "大きな花が咲きました。家族みんなで育てた元気の木です。", ...vigor };
    if (completed >= 6) return { level: 3, label: "つぼみ", message: "つぼみができました。あと少しで花が咲きそうです。", ...vigor };
    if (completed >= 3) return { level: 2, label: "若葉", message: "若葉が増えています。続けた分だけ元気に育ちます。", ...vigor };
    if (completed >= 1) return { level: 1, label: "芽", message: "最初の芽が出ました。今日の一歩が成長につながりました。", ...vigor };
    return { level: 0, label: "たね", message: "最初の運動を完了すると、元気の芽が出ます。", ...vigor };
  }

  // クリアした実績の回の数（練習を除く。植物の段階と、家族の写真で育つ分の上限 D-08 に使う）
  function clearedProgressCount(state) {
    return (Array.isArray(state?.sessions) ? state.sessions : []).filter((item) => item && countsTowardProgress(item) && item.clear_status).length;
  }

  // ---- 写真あそび（同梱の1枚と、家族の端末から届いた写真。F2・D-08・D-23） ----
  const BUNDLED_ALBUM_TITLE = "孫から届いた、ひまわりと柴犬の写真";

  // 家族の写真をふいたときに木が育つ回数（D-08）。その日（PC の時計の日付）はじめての1枚だけ1回分。
  // ただし家族の写真で育った分の合計（photoReward.total）は、クリアした実績の回の数まで（運動なしに写真だけで育たない。ML-PLANT-01）
  function familyPhotoGrowth(state, nowValue) {
    const reward = hydratePhotoReward(state?.photoReward);
    const today = localDateKey(nowValue ? new Date(nowValue) : new Date());
    return reward.lastDay !== today && reward.total < clearedProgressCount(state) ? 1 : 0;
  }

  // 写真あそびのできあがり。1つの写真（questId）につき1回だけ（ML-QUEST-05）。アルバムの題は写真の出どころで決める
  // （同梱は今の題、家族の写真は「{送る人}から届いた写真」）。木のごほうびは、同梱は rewardGrowth（3）、家族の写真は familyPhotoGrowth（0か1）。
  // options.practice（デモ・ためしのカメラでふいた）：アルバムには入れるが、木も写真のごほうびの記録（photoReward）も変えない。
  // 返り値の growth は、そだった回数（画面の文・声に使う）
  function completeDailyQuest(inputState, nowValue, { practice = false } = {}) {
    const state = hydrateState(JSON.parse(JSON.stringify(inputState)));
    const quest = state.dailyQuest;
    const saved = state.album.find((item) => item && item.questId === quest.id) || null;
    if (quest.completed || saved) {
      quest.completed = true;
      quest.completedAt = quest.completedAt || saved?.savedAt || null;
      return { state, awarded: false, growth: 0, albumItem: saved };
    }

    const now = nowValue ? new Date(nowValue) : new Date();
    const completedAt = now.toISOString();
    const family = quest.source === "family";
    const growth = practice ? 0 : family ? familyPhotoGrowth(state, now) : Math.max(1, Number(quest.rewardGrowth) || 3);
    quest.completed = true;
    quest.completedAt = completedAt;
    state.plantBonus += growth;
    if (family && growth > 0) state.photoReward = { ...state.photoReward, lastDay: localDateKey(now), total: state.photoReward.total + 1 };
    const albumItem = {
      id: `album-${now.getTime()}`,
      questId: quest.id,
      title: family ? `${quest.sender}から届いた写真` : BUNDLED_ALBUM_TITLE,
      sender: quest.sender,
      photo: quest.photo,
      ...(family ? { photoId: quest.photoId } : {}),
      receivedAt: completedAt,
      savedAt: completedAt
    };
    state.album.unshift(albumItem);
    return { state, awarded: true, growth, albumItem };
  }

  // 次の写真あそびを決める（D-23：孫の本物の写真を、見本の写真のうしろに隠さない）。
  // waitingPhotos：その人のまだふいていない家族の写真 [{ photoId, sender, sentAt }]（テレビの IndexedDB の status "waiting"）。
  //   1. 今の1枚がまだの家族の写真なら、そのまま
  //   2. まだの家族の写真があり、今の1枚が終わっているか、まだの同梱の写真なら、いちばん古い家族の写真にする（まだの同梱の写真はうしろに回す：bundledWaiting）
  //   3. まだの家族の写真がなく、今の1枚が終わっていて、同梱の写真をうしろに回していたなら、同梱の写真にもどす
  // アルバムにもう入っている写真（同じ questId）は、まだの写真に数えない（1つの写真に1回だけ）。{ state, changed }
  function nextFamilyQuest(inputState, waitingPhotos) {
    const state = hydrateState(JSON.parse(JSON.stringify(inputState)));
    const quest = state.dailyQuest;
    if (quest.source === "family" && !quest.completed) return { state, changed: false };
    const waiting = familyQuestQueue(state, waitingPhotos);
    if (waiting.length) {
      if (!quest.completed) state.photoReward.bundledWaiting = true;
      const photo = waiting[0];
      state.dailyQuest = {
        id: `photo-${photo.photoId}`, title: `${photo.sender}から届いた写真をきれいにしよう`, sender: photo.sender, photo: `idb:${photo.photoId}`,
        rewardGrowth: 1, completed: false, completedAt: null, source: "family", photoId: photo.photoId
      };
      return { state, changed: true };
    }
    if (quest.completed && state.photoReward.bundledWaiting) {
      state.photoReward.bundledWaiting = false;
      const bundled = makeDefaultState().dailyQuest;
      if (!state.album.some((item) => item && item.questId === bundled.id)) state.dailyQuest = bundled;
      return { state, changed: true };
    }
    return { state, changed: false };
  }

  // まだふいていない家族の写真の列（古い順。アルバムにもう入っている写真と、形の崩れたものは除く）。送る人の名前は1〜12字（なければ「家族」）
  function familyQuestQueue(state, waitingPhotos) {
    const done = new Set((Array.isArray(state?.album) ? state.album : []).map((item) => item && item.questId));
    const seen = new Set();
    return (Array.isArray(waitingPhotos) ? waitingPhotos : [])
      .filter((photo) => photo && typeof photo.photoId === "string" && PHOTO_ID.test(photo.photoId) && !done.has(`photo-${photo.photoId}`)
        && !seen.has(photo.photoId) && seen.add(photo.photoId))
      .map((photo) => ({ photoId: photo.photoId, sender: personNameFrom(photo.sender, PERSON_NAME_MAX) || "家族", sentAt: typeof photo.sentAt === "string" ? photo.sentAt : "" }))
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  // ---- 家族ダッシュボード（テレビの renderDashboard）と、家族の端末へ送る写し（4.5.5）で同じ数・同じ文にする部分 ----
  // 4枚のカードの数。実績に数える記録だけを数える。practiceOnly* は、その範囲に練習の記録があるか（実績がないとき「記録はまだありません」の代わりに
  // 「練習だけです」と出すため）
  function getDashboardSummary(state, nowValue) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const summary = getSummary(state, now);
    const today = localDateKey(now);
    const monthKey = today.slice(0, 7);
    const progress = progressSessions(state);
    const month = progress.filter((item) => String(item.dateKey || "").startsWith(monthKey));
    const practiceIn = (inRange) => state.sessions.some((item) => !countsTowardProgress(item) && inRange(String(item.dateKey || "")));
    return {
      todayCount: summary.todayCount,
      todaySessions: summary.todaySessions,
      streakDays: summary.streakDays,
      monthCount: month.reduce((sum, item) => sum + (Number(item.count) || 0), 0),
      monthDays: new Set(month.map((item) => item.dateKey)).size,
      averageScore: summary.averageScore,
      hasCounted: progress.length > 0,
      practiceOnlyToday: practiceIn((key) => key === today),
      practiceOnlyMonth: practiceIn((key) => key.startsWith(monthKey)),
      practiceOnlyAny: practiceIn(() => true)
    };
  }

  // 次のレベルまで。残りの回数や左右の差は本人に見せない（目標を押しつけない ML-MOTION-05。よしさん 2026-10-06）
  function nextLevelText(analysis) {
    if (!analysis.next) return "";
    const close = analysis.next.sessionsLeft <= 3 && analysis.next.repsLeft <= 15 && analysis.next.eachLeft <= 10;
    return close ? "次のレベルまで、もう少し" : "ゆっくり育っています";
  }
  // 体の分析のカードの説明（レベルの名前のあとの文）。まだのときは始め方、いちばん上のレベルは覚えた足踏みの回数
  function analysisNote(analysis) {
    if (!analysis.level) return "座って足踏みを5回すると始まります";
    return analysis.next ? nextLevelText(analysis) : `足踏み ${analysis.reps}回ぶん`;
  }

  // この1週間（今日までの7日）：選べる運動ごとの行と、日ごとの印（"done" 実績の記録がある日・"practice" 練習だけの日・"" ない日）。回数は入れない
  function getWeekMarks(state, nowValue) {
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const days = Array.from({ length: 7 }, (_, offset) => localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + offset)));
    const marks = new Map();
    for (const session of state.sessions) {
      const at = new Date(session.timestamp);
      const key = `${session.exercise_id}|${session.dateKey || (Number.isFinite(at.getTime()) ? localDateKey(at) : "")}`;
      if (countsTowardProgress(session)) marks.set(key, "done");
      else if (!marks.has(key)) marks.set(key, "practice");
    }
    const rows = state.exercises.filter((exercise) => exercise.unlocked)
      .map((exercise) => ({ exerciseId: exercise.id, name: exercise.name, marks: days.map((day) => marks.get(`${exercise.id}|${day}`) || "") }));
    return { days, rows };
  }

  // 共有のお知らせの1行（日付は入れない）：同じ時刻の実績の記録から「座って足踏みを 8回 しました」。記録が見つからない古いお知らせは、
  // スコアの言葉を除き、届け方の言葉（翌朝サマリー）の文は「運動をしました」にする。テレビの家族ダッシュボードと家族の端末で同じ文
  function sharedNoticeLine(item, sessions) {
    const session = (Array.isArray(sessions) ? sessions : []).find((entry) => entry && entry.timestamp === item.timestamp && countsTowardProgress(entry));
    if (session) return `${session.exercise_name}を ${Number(session.count) || 0}回 しました`;
    const message = String(item.message || "");
    return /翌朝サマリー/.test(message) ? "運動をしました" : message.replace(/、?スコア\d+点です/, "");
  }

  // 家族だけのお知らせの見出し：種類だけ（届け方の言葉は使わない）。すぐ伝えたい「いつもと違う足踏み」には（早めに）
  function familyNoteLabel(item) {
    if (item?.topic === "storage") return "保存データ";
    if (item?.topic === "family-device") return "家族の端末";
    if (item?.kind === "health") return item.immediate ? "いつもと違う足踏み（早めに）" : "いつもと違う足踏み";
    return { level: "体の分析", adapt: "数え方", watch: "見守り" }[item?.kind] || "お知らせ";
  }

  // 家族の端末へ送る写し（4.5.5）。shared は、テレビの家族ダッシュボードに出ている内容と同じだけ（体の数値・家族だけのお知らせ・声は入れない）。
  // family は、家族の端末の PIN の先だけで渡す部分（家族だけのお知らせ・練習になったわけ・精度の見え方）。
  // options：now、personId、waitingPhotos（その人のまだふいていない家族の写真 [{ photoId, sender, sentAt }]。写真あそびの列の数）
  const SNAPSHOT_LIMITS = { history: 6, notices: 20, notes: 20, practice: 5, album: 100 };
  function buildFamilySnapshot(inputState, { now: nowValue, personId, waitingPhotos } = {}) {
    const state = hydrateState(inputState);
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const iso = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
    // お知らせの番号：記録の id（なければ時刻と文から作る。写しを送り直しても同じ番号になるように）
    const noticeId = (item, prefix) => (typeof item.id === "string" && item.id ? item.id : `${prefix}-${Date.parse(item.timestamp)}-${textHash(item.message)}`);
    const analysis = getAnalysisLevel(state.bodyProfile);
    const plant = getPlantStage(state);
    const queue = familyQuestQueue(state, waitingPhotos);
    const quest = state.dailyQuest;
    const shared = {
      summary: getDashboardSummary(state, now),
      analysis: { level: analysis.level, name: analysis.name, note: analysisNote(analysis) },
      week: getWeekMarks(state, now),
      chart: getChartData(state, now, 30),
      plant: { level: plant.level, label: plant.label, message: plant.message, vigor: plant.vigor, bonus: state.plantBonus },
      history: state.sessions.slice(0, SNAPSHOT_LIMITS.history).map((session) => ({
        at: iso(session.timestamp), exerciseName: String(session.exercise_name || ""), count: Number(session.count) || 0, practice: session.counts_toward_progress === false
      })),
      notices: state.notifications.filter((item) => item.audience === "shared").slice(0, SNAPSHOT_LIMITS.notices).map((item) => ({
        id: noticeId(item, "notice"), at: iso(item.timestamp), line: sharedNoticeLine(item, state.sessions), immediate: item.immediate === true
      })),
      album: state.album.filter((item) => item && typeof item === "object").slice(0, SNAPSHOT_LIMITS.album).map((item) => ({
        id: String(item.id || ""), title: String(item.title || ""), sender: String(item.sender || ""), photoRef: albumPhotoRef(item), savedAt: iso(item.savedAt)
      })),
      quest: { waiting: queue.length, current: quest.source === "family" && !quest.completed ? { photoId: quest.photoId, sender: quest.sender } : null },
      // テレビの時計の UTC からのずれ（分）。家族の端末が「今日」をテレビの日付で決められるように
      tzOffsetMin: -now.getTimezoneOffset()
    };
    const family = {
      notes: state.notifications.filter((item) => item.audience === "family").slice(0, SNAPSHOT_LIMITS.notes).map((item) => ({
        id: noticeId(item, "family"), at: iso(item.timestamp), label: familyNoteLabel(item), message: item.message, important: item.important === true, immediate: item.immediate === true
      })),
      practice: state.sessions.filter((session) => !countsTowardProgress(session)).slice(0, SNAPSHOT_LIMITS.practice).map((session) => ({
        at: iso(session.timestamp), exerciseName: String(session.exercise_name || ""), reason: practiceReasonText(session)
      })),
      accuracy: getAccuracyView(state, now)
    };
    return { schema: 1, personId, personName: state.userName, generatedAt: now.toISOString(), shared, family };
  }

  // アルバムの写真の出どころ：同梱は "bundled:assets/…"、家族の写真は "photo:<photoId>"（家族の端末が家族のしくみから取る）。どちらでもなければ null
  function albumPhotoRef(item) {
    if (typeof item.photoId === "string" && PHOTO_ID.test(item.photoId)) return `photo:${item.photoId}`;
    const photo = typeof item.photo === "string" ? item.photo : "";
    if (photo.startsWith("idb:") && PHOTO_ID.test(photo.slice(4))) return `photo:${photo.slice(4)}`;
    return /^assets\/[\w.-]+\.(?:png|jpe?g)$/.test(photo) ? `bundled:${photo}` : null;
  }

  // 文の短い印（id のない古いお知らせの番号を、送り直しても変わらないように作る）
  function textHash(value) {
    let hash = 5381;
    for (const char of String(value || "")) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
    return hash.toString(36);
  }

  // 写真のくもりふき（孫から届いた写真）を、端末サービスの関節（手首）でする。
  // 手首は肩の中心を原点・肩幅を1にした長さで見る（カメラから遠い人・近い人、体が少し動いても同じ）。写真は鏡のように左右を返す。
  // 座ったまま、手をおなかからあごの高さで、左右へ肩幅1つ分まで動かせば写真の四すみまで届く（頭より上へ・遠くへ伸ばさなくてよい）
  const QUEST_WIPE_LIMITS = {
    side: 1,           // 肩の中心から左右へ肩幅1つ分で、写真の左右の端
    up: .45,           // 肩の線から上へ肩幅の .45（あごのあたり）で、写真の上の端
    down: 1,           // 肩の線から下へ肩幅1つ分（おなかのあたり）で、写真の下の端
    stillRadius: .15,  // 前にふいた所から肩幅の .15 より小さい手の揺れはふかない（休めている手の揺れ・肩の上げ下げ）
    spacing: .04,      // 速く動かしたときは、写真の上でこの間をあけずに点を補ってつなぐ
    jump: .6,          // 1コマで肩幅の .6 より遠くへ跳んだ手首は、見まちがいとして線でつながない
    gapMs: 300,        // 手首がこれより長く見えなければ、次に見えた所から始め直す（離れた所へ線を引かない）
    movingMs: 600,     // ふいてからこの間は「動いている手」（写真の上に印を出す）
    minScale: .04,     // 肩幅（画像の高さを1）がこれより狭ければ、肩が見えていないとみなす
    torsoShare: .6,    // 腰が見えるときは、肩幅を胴の長さ×これより小さく見ない（横を向いて肩幅が縮んでも、手の動きが大きくなりすぎない）
    // 手のひら：ひじが見えれば、手首からひじと反対へ前腕の .35 先（手のひらの真ん中）でふく（手首の点は手のひらより腕の側にある）
    palm: .35,
    // 写真の下の端（おなか）より、写真の高さの .06 より下の手（ひざ・ももの上に置いた手・腰の横の手）はふかない。そこから上がってきた手は、
    // 写真に入った所から始める（ひざに手を置いて動かすと、写真の下の段が消えていた。よしさん 2026-10-11）
    below: .06
  };

  // landmarks: MediaPipe の番号の33点（画像の 0〜1、端末サービスは LocalSensor.toLandmarks）。aspect: 画像の横÷縦。
  // previous: 前のコマの戻り値の state（はじめは null）。now: そのコマの時刻（ms）。
  // 戻り値: points（このコマでふく点。写真の 0〜1）、hands（left / right：写真の上のいまの手の位置と、動いているか。見えなければ null）、
  // body（肩の中心 x・y と肩幅 scale。画像の高さを1にした長さ。肩が見えなければ null。画面に体の線を描くのに使う）、state
  function questWipeFromPose(landmarks, aspect, previous, now) {
    const limits = QUEST_WIPE_LIMITS;
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
    const body = questBodyFrame(landmarks, ratio);
    const points = [];
    const hands = {};
    const state = {};
    [["left", LANDMARK.leftWrist], ["right", LANDMARK.rightWrist]].forEach(([side, index]) => {
      const before = previous?.[side] || null;
      const recent = Boolean(before) && now - before.seenAt <= limits.gapMs;
      const wrist = landmarks?.[index];
      if (!body || !visible(wrist)) {
        hands[side] = null;
        // 見えないのが一瞬なら前の所を覚えておく（速く動かして一瞬だけ見えなくても、線がつながる）
        state[side] = recent ? before : null;
        return;
      }
      const elbow = landmarks[index - 2];
      // 指の点（小指 17/18・人さし指 19/20）が見えるとき（ブラウザのカメラ。端末サービスは送らない）は、手首と2つの指の点のまん中
      const fingers = [landmarks[index + 2], landmarks[index + 4]];
      const palm = fingers.every((point) => visible(point))
        ? { x: (wrist.x + fingers[0].x + fingers[1].x) / 3 * ratio, y: (wrist.y + fingers[0].y + fingers[1].y) / 3 }
        : visible(elbow)
          ? { x: (wrist.x + (wrist.x - elbow.x) * limits.palm) * ratio, y: wrist.y + (wrist.y - elbow.y) * limits.palm }
          : { x: wrist.x * ratio, y: wrist.y };
      const position = { x: (palm.x - body.x) / body.scale, y: (palm.y - body.y) / body.scale };
      if (questPhotoPoint(position).y > 1 + limits.below) {
        hands[side] = null;
        state[side] = null;
        return;
      }
      let hand;
      if (!recent || Math.hypot(position.x - before.last.x, position.y - before.last.y) > limits.jump) {
        hand = { anchor: position, last: position, seenAt: now, movedAt: before?.movedAt ?? null };
      } else {
        hand = { ...before, last: position, seenAt: now };
        if (Math.hypot(position.x - before.anchor.x, position.y - before.anchor.y) >= limits.stillRadius) {
          points.push(...questWipeSegment(questPhotoPoint(before.anchor), questPhotoPoint(position)));
          hand.anchor = position;
          hand.movedAt = now;
        }
      }
      state[side] = hand;
      const at = questPhotoPoint(position);
      hands[side] = { x: clamp(at.x, 0, 1), y: clamp(at.y, 0, 1), moving: hand.movedAt !== null && now - hand.movedAt <= limits.movingMs };
    });
    return { points, hands, body, state };
  }

  // 肩の中心（画像の高さを1にした長さ）と、長さの単位（肩幅）。両肩が見えなければ null
  function questBodyFrame(landmarks, ratio) {
    const left = landmarks?.[LANDMARK.leftShoulder];
    const right = landmarks?.[LANDMARK.rightShoulder];
    if (!visible(left) || !visible(right)) return null;
    const x = (left.x + right.x) / 2 * ratio;
    const y = (left.y + right.y) / 2;
    let scale = Math.hypot((left.x - right.x) * ratio, left.y - right.y);
    const hips = [landmarks[LANDMARK.leftHip], landmarks[LANDMARK.rightHip]];
    if (hips.every((hip) => visible(hip))) {
      const torso = Math.hypot((hips[0].x + hips[1].x) / 2 * ratio - x, (hips[0].y + hips[1].y) / 2 - y);
      scale = Math.max(scale, torso * QUEST_WIPE_LIMITS.torsoShare);
    }
    return scale >= QUEST_WIPE_LIMITS.minScale ? { x, y, scale } : null;
  }

  // 肩幅の単位の手首の位置 → 写真の上の位置（0〜1 の外にも出る）。人の右手（画像の左）は写真の右（鏡と同じ）
  function questPhotoPoint(position) {
    const { side, up, down } = QUEST_WIPE_LIMITS;
    return { x: .5 - position.x / (2 * side), y: (position.y + up) / (up + down) };
  }

  // 写真の上の from から to までを、spacing より細かい間隔の点にする（写真の外は端に寄せる。同じ点は続けない）
  function questWipeSegment(from, to) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / QUEST_WIPE_LIMITS.spacing));
    const output = [];
    for (let step = 0; step <= steps; step += 1) {
      const point = { x: clamp(from.x + (to.x - from.x) * step / steps, 0, 1), y: clamp(from.y + (to.y - from.y) * step / steps, 0, 1) };
      const last = output[output.length - 1];
      if (!last || last.x !== point.x || last.y !== point.y) output.push(point);
    }
    return output;
  }

  const LANDMARK = {
    leftShoulder: 11, rightShoulder: 12,
    leftElbow: 13, rightElbow: 14,
    leftWrist: 15, rightWrist: 16,
    leftHip: 23, rightHip: 24,
    leftKnee: 25, rightKnee: 26,
    leftAnkle: 27, rightAnkle: 28
  };

  function landmarkConfidence(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 0;
    const visibility = Number.isFinite(point.visibility) ? point.visibility : 1;
    const presence = Number.isFinite(point.presence) ? point.presence : 1;
    return Math.max(0, Math.min(1, visibility, presence));
  }

  // 画像の外へ推定された点は、confidenceが高くても見えている部位として扱わない。
  function insideFrame(point, margin) {
    const edge = Number.isFinite(margin) ? margin : 0;
    return Boolean(point) && point.x >= -edge && point.x <= 1 + edge && point.y >= -edge && point.y <= 1 + edge;
  }

  function visible(point, minimum) {
    return insideFrame(point) && landmarkConfidence(point) >= (minimum || .52);
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // 3次元の角度（b の角、度）。長さのない辺があれば 0
  function angleDegrees3(a, b, c) {
    const ab = [a.x - b.x, a.y - b.y, a.z - b.z];
    const cb = [c.x - b.x, c.y - b.y, c.z - b.z];
    const denominator = Math.hypot(...ab) * Math.hypot(...cb);
    if (denominator < .00001) return 0;
    return Math.acos(clamp((ab[0] * cb[0] + ab[1] * cb[1] + ab[2] * cb[2]) / denominator, -1, 1)) * 180 / Math.PI;
  }

  function angleDegrees(a, b, c) {
    const ab = { x: a.x - b.x, y: a.y - b.y };
    const cb = { x: c.x - b.x, y: c.y - b.y };
    const denominator = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
    if (denominator < .00001) return 0;
    const cosine = Math.max(-1, Math.min(1, (ab.x * cb.x + ab.y * cb.y) / denominator));
    return Math.acos(cosine) * 180 / Math.PI;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  const round3 = (value) => Math.round(value * 1000) / 1000;
  const round4 = (value) => Math.round(value * 10000) / 10000;
  function median(values) {
    return values.length ? percentileOf(values, .5) : null;
  }
  function standardDeviation(values) {
    if (values.length < 2) return null;
    const average = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
  }
  // 直近 keep 件だけ持つ履歴（古いものから捨てる）
  function pushRing(list, value, keep) {
    list.push(value);
    while (list.length > keep) list.shift();
    return list;
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      z: ((Number(a.z) || 0) + (Number(b.z) || 0)) / 2
    };
  }

  // 関節の平滑化（テレビ画面と、記録の流し直しで共通）。速く動いた関節ほど今回値を重く見る。
  // dtMs は前回からの時間。フレームの間隔（ブラウザ 15〜25fps、端末サービス 約30fps、Raspberry Pi はもっと低い）が
  // 変わっても同じ時間の効き方になるよう、30fps（33ms）の1フレームを基準に換算する。
  // 深度が取れなかった関節は NaN。前回か今回が数でなければ平滑化せず今回値を使う（NaN が残り続けないように）
  function smoothLandmarks(current, previous, visibilitySource, dtMs) {
    if (!Array.isArray(current)) return null;
    if (!Array.isArray(previous) || previous.length !== current.length) return current.map((point) => ({ ...point }));
    const visibility = Array.isArray(visibilitySource) ? visibilitySource : current;
    const frames = clamp(Number(dtMs) > 0 ? dtMs / 33 : 1, .25, 6);
    return current.map((point, index) => {
      const old = previous[index];
      if (!old || landmarkConfidence(visibility[index]) < .35 || !Number.isFinite(old.x) || !Number.isFinite(point.x)) return { ...point };
      const speed = Math.hypot(point.x - old.x, point.y - old.y, (Number(point.z) || 0) - (Number(old.z) || 0)) / frames;
      const alpha = 1 - Math.pow(1 - Math.min(.76, .3 + speed * 8), frames);
      return {
        ...point,
        x: old.x * (1 - alpha) + point.x * alpha,
        y: old.y * (1 - alpha) + point.y * alpha,
        z: Number.isFinite(point.z) && Number.isFinite(old.z) ? old.z * (1 - alpha) + point.z * alpha : point.z
      };
    });
  }

  // 本人に見える文なので、体の数値や「調整」は書かない
  function invalidMeasurement(label) {
    return { valid: false, confidence: 0, metric: null, visiblePart: label, message: `${label}が見えるように、少し動いてみてください` };
  }

  function validMeasurement(metric, confidence, profile) {
    return {
      valid: true,
      metric,
      confidence: Math.max(0, Math.min(1, confidence)),
      lowThreshold: profile.low,
      highThreshold: profile.high,
      visiblePart: profile.label,
      lowLabel: profile.lowLabel,
      highLabel: profile.highLabel
    };
  }

  // 座って足踏みのしきい値（ひざの「座った高さ」からの上げ幅、m）。2026-10-05 の実機記録（Gemini 335、座って正面向き、約6分）で、
  // 意図したひざ上げは基準から 6〜35cm、静止中の揺れは標準偏差 約1.3cm。足を下ろす位置は毎回 3〜5cm 変わり、
  // 大きく上げると反対のひざも 5〜7cm（時に15cm）つられて上がる。上げ幅 .06 が記録で最もよく数えられた（.05 と .07 は1回ずつ減る）。
  const MARCH_LIMITS = {
    // 深度で測れるひざ（"3d"）
    liftMeters: .06,          // 上げた：基準からこれ以上（太もも約9〜10°）
    lowerMeters: .03,         // 下ろした：上げ始めの位置からこれ以内に戻った
    releaseFraction: .5,      // または、上げた高さの半分まで下りた（足が前より少し高い所に着いても数える）
    dominanceMeters: .04,     // 上げた：反対のひざよりこれ以上高い（つられて上がったひざ、座り直しで両方上がったひざを数えない）
    nearMissMeters: .045,     // ここまで上がって数えるほどでなかったときは「ゆっくり、ご自分のペースで」と声をかける（高く上げるようには言わない）
    // 深度がないひざ（"2d"：ブラウザのカメラ、またはそのひざの深度が取れない）。画像の高さを、反対のひざの奥行きか胴の長さで m に換算する
    liftMeters2d: .07, lowerMeters2d: .035, dominanceMeters2d: .05, nearMissMeters2d: .05,
    torsoMeters2d: .27,       // 画像上の胴（肩〜腰）の長さ1つ分が、ひざの上げ幅 約0.27m（記録では .24〜.275）
    fullRangeMeters: .12,     // 可動域100%とみなす上げ幅
    // 座った高さの基準（ひざごと）：上げていない間の直近6秒で、低い方から15%の高さ。上げている間は動かさない
    baselineWindowMs: 6000, baselinePercentile: .85, baselineMinSamples: 6, baselineMinSpanMs: 600,
    restBandV: .02, minDepthSamples: 5,
    // 使う関節の信頼度
    kneeMinConfidence: .45, torsoShoulderConfidence: .5, torsoHipConfidence: .3,
    // 両ひざが同じくらい（低い方が高い方の半分以上）上がったまま0.6秒：座り直し・前かがみ・立ち上がりとみなし、数えずに基準を作り直す
    bothUpMs: 600, bothUpSimilarRatio: .5,
    // 両ひざ上がり（座り直し）とみなす高さ。体の分析で liftMeters を下げても、ここは下げない（下げると march-3 54.4秒の、片ひざが5cm高く着いたまま反対を10cm上げた1回が消える）
    bothUpMeters: .06,
    // 計測の質：静止して座っている間の上げ幅の揺れを、この時間ごとに標準偏差で取る（体の分析で、しきい値を下げられる下限に使う）
    qualityWindowMs: 2000, qualityMinSamples: 10,
    // 時間（ms）。上げた／下ろしたは0.1秒続いたら確定。同じ足は0.5秒以上あける。8秒上げたまま（足を組んだ等）は数えずに作り直す
    holdMs: 100, sameSideGapMs: 500, maxLiftMs: 8000, resetAfterMs: 1500, otherFreshMs: 200, hintMs: 2500, nearMissQuietMs: 1000,
    // 足が前より高い所に着いたとき：上げた高さの3割（2cm以上）下りて0.4秒ほぼ止まったら、半分まで下りなくても下ろしたとみなす
    settleMs: 400, settleRangeMeters: .02, settleRangeMeters2d: .03, settleFraction: .3,
    // そうして数えたひざは、半分まで下りないまま settleMergeMs 以内に続けて上げたら同じ1回（途中で止まってから、さらに上げた）
    settleMergeMs: 1200,
    // 反対のひざが下りてからこの間は、反対のひざを上げ始めの位置から測る（大きく上げた足が下りる途中の、つられ上がりを数えない）
    otherSettleMs: 300,
    // 深度が1フレームで画像より5cm以上低く跳んだ（ひざの縁で背景を拾った等）ときは、その差を深度が欠けたフレームの補いに使わない
    gapJumpMeters: .05,
    // その差が0.3秒続いたら跳びではない（測り始めや、深度が欠けている間に座り直して画像の基準がずれた等）。覚え直す
    gapRelearnMs: 300,
    // 上げていた時間（フレームの間隔を足して）がこれ未満は数えない（関節の点が一瞬跳んだもの）。記録のひざ上げは 0.34秒以上。
    // .3秒にすると跳びはほぼ消えるが、上で止めずに素早く上げ下げした小さな上げ（7〜9cm）を黙って落とすので、.25秒にする
    minUpMs: 250,
    // 前の1回からの間隔がこれ未満（両ひざがほぼ同時に下りた）はテンポに使わない
    minCycleMs: 350,
    // 画像上の胴が直近の1.3倍以上に伸びた（立って近づいてきた・大きく前かがみ）ときは上げたとみなさない。ひざを上げると胴は短く見える（.73〜.78倍）
    approachTorsoRatio: 1.3,
    // 左右のひざの画像上の並びが逆になった（推定の左右の取り違え）フレームは1秒まで使わない。それ以上続けば並びを覚え直す（足を組んだ等）
    orderMarginU: .03, orderSwitchMs: 1000,
    // options.fyN（カメラの fy ÷（画像の高さ−1））の妥当な範囲。外れたら胴の長さで換算する
    fyNMin: .4, fyNMax: 2.5
  };

  // 座って足踏み：左右のひざの画像上の高さ（v、下向き）と、深度カメラの3D座標（カメラ座標、y下向き、m）。
  // 正面を向いて座ると太ももはカメラの方を向くので、画像上の「腰とひざの差」は姿勢やカメラの高さで大きく変わる。
  // ひざ自身の高さの変化を、本人の座った高さからの差で見る（換算と判定は updateMarchCounter）。腰の深度は膝の上（ももの面）に当たるので使わない
  function measureChairMarch(landmarks, worldLandmarks, options) {
    const limits = options?.limits || MARCH_LIMITS;
    const conf = (index) => landmarkConfidence(landmarks[index]);
    const sides = [["left", 25], ["right", 26]].flatMap(([side, index]) => {
      const knee = landmarks[index];
      if (!insideFrame(knee) || conf(index) < limits.kneeMinConfidence) return [];
      const point = Array.isArray(worldLandmarks) ? worldLandmarks[index] : null;
      const has3d = Boolean(point) && Number.isFinite(point.y) && Number.isFinite(point.z) && point.z > 0;
      return [{ side, v: knee.y, y: has3d ? point.y : null, z: has3d ? point.z : null, confidence: conf(index) }];
    });
    if (!sides.length) return invalidMeasurement("ひざ");
    const torsos = [[11, 23], [12, 24]]
      .filter(([shoulder, hip]) => insideFrame(landmarks[shoulder]) && insideFrame(landmarks[hip])
        && conf(shoulder) >= limits.torsoShoulderConfidence && conf(hip) >= limits.torsoHipConfidence)
      .map(([shoulder, hip]) => Math.abs(landmarks[hip].y - landmarks[shoulder].y)).filter((value) => value > .04);
    const fyN = Number.isFinite(options?.fyN) && options.fyN >= limits.fyNMin && options.fyN <= limits.fyNMax ? options.fyN : null;
    // metric は表示・記録用の目安（画像上のひざの高さ）。回数は判定側で基準との差を見る
    const measurement = validMeasurement(Math.max(...sides.map((item) => -item.v)), Math.max(...sides.map((item) => item.confidence)), {
      low: limits.lowerMeters, high: limits.liftMeters,
      label: sides.length === 2 ? "両ひざ" : "映っているひざ", lowLabel: "足を下ろした位置", highLabel: "ひざを上げた位置"
    });
    // 左右のひざの画像上の並び（左右の取り違えを見つける用）。信頼度の低いひざも使う（取り違えた直後は信頼度が下がる）
    const placed = (index) => insideFrame(landmarks[index]) && conf(index) > 0;
    const du = placed(25) && placed(26) ? landmarks[25].x - landmarks[26].x : 0;
    const kneeOrder = Math.abs(du) >= limits.orderMarginU ? Math.sign(du) : null;
    return { ...measurement, sides, kneeOrder, torsoV: torsos.length ? mean(torsos) : null, fyN, source: sides.some((item) => item.z !== null) ? "3d" : "2d" };
  }

  // ---- 腕上げ・ひざ伸ばし・立ち座り・横ステップ：本人の「休んだ位置」（基準）から、決まった幅（しきい値）だけ動いて戻ったら1回 ----
  // カメラはテレビの上下に置き、テレビを見る人を正面から撮る。正面では太もも・すねがカメラの方を向くので、画像上の関節の角度はほとんど
  // 変わらない。運動ごとに正面でも変わる量を測る。深度（3D座標、m）が取れる関節ならそれで、なければ画像だけで、本人の体の大きさ
  // （胴の長さ・肩幅・休んだときのすねの長さ）との比で測る。ブラウザのカメラには深度がないので、画像だけでも数えられるようにしてある。
  // しきい値（floor）は固定で、本人に合わせて上げも下げもしない。2026-10 時点でこの4つの運動の実機の記録はなく、カメラの模型
  // （正面、カメラの高さ .7・1.0m、距離 1.3〜2.6m。tests/helpers/pinhole.js）で決めた仮の値（記録が取れたら replay-recording.mjs --limits で確かめる）。
  // 値はどれも「動くと大きくなる」向き。基準は、上げていない間の直近6秒の低い方から15%（座って足踏みの .85 と同じく、休んだ側に寄せる）
  const EXCURSION_TIMING = {
    baselineWindowMs: 6000, baselinePercentile: .15, baselineMinSamples: 6, baselineMinSpanMs: 600,
    // 基準より lower 以上低い値は基準に使わない（腕を一度垂らした・前かがみで床の物を拾った・前かがみで肩幅が広く見えた等で、休んだ位置が下へつられないように）。
    // 低いままなら、baselineWindowMs で古い値が消えてから今の位置で覚え直す（belowReanchorMs があれば、それだけ続いたら）。
    // anchor の単位（中央値）は、基準から lower より離れたまま（どの単位も上げていない間に）baselineWindowMs たったら覚え直す
    belowReanchorMs: null,
    // 戻った：基準から lower 以内か、上げた高さの releaseFraction まで戻った
    releaseFraction: .5,
    // 時間（ms）。上げた／戻したは holdMs 続いたら確定（どれもゆっくりした運動なので、点のぶれで確定しないよう座って足踏みより長い）。
    // 上げていた時間が minUpMs 未満は数えない（関節の点が一瞬跳んだもの）。
    // 前の1回から sameGapMs はあける。見えない部位の値は freshMs まで前の値を使う。
    // 見えない時間が invalidResetMs（上げている間は invalidUpResetMs）を超えたら、その1回は数えずに作り直す（基準は baselineWindowMs まで残す）。
    // maxUpMs：上げたままこの時間を超えたら数えずに作り直す（null は無制限）。基準は残し、そこから一度下がって、しきい値ぶん上がり直すまで次は数えない
    holdMs: 200, minUpMs: 300, sameGapMs: 650, freshMs: 300, invalidResetMs: 900, invalidUpResetMs: 4000, maxUpMs: null,
    // gapKeepMs：見えない間・フレームが来ない間（invalidResetMs より長い）のあとも、その前の基準を使い続ける長さ。この長さまでは、見えなかった時間を
    // 基準の値の古さに数えず、上げている途中で長く見えなかったときも基準は残す（その1回は数えず、一度下ろすまで上げ始めとみなさない）。
    // 見えたらすぐ動いている人の動いた姿勢（腕を上げた・肩を上げた・横へ倒した）を基準に覚えると、そのあと1回も数えないことがあった。
    // 残した基準は、見えてから止まった位置で確かめ、違う位置で休むようになっていれば（見えない間に腕を垂らした・少し傾いて座り直した等）そこで覚え直す。
    // 端末サービスは映像が止まると 120秒まで開き直しを続け、画面は端末サービスの再起動を 60秒までつなぎ直し続ける（local-sensor.js の RECONNECT）ので、
    // その間に戻ったときに使えるよう 120秒。null なら残さない（見えない間も値は古くなる）
    gapKeepMs: 120000,
    // 体の大きさ・位置が急に変わったフレーム（後ろを別の人が通り、姿勢推定がその人へ移った等）は使わない。
    // 肩幅・腰幅・胴の長さ（画像）のうち測れた2つ以上が、そろって bodyScale 倍より大きく／小さく変わった、腰の深度が bodyDepthMeters より変わった、
    // 腰（見えなければ肩）の中心が1フレームで肩幅の bodyJump 倍より横へ跳んだ、のどれか。基準の大きさは bodyRefMs でならして追う。
    // 戻ってから bodyResumeMs 続けて元の体なら使い直す。bodyAdoptMs 続けば、その体を新しい基準にして初めから測り直す（近づいて座り直した等）
    bodyScale: 1.25, bodyDepthMeters: .4, bodyJump: .5, bodyRefMs: 2000, bodyResumeMs: 300, bodyAdoptMs: 2000
  };
  // ゆっくり腕上げ：手首の高さが、下ろしていたときからどれだけ上がったか。画像は手首の y（胴の長さ＝肩〜腰を1とする）、深度は手首の高さ（m）。
  // 肩ではなくカメラに対する高さで測るので、前かがみ（肩が手首の方へ下がる）は上げたことにならない。
  // .25 胴 ≒ 12cm：手をももに置いて座った人なら横へ約55〜60°、腕を垂らした人なら約40°。肩より上（以前のしきい値）までは要らない
  const ARM_LIMITS = {
    ...EXCURSION_TIMING,
    floor2d: .25, lower2d: .08, fullRange2d: 1,
    floor3d: .10, lower3d: .035, fullRange3d: .48,
    // 両腕が映っているときは、低い方の腕もしきい値の半分以上（片手で顔をさわっただけでは数えない）
    bothFraction: .5,
    // ただし片腕だけでも、手首が肩より胴の overhead2d 倍（深度は overhead3d m）以上高ければ数える（肩が痛くて片腕しか上がらない人。
    // 以前の判定も、ももに置いた反対の手との平均でここを数えていた。顔をさわる手は肩より胴の約 .3 倍）
    overhead2d: .9, overhead3d: .43,
    // 手首が体の真ん中（両肩の中点から肩幅の lateralMin 倍以内）にあるうちは、上げ始めとみなさない（両手・片手で顔や髪をさわる）。
    // 前へ上げた腕は肩の前（肩幅の約 .5 倍）なので届く。頭の上（overhead）まで上げたときは問わない
    lateralMin: .3,
    // 腰が見えないときの胴の長さ：肩幅（縦横比で縦の単位に直す）の 1.3 倍
    shoulderSpanTorso: 1.3,
    // 手首の深度が肩から前後にこれ以上離れたら背景を拾ったとみなし、画像で測る
    wristDepthMeters: .8,
    // 腰が休んだ高さからこれ以上（画像は胴の長さの倍、深度は m）上がったら立ち上がっている：上げ始めとみなさず、上げている途中なら戻しても数えない。
    // .25 胴・.12m：座って立つと約 .45m 上がる。腕を上げながら背伸び（かかと上げ、約7cm）するのは数える。
    // 腰が上がった・下がったまま standRebaseMs たったら（立ち上がった・座った）、今の姿勢で休んだ位置を覚え直す（立ってすぐ上げた腕も数える）
    hipRise2d: .25, hipRise3d: .12, standRebaseMs: 500,
    // 手首が肩より下のまま10秒「上げた」ままなら、上げたのではない（腕を垂らして座っていた人が手をももに置いた等）：数えずに覚え直す。
    // 肩より上で止めているのは何秒でも待つ
    maxUpMs: 10000
  };
  // ひざ伸ばし（脚ごと）：すねの縦の長さが、休んだときからどれだけ縮んだか（画像は休んだときを1とした割合。深度はすねの向きの cos の減り）。
  // 深度：すねが前へ約28°（.12）、そのとき足首は約5cm 上がる。画像だけ：正面のカメラでは、すねがカメラの方を向くので縦の長さが縮みにくく、
  // 約65〜70°伸ばしてやっと .25 縮む（それより小さいと数えられない）
  const KNEE_LIMITS = {
    ...EXCURSION_TIMING,
    floor2d: .25, lower2d: .10, fullRange2d: .8,
    floor3d: .12, lower3d: .05, fullRange3d: .7,
    // ひざが休んだ高さから kneeLift3d m（画像は休んだすねの長さの kneeLift2d 倍）より上がったら、ひざ伸ばしではない（足踏み・足を組む）。
    // そのあいだは上げ始めとみなさず、上げている途中なら戻しても数えない（足踏みはひざごと上がり、すねも前へ振れる。記録では 6〜30cm 上がる）
    // 深度は、伸ばすとき もも も椅子から上がる（PC の記録 2026-10-11：ひざが 8〜14cm 上がる）ので、ひざの曲がり（kneeOpen3d）が開いたかで見分け、
    // ひざの高さは足踏み・立ち上がり・足を組むくらい大きく上がったときだけ止める（PC の記録：伸ばすときは8〜14cm、0.16m なら足踏みの記録2本で0回・ひざ伸ばしの記録で約29回）
    kneeLift2d: .15, kneeLift3d: .16,
    // 深度：ひざの曲がり（腰・ひざ・足首の角度。度を100で割った値）が休んだときより kneeOpen3d（25°）以上開いていること
    kneeOpen3d: .25,
    // 深度：足首が休んだ高さから ankleRise3d m 以上上がっていること（足を床で前へ滑らせると、すねは傾くが足首は床のまま）
    ankleRise3d: .03,
    // 伸ばした脚は、反対の脚より（しきい値を1として）これ以上大きいこと（体ごと後ろへ傾いて両脚が少し上がったのは数えない）。
    // 両脚ともしきい値を超えたときは、大きい方の1回だけ数える
    dominance: .5, bilateralQuietMs: 1000,
    // 伸ばしたところで一度止める運動なので、0.4秒未満の伸ばしは数えない（点のぶれ・足を滑らせたもの）。
    // 伸ばしたまま長く止めるのは数える。30秒を超えたら（脚を伸ばして休んでいる）数えずに作り直す
    minUpMs: 400, maxUpMs: 30000,
    // 左右のひざの画像上の並びが逆になった（推定の左右の取り違え）フレームは1秒まで使わない
    orderMarginU: .03, orderSwitchMs: 1000,
    // 深度のすねの長さ（ひざ〜足首、m）がこの範囲の外なら、どちらかの深度の誤り
    shankMinMeters: .2, shankMaxMeters: .7,
    // 深度のもも（腰〜ひざ、m）がこれより短ければ、腰かひざの深度の誤り（ひざの曲がりを確かめない）
    thighMinMeters: .15
  };
  // 椅子から立つ：腰（左右の中点）がどれだけ上がったか。画像は座ったときの胴の長さを1とし、深度は m。
  // .18 胴・.085m ≒ 腰が座面から約9cm 浮いたところ（以前の判定が、カメラ .7m・2.6m で数えていた高さ）。前かがみ・かかと上げ・足を滑らせるは届かない。足元は映らなくてよい
  const STAND_LIMITS = {
    ...EXCURSION_TIMING,
    floor2d: .18, lower2d: .07, fullRange2d: .9,
    floor3d: .085, lower3d: .035, fullRange3d: .45,
    // 座るときは上がった高さの4割まで下りたら戻ったとみなす
    releaseFraction: .4,
    // 立って始めて座った（腰が基準より下がった）ときは、1秒で座った高さを覚え直す
    belowReanchorMs: 1000,
    // 見えない間のあとの基準は残さない（立った人を基準に覚えても、座れば belowReanchorMs で覚え直せる）。記録では、見えない間をはさんで
    // 残した腰の深度の基準と、深度の一瞬の外れ値を比べて、1回余計に数えた
    gapKeepMs: null
  };
  // 立って横ステップ：両足首の横の開きが、そろえたときからどれだけ広がったか（肩幅を1とする。深度は m）。開いて、そろえたら1回。
  // .30 肩幅 ≒ 11cm、.10m（小さな一歩）。体重の移動・その場の足踏み（4cm）は届かない
  const STEP_LIMITS = {
    ...EXCURSION_TIMING,
    floor2d: .30, lower2d: .12, fullRange2d: .8,
    floor3d: .10, lower3d: .04, fullRange3d: .30,
    // 肩が見えないときの肩幅：腰の点の幅の 1.8 倍
    hipShoulderRatio: 1.8,
    // 立っている間だけ数える。画像上の「腰〜ひざの縦の差」が胴（肩が映らなければすね）の seatedRatio 倍未満なら座っている（座ったまま足を横へ動かすのは数えない）。
    // 立ち直ったとみなすのは standRatio 倍以上が standMs 続いてから（記録で座って .3〜.6、立って .72〜.99。模型で座って .0〜.6、立って約 .95〜1.1）
    seatedRatio: .65, standRatio: .7, standMs: 500,
    // 足首が画面の外（位置案内は「少し離れて」と言う）：腰の左右の中点が、立っていた位置から横へ動いた幅（向きは問わない）。
    // 一歩踏み出しただけでは腰は半分ほどしか動かないので、足をそろえて腰が一歩ぶん動いたところで数えるよう、足首より大きくする（.50 肩幅 ≒ 18cm、.18m）。
    // 動いた先で止まったら（settleMs の間、しきい値の settleBand 倍の幅に収まったら）戻ったとみなして1回、立っている位置を覚え直す
    hipFloor2d: .50, hipLower2d: .20, hipFloor3d: .18, hipLower3d: .07,
    settleMs: 500, settleBand: .25,
    // 両足首の深度が前後にこれ以上離れたら、どちらかの深度の誤り
    ankleDepthMeters: .8
  };
  // 座っている・足を止めている間だけ数える（updateExcursionCounter）。どちらかが外れたら、その間は見えないのと同じに扱う。
  // 座っている：腰の深度があれば、座っている間に覚えた腰の高さ（直近 hipRestMs の中央値）から、standRise3d m 上がったら立った、
  // sitRise3d m より下へ戻ったら座った（座って立つと腰は .2〜.3m 上がる。2026-10-08 の PC の記録で、座り直した先の席は .08m 高かった）。
  // ひざが映っていて、比（下）が立ったと言い、腰も ratioRise3d 上がったら、それより小さな上がりでも立った（ゆっくり立ち上がる途中で止まった高さを
  // 座った高さとして覚えても、立ったら閉じる）。
  // 深度がなければ、ひざが映っていれば画像上の「腰〜ひざの縦の差」と胴（肩〜腰）の比：standRatio 倍以上で立った、seatedRatio 倍未満で座った
  // （座るとももがカメラを向いて短く見える。記録で座って .4〜.74、模型で .1〜.6、立つと .78〜1.4。記録の座った間に .78 を超えたことはない）。
  // どれも seatHoldMs 続いたら切り替える（境の近くの1フレームで切り替えない）。
  // ひざが映らないとき（上半身だけの運動）は、深度がなければ腰の画像の高さの上がりを胴の長さで割り、standRise2d 以上で立った、sitRise2d 未満で座った
  // （模型で立つと胴の約1、PC の記録で半分立ち上がって .41、座り直した先の席は .3 高い、座って止めている間の揺れは .03 まで）。胴の長さが座っていたときの
  // nearTorso2d 倍より長ければ、カメラのすぐ前に立った人（座ったまま椅子ごとそこまで近づくと、腰は画面の下から出る）。
  // 座った高さは、見えない間（invalidResetMs より長い）のあとも gapKeepMs まで残し、戻ってきた体をそれと比べる（立ったまま戻ってきた人・前を通った人を
  // 座ったとしない）。腰の高さで座ったと言えないまま、腰が adoptMs 止まった（上下の幅が adoptStill3d m・画像は胴の adoptStill2d 未満）ら、そこを
  // 座った高さとして覚え直す（前と違う高さの席へ座り直した）。ただし、ひざが映っていれば比が座ったと言うときだけ、ひざが映らなければ、座っていない間に
  // いちばん上がった高さから adoptDrop3d m（画像は胴の adoptDrop2d、胴の長さも座っていたときと adoptTorso 以内）以上腰を下ろしてから
  // （立った高さで止まったのを座ったとしない）。座った高さをまだ覚えていない（見え始め）・見えない間のあとで決められないときは、確かめている言葉のまま
  // 数えず、腰が止まったら、そこを座った高さとして覚える（ひざも深度もなければ、立って始めた人とは区別できない）。
  // 座ったまま、腰が覚えた高さより adoptDrop 以上低いまま seatHoldMs 続いたら（途中まで立って止まった高さを覚えていて、そこから座り直した）、
  // 基準を忘れる（途中まで立った姿勢で覚えた基準では、座ってからの1回を数えなかった）。座った高さが追いつくまでは、腰が動けば忘れ直す。
  // 足を止めている：ひざごと（画像上の並びで左右を決める）に、高さ（深度があれば 3Dの点の y÷z、なければ画像の高さ。どちらも画像の高さそのもの）を
  // stillMedianMs の中央値でならし（点の一瞬の跳びを除く）、直近 stillRefMs の中央値からの上がりを、深度があれば直近 stillRefMs の深度の中央値を掛けて m に
  // （深度が背景・ひざの前の手へ跳んでも、上がりは生まれない）、なければ胴の長さで割る。直近 stillMs の上から stillUpMs ぶんの高さが stillRise3d m
  // （画像は stillRise2d）以上上がったら（上がったまま stillUpMs 続いた）、ひざを上げた。
  // 上へだけ見る：画面の下の端に近いひざの点は、座って止めていても下へ揺れる（PC の記録で 3〜7cm）が、足踏みのひざは上へ上がる（6〜35cm。上げている間は
  // 記録で多くが 0.5〜0.8秒）。座って止めている間の上への揺れは、記録で .023m・胴の .06 まで。模型で6cm 上げる足踏みは、画像で胴の .1〜.13 上がる。
  // 0.3秒だけ 5〜8cm 跳ぶ点の揺れでは閉じない（記録の足踏みは、続く長さだけで見ても、閉じた足踏みの数は同じ）。4cm 以下の小さな足踏みも閉じない
  // （深度あり・なしとも）。
  // 腰の深度（両腰の中点の stillMedianMs の中央値。直近の中央値から hipJumpMeters 以上離れたフレームは使わない）の直近 stillMs の幅（上下 stillTrim を除く）が
  // stillShiftMeters 以上なら、椅子の上で前後へずれた（PC の記録で、座って止めている間 .04m まで、座り直して後ろへずれると .15m、前へずれると .13m）。
  // 上げている間（数える1回の途中）は、上げる前に休んでいた腰の深度から stillUpMs 続けて stillShiftMeters 以上ずれても、ずれたとみなす
  // （ひねったまま、ゆっくり・見え隠れしながら前へずれた）。
  // ひざが映らないときは、ひざの代わりに、腰の深度の高さ（stillMedianMs の中央値）の直近 stillMs の幅（上下 stillTrim を除く）が stillBob3d m 以上なら
  // 足踏み（PC の記録で、足踏みの間 .03〜.04m、座って止めている間は .01〜.02m、半分を超えるのは座り直し・立ち上がりのときだけ）。深度がなければしない。
  // ひざを上げた・前後へずれた・腰が上下したら「足の裏を床につけたまま」と言い、基準も覚え直す（小さな揺れでは何もしない）。
  // legStill: false の運動は、ひざと腰の上下の確かめだけしない
  // restRelearnMs：基準（休んだ位置）がまだ確かでない間だけの覚え直し。始まってすぐ・再開してすぐ・見えない間のあとに動き出して、
  // 動いた姿勢（肩を上げた・腕を開いた・横へ倒した）を基準に覚えてしまっても、本当の休んだ位置へ戻れば数えられるように。
  // 確かになるのは、基準の近く（上下とも lower 以内）から上げた1回を数えたとき（左右の単位は左右とも）。基準を覚え直すと、また確かでなくなる。
  // 基準より lower 以上低いまま restRelearnMs 続いたら、そこで覚え直す（belowReanchorMs と同じ。両腕・両肩は、ほかの腕・肩が上がっていないとき）。
  // anchor の左右の単位（体の横倒し・体ひねり）は、止まった位置（baselineMinSpanMs の間 lower の幅に収まった）を順に覚え、基準の近く・X・
  // X の反対側の Y・X のように、基準から floor 以上離れた X へ戻りながら X の両側へ動いていたら、X が本当の休んだ位置（基準は片側へ倒したところ）
  // とみなして、X に止まっていた間の値で覚え直す。見えない間（gapKeepMs）のあとも、基準は確かでなくなる（見えない間に座り直したかもしれない）
  const SEATED_GATE = {
    seatedRatio: .75, standRatio: .78, standRise3d: .12, sitRise3d: .09, standRise2d: .35, sitRise2d: .2, ratioRise3d: .05, seatHoldMs: 300, hipRestMs: 3000,
    adoptMs: 1500, adoptStill3d: .03, adoptStill2d: .1, adoptDrop3d: .1, adoptDrop2d: .3, adoptTorso: .2, nearTorso2d: 1.5, hipJumpMeters: .12,
    legStill: true, stillMs: 1500, stillRefMs: 3000, stillMedianMs: 300, stillTrim: .1, stillUpMs: 350, stillRise3d: .04, stillRise2d: .1,
    stillShiftMeters: .1, stillBob3d: .025,
    restRelearnMs: 600
  };
  // 座ってひざの開閉：両ひざの横の開きが、閉じたときからどれだけ広がったか。深度は m、画像は胴の長さを1とする。開いて閉じたら1回。
  // 深度：両ひざで 10cm 開く（片ひざ 5cm）。画像だけ：ひざは肩・腰より約45cm カメラに近く大きく写るので、10cm の開きは胴の .25〜.32 になる。
  // 記録（足踏み中の座った静止）で、ひざの開きの揺れは深度 3cm 以下
  const KNEE_OPEN_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    floor2d: .22, lower2d: .09, fullRange2d: .7,
    floor3d: .10, lower3d: .04, fullRange3d: .30,
    // 10秒開いたまま（ひざを開いて座り直した等）は数えずに、その位置から覚え直す
    maxUpMs: 10000,
    // 両ひざの深度が前後にこれ以上離れたら、どちらかの深度の誤り
    kneeDepthMeters: .3
  };
  // 座って足を横へ：片足ずつ、足首が休んだ位置から体の外へどれだけ出たか（足首の横の位置。深度は m、画像は胴の長さを1とする）。
  // 外へ出してもどしたら1回（脚ごとに数え、左右を返す）。深度：10cm 外へ出す。画像だけ：足首は肩・腰よりカメラに近く大きく写るので、
  // 10cm は胴の .25〜.3 ほど（座ってひざの開閉と同じ見方）。両足いっしょに開いたのは、大きい方の1回だけ（反対の足より dominance 大きいこと）。
  // 足は動かす運動なので「足を止めている」の確かめ（ひざの上下）はしない（legStill: false。座っているか・椅子の上でずれたかは確かめる）。
  // 数えないもの：足首が休んだ高さから ankleLift より上下した（足踏み・足を組む・脚を上げる・前へ出す。足は床をすべらせる運動）
  const LEG_OUT_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    legStill: false,
    floor3d: .10, lower3d: .04, fullRange3d: .30,
    floor2d: .25, lower2d: .10, fullRange2d: .7,
    ankleLift3d: .08, ankleLift2d: .2,
    // 画像だけ：すねの画像の長さが胴の shankChange2d より変わったら、ひざを伸ばした・足を前へ出した（カメラの方へ出た足首は、画像では外へ動いて見える）
    shankChange2d: .15,
    dominance: .5, bilateralQuietMs: 1000,
    minUpMs: 400, maxUpMs: 10000,
    orderMarginU: .03, orderSwitchMs: 1000,
    // 足首が 0.3秒より長く見えなかったあとは、見えた位置から外へ出すのを待つ（判定側の seeRiseMs の説明）
    seeRiseMs: 300,
    // 足首と腰の深度の差がこれより大きければ深度の誤り（座ると足首は腰より約45cm 手前）
    ankleDepthMeters: .9
  };
  // 座って体ひねり：両肩を結ぶ線の向き（深度で測る。カメラを向いて 0°、左へひねると＋）が、休んだ向きからどれだけ回ったか（°）。
  // 左・右それぞれ、ひねってもどしたら1回（どちらへ回ったかを返す）。休んだ向きは中央値（斜めに座っている人もそこから測る。記録の人は約25°斜め）。
  // 記録の座った静止で、肩の向きの揺れは1秒に 10° ほど。それより十分大きい 20° をしきい値にする。
  // 深度のないとき（ブラウザのカメラ）：肩幅（胴の長さとの比）がどれだけ狭く見えたか（割合）。向きは分からないので左右は返さない。
  // .22 狭く ≒ 約40° ひねる（体の揺れで数えないよう控えめ。斜めに座った人が正面へ戻す向きは狭くならないので数えない）。
  // 前かがみ・後ろへもたれると胴が短く見えて肩幅の比が変わるので、胴の長さ（画像）が休んだときから torsoChange2d より変わったら上げ始めとみなさず、
  // 上げている途中なら戻しても数えない（ひねりでは胴の長さはほとんど変わらない）
  const TWIST_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    floor3d: 20, lower3d: 8, fullRange3d: 45,
    shrinkFloor2d: .22, shrinkLower2d: .08, shrinkFullRange2d: .45,
    torsoChange2d: .06,
    // 左右のひねりは同じ向きの正と負なので、反対側より大きいかの比べ（脚ごとの運動と同じ仕組み）は、いつも満たす
    dominance: .5, bilateralQuietMs: 0,
    // 8秒ひねったまま（横の人と話す・テレビの横を見る等）は数えずに作り直す。休んだ向きは残し、そこへ戻るまで左右とも数えない
    maxUpMs: 8000,
    // 両肩の深度の差がこれより大きければ深度の誤り（肩の点の幅は約36cm）
    shoulderDepthMeters: .45,
    // ひざが映らないときの「足を止めている」の確かめ（腰の上下）：ひねると腰の点も上下に 2.5〜4.5cm 揺れる（PC の記録 2026-10-11）ので、
    // ほかの座ってする運動の 2.5cm でなく 6cm にする（2.5cm のままでは、ひねるたびに閉じて、約15回のうち6回しか数えなかった）
    stillBob3d: .06
  };
  // 肩の上げ下げ：両肩の高さが、下ろしていたときからどれだけ上がったか。深度は肩の高さ（m）、画像は肩の y（胴の長さを1とする）。
  // 両肩を上げて下ろしたら1回。深度：3cm 上げれば数え、深い呼吸（約1.6cm）は届かない。画像だけ：胴の .05 ≒ 2.4cm。
  // 両肩とも上がること（低い方の肩も bothFraction 以上。片方の肩だけ上げる・首をかしげるのは数えない）。
  // 姿勢推定は腕を上げると肩の点も上へずらすので、手首が肩に対して休んだときから胴の armRise2d 倍（深度は armRise3d m）より上がったら、
  // 肩の上げ下げではない（腕上げ・顔をさわる）。腰が休んだ高さから胴の hipRise2d 倍（深度は hipRise3d m）より上がったら、立ち上がり（肩もいっしょに上がる）。
  // 肩を上げたまま6秒（肩をすくめて座り直した等）は数えずに作り直す。耳の点は使わない（深度カメラの関節は 11〜28 だけ）
  const SHRUG_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    floor3d: .025, lower3d: .01, fullRange3d: .08,
    floor2d: .05, lower2d: .02, fullRange2d: .2,
    bothFraction: .7,
    armRise2d: .2, armRise3d: .10,
    hipRise2d: .12, hipRise3d: .06,
    // 腰から見た両肩の深度（平均）が休んだとき（中央値）から前後にこれ以上変わったら、深度の跳び（背景を拾った）か前かがみ：数えない
    shoulderShift3d: .1,
    // 下がった位置で覚え直す（restRelearnMs）のは、腰から見た両肩の深度が relearnShift3d m・肩幅（画像）が relearnShift2d の割合より変わっていないときだけ
    // （前かがみでも、画像の肩は下がって見える。前かがみを休んだ位置にすると、起き上がるたびに数えてしまう。2〜3m 離れて 25° の前かがみで肩幅は 7〜11% 広がる）
    // 点のぶれ（肩幅で数%）で外れないよう、直近 relearnSmoothMs の平均で比べる。.05 では 2.6m より遠い前かがみを、ぶれの大きいときに通してしまった
    relearnShift3d: .05, relearnShift2d: .04, relearnSmoothMs: 500,
    maxUpMs: 6000,
    // 腕を上げている間（armRise）に一緒に上げた肩を、腕を下ろしてから guardHoldMs 上げたままにしたあと下ろしたのは数える（EXCURSION_UNITS の guardFloor）
    guardHoldMs: 400,
    // 手首の深度が肩より前へ wristDepthMeters・奥へ wristBehindMeters より離れたら背景を拾ったとみなし、腕の確かめは画像で
    // （座って腕を下ろした・ももに置いた手首は肩より奥へ行かない。手首が奥の背景を拾うと、3Dの点が下がって見えて上げた肩を数えなかった）
    wristDepthMeters: .8, wristBehindMeters: .15
  };
  // 座って腕の開閉：手首ごとに、体の真ん中（両肩の中点）から横へどれだけ離れたか。深度は m、画像は肩幅を1とする。
  // 胸の前で手を合わせて（休んだ位置）、両腕を横へ開いて、もどしたら1回。深度：片手 14cm 外へ（肩の正面から約15°より大きく開く）、画像だけ：肩幅の .55。
  // 手首が胸の高さ（肩から下へ胴の chestBelow2d 倍・上へ chestAbove2d 倍まで。深度は m）にあるときだけ測る（ももに置いた手・頭の上の手は測らない）。
  // 両腕とも開くこと（低い方の腕も bothFraction 以上。片腕だけ開くのは数えない）。
  // 開く前に、手を胸の前（両手首の間が肩幅の closedGap2d 倍・closedGap3d m 以内）に restMs そろえていたこと（ももの手を横から上げる腕上げは数えない）。
  // 手首が肩より胴の chestAbove2d 倍（深度は chestAbove3d m）より上へ出たら、腕を頭の上へ上げたので数えない
  const ARM_OPEN_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    floor3d: .14, lower3d: .05, fullRange3d: .45,
    floor2d: .55, lower2d: .2, fullRange2d: 1.6,
    bothFraction: .5,
    chestBelow2d: .65, chestAbove2d: .5, chestBelow3d: .30, chestAbove3d: .25,
    closedGap2d: 1.6, closedGap3d: .5, restMs: 300,
    // 両肩の深度の差・手首と肩の深度の差がこれより大きければ深度の誤り（画像で測る）。
    // 胸の前・横へ開いた手首は肩より奥へ行かないので、肩より wristBehindMeters 奥の手首も背景を拾ったとみなす
    shoulderDepthMeters: .45, wristDepthMeters: .8, wristBehindMeters: .15,
    // 10秒開いたままは数えずに作り直す
    maxUpMs: 10000
  };
  // 座って体の横倒し：上半身の傾き（腰の中点から両肩の中点への向き、°。本人の左へ倒すと＋）が、まっすぐ座った向き（中央値）からどれだけ倒れたか。
  // 左へ・右へ、倒してもどしたら1回ずつ（どちらへ倒したかを返す）。7° から数え、3° 以内に戻ったら（または倒した角度の半分まで）戻ったとみなす。
  // 深度（両肩・両腰）があれば3Dの点の正面の面での傾き、なければ画像の傾き（両肩の高さの差で測ると、片腕を高く上げたとき肩の点がずれて数えてしまう）。
  // 画像の傾きは、カメラの正面から横へずれて座った人が前かがみになると、近づいた肩が画像の外側へ動いて傾いて見える。
  // 数えないもの：
  // ・両肩の線の傾き（°）が、休んだときから roll より傾いていない。体を 7° 倒せば肩の線も 7° ほど傾くが、前かがみの人がひねる
  //   （肩の中点が横へ動く）・カメラの正面から横へずれて座った人の前かがみ（画像で、近づいた肩が外側へ動く）では、肩の線はほとんど傾かない
  // ・肩の線の長さ（画像は両肩の点の間、深度は正面の面での両肩の幅）が、休んだとき（中央値）から narrow の割合より短くなった（大きくひねった。
  //   倒しながら少しひねるのは数える。正面の面で倒すだけなら肩の線の長さは変わらない。前かがみで長く見えるのは問わない）
  // ・手首が、同じ側の肩と腰の外側（体の横の線）より、休んだときから肩幅の reach2d 倍（深度は reach3d m）より外へ出た（横の物へ手をのばす）。
  //   ももに置いた手・垂らした手は倒しても体の線の内側にある。点のぶれ・左右の取り違えで1〜2フレーム外へ出たのは数えなくしない（holdMs 続いたら）
  // ・休んだ向きから leanMax° より倒れた（床の物を拾うなど、大きく体を倒した）。
  // 8秒倒したままは数えずに作り直す
  const SIDE_BEND_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    floor2d: 7, lower2d: 3, fullRange2d: 20,
    floor3d: 7, lower3d: 3, fullRange3d: 20,
    // 左右の倒しは同じ傾きの正と負なので、反対側より大きいかの比べ（脚ごとの運動と同じ仕組み）は、いつも満たす
    dominance: .5, bilateralQuietMs: 0,
    maxUpMs: 8000,
    // narrow：肩の線の長さが休んだときより縮んだ割合（ひねった・前かがみ）。左へ小さく倒しただけで 12〜15% 縮んで見えることがある
    // （PC の記録 2026-10-11。.12 では左へ倒した1回を数えなかった）ので .16
    roll2d: 5, roll3d: 5, narrow2d: .16, narrow3d: .16,
    reach2d: .7, reach3d: .25,
    // 大きく倒すのは数える（よしさん 2026-10-11「強く倒すと数えない」。PC の記録の一番大きい倒しは31°）。床の物を拾う（手が床へ届く 55°ほど）は数えない
    leanMax2d: 45, leanMax3d: 45,
    // 両肩の深度の差・肩と腰の深度の差・手首と肩の深度の差がこれより大きければ深度の誤り（画像で測る）
    shoulderDepthMeters: .45, wristDepthMeters: .8
  };
  // 座ってかかと上げ：両ひざの高さが、かかとを下ろしていたときからどれだけ上がったか。深度はひざの高さ（m）、画像はひざの y（胴の長さを1とする）。
  // 両ひざとも上がること（低い方も bothFraction 以上）。つま先を床につけてかかとを上げると、足首とひざは かかとの上がりの約 .7 倍上がる
  // （かかと 3〜7cm でひざ 2〜5cm）。深度：2cm、画像だけ：胴の .06（2m で約 2.3cm。座った静止の点の揺れ .05 に近く、小さな上げは数えにくい）。
  // ひざが画面の下の端に近いと、画像のひざの点が下へだけ 2〜6cm、数フレーム〜十数フレーム跳ぶ（2026-10-08 の記録、手前の席の右ひざ。3Dの高さも画像の点から
  // 求めるので同じだけ跳ぶ）。そのため、片方のひざだけが急に下がったときは直近 spikeHoldMs の一番高い値を使い（判定側の spikeHoldMs の説明。
  // 上げている途中の跳びで戻したとみなして1回を2回に数えない）、左右の差もその値で比べ（跳んだ側だけ下がって見えるのを片足の動きとみなさない）、
  // 基準は低い方から30%にする（跳んだ低い値に基準を寄せない）。
  // ひざは動かす運動なので「足を止めている」の確かめ（ひざ・腰の上下）はしない（座っているか・椅子の上で前後へずれたかの確かめは残す。legStill: false）。
  // 数えないもの：左右のひざの高さの差が gap より開いた（足踏み・足を組む・片足だけ上げる）、腰が hipRise より上がった（座り直し・立ち上がり。
  // かかと上げでは腰は動かない。2026-10-05 の記録で、背もたれへもたれたときは画像の腰が胴の .07 上がった）、
  // 両肩の高さが shoulderMove より動いた（前かがみ・立ち上がる前の前傾）、腰から見た両肩の深度が lean より変わった（背もたれへもたれる：
  // 2026-10-05 の記録で、もたれると肩が 11cm 奥へ・4.5cm 下がり、ひざも 2〜3cm 上がった）、画像だけでは胴の長さが torsoChange の割合より変わった
  // （もたれると胴が短く見える。記録で 17%）。10秒上げたままは数えずに作り直す。
  // 基準より低いまま止まっても、そこで覚え直さない（restRelearnMs: null。両足を前へ 15cm 滑らせると、ひざは約 3cm 下がる。そこを休んだ位置にすると、
  // 足をもどすたびに数えた）。低いままなら、baselineWindowMs で古い値が消えてから覚え直す。
  // ただし、基準を覚え始めてから（覚え直してからも）startWindowMs のうちで、まだ1回も数えておらず、基準の近く（両ひざとも、直近 restTrustMs の
  // 20〜80% の値が基準から floor 以内）にいたこともない間は、両ひざがそろって基準より lower 以上低いまま startRelearnMs 続いたら、そこで覚え直す
  // （すぐにかかとを上げ始めた人・模擬カメラの、上げた位置・上げる途中を基準に覚えると、そのあと1回も数えなかった。足を滑らせるのは、じっと座ったあと
  // なので覚え直さない。かかと上げの、上げて止める間は 2秒より短い。ひざの点の一瞬の跳びは 20〜80% から外れ、1秒より短い）。
  // 腰の確かめ（hipRise）が止めている間（途中まで立った・座る途中で止まった）は、両ひざの値を基準に覚えない（そのときのひざの高さを覚えると、
  // 座ってから下ろした位置が、ずっと基準より低いままになった）
  const SEATED_HEEL_LIMITS = {
    ...EXCURSION_TIMING, ...SEATED_GATE,
    legStill: false, restRelearnMs: null,
    startRelearnMs: 1000, startWindowMs: 10000, restTrustMs: 2000,
    baselinePercentile: .3,
    floor3d: .02, lower3d: .01, fullRange3d: .06,
    floor2d: .06, lower2d: .03, fullRange2d: .18,
    bothFraction: .6,
    gap3d: .03, gap2d: .1,
    hipRise3d: .03, hipRise2d: .06,
    shoulderMove3d: .05, shoulderMove2d: .1,
    lean3d: .08, torsoChange2d: .08,
    spikeHoldMs: 400,
    maxUpMs: 10000
  };
  // 立ってする脚の運動（立ってかかと上げ・浅いスクワット）：立っている間だけ数える。座っていると決めたら数えず、基準も忘れる（「立って、ゆっくり動きましょう」）。
  // 主な手がかりは、腰が「座っていた間の腰の高さ」（直近 seatRefMs の中央値）からどれだけ上がったか（深度は m、画像は座っていたときの胴の長さを1とする）：
  // standRise 以上が standMs 続き、その間の腰の上下が settle に収まり、下の奥行きの差・画像の比が座った側でなくなったら立った
  // （立ち上がる途中で腰を止めた・まだひざが前にある間の腰を、立って休んだ位置として覚えないように）、seatRise 未満なら座った。2026-10-08 の記録で、手前の席から立つと3Dの腰は .20〜.23m 上がった
  // （カメラが少し下を向いているので、カメラへ近づくと上がりは小さく見える。奥の席から立ってカメラの方へ歩くと .11〜.14m）。
  // 座り直し・奥の席へ移るのは .1m 以下。前かがみ・ひざを少し曲げて立っても、腰の上がりはほとんど変わらない。
  // 座っていた腰の高さがまだない（立って始めた）・その中間の高さのときは、腰とひざの奥行きの差（深度。座るとひざが前へ出る。記録の座った間の中央値
  // .20〜.32m、立って .01〜.06m）の直近 postureSmoothMs の中央値が seatedGap より大きければ座った、standGap より小さければ立った
  // （ひざを 10〜15° 曲げた立ち姿勢は .05〜.10m）。深度のない画面（ブラウザのカメラ）では、画像の「腰〜ひざの縦の差」と胴の比で（横ステップと同じ。
  // 2026-10-08 の奥の席では座って .70〜.75 と立った値に近いので、立ったとするのは standRatio 以上。始めにその間の値なら座っているとする）。
  // 立ってかかと上げは、立ったと決めてから restandMs の間に、腰がさらに restand 上がって restandHoldMs 止まったら（立ち上がる途中で一度止まった）、基準を覚え直す
  // （浅いスクワットでは、腰が基準より上がったのは下ろす向きの逆なので、belowReanchorMs で覚え直す）。腰を下ろしている途中（どれかの単位が上げている・上げかけ・e が .4 より上）は、
  // ひざが前へ出ても、奥行きの差・画像の比では座ったと決めない（腰の上がりでは決める：座ったのと同じ高さまで下ろしたら座った）。
  // 深度が一度でも取れた運動は、深度が途切れたフレームでは前の判断のまま（画像の比へ切り替えない）。
  // 奥行きの差・画像の比が立った側のまま standCueMs 続き、腰が止まっていれば、座っていた腰の高さからの上がりが小さくても立った（座っていた腰の高さを忘れる。
  // 作り直した直後の深いスクワットで、ひざが前へ出たのを座ったとみなすと、立っている間の腰の高さを座っていた高さとして覚え、ずっと「立って」のままだった）。
  // 座っていた腰の高さは、奥行きの差・画像の比が立った側のフレームでは覚えない
  const STANDING_POSTURE = {
    standMs: 500, standCueMs: 2000,
    standRise3d: .12, seatRise3d: .06, standRise2d: .3, seatRise2d: .15, settle3d: .04, settle2d: .08,
    seatedGap: .18, standGap: .12, seatedRatio: .65, standRatio: .78,
    postureSmoothMs: 500, seatRefMs: 3000
  };
  // 立ってかかと上げ：腰と両肩の高さが、かかとを下ろしていたときからどれだけ上がったか（深度は m）。腰も肩も上がること
  // （低い方も bothFraction 以上。肩の上げ下げ・腕上げは肩だけ）。深度 2.5cm（かかと約 3.5cm）、画像だけ 胴の .05（約 2.4cm）。
  // 画像は、画面の真ん中からの高さを、肩は今の胴の長さで、腰は体の横幅で割る（立った体が前後に揺れると、画像の腰・肩の高さは近づくほど真ん中から
  // 離れて見えるが、胴の長さ・横幅も同じ割合で変わるので打ち消せる。割らないと、カメラより高い肩は揺れだけで胴の .05 ほど上下した。腰を胴の長さで割ると、
  // 肩をすくめて胴が長く見えただけで、カメラより低い腰が上がって見えた。横幅は肩をすくめても変わらない。肩は横幅で割ると揺れが大きい）。
  // 数えないもの：腰が riseMax より上がった（座っていて立ち上がった）、画像の胴の長さが torsoChange の割合より holdMs 続けて
  // 変わった（カメラの方へ歩いた：カメラが下を向いていると、割っても近づいた体は上がって見える。前かがみ・おじぎ：胴が短く見えて、割った高さがずれる）、
  // 深度で腰から両肩までの高さが trunk m より変わった（前かがみから背を伸ばした：腰は動かず肩だけ上がる）、立つ位置が place より前後に動いた
  // （深度は腰の奥行き m、画像は体の横幅の割合。カメラの方へ歩いた・下がった）、画像だけで、腰〜足首の縦の差が基準の体の横幅の legs より holdMs 続けて
  // 変わった（少し下を向いたカメラの方へ出た・下がった：place に届かない 15cm でも、腰が上がって見えて数えた。かかとを上げても腰〜足首の差は
  // 変わらない。腰・肩が基準より低い間（ひざを曲げて立っていた）の値は、腰〜足首の差の基準に使わない。足首が見えなければ確かめない）。trunk・place は、動いたまま trunkRebaseMs・placeRebaseMs たったら、
  // 今の姿勢で基準を覚え直す（1歩近づいて止まった人を、そこからまた数える）。止められたまま spoiledUpMs 上げているのが続いたら、数えずに覚え直す。
  // 腰・肩が基準より下がったら（ひざを曲げた・床の物を拾った）、その前後 lowSettleMs の値と、基準より lower の半分より低い値は基準に使わない
  // （下りる途中・もどる途中の値で基準が下へつられ、浅いスクワットでもどるたびに数えた）。低いままでも、基準の値は lowKeepMs まで捨てない
  // （ゆっくりしたスクワットの間に古い値が消え、下りた位置を基準にした）。基準の値は baselineWindowMs、少なくとも新しい baselineKeepSamples 個を残す。
  // 10秒上げたままは数えずに作り直す。restSeed：下ろしている間に立つ位置が動いて作り直す（rebase）ときは、動いた先の休んだ側の値で覚える
  // （少し下を向いたカメラの前で、上げたまま 20cm 前へ出て下ろすと、立った位置が下りて見え、下ろし途中の値で覚えた基準からは上げても届かなかった）
  const STAND_HEEL_LIMITS = {
    ...EXCURSION_TIMING, ...STANDING_POSTURE,
    floor3d: .025, lower3d: .015, fullRange3d: .07,
    floor2d: .05, lower2d: .03, fullRange2d: .14,
    bothFraction: .6,
    riseMax3d: .15, riseMax2d: .32,
    torsoChange2d: .08, trunk3d: .03, trunkRebaseMs: 1000, place3d: .1, place2d: .08, placeRebaseMs: 1500, legs2d: .04,
    restandMs: 5000, restandHoldMs: 2500, restand3d: .05, restand2d: .1,
    lowSettleMs: 1000, lowKeepMs: 10000, spoiledUpMs: 2000, baselineWindowMs: 12000, baselineKeepSamples: 45,
    lockRelearnMs: 3000, plateauMs: 2000, lockFreshMs: 1000, lockLeg: .5, lockLegUp: .8, lockShape2d: .025, lockShape3d: .03,
    restSeed: true, maxUpMs: 10000
  };
  // 浅いスクワット：腰が、まっすぐ立っていたときからどれだけ下りたか（深度は m、画像は胴の長さを1とする。画像の高さは、画面の真ん中からの差を、胴の長さと腰の幅をかけた値の平方根で割る：どちらも腰と同じ奥行きの長さなので、カメラの方へ出ても変わらない。体の横幅（肩幅を含む）で割ると、上体を前へ傾けて肩が近づくと、カメラの高さによって腰が下りた分が大きく・小さく見え、高いカメラでは25°をほとんど数えなかった。腰の幅だけで割ると、腰の幅の点のぶれが大きく、点が大きくぶれると 30°も数えないことが増えた。胴の長さだけで割ると、上体の傾きで胴の長さが変わる分が残った）。腰を下ろして、もどしたら1回。
  // 深度 2cm・画像だけ 胴の .04（どちらも、ひざを約25°曲げたところ）。ひざを少し曲げて揺れる（約1cm）は届かない。
  // 基準は高い方（腰の下がりの小さい方）から30%（低い方からでは、立ってかかと上げで上がった腰に基準がつられて、下ろすたびに数えた）。
  // 数えないもの：腰が dropMax より下りた（椅子に座った：立って始めて座ると、腰は 19〜21cm 下りた。2026-10-08 の記録で、奥の席から立つと腰は .11〜.14m 上がった。
  // ひざを 65° 曲げると約15cm、75° の深いスクワットは座ったのと同じ 18cm なので数えない）、上体が前へ倒れた（おじぎ・床の物を拾う：
  // 肩が腰より bow 以上多く下がった。画像は肩・腰それぞれの横幅で割った高さの差。上体を約50° 倒したところ。スクワットで上体を少し前へ傾けるのは届かない）、
  // 立つ位置が place より前後に動いた（立ってかかと上げと同じ。画像は、上体を前へ傾けると肩幅が広く見えるので、立ってかかと上げより広く）、
  // 画像だけで、腰〜足首の縦の差が、基準の体の横幅の legs 以上縮んでいない（腰は下りていない。少し下を向いたカメラでは、カメラの方へ出た腰は
  // 下りたように見え、place に届かない 3〜25cm の前後の揺れ・1歩でも数えた。腰〜足首の差は、カメラの方へ出ると長く見える。画像の
  // 腰の高さは、カメラが下を向くほど点のぶれで揺れ、それだけで数えたこともあった。25°のスクワットで縮むのは横幅の約 .055。
  // 足首が見えなければ確かめない）。
  // 腰が基準より上がったまま belowReanchorMs たったら（立ち上がる途中で止まってから伸びた・1歩動いて止まった）、直近 reanchorSeedMs の値で覚え直す
  // （すぐ基準ができるので、覚え直した直後に腰を下ろしても数える。belowReanchorMs は、かかとを上げたまま止める約1.5秒より長く：
  // 上げた位置で覚え直すと、かかとを下ろすたびに数えた）。15秒下ろしたままは数えずに作り直す。基準の値は、baselineWindowMs より古くても新しい
  // baselineKeepSamples 個を残す（baselineWindowMs より長く下ろしていた間に基準の値がすべて消え、もどる途中の位置で覚え直して、立った位置が
  // 基準より高く見え、そのあと数えなくなった）。深度で測れている間は、基準より低いか（覚えるか）を深度だけで決める（firstModeOffset。画像の腰の高さの
  // 点のぶれで、深度の基準の値が抜け、25°のスクワットを数えないことが増えた）。画像だけのとき、伸ばして立って基準より高く見えるのが upSkipAwayMs 続いてから upSkip2dMs の間は、
  // 下ろした向きへ lower の半分より離れた値を基準に覚えない（ひざを曲げたまま立っていた位置で覚えた基準が、下ろした位置へつられていった）。
  // restSeed：腰を下ろしている間に立つ位置が動いて作り直す（rebase）ときは、動いた先の休んだ側の値で覚える。seedHold：そのときは（下ろしすぎ・おじぎに
  // 止められていなければ）、その基準から下ろし始めたとみなし、次に上げるまで下ろした向きへ lower より離れた値を覚えない（少し下を向いたカメラの前で、
  // 腰を下ろしたまま 20cm 前へ出ると、そのあとの数回を数えなかった）
  const SQUAT_LIMITS = {
    ...EXCURSION_TIMING, ...STANDING_POSTURE,
    baselinePercentile: .3,
    floor3d: .02, lower3d: .01, fullRange3d: .15,
    floor2d: .04, lower2d: .02, fullRange2d: .3,
    dropMax3d: .15, dropMax2d: .3,
    bow3d: .16, bow2d: .3, place3d: .18, place2d: .12, placeRebaseMs: 1500, legs2d: .02,
    belowReanchorMs: 2500, reanchorSeedMs: 1000,
    baselineKeepSamples: 45, lockRelearnMs: 3000, plateauMs: 2000, lockLeg: -.5, lockShape2d: .025, lockShape3d: .03, firstModeOffset: true, upSkip2dMs: 6000, upSkipAwayMs: 800,
    restSeed: true, seedHold: true, maxUpMs: 15000
  };
  const LIMITS_BY_EXERCISE = {
    "chair-march": MARCH_LIMITS, "seated-heel-raise": SEATED_HEEL_LIMITS, "standing-heel-raise": STAND_HEEL_LIMITS, "mini-squat": SQUAT_LIMITS, "arm-raise": ARM_LIMITS, "knee-extend": KNEE_LIMITS, "sit-stand": STAND_LIMITS, "side-step": STEP_LIMITS,
    "knee-open-close": KNEE_OPEN_LIMITS, "seated-leg-out": LEG_OUT_LIMITS, "seated-twist": TWIST_LIMITS, "shoulder-shrug": SHRUG_LIMITS, "arm-open-close": ARM_OPEN_LIMITS, "side-bend": SIDE_BEND_LIMITS
  };

  // 深度の取れた関節の3D座標（カメラ座標、y下向き、m）。取れなければ null
  function worldPoint(worldLandmarks, index) {
    const point = Array.isArray(worldLandmarks) ? worldLandmarks[index] : null;
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) && point.z > 0 ? point : null;
  }

  // 正面向きの運動の測り方の結果。channels: 名前 → { v2, s2, v3, s3 }。v は動くと大きくなる量、s はそれを割る体の大きさ
  // （2d は画像の高さを1とした単位で、横の長さは縦横比で縦の単位に直す。3d は m、s3 は 1 か休んだときの長さ）。数え方は updateExcursionCounter
  function excursionMeasurement(channels, points, profile, extra) {
    const list = Object.values(channels);
    return {
      valid: true,
      metric: profile.metric,
      confidence: clamp(mean(points.map(landmarkConfidence)), 0, 1),
      visiblePart: profile.label,
      lowLabel: profile.lowLabel,
      highLabel: profile.highLabel,
      channels,
      source: list.some((channel) => channel.v3 !== null) ? "3d" : "2d",
      ...extra
    };
  }

  function measureFrontal(exerciseId, landmarks, worldLandmarks, options) {
    const limits = options?.limits || LIMITS_BY_EXERCISE[exerciseId];
    const aspect = Number.isFinite(options?.aspect) && options.aspect > 0 ? options.aspect : 4 / 3;
    const p = (index) => landmarks[index];
    const w = (index) => worldPoint(worldLandmarks, index);
    // 画像上の2点の長さ（縦の単位。横は縦横比で直す）
    const span = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    const center = (indices) => ({ x: mean(indices.map((index) => p(index).x)), y: mean(indices.map((index) => p(index).y)) });
    const shown = (indices) => indices.filter((index) => visible(p(index)));
    // 体の大きさと位置（別の人へ移ったフレームを見つける用。判定側の updateExcursionCounter が前のフレームと比べる）。
    // sizes：肩幅・腰幅・胴の長さ（画像、縦の単位）。x：腰（見えなければ肩）の中心の横の位置（縦の単位）。depth：腰（なければ肩）の深度（m）
    const bodyFrame = () => {
      const sizes = {};
      if (visible(p(11)) && visible(p(12))) sizes.shoulder = Math.abs(p(11).x - p(12).x) * aspect;
      if (visible(p(23)) && visible(p(24))) sizes.hip = Math.abs(p(23).x - p(24).x) * aspect;
      const torsos = [[11, 23], [12, 24]].filter(([shoulder, hip]) => visible(p(shoulder)) && visible(p(hip))).map(([shoulder, hip]) => span(p(shoulder), p(hip)));
      if (torsos.length) sizes.torso = mean(torsos);
      const group = [[23, 24], [11, 12]].find((indices) => shown(indices).length) || null;
      const deep = [[23, 24, "hip"], [11, 12, "shoulder"]].map(([a, b, key]) => [[a, b].map(w).filter(Boolean), key]).find(([points]) => points.length);
      return {
        sizes,
        x: group ? center(shown(group)).x * aspect : null,
        depth: deep ? { key: deep[1], z: mean(deep[0].map((point) => point.z)) } : null
      };
    };
    // 座ってする運動：肩・腰が左右とも見えていること（needKnees のひざの開閉は、ひざも）。上半身だけの運動は、ひざが画面の外でも測る。
    // 胴の長さ（画像）と、座っているか・足を止めているかを確かめる材料（確かめは判定側）、信頼度に使う点（points。ひざは見えているときだけ）。
    // seat.upright：胴が立っている（画像で肩が腰より上）。ratio：画像上の「腰〜ひざの縦の差」と胴の縦の長さの比（両ひざが見えるときだけ）。
    // hip：腰の画像の高さ（v、下向き）と、深度の高さ（h3、上向き m）・深度（z）（両方の腰の深度があるときだけ）。
    // knees：両ひざが見えるときだけ、ひざごとの画像の高さ（v）・3Dの点の y÷z（ray。画像の高さと同じで深度の跳びに左右されない）・深度（z）。
    // 左右は画像上の並びで決める（推定が左右を取り違えても、ひざの高さが跳んだことにしない）
    const seatedBody = (needKnees) => {
      const kneesShown = visible(p(25)) && visible(p(26));
      const missing = [11, 12, 23, 24, ...(needKnees ? [25, 26] : [])].filter((index) => !visible(p(index)));
      if (missing.length) return { missing };
      const shoulderY = (p(11).y + p(12).y) / 2;
      const hipY = (p(23).y + p(24).y) / 2;
      const kneeY = (p(25).y + p(26).y) / 2;
      const torsoV = hipY - shoulderY;
      const torso = mean([span(p(11), p(23)), span(p(12), p(24))]);
      const worldHips = [w(23), w(24)];
      const knee = (index) => ({ v: p(index).y, ray: w(index) ? w(index).y / w(index).z : null, z: w(index)?.z ?? null });
      return {
        torso: torso > .04 ? torso : null,
        points: (kneesShown ? [11, 12, 23, 24, 25, 26] : [11, 12, 23, 24]).map(p),
        seat: {
          torso, upright: torso > .04 && torsoV > .02, ratio: kneesShown && torsoV > .02 ? (kneeY - hipY) / torsoV : null,
          hip: worldHips.every(Boolean)
            ? { v: hipY, h3: -mean(worldHips.map((point) => point.y)), z: mean(worldHips.map((point) => point.z)) }
            : { v: hipY, h3: null, z: null },
          knees: kneesShown ? (p(25).x >= p(26).x ? [25, 26] : [26, 25]).map(knee) : null
        }
      };
    };
    // 立ってする脚の運動：肩・腰が左右とも見えていること。胴の長さ（画像）、腰・両肩の高さ（画像の y と3Dの高さ）、
    // 立っているかの手がかり（posture：腰の高さ、腰とひざの奥行きの差、画像の「腰〜ひざの縦の差」と胴の比。判定側の STANDING_POSTURE）
    const standingBody = () => {
      const missing = [11, 12, 23, 24].filter((index) => !visible(p(index)));
      if (missing.length) return { missing };
      const torso = mean([span(p(11), p(23)), span(p(12), p(24))]);
      const hipY = (p(23).y + p(24).y) / 2;
      const shoulderY = (p(11).y + p(12).y) / 2;
      const hips = [w(23), w(24)];
      const knees = [w(25), w(26)];
      const hip3 = hips.every(Boolean) ? mean(hips.map((point) => point.y)) : null;
      const shoulder3 = [w(11), w(12)].every(Boolean) ? mean([w(11), w(12)].map((point) => point.y)) : null;
      const kneesShown = visible(p(25)) && visible(p(26));
      const kneeY = kneesShown ? (p(25).y + p(26).y) / 2 : null;
      const knee3 = kneesShown && knees.every(Boolean) ? mean(knees.map((point) => point.y)) : null;
      // 見えているひざの高さの平均（片方のひざが隠れても測れる。kneeLeg）
      const shownKnees = [0, 1].filter((side) => visible(p(25 + side)));
      const shownKnees3 = shownKnees.filter((side) => knees[side]);
      const kneeLeg = { y: shownKnees.length ? mean(shownKnees.map((side) => p(25 + side).y)) : null, y3: shownKnees3.length ? mean(shownKnees3.map((side) => knees[side].y)) : null };
      const ankles = [w(27), w(28)];
      const anklesShown = visible(p(27)) && visible(p(28));
      const ankleY = anklesShown ? (p(27).y + p(28).y) / 2 : null;
      const kneeWidth = kneesShown ? Math.abs(p(25).x - p(26).x) * aspect * 1.8 : null;
      const hipZ = hips.every(Boolean) ? mean(hips.map((point) => point.z)) : null;
      // ひざごとの、腰とひざの奥行きの差（m。左右の平均が posture.gap。片方のひざが見えない・深度がないときも、もう片方で形を確かめられるように。legGap）
      const kneeGaps = [25, 26].map((index, side) => (hipZ !== null && visible(p(index)) && knees[side] ? hipZ - knees[side].z : null));
      const ankle3 = anklesShown && ankles.every(Boolean) ? mean(ankles.map((point) => point.y)) : null;
      // 体の横幅（画像、縦の単位）：肩幅と、腰幅の 1.8 倍（肩の点の幅 .36m・腰の点の幅 .20m）。肩・腰それぞれの深さの横幅も
      const shoulderWidth = Math.abs(p(11).x - p(12).x) * aspect;
      const hipWidth = Math.abs(p(23).x - p(24).x) * aspect * 1.8;
      const width = mean([shoulderWidth, hipWidth]);
      return {
        torso: torso > .04 ? torso : null, width: width > .02 ? width : null, shoulderWidth: shoulderWidth > .02 ? shoulderWidth : null, hipWidth: hipWidth > .02 ? hipWidth : null,
        kneeWidth, kneeGaps, kneeSeen: visible(p(25)) || visible(p(26)), hipY, shoulderY, hip3, shoulder3, kneeY, kneeLeg, ankleY, knee3, ankle3, hipZ,
        posture: {
          hip2: hipY, scale2: torso > .04 ? torso : null, hip3,
          gap: hipZ !== null && kneesShown && knees.every(Boolean) ? hipZ - mean(knees.map((point) => point.z)) : null,
          ratio: kneeY !== null && hipY - shoulderY > .02 ? (kneeY - hipY) / (hipY - shoulderY) : null
        }
      };
    };
    // 立つ位置（前後）：深度は腰の奥行き（m）、画像は体の横幅（その割合）。カメラの方へ歩いた・下がった、の確かめ（カメラが少し下を向いていると、
    // 前後に動いた体は上下にも動いて見える）
    const placeChannel = (body) => ({ v2: body.width, s2: body.width, v3: body.hipZ, s3: 1 });
    // 腰〜足首の縦の差が縮んだ分（画像だけ。基準の体の横幅の割合）。腰を下ろすと縮み、かかとを上げても変わらず（足首も体といっしょに上がる）、
    // カメラの方へ出ると長く、下がると短く見える
    const legsChannel = (body) => ({ v2: body.ankleY !== null && body.width ? body.hipY - body.ankleY : null, s2: body.width, v3: null, s3: 1 });
    // 腰〜足首（a）・腰〜ひざ（g）の縦の差（深度は m、画像は体の横幅で割る：前かがみでも変わらない長さ。浅いスクワットの腰のチャンネルの単位とは少し違い、
    // lockLeg はこの割り方で合わせてある。胴の長さを入れて割ると、前かがみで止まったときに差が広がって見え、覚え直せなかった）。止まって数えられないときの覚え直しで、
    // ひざの曲がりを見る（lockLeg）。腰が下りて止まったときの形の確かめ（lockShape2d・lockShape3d）には、画像の肩幅・両ひざの間を腰幅で割った値（w2・k2）と、
    // ひざごとの腰とひざの奥行きの差（f3l・f3r、m。ひざを曲げると、ひざが前へ出て腰が後ろに残るので、30° で約9cm 広がる。左右の平均が立った姿勢の posture.gap）。
    // 肩幅は、ひざが片方でも画面に見えているときだけ（両ひざとも画面の下の外の、とても近い・高いカメラでは、前かがみなしでひざを曲げて止まっても肩幅は変わらず、
    // 曲げて止まった位置を休んだ位置と覚えて、伸ばして立つたびに数えた）
    const legGap = (body) => {
      const shape = (size) => (size && body.hipWidth ? size / body.hipWidth : null);
      return {
        a2: body.ankleY !== null && body.width ? (body.ankleY - body.hipY) / body.width : null, a3: body.hip3 !== null && body.ankle3 !== null ? body.ankle3 - body.hip3 : null,
        g2: body.kneeY !== null && body.width ? (body.kneeY - body.hipY) / body.width : null, g3: body.hip3 !== null && body.knee3 !== null ? body.knee3 - body.hip3 : null,
        w2: body.kneeSeen ? shape(body.shoulderWidth) : null, k2: shape(body.kneeWidth), f3l: body.kneeGaps[0], f3r: body.kneeGaps[1]
      };
    };
    // 見えているひざだけの腰〜ひざの縦の差（o2・o3。片方のひざが隠れても測れる。単位は g2・g3 と同じ）。立ってかかと上げで、腰が基準より上がって止まったとき、
    // 腰〜足首・両ひざの腰〜ひざの差がなければ、これで、ひざを伸ばして立った（座っていた・ひざを曲げていた位置で覚えた基準から立ち上がった）か、
    // かかとを上げたまま止まったかを見分ける（relearnLocked。右ひざが隠れて深度もないと、座ってから立ち上がったときに覚え直せず、最初の数回を数えなかった）。
    // 腰が下りて止まったときには使わない（片方のひざで測る差は、少し下を向いたカメラで前へ出ると変わって見えた）
    const legOne = (body) => ({
      o2: body.kneeLeg.y !== null && body.width ? (body.kneeLeg.y - body.hipY) / body.width : null, o3: body.hip3 !== null && body.kneeLeg.y3 !== null ? body.kneeLeg.y3 - body.hip3 : null
    });

    if (exerciseId === "knee-open-close") {
      const body = seatedBody(true);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const wl = w(25), wr = w(26);
      const has3d = Boolean(wl && wr) && Math.abs(wl.z - wr.z) <= limits.kneeDepthMeters;
      const v2 = Math.abs(p(25).x - p(26).x) * aspect;
      // 深度：両ひざの間の水平の距離（斜めに座っていても同じ長さになるよう、奥行きの差も入れる）
      return excursionMeasurement({ knees: { v2, s2: body.torso, v3: has3d ? Math.hypot(wl.x - wr.x, wl.z - wr.z) : null, s3: 1 } }, body.points, {
        metric: v2 / (body.torso || .3), label: "両ひざ", lowLabel: "ひざを閉じた位置", highLabel: "ひざを開いた位置"
      }, { seat: body.seat, body: bodyFrame() });
    }

    if (exerciseId === "seated-leg-out") {
      const body = seatedBody(false);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      // 外の向きは、腰の画像上の並び（深度は深度の腰の並び）で決める（左右の取り違え・座標の向きに左右されない）
      const order2 = Math.sign(p(23).x - p(24).x) || 1;
      const wh = [w(23), w(24)];
      const hip3 = wh.every(Boolean) ? { x: mean(wh.map((point) => point.x)), z: mean(wh.map((point) => point.z)), order: Math.sign(wh[0].x - wh[1].x) || order2 } : null;
      const channels = {};
      const points = [...body.points];
      [["left", 27, 1], ["right", 28, -1]].forEach(([side, a, sign]) => {
        const ankle = p(a);
        if (!visible(ankle)) return;
        const wa = w(a);
        const deep = Boolean(wa && hip3) && Math.abs(wa.z - hip3.z) <= limits.ankleDepthMeters;
        // 足首の横の位置そのもの（床に置いた足は、上体や腰の揺れでは動かない。腰の中心から測ると、座ったままの体の揺れが入った）
        channels[side] = { v2: sign * order2 * ankle.x * aspect, s2: body.torso, v3: deep ? sign * hip3.order * wa.x : null, s3: 1 };
        // 足首の高さ（足踏み・脚を上げたのでないことの確かめ）
        channels[`${side}Lift`] = { v2: -ankle.y, s2: body.torso, v3: deep ? -wa.y : null, s3: 1 };
        // すねの画像の長さ（画像だけ。ひざも見えるとき）：ひざを伸ばして足先をカメラの方へ出すと、すねが短く見える。横へ出すのでは変わらない
        const knee = p(a - 2);
        if (visible(knee)) channels[`${side}Shank`] = { v2: span(knee, ankle), s2: body.torso, v3: null, s3: 1 };
        points.push(ankle);
      });
      if (!channels.left && !channels.right) return invalidMeasurement("足首");
      const placed = (index) => insideFrame(p(index)) && landmarkConfidence(p(index)) > 0;
      const du = placed(27) && placed(28) ? p(27).x - p(28).x : 0;
      const legs = [channels.left, channels.right].filter(Boolean);
      return excursionMeasurement(channels, points, {
        metric: Math.max(...legs.map((channel) => channel.v2 / (body.torso || .3))),
        label: legs.length === 2 ? "両足" : "映っている足", lowLabel: "足をもどした位置", highLabel: "足を横へ出した位置"
      }, { seat: body.seat, kneeOrder: Math.abs(du) >= limits.orderMarginU ? Math.sign(du) : null, body: bodyFrame() });
    }

    if (exerciseId === "seated-heel-raise") {
      // ひざの高さで測るので、ひざは必ず要る（座っているかの確かめも seatedBody で）
      const body = seatedBody(true);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const meanY = (points) => (points.every(Boolean) ? mean(points.map((point) => point.y)) : null);
      const wk = [w(25), w(26)];
      const channels = {
        left: { v2: -p(25).y, s2: body.torso, v3: wk[0] ? -wk[0].y : null, s3: 1 },
        right: { v2: -p(26).y, s2: body.torso, v3: wk[1] ? -wk[1].y : null, s3: 1 }
      };
      // 確かめ：腰の高さ、両肩の高さ、腰から見た両肩の深度（深度だけ）、胴の長さ（画像だけ）。左右のひざの高さの差は判定側で（spikeHoldMs のあとの値で）
      const hip3 = meanY([w(23), w(24)]);
      const shoulder3 = meanY([w(11), w(12)]);
      channels.hips = { v2: -(p(23).y + p(24).y) / 2, s2: body.torso, v3: hip3 === null ? null : -hip3, s3: 1 };
      channels.shoulders = { v2: -(p(11).y + p(12).y) / 2, s2: body.torso, v3: shoulder3 === null ? null : -shoulder3, s3: 1 };
      channels.lean = { v2: null, s2: null, v3: hip3 !== null && shoulder3 !== null ? mean([w(11), w(12)].map((point) => point.z)) - mean([w(23), w(24)].map((point) => point.z)) : null, s3: 1 };
      if (body.torso) channels.torso = { v2: body.torso, s2: body.torso, v3: null, s3: 1 };
      return excursionMeasurement(channels, body.points, {
        metric: -(p(25).y + p(26).y) / 2 / (body.torso || .3), label: "両ひざ", lowLabel: "かかとを下ろした位置", highLabel: "かかとを上げた位置"
      }, { seat: body.seat, body: bodyFrame() });
    }

    if (exerciseId === "standing-heel-raise") {
      const body = standingBody();
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      // 画像の高さは、画面の真ん中から上へ、胴の長さを1として（腰は体の横幅で割ってから、胴の長さの単位にもどす。STAND_HEEL_LIMITS）
      const channels = {
        hips: { v2: body.width ? (.5 - body.hipY) / body.width : null, s2: body.torso && body.width ? body.torso / body.width : null, v3: body.hip3 === null ? null : -body.hip3, s3: 1, ...legGap(body), ...legOne(body) },
        shoulders: { v2: body.torso ? (.5 - body.shoulderY) / body.torso : null, s2: 1, v3: body.shoulder3 === null ? null : -body.shoulder3, s3: 1 }
      };
      // 確かめ：胴の長さ（画像だけ。カメラの方へ歩いた・前かがみ）、腰から両肩までの高さ（前かがみから背を伸ばした・肩をすくめた）
      if (body.torso) channels.torso = { v2: body.torso, s2: body.torso, v3: null, s3: 1 };
      channels.trunk = { v2: null, s2: null, v3: body.hip3 === null || body.shoulder3 === null ? null : body.hip3 - body.shoulder3, s3: 1 };
      channels.legs = legsChannel(body);
      channels.place = placeChannel(body);
      return excursionMeasurement(channels, [11, 12, 23, 24].map(p), {
        metric: -body.hipY / (body.torso || .3), label: "腰と肩", lowLabel: "かかとを下ろした位置", highLabel: "かかとを上げた位置"
      }, { posture: body.posture, body: bodyFrame() });
    }

    if (exerciseId === "mini-squat") {
      const body = standingBody();
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const channels = {
        hips: { v2: body.torso && body.hipWidth ? (body.hipY - .5) / Math.sqrt(body.torso * body.hipWidth) : null, s2: body.torso && body.hipWidth ? Math.sqrt(body.torso / body.hipWidth) : null, v3: body.hip3, s3: 1, ...legGap(body) },
        // 確かめ：肩が腰よりどれだけ多く下がったか（上体の前への倒れ）
        bow: {
          v2: body.shoulderWidth && body.hipWidth ? (body.shoulderY - .5) / body.shoulderWidth - (body.hipY - .5) / body.hipWidth : null,
          s2: body.torso && body.shoulderWidth ? body.torso / body.shoulderWidth : null, v3: body.hip3 === null || body.shoulder3 === null ? null : body.shoulder3 - body.hip3, s3: 1 },
        legs: legsChannel(body),
        place: placeChannel(body)
      };
      return excursionMeasurement(channels, [11, 12, 23, 24].map(p), {
        metric: body.hipY / (body.torso || .3), label: "腰と肩", lowLabel: "まっすぐ立った位置", highLabel: "腰を下ろした位置"
      }, { posture: body.posture, body: bodyFrame() });
    }

    if (exerciseId === "shoulder-shrug") {
      const body = seatedBody(false);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const channels = {};
      [["left", 11, 15], ["right", 12, 16]].forEach(([side, s, h]) => {
        const ws = w(s);
        channels[side] = { v2: -p(s).y, s2: body.torso, v3: ws ? -ws.y : null, s3: 1 };
        // 確かめ：手首が肩よりどれだけ上か（腕を上げると肩の点も上がる）
        const wrist = p(h);
        if (!visible(wrist)) return;
        const wh = w(h);
        const deep = Boolean(ws && wh) && ws.z - wh.z <= limits.wristDepthMeters && wh.z - ws.z <= limits.wristBehindMeters;
        channels[`${side}Arm`] = { v2: p(s).y - wrist.y, s2: body.torso, v3: deep ? ws.y - wh.y : null, s3: 1 };
      });
      // 確かめ：腰の高さ（立ち上がると肩も上がる）。腰から見た両肩の深度（背景を拾って奥へ跳ぶと、3Dの点の高さも上がって見える。前かがみでも変わる）
      const worldHips = [w(23), w(24)];
      const deepHips = worldHips.every(Boolean);
      channels.hips = { v2: -(p(23).y + p(24).y) / 2, s2: body.torso, v3: deepHips ? -mean(worldHips.map((point) => point.y)) : null, s3: 1 };
      // 画像では肩幅（前かがみでカメラへ近づくと広く見える。肩の上げ下げでは変わらない）。画像の数え方には使わず、覚え直しの確かめ（relearnShift2d）だけ
      const worldShoulders = [w(11), w(12)];
      const width = Math.abs(p(11).x - p(12).x) * aspect;
      channels.depth = { v2: width, s2: width, v3: deepHips && worldShoulders.every(Boolean) ? mean(worldShoulders.map((point) => point.z)) - mean(worldHips.map((point) => point.z)) : null, s3: 1 };
      return excursionMeasurement(channels, body.points, {
        metric: -(p(11).y + p(12).y) / 2 / (body.torso || .3), label: "両肩", lowLabel: "肩を下ろした位置", highLabel: "肩を上げた位置"
      }, { seat: body.seat, body: bodyFrame() });
    }

    if (exerciseId === "arm-open-close") {
      const body = seatedBody(false);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const width = Math.abs(p(11).x - p(12).x) * aspect;
      const middle = (p(11).x + p(12).x) / 2;
      // 外へ開くと＋になる向き。推定が左右の肩を取り違えても変わらないよう、画像上の肩の並びで決める
      const order = Math.sign(p(11).x - p(12).x) || 1;
      const wl = w(11), wr = w(12);
      const worldMiddle = wl && wr && Math.abs(wl.z - wr.z) <= limits.shoulderDepthMeters ? (wl.x + wr.x) / 2 : null;
      const channels = {};
      const points = [...body.points];
      const scale = width >= .02 ? width : null;
      // 手首ごと：胸の高さにあるか（chest）、体の真ん中から外への離れ（off。外へ開くと＋）、肩からの高さ（high。上が＋、画像は胴の長さを1、深度は m）。
      // 左右の手首は画像上の並びで決める（推定が手首の左右を取り違えても、開いた手首が反対側へ跳んだことにしない）
      const crossed = visible(p(15)) && visible(p(16)) && order * (p(15).x - p(16).x) < 0;
      const hands = [["left", 11, crossed ? 16 : 15, 1], ["right", 12, crossed ? 15 : 16, -1]].map(([side, s, h, sign]) => {
        const wrist = p(h);
        if (!visible(wrist) || !body.torso || !scale) return { side, chest2: false, chest3: false };
        const ws = w(s), wh = w(h);
        const has3d = worldMiddle !== null && Boolean(ws && wh) && ws.z - wh.z <= limits.wristDepthMeters && wh.z - ws.z <= limits.wristBehindMeters;
        const high2 = (p(s).y - wrist.y) / body.torso;
        const high3 = has3d ? ws.y - wh.y : null;
        points.push(wrist);
        return {
          side, high2, high3, x2: wrist.x * aspect, x3: has3d ? wh.x : null,
          chest2: -high2 <= limits.chestBelow2d && high2 <= limits.chestAbove2d,
          chest3: has3d && -high3 <= limits.chestBelow3d && high3 <= limits.chestAbove3d,
          off2: sign * order * (wrist.x - middle) * aspect, off3: has3d ? sign * order * (wh.x - worldMiddle) : null
        };
      });
      // rest：胸の前で手を合わせた位置（両手首とも胸の高さで、両手首の間が、画像は肩幅の closedGap2d 倍・深度は closedGap3d m 以内）。
      // 体の真ん中からの離れで見ないのは、カメラの正面から横へずれて座った人では、肩より前の手首が画像の外側へ写るから（両手首の間なら、ずれても同じ）
      const [left, right] = hands;
      const rest = left.chest3 && right.chest3 ? Math.abs(left.x3 - right.x3) <= limits.closedGap3d
        : left.chest2 && right.chest2 && Math.abs(left.x2 - right.x2) / scale <= limits.closedGap2d;
      hands.forEach((hand) => {
        // 手首が見えない・胸の高さにないときも、チャンネルは置いて値を null にする（前の値で開いたままとみなさない。体の大きさの s2 は残す）
        channels[hand.side] = { v2: hand.chest2 ? hand.off2 : null, s2: scale, v3: hand.chest3 ? hand.off3 : null, s3: 1, rest };
        // 確かめ：手首が肩より上（腕を頭の上へ上げた）
        if (hand.high2 !== undefined) channels[`${hand.side}High`] = { v2: hand.high2, s2: 1, v3: hand.high3, s3: 1 };
      });
      return excursionMeasurement(channels, points, {
        metric: 0, label: "両腕", lowLabel: "手を胸の前に合わせた位置", highLabel: "腕を開いた位置"
      }, { seat: body.seat, body: bodyFrame() });
    }

    if (exerciseId === "side-bend") {
      const body = seatedBody(false);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const degrees = (a, b) => Math.atan2(a, b) * 180 / Math.PI;
      // 上半身の傾き（°）：画像の右（本人の左）へ倒すと＋。深度は、両肩・両腰の深度が確かなときだけ
      const shoulders = midpoint(p(11), p(12));
      const hips = midpoint(p(23), p(24));
      const tilt2 = degrees((shoulders.x - hips.x) * aspect, hips.y - shoulders.y);
      const ws = [w(11), w(12)];
      const wh = [w(23), w(24)];
      const deep = ws.every(Boolean) && wh.every(Boolean) && Math.abs(ws[0].z - ws[1].z) <= limits.shoulderDepthMeters
        && Math.abs(mean(ws.map((point) => point.z)) - mean(wh.map((point) => point.z))) <= limits.shoulderDepthMeters;
      const tilt3 = deep ? degrees((ws[0].x + ws[1].x) / 2 - (wh[0].x + wh[1].x) / 2, (wh[0].y + wh[1].y) / 2 - (ws[0].y + ws[1].y) / 2) : null;
      const width = Math.abs(p(11).x - p(12).x) * aspect;
      const line2 = span(p(11), p(12));
      const line3 = deep ? Math.hypot(ws[0].x - ws[1].x, ws[0].y - ws[1].y) : null;
      // lean は同じ傾きを、大きく倒しすぎたかの確かめに使う。roll は肩の線の傾き（°。深度は、奥行きの差も入れた水平の幅に対して）、line は肩の線の長さ
      const channels = {
        tilt: { v2: tilt2, s2: 1, v3: tilt3, s3: 1 },
        lean: { v2: tilt2, s2: 1, v3: tilt3, s3: 1 },
        roll: { v2: degrees(p(12).y - p(11).y, Math.abs(p(11).x - p(12).x) * aspect), s2: 1, v3: deep ? degrees(ws[1].y - ws[0].y, Math.hypot(ws[0].x - ws[1].x, ws[0].z - ws[1].z)) : null, s3: 1 },
        narrow: { v2: -line2, s2: line2 > .02 ? line2 : null, v3: line3 === null ? null : -line3, s3: line3 }
      };
      // 確かめ：手首が、同じ側の肩と腰の外側からどれだけ外へ出たか（横の物へ手をのばす）。外向きは画像上の肩の並びで決める（左右の取り違えでも変わらない）。
      // 深度は手首の深度が確かなときは m で、なければ画像の比を肩幅（m）に直す
      const order = Math.sign(p(11).x - p(12).x) || 1;
      [["left", 11, 15, 23, 1], ["right", 12, 16, 24, -1]].forEach(([side, s, h, hip, sign]) => {
        const wrist = p(h);
        if (!visible(wrist) || width <= .02) return;
        const out = (wristX, shoulderX, hipX) => Math.max(0, Math.min(sign * order * (wristX - shoulderX), sign * order * (wristX - hipX)));
        const out2 = out(wrist.x, p(s).x, p(hip).x) * aspect / width;
        const ww = w(h);
        const out3 = !deep ? null : ww && Math.abs(ww.z - w(s).z) <= limits.wristDepthMeters ? out(ww.x, w(s).x, w(hip).x) : out2 * Math.abs(ws[0].x - ws[1].x);
        channels[`${side}Reach`] = { v2: out2, s2: 1, v3: out3, s3: 1 };
      });
      return excursionMeasurement(channels, body.points, {
        metric: tilt2, label: "上半身", lowLabel: "まっすぐ座った位置", highLabel: "体を横へ倒した位置"
      }, { seat: body.seat, body: bodyFrame() });
    }

    if (exerciseId === "seated-twist") {
      const body = seatedBody(false);
      if (body.missing) return invalidMeasurement(uniqueNames(body.missing));
      const wl = w(11), wr = w(12);
      // 大きくひねると両肩の点が重なり、深度の肩幅がつぶれて向きが 0° に読める（PC の記録 2026-10-11）：深度の肩幅が 10cm 未満のコマは向きを使わない
      const has3d = Boolean(wl && wr) && Math.abs(wl.z - wr.z) <= limits.shoulderDepthMeters && Math.abs(wl.x - wr.x) > .05 && Math.hypot(wl.x - wr.x, wl.z - wr.z) >= .1;
      // 肩の線の向き（°）：左肩が奥へ行くと＋（本人が左へ向く）。横の差は絶対値（±180° で回り込まない）。
      // 推定が左右の肩を取り違えると奥行きの差の符号が逆になるので、画像上の並び（鏡像なしで本人の左肩が右＝x が大きい）で向きをそろえる。
      // 取り違えても向きは変わらない
      const order = Math.sign(p(11).x - p(12).x) || 1;
      const yaw = has3d ? Math.atan2((wl.z - wr.z) * order, Math.abs(wl.x - wr.x)) * 180 / Math.PI : null;
      const width = Math.abs(p(11).x - p(12).x) * aspect;
      const channels = {};
      if (has3d) channels.yaw = { v2: null, s2: null, v3: yaw, s3: 1 };
      if (body.torso) {
        channels.shrink = { v2: -width / body.torso, s2: width / body.torso, v3: null, s3: 1 };
        channels.torso = { v2: body.torso, s2: body.torso, v3: null, s3: 1 };
      }
      return excursionMeasurement(channels, body.points, {
        metric: has3d ? yaw : width / (body.torso || .3), label: "両肩", lowLabel: "もとの向き", highLabel: "体をひねった位置"
      }, { seat: body.seat, yaw, body: bodyFrame() });
    }

    if (exerciseId === "arm-raise") {
      const torsos = [[11, 23], [12, 24]].filter(([shoulder, hip]) => visible(p(shoulder)) && visible(p(hip)))
        .map(([shoulder, hip]) => span(p(shoulder), p(hip))).filter((value) => value > .04);
      const shoulderSpan = visible(p(11)) && visible(p(12)) ? Math.abs(p(11).x - p(12).x) * aspect : null;
      const scale = torsos.length ? mean(torsos) : shoulderSpan > .02 ? shoulderSpan * limits.shoulderSpanTorso : null;
      const middle = shoulderSpan > .02 ? (p(11).x + p(12).x) / 2 : null;
      const channels = {};
      const points = [];
      [["left", 11, 13, 15], ["right", 12, 14, 16]].forEach(([side, s, e, h]) => {
        const shoulder = p(s), elbow = p(e), wrist = p(h);
        if (!visible(shoulder)) return;
        let top = null;
        if (visible(wrist)) top = wrist.y;
        // 近くで頭の上まで上げて手首が画面の上へ出た：ひじが肩より上に見えていれば、画面の外に推定された手首の高さを使う
        else if (visible(elbow) && elbow.y < shoulder.y && wrist && Number.isFinite(wrist.y) && wrist.y < 0 && landmarkConfidence(wrist) > 0) top = Math.min(wrist.y, elbow.y);
        if (top === null) return;
        const ws = w(s), wh = w(h);
        const has3d = Boolean(ws && wh) && visible(wrist) && Math.abs(wh.z - ws.z) <= limits.wristDepthMeters;
        // 手首が肩よりどれだけ上か（胴の長さを1。深度は m）。片腕だけで数える頭の上と、10秒を超えて待つかの目安
        const above = scale ? (shoulder.y - top) / scale : null;
        const solo = (above !== null && above >= limits.overhead2d) || (has3d && ws.y - wh.y >= limits.overhead3d);
        // 体の真ん中の手首（顔・髪をさわる）は上げ始めとみなさない
        const inward = middle !== null && visible(wrist) && Math.abs(wrist.x - middle) * aspect < limits.lateralMin * shoulderSpan;
        channels[side] = { v2: -top, s2: scale, v3: has3d ? -wh.y : null, s3: 1, above: above !== null && above >= 0, solo, block: inward && !solo };
        points.push(shoulder, visible(wrist) ? wrist : elbow);
      });
      if (!channels.left && !channels.right) return invalidMeasurement("肩と手首");
      const both = Boolean(channels.left && channels.right);
      // 確かめ：腰の高さ（立ち上がると手首も上がる）。両方の腰が見えるときだけ
      if (visible(p(23)) && visible(p(24))) {
        const worldHips = [w(23), w(24)];
        channels.hips = { v2: -(p(23).y + p(24).y) / 2, s2: scale, v3: worldHips.every(Boolean) ? -mean(worldHips.map((point) => point.y)) : null, s3: 1 };
      }
      return excursionMeasurement(channels, points, {
        metric: mean([["left", 11], ["right", 12]].filter(([side]) => channels[side]).map(([side, s]) => (p(s).y + channels[side].v2) / (scale || .3))),
        label: both ? "両腕" : "映っている腕", lowLabel: "腕を下げた位置", highLabel: "腕を上げた位置"
        // 測り方（source）は腕のチャンネルだけで決める（腰の深度だけで "3d" にしない）
      }, { body: bodyFrame(), source: [channels.left, channels.right].some((channel) => channel && channel.v3 !== null) ? "3d" : "2d" });
    }

    if (exerciseId === "knee-extend") {
      const channels = {};
      const points = [];
      [["left", 25, 27], ["right", 26, 28]].forEach(([side, k, a]) => {
        const knee = p(k), ankle = p(a);
        if (!visible(knee) || !visible(ankle)) return;
        const drop = ankle.y - knee.y;
        const wk = w(k), wa = w(a);
        const shank = wk && wa ? Math.hypot(wa.x - wk.x, wa.y - wk.y, wa.z - wk.z) : null;
        const has3d = shank !== null && shank >= limits.shankMinMeters && shank <= limits.shankMaxMeters;
        const s2 = drop > .02 ? drop : null;
        // 深度：すねの向きの縦の成分（cos、真下で1）。休んだときの近くでは点の縦の揺れにほとんど左右されない
        channels[side] = { v2: -drop, s2, v3: has3d ? -(wa.y - wk.y) / shank : null, s3: 1 };
        // ひざの高さ（足踏みでないことの確かめ）と、足首の高さ（深度だけ。足を滑らせたのでないことの確かめ）
        channels[`${side}Knee`] = { v2: -knee.y, s2, v3: has3d ? -wk.y : null, s3: 1 };
        channels[`${side}Ankle`] = { v2: null, s2: null, v3: has3d ? -wa.y : null, s3: 1 };
        // ひざの曲がり（深度だけ。腰の深度もあるとき）：伸ばすと開く。足踏み・足を滑らせるでは開かない
        const wh = w(side === "left" ? 23 : 24);
        const thigh = has3d && wh && visible(p(side === "left" ? 23 : 24)) ? Math.hypot(wh.x - wk.x, wh.y - wk.y, wh.z - wk.z) : null;
        channels[`${side}Open`] = { v2: null, s2: null, v3: thigh >= limits.thighMinMeters && thigh <= limits.shankMaxMeters
          ? angleDegrees3(wh, wk, wa) / 100 : null, s3: 1 };
        points.push(knee, ankle);
      });
      if (!channels.left && !channels.right) return invalidMeasurement("ひざと足首");
      // 左右のひざの画像上の並び（左右の取り違えを見つける用）
      const placed = (index) => insideFrame(p(index)) && landmarkConfidence(p(index)) > 0;
      const du = placed(25) && placed(26) ? p(25).x - p(26).x : 0;
      const legs = [channels.left, channels.right].filter(Boolean);
      return excursionMeasurement(channels, points, {
        metric: Math.min(...legs.map((channel) => -channel.v2)),
        label: legs.length === 2 ? "両脚" : "映っている脚", lowLabel: "ひざを曲げた位置", highLabel: "ひざを伸ばした位置"
      }, { kneeOrder: Math.abs(du) >= limits.orderMarginU ? Math.sign(du) : null, body: bodyFrame() });
    }

    if (exerciseId === "sit-stand") {
      const hips = shown([23, 24]);
      if (!hips.length) return invalidMeasurement("腰");
      const shoulders = shown([11, 12]);
      const hip = center(hips);
      const torso = shoulders.length ? span(center(shoulders), hip) : null;
      const worldHips = hips.map(w);
      const has3d = worldHips.every(Boolean);
      return excursionMeasurement({ hips: { v2: -hip.y, s2: torso > .04 ? torso : null, v3: has3d ? -mean(worldHips.map((point) => point.y)) : null, s3: 1 } },
        [...hips, ...shoulders].map(p), {
          metric: torso > .04 ? -hip.y / torso : -hip.y,
          label: "腰", lowLabel: "座った位置", highLabel: "立った位置"
        }, { body: bodyFrame() });
    }

    if (exerciseId === "side-step") {
      if (!visible(p(23)) || !visible(p(24))) return invalidMeasurement("腰");
      const scale = visible(p(11)) && visible(p(12)) ? Math.abs(p(11).x - p(12).x) * aspect
        : Math.abs(p(23).x - p(24).x) * aspect * limits.hipShoulderRatio;
      const s2 = scale > .02 ? scale : null;
      const hipWorld = [w(23), w(24)];
      const channels = {
        hipShift: { v2: (p(23).x + p(24).x) / 2 * aspect, s2, v3: hipWorld.every(Boolean) ? (hipWorld[0].x + hipWorld[1].x) / 2 : null, s3: 1 }
      };
      const points = [p(23), p(24)];
      const feet = visible(p(27)) && visible(p(28));
      if (feet) {
        const wl = w(27), wr = w(28);
        const has3d = Boolean(wl && wr) && Math.abs(wl.z - wr.z) <= limits.ankleDepthMeters;
        channels.feet = { v2: Math.abs(p(27).x - p(28).x) * aspect, s2, v3: has3d ? Math.abs(wl.x - wr.x) : null, s3: 1 };
        points.push(p(27), p(28));
      }
      // 立っているかの確かめ（判定側）：腰〜ひざの縦の差と、胴の縦の長さ（肩が画面の外なら、ひざ〜足首の縦の長さ）の比。
      // 座るとももがカメラを向いて短く見える（記録で座って胴の .4〜.6・すねの .3〜.5、模型で立つと胴の約 .95・すねの約 1.1）。測れないときは null（前の判断のまま）
      const centerY = (a, b) => (visible(p(a)) && visible(p(b)) ? (p(a).y + p(b).y) / 2 : null);
      const shoulderY = centerY(11, 12);
      const kneeY = centerY(25, 26);
      const ankleY = feet ? centerY(27, 28) : null;
      const hipY = (p(23).y + p(24).y) / 2;
      const stance = kneeY === null ? null : shoulderY !== null && hipY - shoulderY > .02 ? (kneeY - hipY) / (hipY - shoulderY)
        : ankleY !== null && ankleY - kneeY > .02 ? (kneeY - hipY) / (ankleY - kneeY) : null;
      return excursionMeasurement(channels, points, {
        metric: feet ? channels.feet.v2 / (s2 || .3) : channels.hipShift.v2 / (s2 || .3),
        label: feet ? "腰と両足首" : "腰", lowLabel: "足をそろえた位置", highLabel: "横へ開いた位置"
      }, { stance, body: bodyFrame() });
    }
    return invalidMeasurement("必要な部位");
  }

  // options: { fyN（座って足踏み）, aspect（画像の横÷縦。ないときは 4/3）, limits（判定のしきい値。createPoseCounter が凍結したもの） }
  function measurePoseForExercise(exerciseId, landmarks, worldLandmarks, options) {
    if (!Array.isArray(landmarks) || landmarks.length < 29) return invalidMeasurement("必要な部位");
    if (exerciseId === "chair-march") return measureChairMarch(landmarks, worldLandmarks, options);
    return measureFrontal(exerciseId, landmarks, worldLandmarks, options);
  }

  // 位置案内で「画面に収まっていてほしい」関節。運動判定に使う部位の左右両側。
  // 立ち座りは腰と胴（足元は要らない）。横ステップは足首で数えるので、足首が画面の外なら「少し離れて」と言う
  // （腰の横移動でも数えるが、一歩出して戻すのは腰がほとんど動かず数えられない）
  const FRAMING_JOINTS = {
    "arm-raise": [11, 12, 13, 14, 15, 16],
    "chair-march": [11, 12, 23, 24, 25, 26],
    "knee-extend": [23, 24, 25, 26, 27, 28],
    "sit-stand": [11, 12, 23, 24, 25, 26],
    "side-step": [11, 12, 23, 24, 27, 28],
    // 座ってひざの開閉は、肩・腰・ひざ。上半身だけの運動は肩・腰（腰より下は画面の外でもよい。座っているかは腰の高さで確かめる）
    "knee-open-close": [11, 12, 23, 24, 25, 26],
    // 座って足を横へは、肩・腰・足首（足首で数える）
    "seated-leg-out": [11, 12, 23, 24, 27, 28],
    "seated-twist": [11, 12, 23, 24],
    "shoulder-shrug": [11, 12, 23, 24],
    // 腕の開閉は、開いた手首も画面に収まっていてほしい
    "arm-open-close": [11, 12, 15, 16, 23, 24],
    "side-bend": [11, 12, 23, 24],
    // 座ってかかと上げは、ひざの高さで数える。立ってかかと上げ・浅いスクワットは腰と肩で数え、ひざは立っているかの確かめに使う
    "seated-heel-raise": [11, 12, 23, 24, 25, 26],
    "standing-heel-raise": [11, 12, 23, 24, 25, 26],
    "mini-squat": [11, 12, 23, 24, 25, 26]
  };
  const JOINT_NAMES = {
    11: "肩", 12: "肩", 13: "ひじ", 14: "ひじ", 15: "手首", 16: "手首",
    23: "腰", 24: "腰", 25: "ひざ", 26: "ひざ", 27: "足首", 28: "足首"
  };
  // 初期値。実機の設置距離で校正する（2026-10 時点で未校正）。
  // recommendedMeters: 距離の目安（カメラ横置き）。座って足踏みは 2026-10-05 の実機記録で、
  // 数えられた足踏みが肩・腰・ひざまで 1.3〜1.9m のときだった（近すぎたのは 0.5〜0.7m）。ほかの運動は記録がないので出さない。
  // 本人の画面には数字の距離を出さず、recommendedHint の言葉で添える（数値は返り値の recommendedMeters に残す）
  const POSITION_LIMITS = {
    edgeMargin: .02, farDepthMeters: 3.5, farShoulderWidth: .07, farHipWidth: .05, farTorsoLength: .09,
    recommendedMeters: { "chair-march": [1.3, 1.9] },
    recommendedHint: { "chair-march": "（目安：カメラから大きく3歩ほど）" }
  };

  function uniqueNames(indices) {
    return Array.from(new Set(indices.map((index) => JOINT_NAMES[index]).filter(Boolean))).join("・");
  }

  // カメラに対する位置の案内を返す。landmarks は鏡像なしの元画像座標（0〜1）。
  // 左右は鏡像表示（画面＝鏡）で本人が動く向き：元画像の左端（x<0）から外れたら「左へ」。
  // options.depthMeters: 深度カメラで測った必要部位までの距離（m）。ないときは画像上の大きさで判断する。
  function assessPosition(exerciseId, landmarks, options) {
    const depthMeters = Number.isFinite(options?.depthMeters) ? options.depthMeters : null;
    const recommended = POSITION_LIMITS.recommendedMeters[exerciseId] || null;
    const base = { arrow: null, distanceMeters: depthMeters, recommendedMeters: recommended };
    const hint = POSITION_LIMITS.recommendedHint[exerciseId] || "";
    if (!Array.isArray(landmarks) || !landmarks.some((point) => landmarkConfidence(point) >= .3)) {
      return { ...base, status: "no-person", title: "カメラの前に来てください", detail: "顔と体が映ると、骨格の線が表示されます" };
    }
    const framing = FRAMING_JOINTS[exerciseId] || [];
    const edge = POSITION_LIMITS.edgeMargin;
    const out = { left: [], right: [], top: [], bottom: [] };
    // 近すぎてひざ等が画面の外に出ると、姿勢推定はその関節を画面外の位置に低い信頼度で置く。
    // ほかの必要部位がはっきり映っていれば、信頼度が低くても「画面の外にある」とみなして「離れて」と案内する
    const anchored = framing.some((index) => landmarkConfidence(landmarks[index]) >= .5 && insideFrame(landmarks[index], 0));
    framing.forEach((index) => {
      const point = landmarks[index];
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      if (Math.abs(point.x) > 3 || Math.abs(point.y) > 3) return;
      const outside = point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1;
      if (landmarkConfidence(point) < .05 && !(anchored && outside)) return;
      if (point.x < edge) out.left.push(index);
      if (point.x > 1 - edge) out.right.push(index);
      if (point.y < edge) out.top.push(index);
      if (point.y > 1 - edge) out.bottom.push(index);
    });
    if (out.top.length || out.bottom.length || (out.left.length && out.right.length)) {
      const parts = uniqueNames([...out.top, ...out.bottom, ...out.left, ...out.right]);
      return { ...base, status: "move-back", title: "少し離れてください", detail: `${parts}が画面からはみ出しています${hint}` };
    }
    if (out.left.length) return { ...base, status: "move-left", arrow: "left", title: "左へ少し動いてください", detail: `${uniqueNames(out.left)}が画面の端から出ています` };
    if (out.right.length) return { ...base, status: "move-right", arrow: "right", title: "右へ少し動いてください", detail: `${uniqueNames(out.right)}が画面の端から出ています` };

    const p = (index) => landmarks[index];
    let tooFar = false;
    if (depthMeters !== null) {
      tooFar = depthMeters > POSITION_LIMITS.farDepthMeters;
    } else {
      // 深度がないときは映る大きさで判断する。肩幅・腰幅は体を斜めに向けると縮むので、
      // 向きで変わりにくい胴の縦の長さ（肩〜腰）も見て、どれも小さいときだけ「遠い」とする。
      // y は画像の高さ、x は幅を1とした値なので、胴の長さは縦横比で幅の単位にそろえて比べる
      const aspect = Number.isFinite(options?.aspect) && options.aspect > 0 ? options.aspect : 4 / 3;
      const small = [];
      if (visible(p(11)) && visible(p(12))) small.push(Math.abs(p(11).x - p(12).x) < POSITION_LIMITS.farShoulderWidth);
      if (visible(p(23)) && visible(p(24))) small.push(Math.abs(p(23).x - p(24).x) < POSITION_LIMITS.farHipWidth);
      [[11, 23], [12, 24]].forEach(([shoulder, hip]) => {
        if (visible(p(shoulder)) && visible(p(hip))) small.push(Math.abs(p(shoulder).y - p(hip).y) / aspect < POSITION_LIMITS.farTorsoLength);
      });
      tooFar = small.length > 0 && small.every(Boolean);
    }
    if (tooFar) return { ...base, status: "move-closer", title: "もう少し近づいてください", detail: `体が小さく映っています${hint}` };

    const measurement = measurePoseForExercise(exerciseId, landmarks, options?.worldLandmarks, { aspect: options?.aspect });
    if (!measurement.valid) {
      return { ...base, status: "adjust", title: `${measurement.visiblePart}が見えるようにしてください`, detail: "体の向きや、手前の物の位置を変えてみてください" };
    }
    return { ...base, status: "ok", title: "ちょうどいい位置です", detail: "このまま運動を始めましょう" };
  }

  // 運動中の細かい様子。angleText・postureText・balanceText は本人の画面に出るので言葉だけ（角度・割合の数は書かない）。
  // 数（angleDegrees・postureDegrees・balancePercent）は記録・家族向けの表示用に別に返す
  function measurePoseDetails(exerciseId, landmarks, worldLandmarks, measurement) {
    if (!measurement?.valid || !Array.isArray(landmarks)) {
      return {
        valid: false,
        angleLabel: "動き",
        angleText: "—",
        angleDegrees: null,
        postureText: "—",
        postureDegrees: null,
        balanceText: "—",
        balancePercent: 0,
        spatialMode: "部位待ち"
      };
    }

    const p = (name) => landmarks[LANDMARK[name]];
    const sideAngles = (centerName, firstName, lastName) => ["left", "right"].map((side) => {
      const first = p(`${side}${firstName}`);
      const center = p(`${side}${centerName}`);
      const last = p(`${side}${lastName}`);
      return visible(first) && visible(center) && visible(last) ? angleDegrees(first, center, last) : null;
    }).filter(Number.isFinite);

    // 正面のカメラでは、腕上げ（体の横で上げる）のほかは画像上の関節の角度が動きを表さないので、角度は腕上げだけ。ほかは様子を言葉で
    let angleLabel = "動き";
    let angleText = "—";
    let armDegrees = null;
    if (exerciseId === "arm-raise") {
      const angles = sideAngles("Shoulder", "Hip", "Wrist");
      angleLabel = "腕";
      if (angles.length) {
        armDegrees = Math.round(mean(angles));
        angleText = armDegrees < 35 ? "下ろしている" : armDegrees < 100 ? "上げている" : "高く上げている";
      }
    } else if (exerciseId === "side-step") {
      // 両足首の幅（肩幅との比）。そろえて立つと約 .55、一歩開くと 1 以上。足首が映らないときは言わない
      angleLabel = "足の開き";
      if (measurement.channels?.feet) angleText = measurement.metric >= .8 ? "開いている" : "そろえている";
    } else if (exerciseId === "seated-leg-out") {
      angleLabel = "足の位置";
    } else if (exerciseId === "knee-open-close") {
      // ひざの開き・体の向きは、その人の休んだ位置からの差でしか言えない（座り方・斜めの向きが人ごとに違う）ので、名前だけ
      angleLabel = "ひざの開き";
    } else if (exerciseId === "seated-twist") {
      angleLabel = "体の向き";
    } else if (exerciseId === "shoulder-shrug") {
      angleLabel = "肩の高さ";
    } else if (exerciseId === "arm-open-close") {
      angleLabel = "腕の開き";
    } else if (exerciseId === "side-bend") {
      angleLabel = "体の傾き";
    } else if (exerciseId === "seated-heel-raise" || exerciseId === "standing-heel-raise") {
      angleLabel = "かかと";
    } else if (exerciseId === "mini-squat") {
      angleLabel = "腰の高さ";
    }

    const shouldersVisible = visible(p("leftShoulder")) && visible(p("rightShoulder"));
    const hipsVisible = visible(p("leftHip")) && visible(p("rightHip"));
    let postureDegrees = null;
    let postureText = "体幹待ち";
    let spatialMode = "2D";
    if (shouldersVisible && hipsVisible) {
      const useWorld = Array.isArray(worldLandmarks)
        && [11, 12, 23, 24].every((index) => worldLandmarks[index] && Number.isFinite(worldLandmarks[index].x) && Number.isFinite(worldLandmarks[index].y));
      const source = useWorld ? worldLandmarks : landmarks;
      const shoulderCenter = midpoint(source[11], source[12]);
      const hipCenter = midpoint(source[23], source[24]);
      const horizontal = Math.hypot(shoulderCenter.x - hipCenter.x, useWorld ? shoulderCenter.z - hipCenter.z : 0);
      const vertical = Math.abs(shoulderCenter.y - hipCenter.y);
      postureDegrees = Math.atan2(horizontal, Math.max(.0001, vertical)) * 180 / Math.PI;
      postureText = postureDegrees <= 10 ? "安定" : postureDegrees <= 20 ? "少し傾き" : "傾き大";
      spatialMode = useWorld ? "RGB推定3D" : "2D";
    }

    const balanceParts = [];
    if (shouldersVisible) {
      const width = Math.max(.05, distance(p("leftShoulder"), p("rightShoulder")));
      balanceParts.push(Math.abs(p("leftShoulder").y - p("rightShoulder").y) / width);
    }
    if (hipsVisible) {
      const width = Math.max(.05, distance(p("leftHip"), p("rightHip")));
      balanceParts.push(Math.abs(p("leftHip").y - p("rightHip").y) / width);
    }
    if (exerciseId === "arm-raise" && visible(p("leftWrist")) && visible(p("rightWrist"))) {
      const scale = shouldersVisible ? Math.max(.08, distance(p("leftShoulder"), p("rightShoulder"))) : .2;
      balanceParts.push(Math.abs(p("leftWrist").y - p("rightWrist").y) / scale);
    }
    const balancePercent = balanceParts.length ? clamp(Math.round(100 - mean(balanceParts) * 115), 0, 100) : 0;
    const balanceText = !balanceParts.length ? "—" : balancePercent >= 82 ? "安定" : balancePercent >= 64 ? "少し左右差" : "左右差あり";

    return { valid: true, angleLabel, angleText, angleDegrees: armDegrees, postureText, postureDegrees, balanceText, balancePercent, spatialMode };
  }

  // options.limits: この人向けのしきい値の上書き（座って足踏みは state.bodyProfile から marchOverridesFromProfile で作る）。
  // 運動の開始時に、その運動の表（LIMITS_BY_EXERCISE）に重ねて凍結し、途中では変えない。表自体は変えない（上書きがなければ limits は null で、既定のまま）
  function createPoseCounter(exerciseId, nowValue, options) {
    const overrides = options?.limits && typeof options.limits === "object" && Object.keys(options.limits).length ? options.limits : null;
    const base = LIMITS_BY_EXERCISE[exerciseId] || MARCH_LIMITS;
    return {
      exerciseId,
      limits: overrides ? Object.freeze({ ...base, ...overrides }) : null,
      phase: "seeking-low",
      lastValidAt: 0,
      lastRepAt: -Infinity,
      lastRangePercent: 0,
      lastCycleDurationMs: null,
      totalFrames: 0,
      validFrames: 0
    };
  }

  function percentileOf(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }

  // 片足ぶんの状態。previous を渡すと、見えた時刻と前回数えた時刻だけ引き継ぎ、基準と上げ下げの途中経過は作り直す
  function marchSide(previous) {
    return {
      samples: [], restV: null, restY: null, zRest: null, mPerV: null, mode: null, v: null, rise: null, prevRise: null, gap: 0, gapJumpSince: null,
      phase: "down", candidate: null, candidateSince: 0, floor: Infinity, landed: Infinity, base: 0, peak: 0, upSince: 0, releasedAt: -Infinity, trail: [],
      excursion: 0, peakV: null, peakY: null, settledAbove: null, continuing: false, upOther: null,
      lastSeenAt: previous ? previous.lastSeenAt : -Infinity, lastRepAt: previous ? previous.lastRepAt : -Infinity
    };
  }

  // 座って足踏みの回数判定。左右それぞれ「座った高さから上がって、下りた」で1回。
  function updateMarchCounter(counter, measurement, now) {
    const limits = counter.limits || MARCH_LIMITS;
    const march = counter.march || (counter.march = {
      left: marchSide(), right: marchSide(), torsos: [], lastRepAt: -Infinity, lastRepSide: null, pending: [], hint: null, bothSince: null,
      frameAt: null, order: null, log: [],
      // 基準が怪しくなった最後の時刻（両ひざ上がり・左右の取り違え・上げたまま）。直後の1回は体の分析の証拠にしない
      unsureAt: null,
      // 計測の質（体の分析用）：見えたひざのフレーム数と、そのうち深度が取れた数。静止中の上げ幅の揺れ（2秒ごとの標準偏差）
      kneeFrames: 0, kneeDepthFrames: 0, rest: { since: null, left: [], right: [] }, restWindowSds: [],
      // 家族への見守り用：ひざごとの見えたフレーム数（片側だけ数えられない日に、そのひざが映っていたか）、座って判定できていた時間（ms）、3D で測れた上げ幅の最大（上げられなかった日）
      sideFrames: { left: 0, right: 0 }, readyMs: 0, maxRise3d: null
    });
    // 判定の経過（記録の流し直しで調べる用）。直近200件だけ残す
    const note = (entry) => {
      if (entry.event === "both-up" || entry.event === "order-flip" || entry.event === "max-lift") march.unsureAt = now;
      march.log.push({ t: now, ...entry });
      if (march.log.length > 200) march.log.shift();
    };
    const reading = () => {
      const seen = [march.left, march.right].filter((side) => side.rise !== null && now - side.lastSeenAt <= 300);
      if (!seen.length) return { liftCm: null, liftSource: null };
      const top = seen.reduce((best, side) => (side.rise > best.rise ? side : best));
      return { liftCm: Math.max(0, Math.round(top.rise * 100)), liftSource: top.mode };
    };
    const result = (rep, message, extra) => ({
      rep, phase: counter.phase, quality: measurement?.valid ? Math.round(measurement.confidence * 100) : 0,
      rangePercent: counter.lastRangePercent || 0, cycleDurationMs: counter.lastCycleDurationMs, message, ...reading(), ...extra
    });
    // 前のフレームからの間隔（フレームレートが低い・揺れるときの補正に使う）
    const frameMs = march.frameAt === null ? 0 : Math.max(0, now - march.frameAt);
    march.frameAt = now;
    // 見えなかったフレームは、上げた／下ろしたの確定までの時間に数えない（見えないまま otherFreshMs を過ぎたら取り消す）
    const pauseHold = (side) => {
      if (side.candidate === null) return;
      if (now - side.lastSeenAt > limits.otherFreshMs) side.candidate = null;
      else side.candidateSince += frameMs;
    };
    if (!measurement?.valid) {
      pauseHold(march.left);
      pauseHold(march.right);
      ["left", "right"].forEach((name) => { if (now - march[name].lastSeenAt > limits.resetAfterMs) march[name] = marchSide(march[name]); });
      return result(false, measurement?.message || "ひざをカメラに映してください", { quality: 0, liftCm: null, liftSource: null });
    }
    counter.validFrames += 1;
    counter.lastValidAt = now;
    // 左右の取り違え：推定がひざの左右を一瞬入れ替えると、上げた足の高さが反対の足に移って数えてしまう。
    // 両ひざの画像上の並びを覚えておき、逆になったフレームは orderSwitchMs まで判定に使わない（それ以上続けば並びを覚え直す）
    if (measurement.kneeOrder) {
      const order = march.order || (march.order = { sign: measurement.kneeOrder, flipSince: null });
      if (measurement.kneeOrder === order.sign) order.flipSince = null;
      else if (order.flipSince === null) {
        order.flipSince = now;
        note({ event: "order-flip" });
      }
      if (order.flipSince !== null) {
        if (now - order.flipSince < limits.orderSwitchMs) {
          pauseHold(march.left);
          pauseHold(march.right);
          return result(false, `${measurement.visiblePart}を認識中`);
        }
        Object.assign(order, { sign: measurement.kneeOrder, flipSince: null });
      }
    }
    if (Number.isFinite(measurement.torsoV)) march.torsos.push({ t: now, v: measurement.torsoV });
    while (march.torsos.length && now - march.torsos[0].t > limits.baselineWindowMs) march.torsos.shift();
    const torso = march.torsos.length ? percentileOf(march.torsos.map((item) => item.v), .5) : null;
    const seen = {};

    // 1) ひざごと：見失った／上げたままのときは作り直し、上げていない間の位置で座った高さ（基準）を更新する
    measurement.sides.forEach((sample) => {
      let side = march[sample.side];
      if (now - side.lastSeenAt > limits.resetAfterMs) side = march[sample.side] = marchSide(side);
      if (side.phase === "up" && now - side.upSince > limits.maxLiftMs) {
        note({ side: sample.side, event: "max-lift" });
        side = march[sample.side] = marchSide(side);
      }
      side.lastSeenAt = now;
      side.v = sample.v;
      seen[sample.side] = sample;
      if (side.phase === "up") return;
      side.samples.push({ t: now, v: sample.v, y: sample.y, z: sample.z });
      while (side.samples.length && now - side.samples[0].t > limits.baselineWindowMs) side.samples.shift();
      const ready = side.samples.length >= limits.baselineMinSamples && now - side.samples[0].t >= limits.baselineMinSpanMs;
      side.restV = ready ? percentileOf(side.samples.map((item) => item.v), limits.baselinePercentile) : null;
      const ys = ready ? side.samples.filter((item) => item.y !== null).map((item) => item.y) : [];
      const zs = ready ? side.samples.filter((item) => item.z !== null && item.v >= side.restV - limits.restBandV).map((item) => item.z) : [];
      side.restY = ys.length >= limits.minDepthSamples ? percentileOf(ys, limits.baselinePercentile) : null;
      side.zRest = zs.length >= limits.minDepthSamples ? percentileOf(zs, .5) : null;
    });
    measurement.sides.forEach((sample) => {
      march.kneeFrames += 1;
      if (sample.y !== null) march.kneeDepthFrames += 1;
      march.sideFrames[sample.side] += 1;
    });

    // 2) ひざごと：測り方と画像の換算（上げていない間に決め、上げている間は固定）、上げ幅（m）
    //    深度があれば、画像の高さ×座ったときの奥行き と 深度の高さ の小さい方。画像は手がひざに乗る等の深度の誤りを、
    //    深度はひざが前後に動いたときの画像の見かけの上下を打ち消す。深度が欠けたフレームは直前の差を保って画像で補う
    let scaled = false;
    ["left", "right"].forEach((name) => {
      const side = march[name];
      const sample = seen[name];
      const other = march[name === "left" ? "right" : "left"];
      // 見えなかったひざは直前の上げ幅を残す（反対のひざの判定では otherFreshMs の間だけ使う）
      if (!sample) return;
      if (side.phase !== "up") {
        const z = side.zRest ?? other.zRest;
        side.mPerV = measurement.fyN && z ? z / measurement.fyN : torso ? limits.torsoMeters2d / torso : null;
        const mode = side.restV === null ? null : side.restY !== null ? "3d" : side.mPerV !== null ? "2d" : null;
        // 測り方が決まった・なくなったときは上げ始めの位置を作り直す。3d と 2d の切り替え（深度がまばら）では引き継ぐ。
        // 3d の深度が欠けたフレームは画像から差（gap）を引いていたので、2d に移ると上げ幅がその分上がる。上げ始めの位置も同じだけずらす
        if (mode !== side.mode) {
          Object.assign(side, {
            mode, floor: side.mode && mode ? side.floor + side.gap : Infinity, landed: side.mode && mode ? side.landed + side.gap : Infinity, gap: 0, gapJumpSince: null
          });
        }
      }
      if (side.mPerV !== null || sample.y !== null) scaled = true;
      const rise2d = side.mPerV !== null && side.restV !== null ? (side.restV - side.v) * side.mPerV : null;
      if (side.mode === "2d") side.rise = rise2d;
      else if (side.mode !== "3d") side.rise = null;
      else if (sample.y !== null) {
        const rise3d = side.restY - sample.y;
        side.rise = rise2d === null ? rise3d : Math.min(rise2d, rise3d);
        // 1フレームで大きく跳んだ差（深度が背景を拾った）は覚えない。続けて深度が欠けると、そのひざの上げ幅がずっと低く出てしまう
        const gap = rise2d === null ? 0 : rise2d - side.rise;
        if (gap - side.gap <= limits.gapJumpMeters) side.gapJumpSince = null;
        else if (side.gapJumpSince === null) side.gapJumpSince = now;
        if (side.gapJumpSince === null || now - side.gapJumpSince >= limits.gapRelearnMs) Object.assign(side, { gap, gapJumpSince: null });
      } else {
        side.rise = rise2d === null ? null : rise2d - side.gap;
      }
    });

    // 3) 両ひざが同じくらい上がったまま：足踏みではない（座り直し・前かがみ・立ち上がり）。数えずに基準を作り直す
    const level = (side) => (side.rise === null || now - side.lastSeenAt > limits.otherFreshMs ? null
      : side.rise - (side.phase === "up" ? side.base : Math.max(0, side.floor)));
    const liftOf = (side) => (side.mode === "2d" ? limits.liftMeters2d : limits.liftMeters);
    const leftLevel = level(march.left);
    const rightLevel = level(march.right);
    // 両ひざ上がりの高さは、この人向けに liftMeters を下げても bothUpMeters より下げない（既定では同じ値）
    const bothLevelOf = (side) => (side.mode === "2d" ? limits.liftMeters2d : Math.max(limits.liftMeters, limits.bothUpMeters));
    const both = leftLevel !== null && rightLevel !== null && leftLevel >= bothLevelOf(march.left) && rightLevel >= bothLevelOf(march.right)
      && Math.min(leftLevel, rightLevel) >= limits.bothUpSimilarRatio * Math.max(leftLevel, rightLevel);
    march.bothSince = both ? (march.bothSince ?? now) : null;
    let voided = false;
    if (both && now - march.bothSince >= limits.bothUpMs) {
      note({ event: "both-up", left: leftLevel, right: rightLevel });
      march.left = marchSide(march.left);
      march.right = marchSide(march.right);
      march.bothSince = null;
      voided = true;
      march.hint = { text: "片足ずつ、交互に上げてください", until: now + limits.hintMs };
    }

    // 4) ひざごとの上げ下げ
    let lifted = null;
    let nearMiss = false;
    let ready = false;
    // 上げたままのひざ（しばらく見えていないひざは、案内のためには上げたままとみなさない）
    const upNow = (side) => side.phase === "up" && now - side.lastSeenAt <= limits.resetAfterMs;
    // 胴が直近より大きく伸びた（立って近づいてきた・大きく前かがみ）。見失う前の座った基準と比べると、枠の端に推定されたひざが「上がった」ように見える
    const approaching = Boolean(torso) && Number.isFinite(measurement.torsoV) && measurement.torsoV > limits.approachTorsoRatio * torso;
    ["left", "right"].forEach((name) => {
      const side = march[name];
      const other = march[name === "left" ? "right" : "left"];
      // 反対のひざから見た「下ろした位置」（landed）は、直前のフレームとの高い方で更新する（深度が1フレームだけ低く跳んでも、着いた位置を下げない）
      const prevRise = side.prevRise;
      side.prevRise = seen[name] ? side.rise : null;
      if (!seen[name] || side.rise === null) {
        pauseHold(side);
        return;
      }
      ready = true;
      const steady = Math.max(side.rise, prevRise ?? side.rise);
      const k = side.mode === "2d"
        ? { lift: limits.liftMeters2d, lower: limits.lowerMeters2d, dom: limits.dominanceMeters2d, near: limits.nearMissMeters2d, settle: limits.settleRangeMeters2d }
        : { lift: limits.liftMeters, lower: limits.lowerMeters, dom: limits.dominanceMeters, near: limits.nearMissMeters, settle: limits.settleRangeMeters };
      // 反対のひざが今どれだけ上がっているか。そのひざ自身の上げ始め・下ろした位置から測る（足が少し高い所に着いたまま止まっていても邪魔しない）。
      // 下ろした直後 otherSettleMs の間は、上げる前の位置から測る
      let otherRise = 0;
      if (other.rise !== null && now - other.lastSeenAt <= limits.otherFreshMs) {
        const from = other.phase === "up" || now - other.releasedAt < limits.otherSettleMs ? other.base : Math.max(0, Math.min(other.landed, other.rise));
        otherRise = other.rise - from;
      }
      let want = null;
      let bySettle = false;
      // 止まったので下ろしたとみなしたひざ（半分まで下りていない）：半分まで下りるか、反対のひざが上がるか、settleMergeMs たつまでは、続けて上げても同じ1回
      if (side.settledAbove !== null && (upNow(other) || side.rise <= side.settledAbove || (side.phase !== "up" && now - side.releasedAt > limits.settleMergeMs))) {
        side.settledAbove = null;
      }
      if (side.phase === "down") {
        // 上げた：基準からも、下ろしてからの一番低い位置からも上がり、反対のひざより高い
        side.floor = Math.min(side.floor, side.rise);
        side.landed = Math.min(side.landed, steady);
        const lift = side.rise - Math.max(0, side.floor);
        if (!approaching && lift >= k.lift && side.rise - Math.max(0, otherRise) >= k.dom) want = "up";
        const sample = seen[name];
        if (lift >= side.excursion) Object.assign(side, { excursion: lift, peakV: side.v, peakY: sample.y });
        if (side.excursion - lift >= k.lift - k.lower) {
          // 惜しかった：上げ幅に少し届かずに下りた（反対のひざが上がっている間や、数えた直後は知らせない）。
          // ひざ自身が下りたときだけ（座った高さの基準が追いついて上げ幅が減っただけなら、ひざは動いていない）
          const dropV = side.mPerV !== null && side.peakV !== null ? (side.v - side.peakV) * side.mPerV : 0;
          const dropY = sample.y !== null && side.peakY !== null ? sample.y - side.peakY : 0;
          const moved = Math.max(dropV, dropY) >= (k.lift - k.lower) / 2;
          if (moved && side.excursion >= k.near && side.excursion < k.lift && !upNow(other) && now - march.lastRepAt > limits.nearMissQuietMs) nearMiss = true;
          Object.assign(side, { excursion: lift, peakV: side.v, peakY: sample.y });
        }
      } else {
        side.peak = Math.max(side.peak, side.rise);
        side.trail.push({ t: now, rise: side.rise });
        while (now - side.trail[0].t > limits.settleMs) side.trail.shift();
        const height = side.rise - side.base;
        const top = side.peak - side.base;
        const span = side.trail.map((item) => item.rise);
        // 下ろした：上げ始めの位置の近くか、上げた高さの半分まで下りた。
        // または、足が前より高い所に着いた（上げた高さの3割以上下りて、ほぼ止まった。上げ幅が lift 以上のまま＝上げている間は使わない）
        const settled = side.trail.length >= 3 && now - side.trail[0].t >= limits.settleMs * .75 && height < k.lift
          && top - height >= Math.max(.02, limits.settleFraction * top) && Math.max(...span) - Math.min(...span) <= k.settle;
        const released = height <= Math.max(k.lower, limits.releaseFraction * top);
        bySettle = settled && !released;
        if (released || settled) want = "down";
      }
      if (!want) {
        side.candidate = null;
        return;
      }
      if (side.candidate !== want) {
        side.candidate = want;
        // 上げたとき、フレームの間隔が広い（20fps未満）なら、最初のフレームの前の半分の間隔も続いたとみなす（12fpsで3フレーム要るのを2フレームに）。
        // 下ろしたときには使わない（上げている途中で推定が0.1秒未満だけ下に跳ぶと、同じ上げを2回数えてしまう）
        side.candidateSince = want === "up" && frameMs > limits.holdMs / 2 ? now - Math.min(frameMs, limits.holdMs) / 2 : now;
      }
      if (now - side.candidateSince < limits.holdMs) return;
      side.candidate = null;
      if (want === "up") {
        Object.assign(side, { phase: "up", upSince: now, base: Math.max(0, side.floor), peak: side.rise, excursion: 0, trail: [], continuing: side.settledAbove !== null, upOther: otherRise });
        lifted = name;
        note({ side: name, event: "up", rise: side.rise, other: otherRise, mode: side.mode });
        return;
      }
      side.phase = "down";
      side.floor = side.rise;
      side.landed = steady;
      side.releasedAt = now;
      // 上げていた時間が短すぎる（関節の点が一瞬跳んだ）ものは数えない。フレームの間隔が広いときはその分を足して比べる
      const tooShort = now - side.upSince + Math.min(frameMs, limits.holdMs * 3) < limits.minUpMs;
      const continued = side.continuing;
      const counted = !tooShort && !continued && now - side.lastRepAt >= limits.sameSideGapMs;
      if (!continued) side.settledAbove = bySettle && counted ? side.base + Math.max(k.lower, limits.releaseFraction * (side.peak - side.base)) : null;
      side.continuing = false;
      // 両ひざが同じフレームで下りたときは、2回目を次のフレームで知らせる
      if (counted) {
        side.lastRepAt = now;
        // 体の分析の証拠：上げ幅の最高点、上げていた時間、測り方、上げたと確定したときの反対のひざの高さ、座ったときのひざの奥行き、着いた高さ、基準が怪しくなってからの時間
        march.pending.push({
          side: name, peak: side.peak - side.base, upMs: now - side.upSince, mode: side.mode, otherMeters: side.upOther ?? null, zRestMeters: side.zRest,
          landedMeters: steady - side.base, sinceUnsureMs: march.unsureAt === null ? null : now - march.unsureAt
        });
      }
      note({ side: name, event: counted ? "rep" : tooShort ? "rep-too-short" : continued ? "rep-continued" : "rep-too-soon", peak: side.peak - side.base, ms: now - side.upSince });
    });

    // 計測の質（家族への見守り用）：座って判定できていた時間と、3D で測れた上げ幅の最大（跳び 50cm 以上は捨てる）
    if (ready) march.readyMs += Math.min(frameMs, 500);
    ["left", "right"].forEach((name) => {
      const side = march[name];
      if (side.mode !== "3d" || side.rise === null || !seen[name]) return;
      const lift = side.rise - (Number.isFinite(side.floor) ? Math.max(0, side.floor) : 0);
      if (lift < .5) march.maxRise3d = Math.max(march.maxRise3d ?? 0, lift);
    });
    // 計測の質：両ひざが下りて候補もなく、どちらも座った位置から2cm以内（静止して座っている）間の上げ幅の揺れ。
    // qualityWindowMs ごとにひざごとの標準偏差を残す（最大200件）。しきい値に届かない小さな上げ下げや基準の作り直しの間は数えない
    const resting = ["left", "right"].every((name) => seen[name] && march[name].phase === "down" && march[name].candidate === null && march[name].rise !== null
      && Math.abs(march[name].rise - Math.max(0, march[name].floor)) < limits.settleRangeMeters);
    if (!resting) Object.assign(march.rest, { since: null, left: [], right: [] });
    else {
      if (march.rest.since === null) march.rest.since = now;
      march.rest.left.push(march.left.rise - Math.max(0, march.left.floor));
      march.rest.right.push(march.right.rise - Math.max(0, march.right.floor));
      if (now - march.rest.since >= limits.qualityWindowMs) {
        ["left", "right"].forEach((name) => {
          const sd = march.rest[name].length >= limits.qualityMinSamples ? standardDeviation(march.rest[name]) : null;
          if (sd !== null) pushRing(march.restWindowSds, round4(sd), 200);
        });
        Object.assign(march.rest, { since: now, left: [], right: [] });
      }
    }

    const rep = march.pending.shift() || null;
    if (lifted || rep) march.hint = null;
    else if (nearMiss && !voided) march.hint = { text: "ゆっくり、ご自分のペースで続けましょう", until: now + limits.hintMs };
    const hint = march.hint && now < march.hint.until ? march.hint.text : null;
    const anyUp = upNow(march.left) || upNow(march.right);
    counter.phase = !ready ? "seeking-low" : anyUp ? "returning" : "ready";
    if (rep) {
      const sinceLast = now - march.lastRepAt;
      // 両ひざがほぼ同時に下りたときの間隔（minCycleMs 未満）はテンポに使わない
      const cycleDurationMs = Number.isFinite(sinceLast) && sinceLast >= limits.minCycleMs && sinceLast < 10000 ? sinceLast : null;
      march.lastRepAt = now;
      march.lastRepSide = rep.side;
      counter.lastRepAt = now;
      counter.lastRangePercent = clamp(Math.round(rep.peak / limits.fullRangeMeters * 100), 0, 120);
      if (cycleDurationMs) counter.lastCycleDurationMs = cycleDurationMs;
      return result(true, "1回を認識しました", {
        side: rep.side, rangePercent: counter.lastRangePercent, cycleDurationMs,
        // 体の分析（pickLearnableRep → learnMarchSession）用。app.js は counter.march を読まず、この update だけを使う
        peakMeters: rep.peak, upMs: rep.upMs, mode: rep.mode, otherMeters: rep.otherMeters, zRestMeters: rep.zRestMeters, landedMeters: rep.landedMeters, sinceUnsureMs: rep.sinceUnsureMs
      });
    }
    if (!ready) {
      if (!scaled) return result(false, "肩から腰まで映るよう、少し離れてください");
      return result(false, hint || "座った姿勢を確認しています。足を下ろしてください");
    }
    if (lifted) return result(false, `${lifted === "left" ? "左" : "右"}ひざが上がりました。ゆっくり下ろしてください`);
    if (anyUp) return result(false, "ゆっくり下ろしてください");
    return result(false, hint || `${measurement.visiblePart}を認識中。ひざを上げてください`);
  }

  // ---- 腕上げ・ひざ伸ばし・立ち座り・横ステップ・ひざの開閉・体ひねりの回数判定（measureFrontal の channels を使う） ----
  // 1回の単位（unit）と、その上がり幅を作るチャンネル。上がり幅はしきい値を1とした値（e）にそろえるので、深度と画像を同じ物差しで比べられる。
  // both: 両腕（両方映るときは平均。ただし低い方の腕も bothFraction 以上。片腕でも頭の上まで上げた腕（チャンネルの solo）はそれだけで足りる）。
  // side: 脚ごとに数え、反対の脚と比べる。negate: チャンネルの値を逆向きに使う（体ひねりの右は、左と同じ肩の向きの負の向き。休んだ向きも左右で共有する）。
  // anchor: 基準（中央値）からの離れ具合で、向きは問わない（signed を付けると、増えた向きだけ）。settle: 離れた先で止まったら戻ったとみなして1回、基準をそこで覚え直す。
  // fallback: ほかの単位のチャンネルが invalidResetMs 見えないときだけ使う。prefix: しきい値の名前の頭（"hip" なら hipFloor2d）。
  // needRest: 休んだ位置（チャンネルの rest。見えているチャンネルがどれも）に limits.restMs 続けていたあとでなければ、上げ始めとみなさない（腕の開閉）。
  // guards: 上がり幅には入れない確かめのチャンネル。基準から limit のしきい値（limit + "2d" / "3d"。その測り方にあるときだけ）を超えて上がったら
  // （abs: 向きを問わず変わったら）上げ始めとみなさず、上げている途中なら戻しても数えない。need: 逆に、そこまで上がっていないうちは上げ始めとみなさない
  // （optional: そのチャンネルが見えない・基準がまだないときは確かめない）。
  // rebase: limits のその名前の時間、向きを問わずしきい値より動いたままなら、単位の基準を覚え直す（腕上げの腰：立ち上がった・座った）。
  // median: 基準を中央値で覚える（abs と同じ。向きは問う）。fixed: 基準を覚えず、値そのもの（0 から）としきい値を比べる。sustain: 超えたのが holdMs 続いたときだけ（点のぶれ・左右の取り違えの1〜2フレームでは、その1回を数えなくしない）。
  // guardFloor: 確かめが止めている間の値も「戻してからの一番低い位置」にする（止められたまま大きく動き、戻る途中でしきい値を通っても上げ始めとみなさない）。
  // relearn: 下がった位置で覚え直す（restRelearnMs）のは、この確かめのチャンネルが基準から limits[relearn + "2d" / "3d"] より変わっていない間だけ
  // （このチャンネルは、単位のチャンネルが基準より低い間の値を基準に使わない）。
  // freeze: この確かめが止めている間は、単位のチャンネルの値を基準に覚えない
  const EXCURSION_UNITS = {
    // 腕上げ：両腕で1回。立ち上がった（腰が上がった）のは数えない（座ったまま・立ったままの腕上げは数える）
    "arm-raise": [{ name: "arms", channels: ["left", "right"], both: true, guards: [{ channel: "hips", limit: "hipRise", median: true, rebase: "standRebaseMs" }] }],
    "knee-extend": ["left", "right"].map((side) => ({
      name: side, channels: [side], side,
      guards: [{ channel: `${side}Knee`, limit: "kneeLift" }, { channel: `${side}Ankle`, limit: "ankleRise", need: true },
        { channel: `${side}Open`, limit: "kneeOpen", need: true, optional: true }]
    })),
    "sit-stand": [{ name: "hips", channels: ["hips"] }],
    "side-step": [{ name: "feet", channels: ["feet"] }, { name: "hips", channels: ["hipShift"], anchor: true, settle: true, fallback: true, prefix: "hip" }],
    "knee-open-close": [{ name: "knees", channels: ["knees"] }],
    // 座って足を横へ：脚ごと。足首が上がったのは数えない
    // （向きを問わない：画像だけでは、足首を前へ出す・カメラの方へ上げると、画像の下へ動いて見える）
    "seated-leg-out": ["left", "right"].map((side) => ({ name: side, channels: [side], side, guards: [{ channel: `${side}Lift`, limit: "ankleLift", abs: true },
      { channel: `${side}Shank`, limit: "shankChange", abs: true }] })),
    // 体ひねり：左へ・右へを別に数える（同じ肩の向きの正と負）。深度がないときだけ、肩幅の狭まりで（向きは分からない）
    "seated-twist": [{ name: "left", channels: ["yaw"], side: "left", anchor: true, signed: true }, { name: "right", channels: ["yaw"], side: "right", anchor: true, signed: true, negate: true },
      { name: "shrink", channels: ["shrink"], fallback: true, prefix: "shrink", guards: [{ channel: "torso", limit: "torsoChange", abs: true }] }],
    // 肩の上げ下げ：両肩で1回。腕を上げた（肩の点もずれる）・立ち上がった・両肩の深度が跳んだ（前かがみ）のは数えない。
    // 腰の基準は中央値（低い方の値では、少し高い席へ座り直したあと古い基準が残り、立ち上がったとみなして数えなかった。画像だけの記録）
    "shoulder-shrug": [{ name: "shrug", channels: ["left", "right"], both: true, guardFloor: true,
      guards: [{ channel: "leftArm", limit: "armRise" }, { channel: "rightArm", limit: "armRise" }, { channel: "hips", limit: "hipRise", median: true },
        { channel: "depth", limit: "shoulderShift", abs: true, relearn: "relearnShift" }] }],
    // 腕の開閉：両腕で1回。胸の前で手をそろえてから開いたときだけ（needRest）。腕を頭の上へ上げたのは数えない
    "arm-open-close": [{ name: "arms", channels: ["left", "right"], both: true, needRest: true, guardFloor: true,
      guards: [{ channel: "leftHigh", limit: "chestAbove", fixed: true }, { channel: "rightHigh", limit: "chestAbove", fixed: true }] }],
    // 体の横倒し：左へ・右へを別に数える（同じ傾きの正と負。体ひねりと同じ）。ひねった・横へずれて前かがみ（肩の線の長さが変わる）、
    // 横の物へ手をのばす、大きく倒しすぎた、のは数えない
    "side-bend": ["left", "right"].map((side) => ({
      name: side, channels: ["tilt"], side, anchor: true, signed: true, negate: side === "right",
      guardFloor: true,
      guards: [{ channel: "roll", limit: "roll", abs: true, need: true }, { channel: "narrow", limit: "narrow", median: true, sustain: true },
        { channel: "leftReach", limit: "reach", abs: true, sustain: true }, { channel: "rightReach", limit: "reach", abs: true, sustain: true },
        { channel: "lean", limit: "leanMax", abs: true }]
    })),
    // 座ってかかと上げ：両ひざで1回。片ひざだけ上がった（足踏み）・座り直した・前かがみ・背もたれへもたれた、のは数えない。
    // 腰が上がっている間（途中まで立った・座る途中で止まった）のひざの高さは基準に覚えない（freeze）
    "seated-heel-raise": [{ name: "heels", channels: ["left", "right"], both: true, guardFloor: true, hold: ["left", "right"],
      guards: [{ channel: "gap", limit: "gap", abs: true, sustain: true, between: ["left", "right"] }, { channel: "hips", limit: "hipRise", freeze: true }, { channel: "shoulders", limit: "shoulderMove", abs: true },
        { channel: "lean", limit: "lean", abs: true, sustain: true }, { channel: "torso", limit: "torsoChange", abs: true, sustain: true }] }],
    // 立ってかかと上げ：腰と両肩がそろって上がって下りたら1回。立ち上がった（腰が上がりすぎ）・カメラの方へ歩いた、のは数えない
    "standing-heel-raise": [{ name: "rise", channels: ["hips", "shoulders"], both: true, guardFloor: true,
      guards: [{ channel: "hips", limit: "riseMax" }, { channel: "torso", limit: "torsoChange", abs: true, sustain: true }, { channel: "trunk", limit: "trunk", abs: true, sustain: true, rebase: "trunkRebaseMs" },
        { channel: "legs", limit: "legs", abs: true, median: true, sustain: true, relearn: "legs" }, { channel: "place", limit: "place", abs: true, sustain: true, rebase: "placeRebaseMs" }] }],
    // 浅いスクワット：腰が下りて、もどったら1回。椅子に座った（腰が下りすぎ）・おじぎ・床の物を拾う（上体が前へ倒れた）、のは数えない
    "mini-squat": [{ name: "squat", channels: ["hips"], guardFloor: true, guards: [{ channel: "hips", limit: "dropMax" }, { channel: "bow", limit: "bow" },
      { channel: "legs", limit: "legs", need: true, median: true, optional: true }, { channel: "place", limit: "place", abs: true, sustain: true, rebase: "placeRebaseMs" }] }]
  };
  const MODES = ["3d", "2d"];
  const unitChannels = (unit) => [...unit.channels, ...(unit.guards || []).map((guard) => guard.channel)];

  // 単位ごとの状態。previous を渡すと、使っているか（active）・見えた時刻・前回数えた時刻・戻した時刻だけ引き継ぐ。
  // spoiled：この1回は戻しても数えない（guards）。restSince・restSeen：休んだ位置にいつからいるか・restMs いたか（needRest）。
  // atBase：上げる前に基準の近く（上下とも lower 以内）にいた（その1回で、基準が本当の休んだ位置だったと分かる。restRelearnMs）。
  // calm・settled：下ろしている間の、チャンネルごとの直近 restTrustMs の e・その間、基準の近くにいた（基準は休んだ位置。startRelearnMs）。
  // lowSince：単位のチャンネルがどれも基準より lower 以上低くなった時刻・freshAt：基準を覚え始めて、初めて読めた時刻（startRelearnMs）。
  // stay：見えない間のあとに残した基準のまま上げている間の、止まっている e（幅が lower に収まる直近の続き）。
  // last：チャンネルごと・測り方ごとの直近の上がり幅（e）。checks：確かめ（guards）ごとの直近の判断（同じ名前のチャンネルを、上がり幅と確かめの
  // 両方に使う単位（立ってかかと上げ・浅いスクワットの腰）でも、互いに書きつぶさない）
  function excursionUnitState(previous) {
    return {
      phase: "down", candidate: null, candidateMode: null, candidateSince: 0, upSince: 0, upMode: null, peak: 0, peakRange: 0, floor: Infinity,
      restAt: null, restSince: null, restSeen: false, atBase: false, calm: [], settled: false, lowSince: null, freshAt: null, held: null, seeded: false, trail: [], stay: [], reading: null, guard: null, last: {}, checks: {}, ready: false, spoiled: false, active: previous ? previous.active : false,
      lastSeenAt: previous ? previous.lastSeenAt : -Infinity, lastRepAt: previous ? previous.lastRepAt : -Infinity, downAt: previous ? previous.downAt : -Infinity
    };
  }
  function excursionChannelState() {
    // low：今の値が基準から lower より離れている（anchor でない単位は、低い）。
    // restRelearnMs のためのもの。counted：この基準の近くから上げて数えた単位の名前。recent：上げている間も含めた直近の値（baselineWindowMs）。
    // dwell：止まっている間の値（幅が lower に収まる直近の続き）。dwells：見つけた止まった位置（新しい順に4つまで）。
    // kept：見えない間のあとに残した基準を、まだ確かめていない（gapKeepMs）。keptDwell：そのための、止まっている間の値。
    // keptSeen：そのための、見えてからの値（anchor でない単位。baselineWindowMs まで）。lowHeld・lowEndedAt：低いまま続いている・そこから戻った時刻（lowSettleMs）。
    // awayAt：最後に、基準から lower より離れて（anchor でない単位は、低くて）upSkipAwayMs 続いていた時刻（upSkip2dMs）
    return { samples: [], baseline: { "3d": null, "2d": null }, lastSeenAt: -Infinity, awaySince: null, low: false, lowHeld: false, lowEndedAt: -Infinity, awayAt: -Infinity, counted: {}, recent: [], dwell: [], dwells: [], kept: false, keptDwell: [], keptSeen: [] };
  }

  // しきい値（prefix つきがあればそれ）。mode は "3d" / "2d"
  function excursionLimit(limits, unit, name, mode) {
    const key = `${name}${mode}`;
    const prefixed = unit.prefix ? limits[`${unit.prefix}${key[0].toUpperCase()}${key.slice(1)}`] : undefined;
    return prefixed ?? limits[key];
  }

  // チャンネルの基準：上げていない間の値（6秒）の低い方から15%（median なら中央値）と、割る体の大きさ（中央値）。足りなければ null
  function excursionBaseline(channel, mode, limits, median) {
    const key = mode === "3d" ? "v3" : "v2";
    const scaleKey = mode === "3d" ? "s3" : "s2";
    const samples = channel.samples.filter((sample) => sample[key] !== null);
    if (samples.length < limits.baselineMinSamples || samples[samples.length - 1].t - samples[0].t < limits.baselineMinSpanMs) return null;
    const scales = samples.map((sample) => sample[scaleKey]).filter((value) => value !== null && value > 0);
    if (!scales.length) return null;
    const values = samples.map((sample) => sample[key]);
    return { base: percentileOf(values, median ? .5 : limits.baselinePercentile), scale: percentileOf(scales, .5) };
  }

  // 体の大きさ・位置の確かめ（EXCURSION_TIMING の body*）。"ok"：使う。"skip"：使わない（別の人・戻ってきたばかり）。"adopt"：その体を新しい基準にした（初めから測り直す）
  function excursionBodyCheck(ex, body, limits, now) {
    const ref = ex.body;
    const start = () => { ex.body = { sizes: { ...body.sizes }, depth: body.depth ? { [body.depth.key]: body.depth.z } : {}, x: body.x, at: now, seenAt: now, badSince: null, goodSince: null }; };
    if (!ref) {
      start();
      return "ok";
    }
    const ratios = Object.keys(body.sizes).filter((key) => ref.sizes[key] > 0).map((key) => body.sizes[key] / ref.sizes[key]);
    const scaled = ratios.length >= 2 && (ratios.every((ratio) => ratio > limits.bodyScale) || ratios.every((ratio) => ratio < 1 / limits.bodyScale));
    const refDepth = body.depth ? ref.depth[body.depth.key] : undefined;
    const deep = Number.isFinite(refDepth) && Math.abs(body.depth.z - refDepth) > limits.bodyDepthMeters;
    const width = ref.sizes.shoulder || (ref.sizes.hip ? ref.sizes.hip * 1.8 : 0);
    const jumped = width > 0 && body.x !== null && ref.x !== null && Math.abs(body.x - ref.x) > limits.bodyJump * width;
    // 長く（invalidResetMs）見えなかったあとは、その体を基準にする。見えなくなる前と大きさ・位置が違えば、初めから測り直す
    // （近づいて画面から外れ、カメラの前へかがんで戻った等。前の休んだ位置は今の体には合わない）
    if (now - ref.seenAt > limits.invalidResetMs) {
      start();
      return scaled || deep || jumped ? "adopt" : "ok";
    }
    ref.seenAt = now;
    if (scaled || deep || jumped) {
      ref.goodSince = null;
      if (ref.badSince === null) ref.badSince = now;
      if (now - ref.badSince < limits.bodyAdoptMs) return "skip";
      start();
      return "adopt";
    }
    if (ref.badSince !== null) {
      if (ref.goodSince === null) ref.goodSince = now;
      if (now - ref.goodSince < limits.bodyResumeMs) return "skip";
      Object.assign(ref, { badSince: null, goodSince: null });
    }
    // ゆっくりした変化（少し前へ座り直した等）には、基準の大きさを bodyRefMs でならして追う
    const k = 1 - Math.exp(-Math.max(0, now - ref.at) / limits.bodyRefMs);
    Object.entries(body.sizes).forEach(([key, value]) => { ref.sizes[key] = ref.sizes[key] > 0 ? ref.sizes[key] + (value - ref.sizes[key]) * k : value; });
    if (body.depth) {
      const old = ref.depth[body.depth.key];
      ref.depth[body.depth.key] = Number.isFinite(old) ? old + (body.depth.z - old) * k : body.depth.z;
    }
    Object.assign(ref, { x: body.x ?? ref.x, at: now });
    return "ok";
  }

  // 腰の高さ・深度（SEATED_GATE の説明）。gate.hipTrack に、直近 stillMs・adoptMs の腰の値を持つ（それより古い値は、いちばん新しい1つだけ残し、
  // それだけ続いたかを確かめる）。深度 zm と深度の高さ h3（上向き m）、画像の高さ vm は、直近 stillMedianMs の中央値。直近の深度の中央値から
  // hipJumpMeters 以上離れたフレームは使わない（背景・手前の物を拾った一瞬の跳び。3Dの点の高さも一緒に跳ぶ）。返り値は今のフレームの値
  // { t, v, torso, zm, h3, vm }
  function trackHips(gate, seat, limits, now) {
    const list = gate.hipTrack;
    list.push({ t: now, v: seat.hip.v, torso: seat.torso, z: seat.hip.z, y: seat.hip.h3 });
    const span = Math.max(limits.stillMs, limits.adoptMs);
    while (list.length > 1 && now - list[1].t >= span) list.shift();
    const item = list[list.length - 1];
    const depths = list.map((entry) => entry.z).filter((z) => z !== null);
    const far = depths.length ? median(depths) : null;
    const near = list.filter((entry) => now - entry.t < limits.stillMedianMs && entry.z !== null && Math.abs(entry.z - far) < limits.hipJumpMeters);
    item.zm = near.length ? median(near.map((entry) => entry.z)) : null;
    item.h3 = near.length ? median(near.map((entry) => entry.y)) : null;
    item.vm = median(list.filter((entry) => now - entry.t < limits.stillMedianMs).map((entry) => entry.v));
    return item;
  }

  // gate.hipTrack の直近 ms の、腰の高さの上下の幅（trim：上下からそれだけの割合を除く）。深度があれば m、なければ画像の高さを胴の長さで割る
  function hipRange(gate, now, ms, deep, trim) {
    const recent = gate.hipTrack.filter((item) => now - item.t < ms);
    const values = deep ? recent.map((item) => item.h3).filter((value) => value !== null) : recent.map((item) => item.vm);
    const scale = deep ? 1 : median(recent.map((item) => item.torso));
    return values.length > 1 ? (percentileOf(values, 1 - trim) - percentileOf(values, trim)) / scale : 0;
  }

  // 座っているか（SEATED_GATE の説明）。gate.seated（null はまだ決めていない：見え始め・見えない間のあと）を、seatHoldMs 続いた判断で切り替える。
  // gate.hips：座って足を止めている間の腰の高さ（h3・画像の高さ v・胴の長さ。直近 hipRestMs。覚えるのは updateExcursionCounter）。
  // gate.peak：座っていない間に、腰が座った高さからいちばん上がった高さ。hip は trackHips の値。返り値は比による判断（比がなければ null）
  function updateSeated(gate, seat, hip, limits, now) {
    const byRatio = seat.ratio === null ? null : seat.ratio >= limits.standRatio ? false : seat.ratio < limits.seatedRatio ? true : gate.seated;
    if (!seat.upright) {
      Object.assign(gate, { seated: false, flipSince: null });
      return false;
    }
    const restReady = gate.hips.length >= limits.baselineMinSamples && now - gate.hips[0].t >= limits.baselineMinSpanMs;
    const rest = (key) => {
      const values = gate.hips.map((item) => item[key]).filter((value) => value !== null);
      return restReady && values.length >= limits.baselineMinSamples ? median(values) : null;
    };
    // 腰が座った高さからどれだけ上がったか（lift）：深度があれば m、なければ画像の高さを胴の長さで割る。座っているかを決めるのは、深度があるときと、
    // ひざが映らないとき（rise。ひざが映って深度がなければ比で決める）
    const rest3 = hip.h3 === null ? null : rest("h3");
    const lift2 = rest("v") === null ? null : (rest("v") - hip.v) / rest("torso");
    const lift = rest3 !== null ? hip.h3 - rest3 : lift2;
    const rise = rest3 !== null || byRatio === null ? lift : null;
    const [mode, standAt, sitAt, drop] = rest3 !== null ? ["3d", limits.standRise3d, limits.sitRise3d, limits.adoptDrop3d] : ["2d", limits.standRise2d, limits.sitRise2d, limits.adoptDrop2d];
    // 比が立ったと言い、腰も ratioRise3d 上がった：立った（座ったと覚えた高さが、立ち上がる途中で止まった高さだったときも）。
    // 画像だけで、胴の長さが座っていたときの nearTorso2d 倍より長い：カメラのすぐ前に立った人（座ったまま椅子ごとそこまで近づくと、腰は画面の下から出る。
    // 画像の腰の高さは、近づくと座っていたときと同じくらいに見えることがある）
    const near = rise !== null && rest3 === null && hip.torso > rest("torso") * limits.nearTorso2d;
    const want = (byRatio === false && rest3 !== null && rise >= limits.ratioRise3d) || near ? false
      : rise !== null ? (rise >= standAt ? false : rise < sitAt ? true : gate.seated) : byRatio ?? gate.seated;
    if (gate.seated === null) gate.seated = want;
    if (want === gate.seated) gate.flipSince = null;
    else if (gate.flipSince === null) gate.flipSince = now;
    if (gate.flipSince !== null && now - gate.flipSince >= limits.seatHoldMs) Object.assign(gate, { seated: want, flipSince: null }, want ? { since: now } : {});
    // 座っていない間に、腰がいちばん上がった高さ（深度・画像それぞれの単位で）
    if (gate.seated) gate.peak = {};
    else {
      if (rest3 !== null) gate.peak["3d"] = Math.max(gate.peak["3d"] ?? lift, lift);
      if (lift2 !== null) gate.peak["2d"] = Math.max(gate.peak["2d"] ?? lift2, lift2);
    }
    // 座り直した（前と違う高さの席。腰の高さでは座ったと言えない）：腰が adoptMs 止まっていて（上下の幅が adoptStill 未満）、比が座ったと言う。ひざが映らなければ、座っていない間に
    // 上がった高さから drop 以上下りてきた（立った高さで止まったのでなく、腰を下ろした。画像だけなら、胴の長さも座っていたときと adoptTorso 以内：
    // 前へ歩いてきて腰が画像で下がったのでない）。まだ決めていない、座った高さを覚えていない（ひざも映らない）なら、止まっていればよい。
    // 座ったとして、止まっていた間の腰の高さを覚える（止まっていた間を、座ってからの時間に数える）
    const track = gate.hipTrack;
    const lowered = byRatio === true || (byRatio === null && (lift === null
      || (gate.peak[mode] - lift >= drop && (mode === "3d" || Math.abs(hip.torso / rest("torso") - 1) <= limits.adoptTorso))));
    if (gate.seated !== true && want !== true && (gate.seated === null || lowered) && now - track[0].t >= limits.adoptMs
      && hipRange(gate, now, limits.adoptMs, hip.h3 !== null, 0) < (hip.h3 !== null ? limits.adoptStill3d : limits.adoptStill2d)) {
      const hips = track.filter((item) => now - item.t < limits.adoptMs).map(({ t, h3, v, torso: length }) => ({ t, h3, v, torso: length }));
      Object.assign(gate, { seated: true, flipSince: null, peak: {}, hips, since: hips[0].t });
    }
    // 座ったまま、腰が座った高さより drop 以上低いまま seatHoldMs 続いた：覚えた高さは、途中まで立って止まった高さだった（比が座ったと言うので
    // 覚えた）。判定側の基準を忘れる（gate.reseat。途中まで立った姿勢で覚えた基準のままだと、座り直してからの1回を数えなかった。
    // 低いまま覚え直さない座ってかかと上げは、そのあとずっと）。座った高さは hipRestMs のうちに新しい高さへ移る。そこまで（腰が drop の半分より
    // 上へ戻るまで。座っていないときも終わり）は、腰が動いている（直近 seatHoldMs の上下の幅が adoptStill 以上）フレームごとに忘れ続ける
    // （途中で止まってから、もう一度腰を下ろした：座る途中のひざの高さを基準に覚えない）
    if (gate.seated && lift !== null && lift <= -drop) {
      if (gate.dropSince === null) gate.dropSince = now;
      if (!gate.dropped && now - gate.dropSince >= limits.seatHoldMs) Object.assign(gate, { dropped: true, reseat: true });
    } else {
      gate.dropSince = null;
      if (!gate.seated || (lift !== null && lift > -drop / 2)) gate.dropped = false;
    }
    if (gate.dropped && gate.seated && hipRange(gate, now, limits.seatHoldMs, mode === "3d", 0) >= (mode === "3d" ? limits.adoptStill3d : limits.adoptStill2d)) gate.reseat = true;
    return byRatio;
  }

  // ひざを上げたか（SEATED_GATE の説明）。gate.knees にひざごと（画像上の並び）の直近 stillRefMs の値を持つ
  function kneesMoved(gate, seat, limits, now) {
    const half = (values) => values.filter((value) => value !== null).length * 2 >= values.length;
    const middle = (values) => median(values.filter((value) => value !== null));
    // 直近 stillMs の値の、上から stillUpMs ぶんの高さが、基準より rise 以上上がった
    const lifted = (values, ref, scale, rise) => (percentileOf(values, 1 - limits.stillUpMs / limits.stillMs) - ref) / scale >= rise;
    return seat.knees.map((knee, index) => {
      const list = gate.knees[index];
      list.push({ t: now, v: knee.v, ray: knee.ray, z: knee.z });
      while (now - list[0].t > limits.stillRefMs) list.shift();
      // 直近 stillMedianMs の中央値でならす（画像の高さ h2 と、3Dの点の y÷z の hr。どちらも上向き）。深度があれば、hr の上がりに直近 stillRefMs の
      // 深度の中央値を掛けて m にする（深度が背景・ひざの前の手へ跳んでも、上がりは生まれない。長く続けば m への掛け算が少し変わるだけ）
      const recent = list.filter((item) => now - item.t < limits.stillMedianMs);
      const item = list[list.length - 1];
      item.h2 = -median(recent.map((entry) => entry.v));
      item.hr = half(recent.map((entry) => entry.ray)) ? -middle(recent.map((entry) => entry.ray)) : null;
      const window = list.filter((entry) => now - entry.t < limits.stillMs);
      if (half(list.map((entry) => entry.z)) && half(window.map((entry) => entry.hr))) {
        return lifted(window.map((entry) => entry.hr).filter((value) => value !== null), middle(list.map((entry) => entry.hr)), 1 / middle(list.map((entry) => entry.z)),
          limits.stillRise3d);
      }
      return lifted(window.map((entry) => entry.h2), median(list.map((entry) => entry.h2)), seat.torso, limits.stillRise2d);
    }).some(Boolean);
  }

  // 椅子の上で前後へずれたか（shifted）・腰が上下したか（bobbed。ひざが映らないときの足踏みの確かめ）（SEATED_GATE の説明）。
  // hip は trackHips の値。gate.restDepth に休んでいた（resting：数える途中の1回がない）間の腰の深度を持つ
  function hipsMoved(gate, hip, limits, now, resting) {
    if (resting && hip.zm !== null) gate.restDepth = hip.zm;
    const recent = gate.hipTrack.filter((item) => now - item.t < limits.stillMs);
    const depths = recent.map((item) => item.zm).filter((value) => value !== null);
    const shift = depths.length > 1 ? percentileOf(depths, 1 - limits.stillTrim) - percentileOf(depths, limits.stillTrim) : 0;
    // 休んでいた深度からのずれは、stillUpMs 続いたときだけ（深度の一瞬の跳びは、関節の平滑化で少し長く・小さくなる）
    const latest = recent.filter((item) => now - item.t < limits.stillUpMs);
    const drifted = !resting && gate.restDepth !== null && latest.every((item) => item.zm !== null && Math.abs(item.zm - gate.restDepth) >= limits.stillShiftMeters);
    return { shifted: drifted || shift >= limits.stillShiftMeters, bobbed: hipRange(gate, now, limits.stillMs, true, limits.stillTrim) >= limits.stillBob3d };
  }

  // 立ってする脚の運動の、座っているかの判断（STANDING_POSTURE）。stand.seated を書き換え、座っている間は腰の高さを覚える（stand.seat）
  function updateStandingPosture(stand, posture, limits, now, moving) {
    if (!stand.seat) Object.assign(stand, { seat: { "3d": null, "2d": null }, seatSamples: [], cues: [], hips: [], deep: false, decided: false, cueSince: null });
    if (posture.hip3 !== null || posture.gap !== null) stand.deep = true;
    const mode = stand.deep ? "3d" : "2d";
    const hip = mode === "3d" ? posture.hip3 : posture.hip2;
    const scale = mode === "3d" ? 1 : posture.scale2;
    const cue = mode === "3d" ? posture.gap : posture.ratio;
    if (cue !== null) stand.cues.push({ t: now, v: cue });
    while (stand.cues.length && now - stand.cues[0].t > limits.postureSmoothMs) stand.cues.shift();
    const cueLevel = stand.cues.length ? median(stand.cues.map((item) => item.v)) : null;
    const seatedCue = cueLevel !== null && (mode === "3d" ? cueLevel > limits.seatedGap : cueLevel < limits.seatedRatio);
    const standCue = cueLevel !== null && (mode === "3d" ? cueLevel < limits.standGap : cueLevel >= limits.standRatio);
    // 腰の上がり（画像の y・3Dの高さは下向きなので、上がると基準より小さくなる）
    const seat = stand.seat[mode];
    const rise = seat && hip !== null ? (seat.hip - hip) / seat.scale : null;
    const standRise = limits[`standRise${mode}`];
    if (!standCue) stand.cueSince = null;
    else if (stand.cueSince === null) stand.cueSince = now;
    const cueStanding = standCue && now - stand.cueSince >= limits.standCueMs;
    const seatedNow = !cueStanding && (rise !== null ? rise < limits[`seatRise${mode}`] || (seatedCue && !moving && rise < standRise) : seatedCue && !moving);
    const standingNow = rise !== null ? rise >= standRise : standCue;
    // 直近 standMs の腰の上下（測り方ごと）
    if (hip !== null && scale) stand.hips.push({ t: now, v: hip / scale, hip, scale, mode });
    stand.hips = stand.hips.filter((item) => item.mode === mode && now - item.t <= limits.standMs);
    const levels = stand.hips.map((item) => item.v);
    const settled = levels.length > 0 && Math.max(...levels) - Math.min(...levels) <= limits[`settle${mode}`];
    // 立ったと決めてから restandMs の間に、腰がそこから restand より上がって restandHoldMs 続いた（立ち上がる途中で止まっていた。かかと上げなら下ろす）：true を返し、
    // 判定側で基準を覚え直す（途中の高さを立って休んだ位置にすると、伸びきった姿勢がずっと「上げた」になる・腰が下りたままに見える）
    let restood = false;
    // 始めたばかりで、まだ座っているとも立っているとも決めていない間：奥行きの差・画像の比が立った側なら立った、どちらでもない（画像の比が
    // .65〜.78。2026-10-08 の奥の席では座って .70〜.75、立って .78〜.89）なら、座っているとして数えない（座っていた腰の高さも覚えない）。
    // ひざが見えず手がかりがなければ、立っているとする
    if (seatedNow) Object.assign(stand, { seated: true, decided: true, since: null, level: null });
    else if (stand.seated && stand.decided && cueStanding && settled && rise !== null && rise < standRise) {
      Object.assign(stand, { seated: false, since: null, level: { hip: median(stand.hips.map((item) => item.hip)), scale: median(stand.hips.map((item) => item.scale)), mode, at: now }, risenSince: null, seatSamples: [] });
      stand.seat[mode] = null;
    }
    else if (!stand.decided) Object.assign(stand, cueLevel === null || standCue ? { seated: false, decided: true } : { seated: true });
    else if (stand.seated && standingNow) {
      if (stand.since === null) stand.since = now;
      if (now - stand.since >= limits.standMs && settled && !seatedCue) {
        Object.assign(stand, { seated: false, since: null, level: { hip: median(stand.hips.map((item) => item.hip)), scale: median(stand.hips.map((item) => item.scale)), mode, at: now }, risenSince: null });
      }
    } else stand.since = null;
    const level = stand.level;
    if (limits.restandMs && !stand.seated && level && level.mode === mode && now - level.at <= limits.restandMs && hip !== null && scale) {
      if ((level.hip - hip) / level.scale < limits[`restand${mode}`]) stand.risenSince = null;
      else if (stand.risenSince === null) stand.risenSince = now;
      else if (now - stand.risenSince >= limits.restandHoldMs) {
        Object.assign(stand, { level: { hip, scale: level.scale, mode, at: now }, risenSince: null });
        restood = true;
      }
    }
    // 座っている間の腰の高さ（立ち上がりかけのフレームは足さない）。測り方が変わったら覚え直す
    if (stand.seated && stand.decided && !standingNow && !standCue && hip !== null && scale) {
      if (stand.seatSamples.length && stand.seatSamples[0].mode !== mode) stand.seatSamples = [];
      stand.seatSamples.push({ t: now, hip, scale, mode });
      while (now - stand.seatSamples[0].t > limits.seatRefMs) stand.seatSamples.shift();
      if (stand.seatSamples.length >= limits.baselineMinSamples) {
        stand.seat[mode] = { hip: median(stand.seatSamples.map((item) => item.hip)), scale: median(stand.seatSamples.map((item) => item.scale)) };
      }
    }
    return restood;
  }

  function updateExcursionCounter(counter, measurement, now) {
    const limits = counter.limits || LIMITS_BY_EXERCISE[counter.exerciseId];
    const units = EXCURSION_UNITS[counter.exerciseId];
    const channelNames = Array.from(new Set(units.flatMap(unitChannels)));
    const ex = counter.excursion || (counter.excursion = {
      units: Object.fromEntries(units.map((unit) => [unit.name, excursionUnitState()])),
      channels: Object.fromEntries(channelNames.map((name) => [name, excursionChannelState()])),
      pending: [], frameAt: null, order: null, cueRest: false, validAt: null
    });
    const frameMs = ex.frameAt === null ? 0 : Math.max(0, now - ex.frameAt);
    ex.frameAt = now;
    const result = (rep, message, extra) => ({
      rep, phase: counter.phase, quality: measurement?.valid ? Math.round(measurement.confidence * 100) : 0,
      rangePercent: counter.lastRangePercent || 0, cycleDurationMs: counter.lastCycleDurationMs, message, side: null, cue: null, ...extra
    });
    // 見えなかったフレームは、上げた／戻したの確定までの時間に数えない（見えないまま freshMs を過ぎたら取り消す）
    const pauseHold = (state) => {
      if (state.candidate === null) return;
      if (now - state.lastSeenAt > limits.freshMs) state.candidate = null;
      else state.candidateSince += frameMs;
    };
    // チャンネルの基準を覚え直す（値を捨てた・作り直した）と、その基準はまだ確かでない（restRelearnMs）。そのチャンネルで上がり幅を測る単位の
    // atBase も消す（覚え直す前の基準の近くにいたことで、新しい基準を確かにしない）
    const unproveChannel = (name) => {
      ex.channels[name].counted = {};
      units.forEach((unit) => { if (unit.channels.includes(name)) Object.assign(ex.units[unit.name], { atBase: false, calm: [], settled: false, freshAt: null }); });
    };
    // 単位を作り直す（その1回は数えない）。forget で、その単位のチャンネルの基準も忘れる。
    // 基準を残すときは「戻してからの一番低い位置」も残す（休んでいた人が見えない間にひねり始めても、見えたら数えられる）
    // seed（立ってする脚の運動）：忘れたチャンネルの基準を、直近の値（recent）のうち seed(時刻) が true の値ですぐ作り直す（seededChannel。次のフレームから
    // 覚え直すと、上げている途中・下ろしている途中の値だけで基準ができ、休んだ位置がずっと基準より低く見えて数えなくなった）。
    // 作り直したら、止まって数えられないときの覚え直し（lockRelearnMs）の時間も数え直す
    const resetUnit = (unit, forget, seed = null) => {
      const floor = forget ? Infinity : ex.units[unit.name].floor;
      ex.units[unit.name] = { ...excursionUnitState(ex.units[unit.name]), floor };
      if (forget) unitChannels(unit).forEach((name) => {
        const old = ex.channels[name];
        ex.channels[name] = seed ? seededChannel(name, old.recent.filter((sample) => seed(sample.t)), old) : excursionChannelState();
        unproveChannel(name);
      });
      if (forget && ex.watch?.[unit.name]) Object.assign(ex.watch[unit.name], { okAt: now, near: { "3d": [], "2d": [] }, shape: { "3d": [], "2d": [] }, bentAt: null, bentShape: null });
    };
    const resetAll = () => units.forEach((unit) => resetUnit(unit, true));
    // 長く見えなかった単位は、その1回を数えずに作り直す。上げている途中で見えなくなったときは、何があったか分からないので、一度下ろすまで
    // 上げ始めとみなさない（gapKeepMs がなければ基準も忘れる）。チャンネルが baselineWindowMs 見えなければ基準を忘れる（gapKeepMs があれば、
    // 人が見えない間は待ち、見えたフレームで、見えなかった時間を除いて確かめる）
    const expireStale = (seenFrame) => {
      units.forEach((unit) => {
        const state = ex.units[unit.name];
        const up = state.phase === "up";
        if (Number.isFinite(state.lastSeenAt) && now - state.lastSeenAt > (up ? limits.invalidUpResetMs : limits.invalidResetMs)) {
          resetUnit(unit, up && !limits.gapKeepMs);
          if (up) ex.units[unit.name].floor = Infinity;
          ex.units[unit.name].lastSeenAt = -Infinity;
        }
      });
      if (!seenFrame && limits.gapKeepMs) return;
      channelNames.forEach((name) => {
        const channel = ex.channels[name];
        if (!channel.samples.length || now - channel.lastSeenAt <= limits.baselineWindowMs) return;
        ex.channels[name] = { ...excursionChannelState(), lastSeenAt: channel.lastSeenAt };
        unproveChannel(name);
      });
    };
    const settlePhase = () => {
      const states = Object.values(ex.units);
      counter.phase = states.some((state) => state.phase === "up") ? "returning" : states.some((state) => state.ready) ? "ready" : "seeking-low";
    };
    // 本人への合図（update.cue）。単位の状態を読むだけで、数え方は変えない（書くのは合図のための ex.cueRest だけ）。
    // "reached"：どれかの単位が上げていて、戻せば数える（spoiled の1回は言わない）。
    // "rest"：使っている単位のうち今の読みがあるものが、どれも休んだ位置にいる（上げ始めの確定待ちでなく、e が数え方と同じ lower 以下、
    // needRest の単位は restMs いた）。どれも、なので、左右の単位（体の横倒し・体ひねり）は片側へ倒している間に反対側で rest と言わない。
    // いったん rest になったら、どれかの単位が e .75 以上（数えるしきい値の4分の3）・上げ始めの確定待ち・上げた・見えないフレーム、になるまで rest のまま
    // （呼吸の揺れでちらつかない。肩の上げ下げの深度で 1.6cm の深い呼吸は e 約 .6 まで上がるので、.5 では息ごとに rest が切れる）
    const cueOf = () => {
      const active = units.filter((unit) => ex.units[unit.name].active);
      const up = active.filter((unit) => ex.units[unit.name].phase === "up");
      if (up.length) {
        ex.cueRest = false;
        return up.some((unit) => !ex.units[unit.name].spoiled) ? "reached" : null;
      }
      const read = active.map((unit) => {
        const state = ex.units[unit.name];
        const mode = state.reading?.["3d"] ? "3d" : "2d";
        const value = state.reading?.[mode];
        return value ? { unit, state, mode, e: value.e } : null;
      }).filter(Boolean);
      if (!read.length) ex.cueRest = false;
      else if (ex.cueRest) ex.cueRest = !read.some(({ state, e }) => e >= .75 || state.candidate === "up");
      else {
        ex.cueRest = read.every(({ unit, state, mode, e }) => state.candidate !== "up" && (!unit.needRest || state.restSeen)
          && e <= excursionLimit(limits, unit, "lower", mode) / excursionLimit(limits, unit, "floor", mode));
      }
      return ex.cueRest ? "rest" : null;
    };
    // 体の大きさ・位置が急に変わったフレーム（別の人へ移った等）は見えないのと同じに扱う。その体が続けば、初めから測り直す
    if (measurement?.valid && measurement.body) {
      const verdict = excursionBodyCheck(ex, measurement.body, limits, now);
      if (verdict === "adopt") resetAll();
      if (verdict === "skip") measurement = { valid: false, message: `${measurement.visiblePart}を認識中` };
    }
    // 立ってする運動（limits.standMs あり）：座っている間は数えず、基準も忘れる（座ったまま足を横へ動かすのを数えない）。
    // 横ステップ：立ち直ったとみなすのは standRatio 以上が standMs 続いてから。腰・ひざ・肩が見えずに確かめられないフレームは、前の判断のまま。
    // 立ってする脚の運動（limits.standRise3d あり）は、腰の上がりを主に決める（STANDING_POSTURE・updateStandingPosture）
    if (limits.standMs && measurement?.valid) {
      const stand = ex.stand || (ex.stand = { seated: false, since: null });
      const ratio = measurement.stance;
      if (limits.standRise3d) {
        // 腰を下ろしている途中（STANDING_POSTURE）。確かめが止めた（腰が下りすぎ：座った）ときは除く
        const moving = Object.values(ex.units).some((state) => !state.spoiled && MODES.some((mode) => !state.guard?.[mode]?.spoil
          && (state.phase === "up" || state.candidate === "up" || (state.reading?.[mode]?.e ?? 0) > .4)));
        if (updateStandingPosture(stand, measurement.posture, limits, now, moving)) resetAll();
      } else if (Number.isFinite(ratio)) {
        if (ratio < limits.seatedRatio) Object.assign(stand, { seated: true, since: null });
        else if (stand.seated && ratio >= limits.standRatio) {
          if (stand.since === null) stand.since = now;
          if (now - stand.since >= limits.standMs) Object.assign(stand, { seated: false, since: null });
        } else stand.since = null;
      }
      if (stand.seated) {
        resetAll();
        measurement = { valid: false, message: "立って、ゆっくり動きましょう" };
      }
    }
    // 座ってする運動（limits.stillMs あり）：座って、足を止めている間だけ数える（SEATED_GATE）。立った・歩いた・足踏みした間は見えないのと同じに扱い、
    // 休んだ位置（基準）はその間の値を使わずに覚え直す。見え始めてから（見えない間のあとも）stillMs の8割たつまでは、まだ数えない
    if (limits.stillMs) {
      // 基準を忘れ、上げている途中の1回は、戻しても数えない（立った・足踏みした間の動きを1回にしない）
      const forget = () => {
        Object.values(ex.channels).forEach((channel) => { Object.assign(channel, { samples: [], counted: {}, recent: [], dwell: [], dwells: [] }); });
        Object.values(ex.units).forEach((state) => {
          Object.assign(state, { atBase: false, calm: [], settled: false, freshAt: null });
          if (state.phase === "up") state.spoiled = true;
        });
      };
      const seat = measurement?.valid ? measurement.seat : null;
      if (seat) {
        const gate = ex.gate || (ex.gate = { seated: null, flipSince: null, peak: {}, hips: [], hipTrack: [], restDepth: null, knees: [[], []], kneesUpAt: -Infinity, since: now, seenAt: now,
          dropSince: null, dropped: false, reseat: false });
        // 見えない間・フレームが来ない間が長い（invalidResetMs）：座っているか・止めているかを確かめ直す。座った腰の高さは gapKeepMs まで残し
        // （見えなかった時間を古さに数えない）、戻ってきた体をそれと比べる（立ったまま戻ってきた人を座ったとしない）。上げている途中の1回は残す
        // （見えない間に立った・足踏みしたなら、見えてからの確かめで閉じて数えない）
        const gap = now - gate.seenAt;
        if (gap > limits.invalidResetMs) {
          Object.assign(gate, { seated: null, flipSince: null, peak: {}, hipTrack: [], knees: [[], []], since: now,
            hips: limits.gapKeepMs && gap <= limits.gapKeepMs ? gate.hips.map((item) => ({ ...item, t: item.t + gap })) : [] });
        }
        gate.seenAt = now;
        const hip = trackHips(gate, seat, limits, now);
        const byRatio = updateSeated(gate, seat, hip, limits, now);
        // 途中まで立って止まった高さを座った高さとして覚えていて、そこより低く座り直した（updateSeated）：基準を忘れる
        if (gate.reseat) {
          gate.reseat = false;
          forget();
        }
        const resting = Object.values(ex.units).every((state) => state.phase !== "up" || state.spoiled);
        // ひざが映らないとき（上半身だけの運動）は、ひざの代わりに腰の上下（深度があるときだけ）を見る。ひざを上げて閉じてから stillMs のうちに
        // ひざが見えなくなったときも、閉じたまま
        const hips = hipsMoved(gate, hip, limits, now, resting);
        if (!seat.knees) gate.knees = [[], []];
        const kneesUp = limits.legStill && seat.knees !== null && kneesMoved(gate, seat, limits, now);
        if (kneesUp) gate.kneesUpAt = now;
        const legsMoved = limits.legStill && (seat.knees ? kneesUp : hips.bobbed || now - gate.kneesUpAt < limits.stillMs);
        const moved = (hips.shifted || legsMoved) && gate.seated;
        // 座った腰の高さを覚える（座って足を止めている間だけ。比が立っていると言う間・切り替わりそうな間は覚えない）
        if (gate.seated && !moved && gate.flipSince === null && byRatio !== false) {
          gate.hips.push({ t: now, h3: hip.h3, v: hip.v, torso: hip.torso });
          while (now - gate.hips[0].t > limits.hipRestMs) gate.hips.shift();
        }
        // まだ決めていない間（gate.seated が null）は、確かめている言葉のまま数えない
        const closed = gate.seated === false ? "椅子に座って、ゆっくり動きましょう" : moved ? "足の裏を床につけたまま、ゆっくり動きましょう" : null;
        if (closed) forget();
        if (closed || gate.seated === null || now - gate.since < limits.stillMs * .8) measurement = { valid: false, message: closed || `${measurement.lowLabel}を確認しています` };
      }
    }
    if (!measurement?.valid) {
      Object.values(ex.units).forEach(pauseHold);
      expireStale(false);
      settlePhase();
      ex.cueRest = false;
      return result(false, measurement?.message || "必要な部位をカメラに映してください", { quality: 0 });
    }
    counter.validFrames += 1;
    counter.lastValidAt = now;
    // 見えない間・フレームが来ない間（invalidResetMs より長い）のあと：その前の基準を使う。間が gapKeepMs までなら、見えなかった時間を基準の値の古さに
    // 数えず、単位のチャンネル（予備の単位を除く）の基準は、見えてからの値で確かめるまで残す（kept。settleKept）。基準は確かでなくなり（restRelearnMs）、
    // 見えなくなる前に基準の近くにいたことも消す（見えたすぐあとに戻した1回で、見えない間に変わったかもしれない基準を確かにしない）。
    // 離れている・低いままの時間も、見えたときから数え直す
    if (limits.gapKeepMs && ex.validAt !== null && now - ex.validAt > limits.invalidResetMs) {
      const gap = now - ex.validAt;
      const owned = new Set(units.filter((unit) => !unit.fallback).flatMap((unit) => unit.channels));
      Object.entries(ex.channels).forEach(([name, channel]) => {
        if (gap <= limits.gapKeepMs) Object.assign(channel, { samples: channel.samples.map((sample) => ({ ...sample, t: sample.t + gap })), lastSeenAt: channel.lastSeenAt + gap });
        Object.assign(channel, { counted: {}, recent: [], dwell: [], dwells: [], awaySince: null, low: false,
          kept: gap <= limits.gapKeepMs && channel.samples.length > 0 && owned.has(name), keptDwell: [], keptSeen: [] });
      });
      Object.values(ex.units).forEach((state) => { state.atBase = false; });
    }
    // 映りが悪く、とびとびに見えた（前に見えたフレームから freshMs より長くあいた。見えない間より短い）：あいた時間は基準の値の古さに数えず、
    // このフレームの値は基準に足さない（休んでいたか動いている途中か分からない値で、基準が上がっていかないように）
    const sparse = Boolean(limits.gapKeepMs) && ex.validAt !== null && now - ex.validAt > limits.freshMs && now - ex.validAt <= limits.invalidResetMs;
    if (sparse) Object.values(ex.channels).forEach((channel) => { channel.samples = channel.samples.map((sample) => ({ ...sample, t: sample.t + now - ex.validAt })); });
    ex.validAt = now;
    // 左右の取り違え（脚ごとに数える運動）：ひざの画像上の並びが逆になったフレームは orderSwitchMs まで使わない（それ以上続けば並びを覚え直す）
    if (measurement.kneeOrder) {
      const order = ex.order || (ex.order = { sign: measurement.kneeOrder, flipSince: null });
      if (measurement.kneeOrder === order.sign) order.flipSince = null;
      else if (order.flipSince === null) order.flipSince = now;
      if (order.flipSince !== null) {
        if (now - order.flipSince < limits.orderSwitchMs) {
          Object.values(ex.units).forEach(pauseHold);
          ex.cueRest = false;
          return result(false, `${measurement.visiblePart}を認識中`);
        }
        Object.assign(order, { sign: measurement.kneeOrder, flipSince: null });
      }
    }

    // 1) チャンネル：基準を覚え、測り方ごとの上がり幅（しきい値を1とした e と、可動域の割合）を出す
    const seen = { ...(measurement.channels || {}) };
    // spikeHoldMs：単位の hold の2つのチャンネル（両ひざ）のうち、片方が、直近 spikeHoldMs の一番高い値から floor より下がって、基準からの高さが
    // もう片方より floor より低く、もう片方はその間 floor の幅に止まっていたときは、その値を一番高い値にする（画面の下の端に近いひざの点は、
    // 下へだけ数フレーム跳ぶ。上げている途中の跳びで戻したとみなして1回を2回に数えない・跳んだ片方だけ下がって見えるのを片足の動きとみなさないように）。
    // 両方そろって下がったのは本当に下ろした、片方が下りながらもう片方が上がるのは足踏み：どちらもそのまま使う（戻したの確定を遅らせない。
    // 足踏みの左右を、そろって上げたように見せない）
    if (limits.spikeHoldMs) units.forEach((unit) => {
      if (!unit.hold) return;
      const tops = unit.hold.map((name) => {
        const value = seen[name];
        if (!value) return null;
        const held = (ex.held || (ex.held = {}))[name] || (ex.held[name] = []);
        held.push({ t: now, v2: value.v2, v3: value.v3 });
        while (now - held[0].t > limits.spikeHoldMs) held.shift();
        const range = (key) => {
          const values = held.map((item) => item[key]).filter((item) => item !== null);
          return value[key] === null ? null : { top: Math.max(...values), bottom: Math.min(...values) };
        };
        return { name, value, v2: range("v2"), v3: range("v3") };
      });
      if (tops.some((top) => !top)) return;
      MODES.forEach((mode) => {
        const key = mode === "3d" ? "v3" : "v2";
        if (tops.some((top) => top[key] === null)) return;
        const baselines = tops.map((top) => ex.channels[top.name].baseline[mode]);
        if (baselines.some((baseline) => !baseline)) return;
        // 基準からの高さ・直近の一番高い値からの下がり・直近の上下の幅（しきい値を1）
        const floor = excursionLimit(limits, unit, "floor", mode);
        const [a, b] = tops.map((top, i) => {
          const unitOf = (value) => value / baselines[i].scale / floor;
          return { top, height: unitOf(top.value[key] - baselines[i].base), drop: unitOf(top[key].top - top.value[key]), spread: unitOf(top[key].top - top[key].bottom) };
        });
        const dropped = [[a, b], [b, a]].find(([one, other]) => one.drop > 1 && other.height - one.height > 1 && other.spread <= 1);
        if (dropped) seen[dropped[0].top.name] = { ...seen[dropped[0].top.name], [key]: dropped[0].top[key].top };
      });
    });
    // between：確かめのチャンネルを、単位の2つのチャンネルの差にする（hold のあとの値で）
    units.forEach((unit) => (unit.guards || []).forEach((guard) => {
      if (!guard.between) return;
      const [a, b] = guard.between.map((name) => seen[name]);
      if (!a || !b) return;
      const diff = (key) => (a[key] === null || b[key] === null ? null : a[key] - b[key]);
      seen[guard.channel] = { v2: diff("v2"), s2: a.s2, v3: diff("v3"), s3: 1 };
    }));
    Object.keys(seen).forEach((name) => { if (ex.channels[name]) ex.channels[name].lastSeenAt = now; });
    // 予備の単位（横ステップの腰・体ひねりの肩幅）は、ほかの単位のチャンネルが invalidResetMs 見えないときだけ使う。切り替わったら作り直す。
    // 基準は、baselineWindowMs より古い値だけ捨てる（体ひねりで肩の深度が1〜2秒途切れて戻ったときは、休んだ向きをそのまま使う）
    const primarySeen = units.some((unit) => !unit.fallback && unit.channels.some((name) => now - ex.channels[name].lastSeenAt <= limits.invalidResetMs));
    units.forEach((unit) => {
      const active = !unit.fallback || !primarySeen;
      if (active !== ex.units[unit.name].active) {
        resetUnit(unit, false);
        Object.assign(ex.units[unit.name], { active, lastSeenAt: -Infinity });
        unitChannels(unit).forEach((name) => {
          const channel = ex.channels[name];
          channel.samples = channel.samples.filter((sample) => now - sample.t <= limits.baselineWindowMs);
          MODES.forEach((mode) => { channel.baseline[mode] = excursionBaseline(channel, mode, limits, Boolean(unit.anchor)); });
        });
      }
    });
    expireStale(true);
    let missingScale = false;
    // チャンネルの今の値の、基準からの離れ（単位の lower を1とする。測れた測り方ごと。firstModeOffset の運動は、深度で測れていれば深度だけ）
    const offsetsOf = (name, unit) => {
      const offsets = MODES.map((mode) => {
        const baseline = ex.channels[name].baseline[mode];
        const current = seen[name]?.[mode === "3d" ? "v3" : "v2"];
        return !baseline || current === null || current === undefined ? null : (current - baseline.base) / baseline.scale / excursionLimit(limits, unit, "lower", mode);
      }).filter((offset) => offset !== null);
      return limits.firstModeOffset ? offsets.slice(0, 1) : offsets;
    };
    // 基準を中央値で覚えるチャンネルか（anchor の単位のチャンネルと、向きを問わない確かめ）
    const learnsMedian = (name, users) => {
      const owner = users.find((unit) => unit.channels.includes(name));
      return owner ? Boolean(owner.anchor) : users.some((unit) => (unit.guards || []).some((guard) => guard.channel === name && (guard.abs || guard.median)));
    };
    // 値の列（samples）から基準を作り直したチャンネル（見えた時刻・直近の値は前のまま）
    const seededChannel = (name, samples, old) => {
      const users = units.filter((unit) => ex.units[unit.name].active && unitChannels(unit).includes(name));
      const fresh = { ...excursionChannelState(), lastSeenAt: old.lastSeenAt, recent: old.recent, samples: samples.map(({ t, v2, s2, v3, s3 }) => ({ t, v2, s2, v3, s3 })) };
      MODES.forEach((mode) => { fresh.baseline[mode] = excursionBaseline(fresh, mode, limits, learnsMedian(name, users)); });
      return fresh;
    };
    // lockRelearnMs（立ってする脚の運動）：止まって数えられなくなったときの覚え直し。どんな順で基準がずれても（上げている途中・下ろしている途中で
    // 覚え直した等）、休んだ位置が基準より lower 以上低く見えて、もどすたびに基準の高さへ来るだけなら、その単位は二度と数えない。
    // 休んだ位置が基準より上に見えて（基準を休んだ位置より低い所で覚えた）、もどしても下がりきらないなら、上げたままになって数えない。
    // そこで、基準の近くから上げて数えたのが最後に lockRelearnMs より前（作り直してからも同じ）で、上げかけでない間に、単位のチャンネルが
    // どれも plateauMs のあいだ止まっていて（10〜90% の幅が lower 以内）、その止まった位置が、下ろしている間は基準より lower 以上低く、
    // 上げている間（plateauMs より長く上げている。下ろしている間に高く止まっていても同じ）は lower 以上高く（lower の半分以上なら、lockRelearnMs のあいだ幅 lower の半分以内で止まって。
    // どれも反対の側へ lower より離れていない）なっていたら、
    // 止まっていた間の値で、単位のチャンネル（確かめのチャンネルも）を覚え直す（その1回は数えない）。数えるしきい値は変えない。
    // ひざの曲がり（lockLeg。腰〜足首の縦の差、チャンネルの a2・a3。足首が見えなければ腰〜ひざの差 g2・g3 で、lockLeg の半分）：腰が基準から dv 動いた
    // 止まり方で、腰〜足首の差の変わりが lockLeg × dv 以下なら覚え直さない（立ってかかと上げ：ひざが曲がって、腰が下がった分だけ腰〜足首の差が
    // 縮んだ＝しゃがんで止まった・上がったまま止まった＝かかとを上げて止まった（足首も体といっしょに上がるので、休んだ位置と見分けられない。上げている間は lockLegUp × dv 以下なら
    // 覚え直さない：かかとを上げたまま止めても、足首は腰ほど上がらず、腰〜足首の差が dv の半分ほど広がって見えた。曲げたひざを伸ばしたなら、腰が上がった分だけ広がる）。
    // 浅いスクワット：腰が上がっても、腰〜足首の差が広がっていない＝かかとを上げて止まった・腰が下りたまま、腰〜足首の差が縮んでいる＝腰を下ろして
    // 止まった。どれも数えてはいけない・数える動きの位置を休んだ位置にしない）。基準の近く（lower 以内）にいた値（真ん中の値）と比べる。
    // ひざ・足首がなければ、腰が下りて止まったときは下の形の確かめだけで決める。腰が上がって止まったときは、立ってかかと上げ（上げている側）は覚え直さず、
    // 浅いスクワット（下ろしている側）は確かめない
    const legsOf = (value, mode) => {
      const pick = (key) => (Number.isFinite(value[key]) ? value[key] : null);
      return { ...(mode === "3d" ? { a: pick("a3"), g: pick("g3"), o: pick("o3"), f: [pick("f3l"), pick("f3r")] } : { a: pick("a2"), g: pick("g2"), o: pick("o2"), f: [null, null] }), w: pick("w2"), k: pick("k2") };
    };
    // 腰が下りて止まったときの形の確かめに使う値があるか（深度：腰とひざの奥行きの差、画像：肩幅・両ひざの間）
    const hasShape = (leg) => leg.w !== null || leg.k !== null || leg.f.some((value) => value !== null);
    // 休んだ位置（rested）：単位の基準と、そのときの立つ位置のチャンネル（place）の基準
    const restedOf = (name, mode) => ({ ...ex.channels[name].baseline[mode], place: ex.channels.place?.baseline[mode] ? { ...ex.channels.place.baseline[mode] } : null });
    const relearnLocked = (unit, state) => {
      const watch = (ex.watch || (ex.watch = {}))[unit.name]
        || (ex.watch[unit.name] = { frames: [], near: { "3d": [], "2d": [] }, shape: { "3d": [], "2d": [] }, okAt: now, bentAt: null, bentShape: null, rested: { "3d": null, "2d": null } });
      const names = Array.from(new Set(unitChannels(unit)));
      const [first] = unit.channels;
      // まだ数えていない測り方は、初めの基準を休んだ位置とする（rested。数えたら、その基準に変える。立つ位置が動いて作り直したら、次に数えるまで null）
      if (watch.rested) MODES.forEach((item) => { if (!watch.rested[item] && ex.channels[first].baseline[item]) watch.rested[item] = restedOf(first, item); });
      if (unit.channels.every((name) => seen[name])) {
        watch.frames.push({ t: now, values: Object.fromEntries(names.filter((name) => seen[name]).map((name) => [name, seen[name]])) });
        // 基準の近く（lower 以内）にいたときの腰〜ひざの差（新しい方から baselineKeepSamples 個まで。古くても残す：長く止まっていた間も、前の休んだ位置と比べられるように）。
        // 形（shape：腰とひざの奥行きの差、画像の肩幅・両ひざの間）は、lower の半分以内にいたときだけ（浅くしゃがんで lower のあたりで止まった間の形を、基準の近くの形にしない）
        const keep = (list, leg) => {
          list.push(leg);
          if (list.length > (limits.baselineKeepSamples || 45)) list.shift();
        };
        MODES.forEach((item) => {
          const baseline = ex.channels[first].baseline[item];
          const value = seen[first][item === "3d" ? "v3" : "v2"];
          const leg = legsOf(seen[first], item);
          const lower = excursionLimit(limits, unit, "lower", item);
          if (!baseline || value === null || Math.abs(value - baseline.base) > lower * baseline.scale) return;
          if (leg.a !== null || leg.g !== null || leg.o !== null) keep(watch.near[item], leg);
          if (hasShape(leg) && Math.abs(value - baseline.base) <= lower * baseline.scale / 2) keep(watch.shape[item], leg);
        });
      }
      while (watch.frames.length && now - watch.frames[0].t > limits.lockRelearnMs) watch.frames.shift();
      // 立つ位置が動いて作り直したあと（rested が null）は、下ろしている間（上げかけでない）に、単位の初めのチャンネルが lockRelearnMs のあいだ
      // 新しい基準から lower 以内にいた測り方で、その基準を休んだ位置とする（次に数えるまで null のままだと、1歩動いて立ったあと、上げる前に
      // ひざを曲げて止まった位置を、動いたあとの位置と見て覚え、伸ばして立つたびに数えた）
      if (watch.rested === null && state.phase === "down" && state.candidate === null) {
        const span = watch.frames.filter((frame) => now - frame.t <= limits.lockRelearnMs);
        if (span.length >= limits.baselineMinSamples && now - span[0].t >= limits.lockRelearnMs * .9) {
          const settled = MODES.filter((item) => {
            const b = ex.channels[first].baseline[item]; const key = item === "3d" ? "v3" : "v2"; const lower = excursionLimit(limits, unit, "lower", item);
            return b && span.every((frame) => frame.values[first] && frame.values[first][key] !== null && Math.abs(frame.values[first][key] - b.base) <= lower * b.scale);
          });
          if (settled.length) { watch.rested = { "3d": null, "2d": null }; settled.forEach((item) => { watch.rested[item] = restedOf(first, item); }); }
        }
      }
      const raised = state.phase === "up";
      // 最後に上げていた（phase が up）時刻
      if (raised) watch.upAt = now;
      // lockFreshMs：基準をまだ確かめていない（その単位で、基準の近くから上げて数えたことがない。作り直した・覚え直した直後）間は、作り直し・覚え直しから
      // lockFreshMs たてば、下ろしている間に基準より低く lockFreshMs 止まった位置で覚え直す（立ってかかと上げ：深く曲げて座ったとみなされたあと、
      // 立ったと分かったときにはもう上げていて、上げた位置を基準にした。上げたまま上体を傾けた・1歩動いたところで基準を覚え直した。どちらも、
      // 1.5〜2秒ずつの休みでは plateauMs・lockRelearnMs に届かず、そのあとの1回・2秒止まるまでを数えなかった）。ひざの曲がり・形の確かめは同じ
      const unproven = limits.lockFreshMs && !unit.channels.every((name) => ex.channels[name].counted[unit.name]);
      const waited = now - watch.okAt;
      if (state.candidate !== null || waited < (unproven ? limits.lockFreshMs : limits.lockRelearnMs) || (raised && now - state.upSince < limits.plateauMs)) return false;
      // span のあいだ止まっていた位置（単位のチャンネルがどれも、10〜90% の幅が lower × band 以内）。止まっていなければ null
      const restOf = (span, band) => {
        const frames = watch.frames.filter((frame) => now - frame.t <= span);
        if (frames.length < limits.baselineMinSamples || now - frames[0].t < span * .9) return null;
        const mode = MODES.find((item) => unit.channels.every((name) => ex.channels[name].baseline[item] && frames.every((frame) => frame.values[name][item === "3d" ? "v3" : "v2"] !== null)));
        if (!mode) return null;
        const key = mode === "3d" ? "v3" : "v2";
        const lower = excursionLimit(limits, unit, "lower", mode);
        const levels = unit.channels.map((name) => {
          const { base, scale } = ex.channels[name].baseline[mode];
          const values = frames.map((frame) => frame.values[name][key]);
          return percentileOf(values, .9) - percentileOf(values, .1) > lower * band * scale ? null : { name, base, scale, dv: median(values) - base };
        });
        return levels.some((level) => !level) ? null : { frames, mode, lower, levels };
      };
      // 下ろしている間は基準より低く、上げている間は基準より高く止まっていること（どれも反対の側へ lower より離れていない）。
      // lower より離れていれば plateauMs 止まっていればよい。lower の半分より離れている（lowSettleMs の単位は、それより低い値を基準に使わない）だけなら、
      // lockRelearnMs のあいだ、幅 lower の半分以内で止まっていること（少し下を向いたカメラの前で、ゆっくり前後に揺れて、向きを変える所で覚え直さない）。
      // 下ろしている間に基準より高く止まっていても、上げている間と同じに見る（確かめのチャンネルがときどき止めて、上げたことにならないまま、
      // 曲げたひざで覚えた基準の上に立ち続けて、数えなくなった）
      const beyond = (rest, share, sign) => Boolean(rest) && rest.levels.some((level) => sign * level.dv > share * rest.lower * level.scale)
        && !rest.levels.some((level) => -sign * level.dv > rest.lower * level.scale);
      const short = waited >= limits.lockRelearnMs ? restOf(limits.plateauMs, 1) : null;
      const long = waited >= limits.lockRelearnMs ? restOf(limits.lockRelearnMs, .5) : null;
      const fresh = unproven ? restOf(limits.lockFreshMs, 1) : null;
      const sign = (raised ? [1] : [-1, 1]).find((item) => beyond(short, 1, item) || beyond(long, .5, item) || (item < 0 && beyond(fresh, 1, item)));
      if (!sign) return false;
      const up = sign > 0;
      const rest = beyond(short, 1, sign) ? short : beyond(long, .5, sign) ? long : fresh;
      const { frames: plateau, mode, levels } = rest;
      if (Number.isFinite(limits.lockLeg)) {
        const [{ name, dv }] = levels;
        const legOf = (legs, part) => {
          const values = legs.map((leg) => leg[part]).filter((value) => value !== null);
          return values.length >= limits.baselineMinSamples ? median(values) : null;
        };
        const nowLegs = plateau.map((frame) => legsOf(frame.values[name], mode));
        // 足首が止まっていた間・基準の近くの両方で見えていれば腰〜足首、なければ腰〜ひざ（腰が下りた分の半分ほど縮む）で比べる。
        // 上げている側は、両ひざの差もなければ、見えているひざだけの差（o。立ってかかと上げだけ。legOne）で
        const [part, share] = [["a", 1], ["g", .5], ...(up ? [["o", .5]] : [])].find(([item]) => legOf(nowLegs, item) !== null && legOf(watch.near[mode], item) !== null) || [];
        // 上げている間は、ひざが曲がっていない（数える動きでない）と分かったときだけ
        if (up && !part) return false;
        // 腰が基準より下りて止まった（ひざを曲げたかもしれない。立ってかかと上げは下ろしている側、浅いスクワットは上げている側で、lockLeg と向きの符号が逆）
        // ときは、形が基準の近くから変わっていないときだけ覚え直す：深度は腰とひざの奥行きの差が lockShape3d 以内、画像は肩幅・両ひざの間（腰幅の割合）が
        // lockShape2d 以内。比べられる形がなければ覚え直さない（下の shapeOf。腰〜足首の差があるとき・立ってかかと上げで手がかりが弱いときは下の説明。
        // しゃがむと、ひざが前に出て、奥行きの差が広がり、両ひざの間が、前かがみで肩が前に出て肩幅が、広く見える。画像では、高いカメラで足首が画面の外だと、しゃがんでも腰〜ひざの差が縮んで見えず（近いカメラでは広がって見えた）、
        // しゃがんで止まった位置を休んだ位置と覚え、立ってかかと上げは立ち上がるたびに数え、浅いスクワットは下ろして止めた1回とそのあとを数えなかった。
        // 足首が見えていても、前かがみなしで 30° 下ろして止めると、腰〜足首の差の縮みが lockLeg × dv に届かないことがあった。深度でも、30° で約1.5cm の
        // 腰〜ひざの差の縮みは、ひざの点がゆっくり 0.5cm ずれるだけで lockLeg × dv の内に入り、下ろして止めた位置を覚えて、そのあと数えなかった。
        // 近い・高いカメラでひざが画面の外だと確かめられず、ひざを曲げて止まった位置を覚えて、伸ばして立つたびに数えた）。
        // 形が変わったまま止まっているのは覚え直さない（ずっと低いままなら、lowKeepMs・belowReanchorMs・maxUpMs の覚え直しにまかせる。
        // 8秒止まったら覚え直すと、ひざを曲げて8秒立った位置を休んだ位置と覚え、伸ばして立つたびに数えた）
        const sank = sign * limits.lockLeg < 0;
        // 深度の奥行きの差は、止まった間と比べる相手の両方で測れたひざで（左右とも測れれば平均、なければ片方）。比べられなければ画像の肩幅・両ひざの間で、
        // 立ってかかと上げは、両ひざの間も比べられなければ（片方のひざが隠れた）肩幅だけで比べる（比べられる値がないときに覚え直さないと、片方のひざが
        // 隠れた・深度がないだけで、1歩動いた・上げたまま前かがみになった・基準がずれた、のあと、ずっと数えなかった。両ひざとも画面の外なら肩幅もない：legGap）。
        // 肩幅だけで比べるのは、確かめる側（止まった間・上げていた間）のフレームの半分以上で肩幅が測れた（ひざが見えていた）ときだけ（近い・高いカメラの画像だけで、
        // 前かがみなしでひざを 55° 曲げて8秒立つと、止まった間はひざが画面の下の外で、立ち上がり始めの数フレームだけ見えたひざで肩幅を測り、前かがみなしでは
        // 肩幅は変わらないので、曲げて止まった位置を覚え、伸ばして立っても上げたままに見えて数えなかった）。
        // 浅いスクワット（腰を下ろして止めたのが数える動き。sign > 0）は、肩幅だけでは覚え直さない（前かがみなしで下ろして止めても肩幅は変わらず、
        // 下ろした位置を覚えて、そのあと数えなかった。下ろした位置で止まったままなら maxUpMs で作り直す）
        const depthOf = (legs, knees) => legOf(legs.map((leg) => ({ v: knees.every((side) => leg.f[side] !== null) ? mean(knees.map((side) => leg.f[side])) : null })), "v");
        // 両ひざの間も、確かめる側のフレームの半分以上で測れたときだけ使う（とても近いカメラの画像だけで、前かがみ少しでひざを 35° 曲げて5秒立つと、止まった間は
        // ひざが画面の下の外で、伸ばし始めの数フレームだけ見えた両ひざの間と肩幅で同じ形に見え、曲げて止まった位置を覚え、伸ばして立って数えた）。
        // 形が同じか（same：true / false。既定は止まった間の形と比べる。比べられる値がなければ null）と、比べた手がかり（cue："depth" 奥行きの差・"image" 肩幅と
        // 両ひざの間・"width" 肩幅だけ・null なし）
        const shapeOf = (legs, at = nowLegs) => {
          const depth = [[0, 1], [0], [1]].map((knees) => [depthOf(at, knees), depthOf(legs, knees)]).find((values) => values.every((value) => value !== null));
          if (depth) return { cue: "depth", same: Math.abs(depth[0] - depth[1]) <= limits.lockShape3d };
          const [w, k] = ["w", "k"].map((item) => [legOf(at, item), legOf(legs, item)]);
          const mostly = (item) => at.filter((leg) => leg[item] !== null).length * 2 >= at.length;
          const pairs = sign > 0 || (k.every((value) => value !== null) && mostly("k")) ? [w, k] : mostly("w") ? [w] : [[null, null]];
          if (pairs.some((values) => values.includes(null))) return { cue: null, same: null };
          return { cue: pairs.length > 1 ? "image" : "width", same: pairs.every(([at, near]) => Math.abs(at - near) <= limits.lockShape2d) };
        };
        // 立ってかかと上げでは、止まる前に、止まった位置から floor 以上高かったフレーム（止まった位置からかかとを上げていた）の形とも比べる
        // （ひざを少し曲げた立ち方に変えて、そこからかかとを上げている：上げても形は変わらない。ひざを曲げて止まる前に伸ばして立っていたのは形が違う）。
        // 形が違って覚え直さなかったあと（bentAt）は、そのあとのフレームとだけ比べる（同じ位置に止まったまま比べ直すと、止まる前のフレームが古い方から消えて、
        // 深く曲げて下りてくる最後の方だけが残り、止まった形に近く見えた：画像だけで、ひざの点が横にぶれると、ひざを 55° 曲げて8秒立った位置を覚え、
        // 伸ばして立って数えたあと、上げたままになって数えなかった）。まだ断っていなくて、基準の近くの形が分かっていれば、上げていたフレームの形が基準の近くの形とも
        // 同じときだけ（trusted。かかとを上げたままひざを曲げて、曲げたまま下ろすと、止まる前の上げていたフレームが曲げた形で、曲げた位置を覚え、伸ばして立つと
        // 上げたままに見えて数えなかった。上げた位置で覚え直した基準から下ろして止まった形は、基準の近くの形とわずかに違って見えることがあり、上げていたフレームと
        // 比べないと、次に上げ始めるまで覚え直さず、その1回を数えなかった）。bentAt は、上げた・覚え直した・作り直したら忘れる
        const key = mode === "3d" ? "v3" : "v2";
        const level = levels[0].base + dv;
        const near = shapeOf(watch.shape[mode]);
        const lifted = sank && sign < 0 ? watch.frames.filter((frame) => frame.t > (watch.bentAt ?? -Infinity) && frame.t < plateau[0].t && frame.values[name] && frame.values[name][key] !== null
          && frame.values[name][key] - level >= excursionLimit(limits, unit, "floor", mode) * levels[0].scale).map((frame) => legsOf(frame.values[name], mode)) : [];
        const raised = shapeOf(lifted);
        const standing = shapeOf(watch.shape[mode], lifted);
        const trusted = watch.bentAt !== null || near.same === null || standing.same;
        // 立ってかかと上げで、ひざの曲がりを確かめられない（弱い手がかり）：奥行きの差がなく、腰〜足首の差（a）もなく、画像の肩幅と両ひざの間があっても、止まった間の
        // 腰〜足首・腰〜ひざの差が測れない（基準の近くの差がまだないだけ：作り直した直後、は弱いとしない。少し下を向いたカメラの画像だけで、上げたまま 20cm 前へ出て
        // 下ろすと、動いた先で立った位置が下りて見え、そこで覚え直さずに次の1回を数えなかった）。肩幅は前かがみしか見えず（前かがみなしでひざを曲げても変わらない）、
        // 両ひざの間も腰〜ひざの差なしでは、ひざを曲げて止まった位置と見分けられなかった（片方のすね・ひざが隠れた・脚の深度がない、で、ひざを曲げて5〜8秒立ったあと、
        // 伸ばして立つたびに数えた・そのあとの数回を数えなかった）。
        // そのときは、止まった位置が、基準の近くから上げて数えた最後の1回の基準（rested。まだ数えていなければ初めの基準、1歩動いて作り直したあとは
        // 新しい基準）から lower 以内で、今の基準がそれより floor 以上高い（いつもの休んだ位置へ、上げた位置で覚えた基準から下ろした：上げたまま1歩動いた・
        // 前かがみになった・基準がずれた、のあと。今の基準が休んだ位置のそばなら、そこから曲げて下りただけ：ひざを少し曲げて立ち始め、伸ばして立ったあと、
        // ひざを曲げて止まった位置が初めの基準から lower 以内で、そこを覚え、伸ばして立つたびに数えた）か、断ったあとにその位置からかかとを上げていて、その上げていたフレームの
        // 形が止まった間と同じで、止まった間の形も上げていたフレームの形も基準の近くの形と違う（立ち方を変えて、そこから上げている）ときだけ覚え直す
        // （比べる形がまったくなくても、ずっと覚え直さないことはない）
        const cue = near.cue ?? raised.cue;
        const weak = sank && sign < 0 && !(cue === "depth" || part === "a" || (cue === "image" && ["a", "g"].some((item) => legOf(nowLegs, item) !== null)));
        if (weak) {
          const rested = watch.rested?.[mode];
          const home = Boolean(rested) && Math.abs(level - rested.base) <= excursionLimit(limits, unit, "lower", mode) * rested.scale
            && levels[0].base - rested.base >= excursionLimit(limits, unit, "floor", mode) * rested.scale;
          // 立つ位置が動いたあと（moved）は、休んだ位置と比べられない（少し下を向いたカメラの前で、上げたまま 20cm 前へ出て下ろすと、立った位置が下りて見え、
          // 休んだ位置から lower より離れて、そのあとずっと数えなかった。作り直さないほどの動きでも同じ）。止まる前に止まった位置より上にいて（上げていた）、その形が
          // 止まった間と違わず、次のどちらかなら覚え直す：作り直した（place の rebase。rested なし）あとで、形が基準の近くと違わない。止まった間の立つ位置の
          // チャンネルの値（真ん中の値）が、休んだ位置を覚えたときの place の基準から place の半分より離れていて、形が基準の近くと同じと分かった（place の基準は
          // 上げている間も覚えるので遅れ、動いた先で下ろしてすぐは、まだ離れて見えなかった。体の横幅は前かがみでも広がる：とても近いカメラで、上げたまま
          // ひざを曲げて前かがみになり、曲げたまま下ろして止まった位置を覚え、そのあとの数回を数えなかった）。
          // どちらも、止まる前の lockRelearnMs のあいだに上げていて（phase が up。伸ばして立っていたフレームを上げていたフレームとしない：1歩動いて立ったあと、
          // 上げる前にひざを曲げて止まった位置を覚え、伸ばして立つたびに数えた）、離れていたときは、上げていたフレームの立つ位置（真ん中の値）も、止まった間の
          // 立つ位置から place の半分以内で、休んだ位置の立つ位置より止まった間の立つ位置に近い（上げたまま動いて、動いた先で下ろした。ひざを曲げて腰が
          // 動いただけなら、上げていたフレームは前の位置にある：ひざを曲げて腰を 9cm 後ろへ引いて止まると、腰の奥行き・体の横幅が離れて見え、動いたとみて
          // 曲げた位置を覚え、伸ばして立つたびに数えた。6〜7cm 動かして止まると、止まる前のフレームに動きかけのフレームが入って、止まった間の立つ位置から
          // place の半分以内に見えた）
          const places = plateau.map((frame) => frame.values.place?.[key]).filter((value) => value !== null && value !== undefined);
          const away = Boolean(rested?.place) && places.length > 0 && Math.abs(median(places) - rested.place.base) / rested.place.scale > limits[`place${mode}`] / 2;
          const liftedPlaces = watch.frames.filter((frame) => frame.t > (watch.bentAt ?? -Infinity) && frame.t < plateau[0].t && frame.values[name] && frame.values[name][key] !== null
            && frame.values[name][key] - level >= excursionLimit(limits, unit, "floor", mode) * levels[0].scale).map((frame) => frame.values.place?.[key]).filter((value) => value !== null && value !== undefined);
          const sameSpot = !rested?.place || !places.length || !liftedPlaces.length
            || Math.abs(median(liftedPlaces) - median(places)) / rested.place.scale <= Math.min(limits[`place${mode}`] / 2, Math.abs(median(liftedPlaces) - rested.place.base) / rested.place.scale);
          const wasUp = watch.upAt !== undefined && watch.upAt >= plateau[0].t - limits.lockRelearnMs;
          const moved = wasUp && (rested ? away && sameSpot && near.same === true : near.same !== false) && lifted.length > 0 && raised.same !== false;
          // 基準の近くの形は、初めに断ったときの形（bentShape）を使う（そのあと止まった位置からかかとを上げると、上げ下げの途中のフレームが基準の近くの形に入り、
          // 立ち方を変えた形に近づいて、違うと分からなくなった）。止まった間と上げていたフレームの両方で違うときだけ（changed。上げていたフレームは止まる前の
          // 1秒ほどで少なく、伸ばして立っていたフレームと曲げて下りる途中のフレームで、点のぶれで違う形・止まった間と同じ形に見えた：高いカメラで、
          // 前かがみなしでひざを 30° 曲げて8秒立つのを3回はさむと、画像だけで右ひざが隠れて肩幅だけのときも、深度の脚の点がないときも、
          // 2回目に曲げた位置を覚え、伸ばして立って数えた）
          const before = watch.bentShape ? watch.bentShape[mode] : watch.shape[mode];
          const changed = [nowLegs, lifted].every((at) => shapeOf(before, at).same === false);
          if (!home && !moved && !(watch.bentAt !== null && raised.same && changed)) {
            if (watch.bentAt === null) watch.bentShape = { "3d": watch.shape["3d"].slice(), "2d": watch.shape["2d"].slice() };
            watch.bentAt = now;
            return false;
          }
        // 立ってかかと上げは、比べる形がまったくなくても、腰〜足首の差（a）があれば、下の lockLeg だけで決める（両ひざが隠れても、ひざの曲がりは腰〜足首の差の縮みで
        // 分かる。浅いスクワットは、前かがみなしで 30° 下ろして止めると、縮みが lockLeg × dv に届かないことがあり、形がなければ覚え直さない）
        } else if (sank && !near.same && !(trusted && raised.same) && !(sign < 0 && cue === null && part === "a")) {
          watch.bentAt = now;
          return false;
        }
        // 腰が下りて止まったときは、差が反対の向きに lockLeg × dv より広がっていても覚え直さない（近い・高いカメラでは、ひざを曲げると、ひざが前へ出て
        // 腰〜ひざの差が広がって見え、立ってかかと上げで、ひざを曲げて5秒立った位置を休んだ位置と覚え、伸ばして立って数えた。上げた位置で覚えた
        // 基準からかかとを下ろしたなら、ひざは腰といっしょに下りて、差はほとんど変わらない）
        const lockLeg = up && Number.isFinite(limits.lockLegUp) ? limits.lockLegUp : limits.lockLeg;
        const change = part ? legOf(nowLegs, part) - legOf(watch.near[mode], part) : null;
        if (part && (change <= lockLeg * share * dv || (sank && change >= -lockLeg * share * dv))) return false;
      }
      const since = plateau[0].t;
      names.forEach((name) => {
        ex.channels[name] = seededChannel(name, plateau.filter((frame) => frame.values[name]).map((frame) => ({ t: frame.t, ...frame.values[name] })), ex.channels[name]);
        unproveChannel(name);
      });
      ex.units[unit.name] = { ...excursionUnitState(state), reading: { "3d": null, "2d": null } };
      // 形は、止まっていた間（新しい基準の近くにいた）の形から始める（空から始めると、すぐに離れて lower の半分以内のフレームがたまらず、次の覚え直しで
      // 形を確かめられなかった：下を向いたカメラの深度では、1歩下がると腰が下りて見え、下がる・もどるを繰り返すと、覚え直せずに、もどるたびに数えた）
      const shape = Object.fromEntries(MODES.map((item) => [item, plateau.map((frame) => legsOf(frame.values[first], item))
        .filter(hasShape).slice(-(limits.baselineKeepSamples || 45))]));
      Object.assign(watch, { okAt: now, frames: watch.frames.filter((frame) => frame.t >= since), near: { "3d": [], "2d": [] }, shape, bentAt: null, bentShape: null });
      return true;
    };
    // 止まった位置で覚え直すか（restRelearnMs の anchor の単位。SEATED_GATE の説明）。今のフレームの値を足して、止まった位置を見つけたら覚え、
    // 新しい順に X・Y・X・基準の近く（か X・基準の近く・X・Y）になったら true。今 X にいるときだけ（X に止まっていた間の値で覚え直すので）。
    // 見えない間のあとに残した基準（kept。確かめる前）は、基準の近くでなくても、X・Y・X・Z の Y と Z が X の両側へ floor 以上離れていれば true
    // （見えない間に、向きを変えて・傾いて座り直した）
    const relearnAtDwell = (channel, unit, value) => {
      const mode = value.v3 !== null && channel.baseline["3d"] ? "3d" : value.v2 !== null && channel.baseline["2d"] ? "2d" : null;
      if (!mode) return false;
      const { base, scale } = channel.baseline[mode];
      const lower = excursionLimit(limits, unit, "lower", mode) * scale;
      const floor = excursionLimit(limits, unit, "floor", mode) * scale;
      if (channel.dwell.length && channel.dwell[0].mode !== mode) channel.dwell = [];
      channel.dwell.push({ t: now, v: value[mode === "3d" ? "v3" : "v2"], mode });
      const spread = () => Math.max(...channel.dwell.map((item) => item.v)) - Math.min(...channel.dwell.map((item) => item.v));
      while (spread() > lower || now - channel.dwell[0].t > limits.baselineWindowMs) channel.dwell.shift();
      if (now - channel.dwell[0].t < limits.baselineMinSpanMs) return false;
      const level = mean(channel.dwell.map((item) => item.v));
      const dwells = channel.dwells.filter((item) => item.mode === mode);
      if (dwells.length && Math.abs(dwells[0].level - level) <= lower) return false;
      channel.dwells = [{ level, mode }, ...dwells].slice(0, 4);
      if (channel.dwells.length < 3) return false;
      // 3つだけのときは、いちばん古い止まった位置の前に、基準を覚えた位置（基準の近く）があったとみなす
      const [x, p, x2, q = base] = channel.dwells.map((item) => item.level);
      const near = (a, b) => Math.abs(a - b) <= lower;
      if (!near(x, x2) || Math.abs(x - base) < floor) return false;
      if (channel.kept) return channel.dwells.length === 4 && (p - x) * (q - x) < 0 && Math.abs(p - x) >= floor && Math.abs(q - x) >= floor;
      const rest = near(p, base) ? p : near(q, base) ? q : null;
      const far = rest === p ? q : p;
      return rest !== null && (rest - x) * (far - x) < 0 && Math.abs(far - x) >= floor;
    };
    // 見えない間のあとに残した基準（kept）を確かめる。確かめるまでは基準の値を足しも捨てもしない（違う位置で休むようになっていても、
    // 上げ下げの途中の値で基準が少しずつずれていかないように）。ただし座ってする運動（restRelearnMs）の anchor でない単位は、基準より lower 低い位置から
    // floor に届かない位置までの値を足し、足すたびに古すぎる値を1つ捨てる（深い呼吸で肩が上下し続けても、見えないことがなかったときと同じように
    // 基準がついていく。1つずつなので、前かがみ等で足さない間が長くても、残した基準がまとめて消えない）。映りが悪く、とびとびに見えたフレーム（sparse）は使わない。
    // anchor でない単位は、見えてからの値（keptSeen：どの単位も上げていない間。baselineWindowMs まで）の baselinePercentile で確かめる。
    // 基準の近く（lower 以内）なら休んだ位置は変わっていない：残した基準に、見えてからの値のうち基準の近くの値を足して覚え続ける
    // （座ってする運動は足してあるので足さない。止まらずに動き続けていても確かめられる）。基準より高くても floor に届かない位置に
    // baselineWindowMs の半分いたら、見えない間に肩をすくめて座り直した等とみなして、見えてからの値で覚え直す（止まった位置で高い位置を覚え直すと、
    // 小さく上げて止めた回や上げる途中の止まりで基準が一段ずつ上がって数えなくなる）。
    // 止まった位置（keptDwell：lower の幅に baselineMinSpanMs 収まった。途中で freshMs より長く見えなくなったら数え直す）が基準の近くなら
    // 確かめたとし、止まっていた間の値を基準にする。基準より低い位置に止まったら、前の休んだ位置へ戻しても新しい基準から上げたように見えない位置
    // （ゆれの lower を足しても floor に届かない。ひざの上と体の横を行き来するだけの腕を数えない）か、低いまま覚え直す運動（restRelearnMs）なら、
    // 見えない間に座り直した・腕を垂らした等とみなしてそこで覚え直し、次の確かめを待つ（確かめ（relearn）のチャンネルが動いている間・ほかの腕や肩が
    // 上がっている間は覚え直さない）。anchor の単位は、どちら側でも前の休んだ位置へ戻して倒した（ひねった）ように見えない位置なら、そこで覚え直す。
    // true：このフレームの値は基準に足さず、古い値も捨てない。false：足す（座ってする運動の、確かめる前の値）か、残した基準がない
    const settleKept = (name, owner, value, steady) => {
      const channel = ex.channels[name];
      if (!MODES.some((mode) => channel.baseline[mode])) {
        channel.kept = false;
        return false;
      }
      const mode = MODES.find((item) => channel.baseline[item] && value[item === "3d" ? "v3" : "v2"] !== null);
      if (!mode || sparse) return true;
      const lower = excursionLimit(limits, owner, "lower", mode);
      const floor = excursionLimit(limits, owner, "floor", mode);
      const offset = (value[mode === "3d" ? "v3" : "v2"] - channel.baseline[mode].base) / channel.baseline[mode].scale / lower;
      const sample = { t: now, v2: value.v2, s2: value.s2, v3: value.v3, s3: value.s3 };
      // このフレームの値を基準に足さない（座ってする運動の anchor でない単位は、lower 低い位置より下か、floor に届いた値だけ）
      const keep = !limits.restRelearnMs || owner.anchor || offset < -1 || offset * lower >= floor;
      const release = (samples) => {
        Object.assign(channel, { samples: samples || (limits.restRelearnMs ? channel.samples : [...channel.samples, ...channel.keptSeen.filter((item) => Math.abs(item.offset) <= 1).map((item) => item.sample)]), kept: false, keptDwell: [], keptSeen: [], awaySince: null, low: false });
        if (samples) unproveChannel(name);
        return true;
      };
      if (!owner.anchor) {
        const seen = channel.keptSeen;
        if (seen.length && seen[0].mode !== mode) seen.length = 0;
        seen.push({ mode, offset, sample });
        while (now - seen[0].sample.t > limits.baselineWindowMs) seen.shift();
        const span = now - seen[0].sample.t;
        if (seen.length >= limits.baselineMinSamples && span >= limits.baselineMinSpanMs) {
          const low = percentileOf(seen.map((item) => item.offset), limits.baselinePercentile);
          if (Math.abs(low) <= 1) return release();
          if (low > 1 && low * lower < floor && span >= limits.baselineWindowMs / 2) return release(seen.map((item) => item.sample));
        }
      }
      const dwell = channel.keptDwell;
      if (dwell.length && (dwell[0].mode !== mode || now - dwell[dwell.length - 1].sample.t > limits.freshMs)) dwell.length = 0;
      dwell.push({ mode, offset, sample });
      while (Math.max(...dwell.map((item) => item.offset)) - Math.min(...dwell.map((item) => item.offset)) > 1) dwell.shift();
      if (dwell.length < limits.baselineMinSamples || now - dwell[0].sample.t < limits.baselineMinSpanMs) return keep;
      const level = mean(dwell.map((item) => item.offset));
      const same = Math.abs(level) <= 1;
      // 前の休んだ位置へ戻しても、新しい基準から上げた（倒した）ように見えない
      const clear = (Math.abs(level) + 1) * lower < floor;
      const moved = !same && (owner.anchor ? clear
        : level < 0 && (clear || Boolean(limits.restRelearnMs)) && steady() && owner.channels.every((other) => offsetsOf(other, owner).every((item) => item <= 1)));
      if (same || moved) {
        Object.assign(channel, { samples: dwell.map((item) => item.sample), kept: moved, keptDwell: [], keptSeen: [], awaySince: null, low: false });
        if (moved) unproveChannel(name);
        return true;
      }
      return keep;
    };
    // 基準：そのチャンネルを使う単位がどれも上げていない間だけ覚える。基準より lower 以上低い値は使わない（belowReanchorMs 続けば覚え直す）。
    // anchor の単位は、基準の近く（lower 以内）にいる間だけ（動いている途中で基準がつられないように。離れたまま baselineWindowMs たてば、今の位置で覚え直す）。
    // 両向きの確かめ（abs。胴の長さ）は、その単位がしきい値まで上がっていない間だけ（前かがみで始めた人が背を伸ばしている間に、胴の長さの基準がつられないように）
    channelNames.forEach((name) => {
      const channel = ex.channels[name];
      const value = seen[name];
      const users = units.filter((unit) => ex.units[unit.name].active && unitChannels(unit).includes(name));
      if (!value || !users.length) return;
      const owner = users.find((unit) => unit.channels.includes(name));
      if (limits.restRelearnMs || limits.reanchorSeedMs || limits.lockRelearnMs || limits.startRelearnMs) {
        channel.recent.push({ t: now, v2: value.v2, s2: value.s2, v3: value.v3, s3: value.s3 });
        while (now - channel.recent[0].t > limits.baselineWindowMs) channel.recent.shift();
      }
      // 基準がまだ確かでない（restRelearnMs。左右の単位なら、どちらかがまだ）
      const unproven = Boolean(limits.restRelearnMs && owner) && users.some((unit) => unit.channels.includes(name) && !channel.counted[unit.name]);
      if ((unproven || channel.kept) && owner.anchor && relearnAtDwell(channel, owner, value)) {
        // 片側へ倒したところを基準にしていた：その単位の1回は数えず、確かめのチャンネルも含めて、X に止まっていた間の値で覚え直す
        const since = channel.dwell[0].t;
        users.forEach((unit) => { ex.units[unit.name] = excursionUnitState(ex.units[unit.name]); });
        new Set(users.flatMap(unitChannels)).forEach((other) => {
          const old = ex.channels[other];
          const fresh = { ...excursionChannelState(), lastSeenAt: old.lastSeenAt, recent: old.recent, samples: old.recent.filter((sample) => sample.t >= since) };
          MODES.forEach((mode) => { fresh.baseline[mode] = excursionBaseline(fresh, mode, limits, learnsMedian(other, users)); });
          ex.channels[other] = fresh;
        });
        return;
      }
      if (users.some((unit) => ex.units[unit.name].phase === "up")) {
        Object.assign(channel, { awaySince: null, keptDwell: [] });
        return;
      }
      const median = learnsMedian(name, users);
      if (!owner && median && users.some((unit) => MODES.some((mode) => ex.units[unit.name].reading?.[mode]?.e >= 1))) return;
      // 覚え直しの確かめ（relearn）のチャンネルは、単位のチャンネルが基準より低い間（前かがみ）の値を覚えない（前かがみの肩幅を基準にしない）
      let learn = Boolean(owner) || !users.some((unit) => (unit.guards || []).some((guard) => guard.channel === name && guard.relearn)
        && unit.channels.some((other) => ex.channels[other].low));
      let hold = false;
      if (owner) {
        const offsets = offsetsOf(name, owner);
        const away = owner.anchor ? offsets.some((offset) => Math.abs(offset) > 1) : offsets.some((offset) => offset < -1);
        // 確かめ（relearn）のチャンネルが基準から動いていない（前かがみでない）
        const steady = () => (owner.guards || []).every((guard) => !guard.relearn || MODES.every((mode) => {
          const threshold = limits[`${guard.relearn}${mode}`];
          const { baseline, recent } = ex.channels[guard.channel];
          const key = mode === "3d" ? "v3" : "v2";
          const values = recent.filter((sample) => now - sample.t <= limits.relearnSmoothMs && sample[key] !== null).map((sample) => sample[key]);
          return !Number.isFinite(threshold) || !baseline[mode] || !values.length || Math.abs(mean(values) - baseline[mode].base) / baseline[mode].scale <= threshold;
        }));
        channel.low = away;
        hold = channel.kept && settleKept(name, owner, value, steady);
        if (hold) learn = false;
        else if (!away) {
          channel.awaySince = null;
          if (channel.lowHeld) Object.assign(channel, { lowHeld: false, lowEndedAt: now });
          // lowSettleMs の単位は、基準より lower の半分より低い値も覚えない（ゆっくり下りる途中の値で、低いと分かる前に基準がつられないように）
          // upSkip2dMs の単位は、画像だけのとき、基準から lower より離れて（浅いスクワット：基準より高く）upSkipAwayMs 続いたあと upSkip2dMs の間、数える向きへ lower の半分より
          // 離れた値も覚えない（ひざを曲げて立った位置で覚えた基準が、伸ばして立った位置を覚えないまま、下ろした位置の値で下へつられていき、数えなくなった。
          // 深度では、少し下を向いたカメラの前で前後に揺れるのを、基準が追えずに数えた。点のぶれで一瞬高く見えたのでも覚えないと、基準が高い方へかたより、
          // 近い低いカメラの 45° を下ろしすぎ（dropMax）として数えなかった）
          // seedHold の単位は、下ろしている間に覚え直した（rebase の seeded）あと、次に上げるまで、数える向きへ lower より離れた値も覚えない
          // （少し下を向いたカメラの前で、腰を下ろしたまま 20cm 前へ出ると、動いた先で覚え直したときにまだ下ろしていた・覚え直してすぐ下ろし始めて、
          // 上げ始めとみなせない間に、下ろしていた値で少ない値の基準が下へつられ、立った位置が基準より高く見えて、そのあと数えなかった）
          if (now - channel.lowEndedAt < limits.lowSettleMs || (limits.lowSettleMs && offsets.some((offset) => offset < -.5)) || (limits.upSkip2dMs && value.v3 === null && now - channel.awayAt < limits.upSkip2dMs && offsets.some((offset) => offset > .5))
            || (ex.units[owner.name].seeded && offsets.some((offset) => offset > 1))) learn = false;
        }
        else {
          if (channel.awaySince === null) channel.awaySince = now;
          if (now - channel.awaySince >= (limits.upSkipAwayMs || 0)) channel.awayAt = now;
          // lowSettleMs：基準より lower 以上低いまま holdMs 続いたら、低くなる前 lowSettleMs に覚えた値を捨て、戻ってからも lowSettleMs は覚えない
          // （下りる途中・もどる途中の値で、基準が一段ずつ下へつられないように。点のぶれで一瞬低く見えたのは捨てない。
          // 捨てると基準がなくなる・下がるとき（前に低いところで覚えた値が残っている）も捨てない）
          if (limits.lowSettleMs && !channel.lowHeld && now - channel.awaySince >= limits.holdMs) {
            channel.lowHeld = true;
            const older = { samples: channel.samples.filter((sample) => sample.t < channel.awaySince - limits.lowSettleMs) };
            const raised = (mode) => {
              const kept = excursionBaseline(older, mode, limits, false);
              return !channel.baseline[mode] || Boolean(kept && kept.base >= channel.baseline[mode].base);
            };
            if (MODES.every(raised)) channel.samples = older.samples;
          }
          // 基準がまだ確かでない（restRelearnMs）：低いまま restRelearnMs たったら覚え直す。確かめ（relearn）のチャンネルが動いている間（前かがみ）は数え直す。
          // 両腕・両肩の単位は、ほかのチャンネルが基準より上がっていないときだけ（体を横へ倒すと、片方の肩が下がって反対の肩が上がる）。
          // 予備の単位（体ひねりの画像だけの肩幅）は覚え直さない（前かがみでも肩幅は広く見えて、起き上がると狭まって見える）
          const relearnable = unproven && !owner.anchor && !owner.fallback;
          if (relearnable && !steady()) channel.awaySince = now;
          const relearn = relearnable && now - channel.awaySince >= limits.restRelearnMs
            && owner.channels.every((other) => offsetsOf(other, owner).every((offset) => offset <= 1));
          const reanchorMs = owner.anchor ? limits.baselineWindowMs : limits.lowKeepMs || limits.belowReanchorMs;
          if (relearn || (reanchorMs && now - channel.awaySince >= reanchorMs)) {
            // reanchorSeedMs：低いまま覚え直すときは、直近 reanchorSeedMs の値ですぐ基準を作る（覚え直した直後に動き始めても、その1回の上げ始めを測れるように）
            const seed = !relearn && limits.reanchorSeedMs ? channel.recent.filter((sample) => now - sample.t <= limits.reanchorSeedMs) : [];
            Object.assign(channel, { samples: seed, awaySince: null });
            unproveChannel(name);
          } else learn = false;
        }
        // freeze の確かめが止めている（前のフレームの判断。座ってかかと上げの腰が上がっている）間は覚えない（途中まで立って止まった間のひざの高さを
        // 覚えると、座り直して下ろした位置が、ずっと基準より低いままになった。低いまま覚え直さない運動なので、そのあと1回も数えなかった）
        const frozen = (owner.guards || []).some((guard) => guard.freeze && MODES.some((mode) => {
          const last = ex.units[owner.name].checks[guard.channel]?.[mode];
          return Boolean(last) && now - last.t <= limits.freshMs && last.over;
        }));
        if (frozen) learn = false;
      }
      if (learn && !sparse) channel.samples.push({ t: now, v2: value.v2, s2: value.s2, v3: value.v3, s3: value.s3 });
      // 古い値を捨てる（anchor が離れている間と、覚え直しの確かめ（relearn）のチャンネルが覚えない間は、休んだ位置を残すため捨てない。
      // 確かめの基準が消えると、前かがみのままでも覚え直してしまう）。見えない間のあとに残した基準を確かめる前は、足した値1つにつき1つだけ（settleKept）
      if (!hold && channel.kept) {
        if (learn && !sparse && channel.samples.length && now - channel.samples[0].t > limits.baselineWindowMs) channel.samples.shift();
      } else if (!hold && (learn || (owner && !owner.anchor && !(limits.lowKeepMs && channel.low)))) {
        while (channel.samples.length > (limits.baselineKeepSamples || 0) && now - channel.samples[0].t > limits.baselineWindowMs) channel.samples.shift();
      }
      MODES.forEach((mode) => { channel.baseline[mode] = excursionBaseline(channel, mode, limits, median); });
      if (owner && channel.baseline["2d"] === null && channel.samples.length >= limits.baselineMinSamples && channel.samples.every((sample) => sample.s2 === null && sample.v3 === null)) missingScale = true;
    });
    units.forEach((unit) => {
      const state = ex.units[unit.name];
      if (!state.active) return;
      // 測り方ごとの e：その単位の見えているチャンネルが、どれもその測り方で測れたときだけ（両腕の片方だけ深度、のような混ぜ方はしない）
      const eOf = (mode) => {
        const floor = excursionLimit(limits, unit, "floor", mode);
        const fullRange = excursionLimit(limits, unit, "fullRange", mode) || floor;
        const parts = [];
        for (const name of unit.channels) {
          const channel = ex.channels[name];
          const value = seen[name];
          const key = mode === "3d" ? "v3" : "v2";
          const baseline = channel.baseline[mode];
          const last = state.last[name] || (state.last[name] = { "3d": null, "2d": null });
          if (value && value[key] !== null && baseline) {
            const offset = (value[key] - baseline.base) / baseline.scale * (unit.negate ? -1 : 1);
            const rise = unit.anchor && !unit.signed ? Math.abs(offset) : offset;
            last[mode] = { t: now, e: rise / floor, range: rise / fullRange, solo: Boolean(value.solo), block: Boolean(value.block), above: Boolean(value.above), rest: Boolean(value.rest) };
          }
          const present = Boolean(value) || MODES.some((other) => last[other] && now - last[other].t <= limits.freshMs);
          if (last[mode] && now - last[mode].t <= limits.freshMs) parts.push(last[mode]);
          else if (present) return null;
        }
        if (!parts.length) return null;
        if (parts.length === 1) return parts[0];
        const average = mean(parts.map((part) => part.e));
        const low = Math.min(...parts.map((part) => part.e));
        const solo = parts.filter((part) => part.solo);
        return {
          e: Math.max(unit.both ? Math.min(average, low / limits.bothFraction) : average, ...solo.map((part) => part.e)),
          range: mean(parts.map((part) => part.range)),
          block: !solo.length && parts.some((part) => part.block),
          above: parts.some((part) => part.above),
          rest: parts.every((part) => part.rest)
        };
      };
      // 確かめのチャンネル（guards）：spoil 上がりすぎ（足踏みのひざ・前かがみの胴）、unmet 届いていない（足を滑らせた足首）。
      // 見えなかったフレームは freshMs まで前の判断を使い、それより古ければ need は届いていないとみなす（上がり幅だけ前の値で上がったことにしない）
      const guardOf = (mode) => {
        const verdict = { spoil: false, unmet: false };
        (unit.guards || []).forEach((guard) => {
          const threshold = limits[`${guard.limit}${mode}`];
          if (!Number.isFinite(threshold)) return;
          const value = seen[guard.channel];
          const current = value ? value[mode === "3d" ? "v3" : "v2"] : null;
          const baseline = guard.fixed ? { base: 0, scale: 1 } : ex.channels[guard.channel].baseline[mode];
          const last = state.checks[guard.channel] || (state.checks[guard.channel] = { "3d": null, "2d": null });
          if (current !== null && baseline) {
            const offset = (current - baseline.base) / baseline.scale;
            const over = (guard.abs ? Math.abs(offset) : offset) > threshold;
            const fresh = last[mode] && now - last[mode].t <= limits.freshMs ? last[mode] : null;
            const overSince = !over ? null : fresh?.overSince ?? now;
            // rebase：向きを問わず、しきい値より動いたままの時刻
            const movedSince = guard.rebase && Math.abs(offset) > threshold ? fresh?.movedSince ?? now : null;
            last[mode] = { t: now, over: over && (!guard.sustain || now - overSince >= limits.holdMs), overSince, movedSince };
          } else if (!last[mode] || now - last[mode].t > limits.freshMs) {
            if (guard.need && !guard.optional) verdict.unmet = true;
            return;
          }
          if (guard.need) verdict.unmet = verdict.unmet || !last[mode].over;
          else verdict.spoil = verdict.spoil || last[mode].over;
        });
        return verdict;
      };
      const reading = { "3d": eOf("3d"), "2d": eOf("2d") };
      state.reading = reading;
      state.guard = { "3d": guardOf("3d"), "2d": guardOf("2d") };
      state.ready = Boolean(reading["3d"] || reading["2d"]) || state.phase === "up";
      if (limits.startRelearnMs && state.ready && state.freshAt === null) state.freshAt = now;
      // rebase：下ろしている間に、確かめのチャンネルが向きを問わずしきい値より動いたまま limits[guard.rebase] ms たったら（立ち上がった・座った）、
      // その単位のチャンネルの基準をすべて忘れて、今の姿勢で覚え直す（立って休んだ位置から、すぐ数えられるように）
      const moved = (guard) => MODES.some((mode) => {
        const last = state.checks[guard.channel]?.[mode];
        return Boolean(last) && now - last.t <= limits.freshMs && last.movedSince !== null && now - last.movedSince >= limits[guard.rebase];
      });
      // 上げている間・上げかけ（確定待ち）の間はしない（spoiledUpMs の単位の、確かめに止められて数えない1回（spoiled）は除く）。基準は、直近の値のうち、確かめのチャンネルが今の値からしきい値以内で、前の基準から
      // しきい値の半分より離れていた（動いた先にいた）フレームの値ですぐ作り直す（その間の低い方なので、休んだ位置になる。動いてからの時刻で選ぶと、
      // 確かめの基準が少しずつ動いた先へつられて、上げ始めてからの値だけになることがあった。今の値から近い値だけでは、腰を下ろす途中で覚え直すと、
      // 上体を傾けて広く見えた肩幅のフレームだけになり、動いた先で立っていた値が入らなかった。動いている途中の値も、前の基準の近くなら入れない）。
      // spoiled のまま動いた先にいるときもここで覚え直す（立ってかかと上げ：ひざを曲げて前かがみで立った位置で覚え直したあと、背を伸ばして立つと、
      // 上げたとみなされてから腰から両肩までの高さで止められ、spoiledUpMs で基準を忘れて、次のかかと上げの上げた位置を休んだ位置と覚え、2秒止まるまで数えなかった）
      const rebaseGuard = (state.phase === "up" && !(state.spoiled && limits.spoiledUpMs)) || state.candidate === "up" ? null : (unit.guards || []).find((guard) => guard.rebase && moved(guard));
      if (rebaseGuard) {
        // restSeed の単位は、下ろしている間に覚え直すとき、動いた先の値のうち、単位のチャンネル（腰）が休んだ側（数える向きの反対。値の小さい方）の
        // 端（10%）から lower 以内の値だけを使う（浅いスクワットで腰を下ろしたまま 20cm 動いて、もどしてすぐ覚え直すと、動いた先の値のほとんどが下ろしていた間の値で、
        // 下ろした位置を立った位置と覚え、そのあと数えなかった。前の位置で前かがみに下ろしていた間も、画像の体の横幅が動いた先と同じに見えて入った。上げていた間の値を
        // 除くだけでは、少し下を向いたカメラで、動いた先で立っても前の基準より下ろしたように見えて上げたままになり、立っていた値が入らなかった。立ってかかと上げは、
        // 上げたまま 20cm 前へ出て下ろす途中の値で覚え、動いた先で立った位置から上げても届かず、そのあとの1回を数えなかった。上げていた間を除くと、
        // 少し下を向いたカメラの画像だけで、数えないことが増えた）
        const resting = state.phase === "down";
        const there = new Set(MODES.flatMap((mode) => {
          const key = mode === "3d" ? "v3" : "v2";
          const current = seen[rebaseGuard.channel];
          const scale = current?.[mode === "3d" ? "s3" : "s2"];
          if (!current || current[key] === null || !scale) return [];
          const near = limits[`${rebaseGuard.limit}${mode}`];
          const before = ex.channels[rebaseGuard.channel].baseline[mode];
          return ex.channels[rebaseGuard.channel].recent.filter((sample) => sample[key] !== null && Math.abs(sample[key] - current[key]) / scale <= near
            && (!before || Math.abs(sample[key] - before.base) / before.scale > near / 2)).map((sample) => sample.t);
        }));
        if (limits.restSeed && resting) {
          const samples = ex.channels[unit.channels[0]].recent.filter((sample) => there.has(sample.t));
          const edges = Object.fromEntries(MODES.map((mode) => {
            const [key, scaleKey] = mode === "3d" ? ["v3", "s3"] : ["v2", "s2"];
            const list = samples.filter((sample) => sample[key] !== null && sample[scaleKey] > 0);
            return [mode, list.length ? percentileOf(list.map((sample) => sample[key]), .1) + excursionLimit(limits, unit, "lower", mode) * percentileOf(list.map((sample) => sample[scaleKey]), .5) : null];
          }));
          there.clear();
          samples.forEach((sample) => {
            const mode = sample.v3 !== null && edges["3d"] !== null ? "3d" : "2d";
            const value = sample[mode === "3d" ? "v3" : "v2"];
            if (value !== null && edges[mode] !== null && value <= edges[mode]) there.add(sample.t);
          });
        }
        // seedHold の単位は、休んだ側の値で覚え直したので、その基準から下ろし始めたとみなす（覚え直したときにまだ下ろしていた1回も、もどせば数える）。
        // 作り直した確かめのほかの確かめ（下ろしすぎ・おじぎ）に止められていたときは、そうみなさない（床の物を拾うと、前かがみで体の横幅が広く見えて
        // 立つ位置が動いたとみなされ、拾っている姿勢の値で覚え直して、立ち上がるのを1回と数えた）
        const stopped = (unit.guards || []).some((guard) => guard !== rebaseGuard && !guard.need && MODES.some((mode) => {
          const last = state.checks[guard.channel]?.[mode];
          return Boolean(last) && now - last.t <= limits.freshMs && last.over;
        }));
        resetUnit(unit, true, (t) => there.has(t));
        if (rebaseGuard.channel === "place" && ex.watch?.[unit.name]) ex.watch[unit.name].rested = null;
        const seeded = resting && Boolean(limits.seedHold) && !stopped;
        Object.assign(ex.units[unit.name], { reading: { "3d": null, "2d": null }, seeded, ...(seeded ? { floor: 0 } : {}) });
        return;
      }
      // startRelearnMs（座ってかかと上げ）：基準を覚え始めてから startWindowMs のうちで、まだ数えておらず、基準の近くにいたこともない（settled）うちに、
      // 単位のチャンネル（両ひざ）がそろって（下がった幅の差が floor より小さく）、今の測り方で基準より lower 以上低いまま（確かめも止めずに）
      // startRelearnMs 続いた：上げた位置・上げる途中を基準に覚えていた。その間の値（recent）ですぐ覚え直す（確かめのチャンネルも）。
      // 片方のひざだけ大きく下がったのは、かかとを下ろしたのでない
      if (limits.startRelearnMs) {
        const mode = reading["3d"] ? "3d" : "2d";
        const lowerE = excursionLimit(limits, unit, "lower", mode) / excursionLimit(limits, unit, "floor", mode);
        const drops = unit.channels.map((name) => {
          const last = state.last[name]?.[mode];
          return !ex.channels[name].counted[unit.name] && last && now - last.t <= limits.freshMs ? last.e : null;
        });
        const low = state.phase === "down" && state.candidate !== "up" && !state.settled && now - state.freshAt <= limits.startWindowMs && Boolean(reading[mode]) && !state.guard[mode].spoil
          && drops.every((e) => e !== null && e <= -lowerE) && Math.max(...drops) - Math.min(...drops) < 1;
        if (!low) state.lowSince = null;
        else if (state.lowSince === null) state.lowSince = now;
        if (state.lowSince !== null && now - state.lowSince >= limits.startRelearnMs) {
          const since = state.lowSince;
          resetUnit(unit, true, (t) => t >= since);
          ex.units[unit.name].reading = { "3d": null, "2d": null };
          return;
        }
      }
      if (limits.lockRelearnMs && relearnLocked(unit, state)) return;
    });

    // 2) 単位ごとの上げ下げ
    let lifted = null;
    units.forEach((unit) => {
      const state = ex.units[unit.name];
      if (!state.active) return;
      const reading = state.reading;
      const other = unit.side ? units.find((item) => item.side && item !== unit) : null;
      const otherState = other ? ex.units[other.name] : null;
      // 上げたまま長すぎる：数えずに作り直す。基準は残す。作り直した位置が「戻してからの一番低い位置」になるので、一度下がってしきい値ぶん上がり直すまで上げ始めとみなさない（腕上げで肩より上なら待つ）。
      // 見えない間のあとに残した基準（kept）も、もう確かめるのを待たずに覚え続ける（上げたままに見えたのは、見えない間に変わった休んだ位置かもしれない）
      if (state.phase === "up" && limits.maxUpMs && now - state.upSince > limits.maxUpMs && !MODES.some((mode) => reading[mode]?.above)) {
        ex.units[unit.name] = excursionUnitState(state);
        unit.channels.forEach((name) => { ex.channels[name].kept = false; });
        return;
      }
      let mode;
      let value;
      if (state.phase === "up") {
        // 上げている間は、上げたときの測り方で戻りを見る。その測り方が欠けたフレームは、もう一方の測り方で上がったままと分かれば見えたことにするだけ
        mode = state.upMode;
        value = reading[mode];
        if (!value) {
          const otherMode = reading[mode === "3d" ? "2d" : "3d"];
          if (otherMode && otherMode.e >= 1) state.lastSeenAt = now;
          pauseHold(state);
          return;
        }
      } else {
        mode = reading["3d"] ? "3d" : "2d";
        value = reading[mode];
        if (!value) {
          pauseHold(state);
          return;
        }
      }
      // seeRiseMs：その単位が seeRiseMs より長く見えなかったあとは、見えた位置から上げ始めを見直す（隠れていた足首が、外へ出た位置で見え始めたのを、
      // 外へ出した1回にしない。画像だけの記録で、足首が画面の下の端でちらついたあと数えた）
      if (limits.seeRiseMs && state.phase === "down" && now - state.lastSeenAt > limits.seeRiseMs) state.floor = Infinity;
      state.lastSeenAt = now;
      const lowerE = excursionLimit(limits, unit, "lower", mode) / excursionLimit(limits, unit, "floor", mode);
      const e = value.e;
      const guard = state.guard[mode];
      let want = null;
      // 休んだ位置に restMs 続けていたか（needRest の単位だけ）。戻している途中（戻ったと確定する前）に休んだ位置へ着いた時間も数える
      // （開いて、もどして、すぐ開く、を続けても数えられるように）
      if (unit.needRest) {
        if (!value.rest) state.restSince = null;
        else if (state.restSince === null) state.restSince = now;
        if (value.rest && now - state.restSince >= limits.restMs) state.restSeen = true;
      }
      // restTrustMs：下ろしている間（確かめも止めずに）、直近 restTrustMs のチャンネルごとの e の 20〜80% が上下とも floor 以内なら、基準は休んだ位置
      // （startRelearnMs。点の一瞬の跳び・跳びのあとの戻りすぎでは、確かめ直しにならない）
      if (limits.restTrustMs && !state.settled) {
        if (state.phase !== "down" || guard.spoil) state.calm = [];
        else {
          state.calm.push({ t: now, es: unit.channels.map((name) => state.last[name]?.[mode]?.e ?? null) });
          while (now - state.calm[0].t > limits.restTrustMs) state.calm.shift();
          state.settled = now - state.calm[0].t >= limits.restTrustMs * .9 && unit.channels.every((name, index) => {
            const values = state.calm.map((item) => item.es[index]).filter((value) => value !== null);
            return values.length > 0 && percentileOf(values, .8) < 1 && percentileOf(values, .2) > -1;
          });
        }
      }
      if (state.phase === "down") {
        if (e <= lowerE) state.restAt = now;
        if (Math.abs(e) <= lowerE) state.atBase = true;
        // 戻してからの一番低い位置。次の1回は、そこからもしきい値ぶん上がること（途中まで戻して上げ直したのは数え、しきい値の近くの揺れは数えない）
        state.floor = unit.guardFloor && guard.spoil ? e : Math.min(state.floor, e);
        // 確かめが止めている間に上げた位置から、止めが解けても下げずに（しきい値より上のまま）guardHoldMs いた：そこまで上げたとみなす
        // （腕を上げながら肩も上げ、腕を下ろしてから、上げたままの肩を下ろした。腕を下ろすと一緒に下がる肩の点のずれは、ここまで残らない）
        if (limits.guardHoldMs && unit.guardFloor) {
          if (guard.spoil) state.held = { since: null };
          else if (state.held && state.floor < 1) state.held = null;
          else if (state.held) {
            if (state.held.since === null) state.held.since = now;
            if (now - state.held.since >= limits.guardHoldMs) Object.assign(state, { floor: 0, held: null });
          }
        }
        // 脚ごと：反対の脚より dominance 以上大きいこと。両脚とも休んでいたところから一緒にしきい値を超えたときは、先に確定した脚の1回だけ
        // （反対の脚が上がっている間と、戻して1秒の間は、その脚より dominance 以上大きくないと上がったとみなさない）
        let dominant = true;
        if (otherState?.active) {
          const otherValue = otherState.reading ? otherState.reading[mode] || otherState.reading["3d"] || otherState.reading["2d"] : null;
          const otherE = otherValue ? otherValue.e : 0;
          const otherBusy = otherState.phase === "up" || now - otherState.downAt < limits.bilateralQuietMs;
          dominant = e - Math.max(0, otherE) >= limits.dominance || (!otherBusy && otherE >= 1 && e >= otherE - limits.dominance);
        }
        if (e >= 1 && e - Math.max(0, state.floor) >= 1 && dominant && !value.block && !guard.spoil && !guard.unmet && (!unit.needRest || state.restSeen)) want = "up";
      } else {
        if (guard.spoil && !state.spoiled) Object.assign(state, { spoiled: true, spoiledAt: now });
        // spoiledUpMs：止められたまま上げているのが続いた（立ち上がる途中で止まってから伸び上がった等）：数えずに、今の姿勢で基準を覚え直す
        if (state.spoiled && limits.spoiledUpMs && now - state.spoiledAt >= limits.spoiledUpMs) {
          resetUnit(unit, true);
          return;
        }
        state.peak = Math.max(state.peak, e);
        state.peakRange = Math.max(state.peakRange, value.range);
        const released = e <= Math.max(lowerE, limits.releaseFraction * state.peak);
        // 見えない間のあとに残した基準のまま上げている（restRelearnMs の、anchor でない単位）：上げたまま、いちばん上がった位置から1以上下がって、
        // しきい値より上に止まった（e の幅が lower に収まって baselineMinSpanMs）なら、そこが見えない間に変わった休んだ位置（ひざを広く開いて
        // 座り直した等）。この1回は数えず、止まっていた間からの値で単位のチャンネルを覚え直す（残した基準のままでは、次の回から戻しても下がりきらない）
        if (!released && limits.restRelearnMs && !unit.anchor && unit.channels.some((name) => ex.channels[name].kept)) {
          state.stay.push({ t: now, e });
          while (Math.max(...state.stay.map((item) => item.e)) - Math.min(...state.stay.map((item) => item.e)) > lowerE) state.stay.shift();
          const level = mean(state.stay.map((item) => item.e));
          if (state.stay.length >= limits.baselineMinSamples && now - state.stay[0].t >= limits.baselineMinSpanMs && level >= 1 && state.peak - level >= 1) {
            const since = state.stay[0].t;
            unit.channels.forEach((name) => {
              const channel = ex.channels[name];
              Object.assign(channel, { samples: channel.recent.filter((sample) => sample.t >= since), kept: false, keptDwell: [], keptSeen: [], awaySince: null, low: false });
              MODES.forEach((item) => { channel.baseline[item] = excursionBaseline(channel, item, limits, false); });
              unproveChannel(name);
            });
            ex.units[unit.name] = excursionUnitState(state);
            return;
          }
        }
        let settled = false;
        if (unit.settle) {
          state.trail.push({ t: now, e });
          while (now - state.trail[0].t > limits.settleMs) state.trail.shift();
          const span = state.trail.map((item) => item.e);
          settled = state.trail.length >= 3 && now - state.trail[0].t >= limits.settleMs * .75 && Math.max(...span) - Math.min(...span) <= limits.settleBand;
        }
        if (released || settled) want = settled && !released ? "settle" : "down";
      }
      // 確定待ちと違う測り方のフレームが違う判定をしたときは、確定までの時間を止めるだけ（深度がまばらなとき、画像だけのフレームで取り消さない）
      if (state.candidate !== null && state.candidate !== want && state.candidateMode !== mode) {
        pauseHold(state);
        return;
      }
      if (!want) {
        state.candidate = null;
        return;
      }
      if (state.candidate !== want) {
        state.candidate = want;
        state.candidateMode = mode;
        // フレームの間隔が広い（holdMs の半分より長い）ときは、上げたときに限り最初のフレームの前の半分の間隔も続いたとみなす（座って足踏みと同じ）
        state.candidateSince = want === "up" && frameMs > limits.holdMs / 2 ? now - Math.min(frameMs, limits.holdMs) / 2 : now;
      }
      if (now - state.candidateSince < limits.holdMs) return;
      state.candidate = null;
      if (want === "up") {
        Object.assign(state, { phase: "up", upSince: now, upMode: mode, peak: e, peakRange: value.range, trail: [], stay: [], spoiled: false, restSince: null, restSeen: false, seeded: false });
        if (ex.watch?.[unit.name]) Object.assign(ex.watch[unit.name], { bentAt: null, bentShape: null });
        lifted = unit;
        return;
      }
      const tooShort = now - state.upSince + Math.min(frameMs, limits.holdMs * 3) < limits.minUpMs;
      const counted = !tooShort && !state.spoiled && now - state.lastRepAt >= limits.sameGapMs;
      if (counted) {
        state.lastRepAt = now;
        // 上げる前の一番低い位置（floor）が基準より lower の2倍より下でなかった：基準は休んだ位置のまま（lockRelearnMs の時間を数え直す。
        // 休んだ位置がずっと基準より低いまま、上げるたびに基準をわずかに越えて数えたときは数え直さない）
        if (state.floor >= -2 * lowerE && ex.watch?.[unit.name]) ex.watch[unit.name].okAt = now;
        // 基準の近くから上げて数えた：その基準が休んだ位置（relearnLocked の rested）
        if (state.floor >= -2 * lowerE && state.atBase && ex.watch?.[unit.name]) {
          const rested = ex.watch[unit.name].rested || (ex.watch[unit.name].rested = { "3d": null, "2d": null });
          MODES.forEach((item) => { if (ex.channels[unit.channels[0]].baseline[item]) rested[item] = restedOf(unit.channels[0], item); });
        }
        ex.pending.push({ side: unit.side || null, range: state.peakRange, durationMs: state.restAt === null ? null : now - state.restAt });
        if (state.atBase) unit.channels.forEach((name) => { ex.channels[name].counted[unit.name] = true; });
      }
      Object.assign(state, { phase: "down", upMode: null, peak: 0, peakRange: 0, trail: [], restAt: null, atBase: false, spoiled: false, downAt: now, floor: want === "settle" ? Infinity : e });
      // 動いた先で止まった（横に一歩移って足をそろえた）：今の位置を新しい基準にする
      if (want === "settle") unit.channels.forEach((name) => { ex.channels[name] = { ...excursionChannelState(), lastSeenAt: now }; });
    });

    settlePhase();
    const cue = cueOf();
    const rep = ex.pending.shift() || null;
    if (rep) {
      counter.lastRepAt = now;
      counter.lastRangePercent = clamp(Math.round(rep.range * 100), 0, 120);
      counter.lastCycleDurationMs = rep.durationMs;
      return result(true, "1往復を認識しました", { side: rep.side, rangePercent: counter.lastRangePercent, cycleDurationMs: rep.durationMs, cue });
    }
    if (counter.phase === "seeking-low") {
      if (missingScale) return result(false, "肩から腰まで映るよう、少し離れてください", { cue });
      return result(false, `${measurement.lowLabel}を確認しています`, { cue });
    }
    if (lifted || counter.phase === "returning") return result(false, `${measurement.highLabel}を確認。ゆっくり戻してください`, { cue });
    return result(false, `${measurement.visiblePart}を認識中`, { cue });
  }

  // ---- 体の分析（一緒に育つ）。この人の足踏みの数値だけを state.bodyProfile に持つ。映像・関節の座標の履歴・外部送信はない ----
  // 数え方に効くのは liftMeters（深度で測れるひざの「上げた」の高さ）だけで、既定の .06 から .05 までしか下がらない（ML-MOTION-05：高くはしない）。
  // 証拠にするのは「はっきり数えた1回」だけ（深度あり・.06 以上・反対のひざが静か・0.3〜3秒・基準が怪しい直後でない）。
  // 下げたしきい値のおかげで数えた 5〜6cm の1回は証拠にならないので、学習が自分の出力を食べて下がり続けることはない。
  // 確定はセッションの終了時、実績に数えるセッション（pose / rgbd）だけ（learnMarchSession → completeSession）。
  const PROFILE_VERSION = 2; // 2: 証拠の条件を厳しくした（50回・左右各20回・6セッション）。1 の保存は捨てて覚え直す（しきい値が静かに上がらないように）
  const PROFILE_LIMITS = {
    adaptEnabled: true,       // false にすると、覚えはするが数え方（liftMeters）は変えない（marchOverridesFromProfile が常に {}）
    keep: 60,                 // 1回ごとの数値（ひざごとの最高点、上げていた時間）は直近60件
    keepSessions: 20,         // セッションごとの数値（体の大きさ・いつもの距離・計測の質）は直近20件
    teachMinPeak: .06,        // 証拠にする1回：基準からの最高点がこれ以上（= 既定の liftMeters。下げたしきい値で数えた1回は証拠にしない）
    teachMaxPeak: .40,        // これを超える最高点は推定の跳び（記録の最大 35cm）
    teachMinUpMs: 300, teachMaxUpMs: 3000, // 上げていた時間（記録 0.34〜2.4秒）
    teachMaxOther: .02,       // 上げたと確定したとき、反対のひざがこれ以下（つられ上がりの間の1回は証拠にしない）
    teachQuietMs: 3000,       // 両ひざ上がり・取り違え・上げたままの直後はこの間、証拠にしない
    minAttested: 50, minPerKnee: 20, minSessions: 6, // しきい値を動かすのに要る証拠（50回・左右各20回・6セッション。じっくり：よしさん 2026-10-06。条件を厳しくするときは PROFILE_VERSION も上げる）
    liftFloor: .05, liftCeil: .06, liftRatio: .5, liftStep: .005, // liftMeters = clamp(.5 × 下から25%の最高点, .05, .06) を .005 刻みで
    nearMissGap: .015,        // nearMissMeters = liftMeters − .015（既定の .06/.045 と同じ差）
    // 静止中の揺れ（2秒窓の標準偏差の中央値）の4倍より下げない（揺れの大きい設置では下げない）。揺れが4セッションぶん測れるまでは下げない
    // （restSdRequired。測れていない設置の揺れは分からないので、既定の .06 のまま。5回の短い運動でも、始める前に2秒座っていれば1窓取れる）
    restSdFloorFactor: 4, restSdMinSessions: 4, restSdRequired: true,
    minBodySamples: 10, minZRestReps: 3, minQualityFrames: 90, minQualityWindows: 2
  };
  const PROFILE_BOUNDS = {
    peak: [.06, .40], upMs: [300, 3000], zRest: [.4, 4],
    shoulderWidth: [.20, .60], shoulderToKnee: [.15, .70], shoulderY: [-.5, .8], kneeZ: [.4, 4],
    restSd: [0, .05], kneeDepthAdoption: [0, 1]
  };
  const LEARN_SOURCES = new Set(["pose", "rgbd"]);
  const inBounds = (value, bounds) => Number.isFinite(value) && value >= bounds[0] && value <= bounds[1];

  // ---- 家族への見守り（著しい体の機能低下の即時通知）。本人の画面には何も出さない（ML-MOTION-05：本人に目標や不安を押しつけない） ----
  // state.watch（体の分析 bodyProfile とは別。「体の分析をやり直す」や判定の版の更新で消えない）に、座って足踏みのセッションごとの数値（history、直近120件、数だけ）を持ち、
  // 今日の数値が「いつも」から著しく弱いときだけ、家族だけに届く通知を作る。
  // 強い印（即時）：ひざ上げが半分以下（lift）、片側だけ上がらない（asym / collapse）、ほとんど上げられない（attempt）、途中で終わる日が3日続いて他の印もある（streak）。
  // 弱い印：ひざ上げ65%以下（lift）、前かがみ（trunk）、テンポ1.8倍（slow）、途中で終わった（incomplete）。弱い印2つ（うち1つは lift か trunk）は翌朝サマリー、次の運動でも同じ組なら即時。
  // slow・incomplete だけの組み合わせでは知らせない（電話・来客・声かけで止まった日を誤報しない）。
  // 比べられるのは、同じ人（肩幅）・同じ設置（距離・ひざの奥行き・肩の高さ）・深度が十分（採用率70%以上）・追跡の質がいつも並み のセッションだけ。基準は別の日が5日ぶん要る。
  // 同じ印は7日空ける（悪化・新しい強い印は除く）。知らせたあと3回続けて同じくらいなら、それを新しい「いつも」にする。戻ったら「戻りました」を1度。数か月のゆっくりした低下はサマリーで
  const WATCH_VERSION = 1;
  const HEALTH_LIMITS = {
    keepHistory: 120, baselineSessions: 10, baselineDays: 5, repsBaselineMin: 3, minReps3d: 4, minSideReps: 4,
    liftStrongRatio: .5, liftStrongDropM: .06, liftConfirmRatio: .7, liftSoloRatio: .4, liftModerateRatio: .65, liftModerateDropM: .05, pendingDays: 3,
    tempoRatio: 1.8, tempoMinDeltaMs: 800, tempoMinCycles: 4, tempoMinUps: 5, baselineMaxAgeDays: 120,
    asymRatio: .55, asymBaseRatio: .75, asymDropM: .04, asymMaxZDiffM: .15,
    collapseMaxReps: 1, collapseOtherMin: 4, collapseVisibleRatio: .6, collapseBaseShare: .3, collapseBaseSessions: 4,
    incompleteMinReps: 2, incompleteMinReadyS: 20, incompleteFraction: .5,
    streakDays: 3, streakWindowDays: 10,
    attemptMaxReps: 1, attemptMinReadyS: 30, attemptMinBaselineReps: 5, lowMaxRiseRatio: .5, lowMaxReps: 4,
    trunkDropM: .06, trunkSameShoulderM: .03, trunkSameKneeZM: .3, trunkMinBodySessions: 4,
    driftMinRows: 40, driftAnchorFrom: 5, driftAnchorTo: 30, driftRecent: 10, driftRatio: .65, driftDropM: .05, driftCooldownMs: 30 * 24 * 3600 * 1000,
    setupZRestM: .4, setupKneeZM: .3, setupShoulderYM: .08, minDepthAdoption: .7, trackingDrop: 15, minValidRatio: .7, swayNoiseRatio: 2,
    plateauSessions: 3, plateauSpread: .2, recoverSessions: 2,
    cooldownMs: 7 * 24 * 3600 * 1000,
    samePersonShoulderM: .05, samePersonSpanM: .08, samePersonMinSessions: 3
  };
  const HISTORY_BOUNDS = {
    at: [1.6e12, 4.1e12], reps: [0, 10000], reps3d: [0, 10000], leftN: [0, 10000], rightN: [0, 10000], leftFrames: [0, 1e7], rightFrames: [0, 1e7],
    peak: [0, .5], left: [0, .5], right: [0, .5], leftHi: [0, .5], rightHi: [0, .5], lrRatio: [0, 20], leftZ: [.3, 5], rightZ: [.3, 5], maxRise: [0, .5], upMs: [0, 10000], cycleMs: [0, 60000],
    zRest: [.3, 5], shoulderY: [-.5, .8], kneeZ: [.3, 5], shoulderToKnee: [.15, .7], shoulderWidth: [.2, .6], restSd: [0, .1],
    completed: [0, 1], target: [0, 100], tq: [0, 100], valid: [0, 1], depth: [0, 1], lift: [.04, .07], person: [0, 1], attempt: [0, 1], readyS: [0, 36000], score: [0, 100], lift1: [0, 1]
  };
  const HISTORY_REQUIRED = new Set(["at", "reps", "reps3d", "leftN", "rightN", "completed", "target", "person", "attempt", "score", "lift1"]);
  const SIGNAL_KEYS = new Set(["lift", "slow", "trunk", "incomplete", "attempt", "streak", "asym-left", "asym-right", "collapse-left", "collapse-right"]);
  function hydrateHistoryRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const [key, bounds] of Object.entries(HISTORY_BOUNDS)) {
      const value = raw[key];
      if (typeof value === "number" && inBounds(value, bounds)) out[key] = value;
      else if (HISTORY_REQUIRED.has(key)) return null;
      else out[key] = null;
    }
    ["completed", "person", "attempt", "lift1"].forEach((key) => { out[key] = out[key] ? 1 : 0; });
    return out;
  }
  function hydrateHealth(raw) {
    const h = raw && typeof raw === "object" ? raw : {};
    const at = (value) => (typeof value === "number" && inBounds(value, HISTORY_BOUNDS.at) ? value : null);
    const count = (value) => (typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), 0, 100000) : 0);
    const keys = (list) => (Array.isArray(list) ? list.filter((item) => SIGNAL_KEYS.has(item)).slice(0, 10) : []);
    const pending = h.pending && typeof h.pending === "object" && at(h.pending.at) !== null && typeof h.pending.ratio === "number" && Number.isFinite(h.pending.ratio)
      ? { at: h.pending.at, ratio: round3(clamp(h.pending.ratio, 0, 2)) } : null;
    return {
      lastAlertAt: at(h.lastAlertAt), lastScore: count(h.lastScore), lastSignals: keys(h.lastSignals), alerts: count(h.alerts),
      lastModerateAt: at(h.lastModerateAt), lastModerate: keys(h.lastModerate),
      lastDriftAt: at(h.lastDriftAt), lastStreakAt: at(h.lastStreakAt), pending, goodAfterAlert: count(h.goodAfterAlert), recoveredAt: at(h.recoveredAt)
    };
  }
  function createWatch() {
    return { version: WATCH_VERSION, liftFrom: 0, history: [], health: hydrateHealth(null) };
  }
  // 読み込み。版が違えば空から。壊れた行は捨て、時刻順に直近120件。liftFrom: この時刻より前の行は、ひざ上げの基準に使わない（判定の版が変わったとき）
  function hydrateWatch(raw) {
    if (!raw || typeof raw !== "object" || raw.version !== WATCH_VERSION) return createWatch();
    return {
      version: WATCH_VERSION,
      liftFrom: typeof raw.liftFrom === "number" && inBounds(raw.liftFrom, HISTORY_BOUNDS.at) ? raw.liftFrom : 0,
      // 並びは入れた順（新しいものが最後）。時刻で並べ直さない（時計が戻った日があっても、位置が正）
      history: (Array.isArray(raw.history) ? raw.history.map(hydrateHistoryRecord).filter(Boolean) : []).slice(-HEALTH_LIMITS.keepHistory),
      health: hydrateHealth(raw.health)
    };
  }
  const localDayOf = (ms) => localDateKey(new Date(ms));
  // 今日のセッションの数値。高さ・テンポ・距離は 3D で測れ、基準が怪しい直後でない1回だけから（2D の推定は比べられない）
  function marchHistoryRecord(learned, input, nowMs) {
    const L = PROFILE_LIMITS;
    const reps = Array.isArray(learned) ? learned.filter((rep) => rep && (rep.side === "left" || rep.side === "right")) : [];
    const threeD = reps.filter((rep) => rep.mode === "3d" && Number.isFinite(rep.peakMeters) && (!Number.isFinite(rep.sinceUnsureMs) || rep.sinceUnsureMs >= L.teachQuietMs));
    const ofSide = (name) => threeD.filter((rep) => rep.side === name);
    const med3 = (values) => { const m = median(values); return m === null ? null : round3(m); };
    const medMs = (values) => { const m = median(values); return m === null ? null : Math.round(m); };
    const num = (value, bounds) => (typeof value === "number" && inBounds(value, bounds) ? value : null);
    const hi3 = (reps) => (reps.length ? round3(percentileOf(reps.map((rep) => rep.peakMeters), .75)) : null);
    const pairRatio = (reps) => {
      const lefts = [], rights = [];
      reps.forEach((rep, i) => (rep.side === "left" ? lefts : rights).push({ i, peak: rep.peakMeters }));
      const ratios = lefts.map((l) => {
        let best = null;
        rights.forEach((r) => { if (best === null || Math.abs(r.i - l.i) < Math.abs(best.i - l.i)) best = r; });
        return best && best.peak > 0 ? l.peak / best.peak : null;
      }).filter((value) => value !== null);
      return ratios.length ? round3(Math.min(20, median(ratios))) : null;
    };
    const quality = input?.quality && typeof input.quality === "object" ? input.quality : {};
    const body = input?.bodyMedians && typeof input.bodyMedians === "object" ? input.bodyMedians : {};
    const target = clamp(Math.round(Number(input?.target) || 0), 0, 100);
    return {
      at: Math.round(nowMs), reps: reps.length, reps3d: threeD.length, leftN: ofSide("left").length, rightN: ofSide("right").length,
      leftFrames: num(Math.round(Number(quality.leftFrames) || 0), HISTORY_BOUNDS.leftFrames), rightFrames: num(Math.round(Number(quality.rightFrames) || 0), HISTORY_BOUNDS.rightFrames),
      peak: med3(threeD.map((rep) => rep.peakMeters)), left: med3(ofSide("left").map((rep) => rep.peakMeters)), right: med3(ofSide("right").map((rep) => rep.peakMeters)),
      // 左右差の判定用：各側の上から25%の最高点（弱い側の高い方の1回も小さいか）と、時間の近い左右の組ごとの比（左÷右）の中央値（両ひざとも小さくした区間と、片側だけ小さい日を見分ける）
      leftHi: hi3(ofSide("left")), rightHi: hi3(ofSide("right")), lrRatio: pairRatio(threeD),
      leftZ: med3(ofSide("left").map((rep) => rep.zRestMeters).filter(Number.isFinite)), rightZ: med3(ofSide("right").map((rep) => rep.zRestMeters).filter(Number.isFinite)),
      maxRise: num(Number.isFinite(quality.maxRise3d) ? round3(quality.maxRise3d) : null, HISTORY_BOUNDS.maxRise),
      upMs: medMs(threeD.map((rep) => rep.upMs).filter(Number.isFinite)),
      cycleMs: medMs(threeD.map((rep) => rep.cycleMs).filter((value) => Number.isFinite(value) && value > 0)),
      zRest: med3(threeD.map((rep) => rep.zRestMeters).filter(Number.isFinite)),
      shoulderY: num(Number.isFinite(body.shoulderY) ? round3(body.shoulderY) : null, HISTORY_BOUNDS.shoulderY),
      kneeZ: num(Number.isFinite(body.kneeZ) ? round3(body.kneeZ) : null, HISTORY_BOUNDS.kneeZ),
      shoulderToKnee: num(Number.isFinite(body.shoulderToKnee) ? round3(body.shoulderToKnee) : null, HISTORY_BOUNDS.shoulderToKnee),
      shoulderWidth: num(Number.isFinite(body.shoulderWidth) ? round3(body.shoulderWidth) : null, HISTORY_BOUNDS.shoulderWidth),
      restSd: Number.isFinite(input?.restSdM) ? round4(input.restSdM) : null,
      completed: input?.completed === true ? 1 : 0, target,
      tq: num(Number.isFinite(input?.trackingQuality) ? Math.round(input.trackingQuality) : null, HISTORY_BOUNDS.tq),
      valid: num(Number.isFinite(input?.validRatio) ? round3(input.validRatio) : null, HISTORY_BOUNDS.valid),
      depth: num(Number.isFinite(input?.kneeDepthAdoption) ? round3(input.kneeDepthAdoption) : null, HISTORY_BOUNDS.depth),
      lift: num(Number.isFinite(input?.liftMeters) ? round3(input.liftMeters) : null, HISTORY_BOUNDS.lift),
      person: input?.personVerified === true ? 1 : 0, attempt: input?.attempt === true ? 1 : 0,
      readyS: num(Number.isFinite(quality.readyMs) ? Math.round(quality.readyMs / 1000) : null, HISTORY_BOUNDS.readyS),
      score: 0, lift1: 0
    };
  }
  // 別の人が使ったらしいか（孫や家族がテレビで遊んだとき）。深度で測った肩幅が覚えている肩幅と 5cm 以上、または肩からひざが 8cm 以上違えば別の人とみなし、
  // そのセッションは覚えず（回数・証拠・履歴に入れず）、知らせもしない。RGB だけの日や覚え始め（体の大きさが3セッション未満）は確かめられない（checked: false）：
  // 同じ人として覚えるが、見守りのうち体の大きさに頼る印（ひざ上げ・左右差・前かがみ）は出さない。同じくらいの体の大人（配偶者）は見分けられない
  function assessSamePerson(profile, medians) {
    const L = HEALTH_LIMITS;
    const b = profile?.body;
    if (!medians || !b || (Number(b.sessions) || 0) < L.samePersonMinSessions || !Array.isArray(b.shoulderWidth) || !b.shoulderWidth.length || !Number.isFinite(medians.shoulderWidth)) {
      return { checked: false, same: true, shoulderDiff: null, spanDiff: null };
    }
    const shoulderDiff = Math.abs(medians.shoulderWidth - median(b.shoulderWidth));
    const spanDiff = Array.isArray(b.shoulderToKnee) && b.shoulderToKnee.length && Number.isFinite(medians.shoulderToKnee) ? Math.abs(medians.shoulderToKnee - median(b.shoulderToKnee)) : 0;
    return { checked: true, same: shoulderDiff <= L.samePersonShoulderM && spanDiff <= L.samePersonSpanM, shoulderDiff: round3(shoulderDiff), spanDiff: round3(spanDiff) };
  }
  // 今日の数値（marchHistoryRecord）を、これまでの履歴（watch.history、今日を含まない）と比べる。
  // options: { bodyMedians, bodyBaseline（profile.body の中央値、今日を足す前）, hasBody（この人の体の大きさを覚えているか）}
  // 戻り値：alert（知らせる）・level "immediate"|"summary"・summary（翌朝サマリーの種類）・strong/moderate（印）・skipped（比べられなかった理由）
  function assessMarchHealth(watch, today, options) {
    const L = HEALTH_LIMITS;
    const result = { alert: false, level: null, summary: null, score: 0, strong: [], moderate: [], skipped: [], cooldown: false, pending: null, confirmed: false, first: false, baselineSessions: 0, today: today || null, baseline: null, reps: null, drift: null };
    if (!today || typeof today !== "object") { result.skipped.push("no-record"); return result; }
    const w = watch && typeof watch === "object" ? watch : createWatch();
    const dayMs = 24 * 3600 * 1000;
    // 今日より1日以上あとの時刻の行（時計がずれていた）は使わない
    const history = Array.isArray(w.history) ? w.history.filter((rec) => rec && typeof rec === "object" && rec.at <= today.at + dayMs) : [];
    const health = hydrateHealth(w.health);
    const liftFrom = Number(w.liftFrom) || 0;
    const near = (a, b, tolerance) => a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) <= tolerance;
    // 回数の基準（終えた運動の回数の中央値・目標の最大）：途中で終わった・ほとんど上げられない の判定用。深度も体の大きさも要らない
    const sessionsOnly = history.filter((rec) => !rec.attempt);
    const completedRows = sessionsOnly.slice(-L.baselineSessions).filter((rec) => rec.completed);
    const repsBase = completedRows.length >= L.repsBaselineMin ? { reps: median(completedRows.map((rec) => rec.reps)), maxTarget: Math.max(...completedRows.map((rec) => rec.target)), sessions: completedRows.length } : null;
    result.reps = repsBase;
    // ひざ上げの基準：同じ人と確かめた（体の大きさを覚えていない人はそのまま）・同じ設置・3Dで4回以上・判定の版が同じ セッションを直近10件、別の日が5日ぶん
    const verified = (rec) => rec.person === 1 || !options?.hasBody;
    const sameSetup = (rec) => near(rec.zRest, today.zRest, L.setupZRestM) && near(rec.kneeZ, today.kneeZ, L.setupKneeZM) && near(rec.shoulderY, today.shoulderY, L.setupShoulderYM);
    // 今日と同じ日の運動と、120日より古い運動は基準に入れない
    const todayKey = localDayOf(today.at);
    let liftRows = sessionsOnly.filter((rec) => rec.at >= liftFrom && localDayOf(rec.at) !== todayKey && today.at - rec.at <= L.baselineMaxAgeDays * dayMs
      && rec.reps3d >= L.minReps3d && rec.peak !== null && verified(rec) && sameSetup(rec)).slice(-L.baselineSessions);
    const days = new Set(liftRows.map((rec) => localDayOf(rec.at)));
    let liftBase = null;
    if (liftRows.length >= L.baselineDays && days.size >= L.baselineDays) {
      // 知らせたあと3回続けて同じくらい（±20%）なら、それを新しい「いつも」にする（同じ状態を繰り返し知らせない）
      if (health.lastAlertAt !== null) {
        const after = liftRows.filter((rec) => rec.at > health.lastAlertAt);
        if (after.length >= L.plateauSessions) {
          const m = median(after.map((rec) => rec.peak));
          if (after.every((rec) => Math.abs(rec.peak - m) <= L.plateauSpread * m)) liftRows = after;
        }
      }
      const vals = (key) => liftRows.map((rec) => rec[key]).filter((value) => value !== null);
      liftBase = {
        peak: median(vals("peak")), left: median(vals("left")), right: median(vals("right")), cycleMs: median(vals("cycleMs")), upMs: median(vals("upMs")),
        restSd: median(vals("restSd")), tq: median(vals("tq")), sessions: liftRows.length
      };
    } else {
      // 比べられなかった理由：baseline（3Dで4回以上のセッションが5つ未満）／setup（設置が違う）／days（別の日が5日ぶんない・同じ日・120日より古い）
      const eligible = sessionsOnly.filter((rec) => rec.at >= liftFrom && rec.reps3d >= L.minReps3d && rec.peak !== null && verified(rec));
      result.skipped.push(eligible.length < L.baselineDays ? "baseline" : eligible.filter(sameSetup).length < L.baselineDays ? "setup" : "days");
    }
    result.baselineSessions = liftRows.length;
    result.baseline = liftBase;
    // 今日の計測が比べられるか（深度・追跡の質・体の確認）。だめなら、ひざ上げ系の印（lift / asym / collapse / trunk / slow）は出さない
    const personOk = today.person === 1 || !options?.hasBody;
    const liftOk = Boolean(liftBase) && personOk
      && (today.depth === null || today.depth >= L.minDepthAdoption)
      && (today.valid === null || today.valid >= L.minValidRatio)
      && (today.tq === null || liftBase.tq === null || today.tq >= liftBase.tq - L.trackingDrop);
    if (liftBase && !liftOk) result.skipped.push(!personOk ? "unverified" : "quality");
    const noisy = Boolean(liftBase) && today.restSd !== null && liftBase.restSd !== null && today.restSd > L.swayNoiseRatio * liftBase.restSd;
    let liftRatio = null;
    if (liftOk && today.reps3d >= L.minReps3d && today.peak !== null && liftBase.peak) {
      liftRatio = today.peak / liftBase.peak;
      const drop = liftBase.peak - today.peak;
      // ひざ上げの高さ：半分以下で 6cm 以上低い → 強い印。65%以下で 5cm 以上低い → 弱い印（揺れの大きい日は弱い印を出さない）
      if (liftRatio <= L.liftStrongRatio && drop >= L.liftStrongDropM) result.strong.push("lift");
      else if (liftRatio <= L.liftModerateRatio && drop >= L.liftModerateDropM && !noisy) result.moderate.push("lift");
      // テンポ：1回にかかる時間（中央値）か、上げている時間がいつもの 1.8 倍以上 → 弱い印（これだけでは知らせない）
      const slowCycle = today.cycleMs !== null && liftBase.cycleMs && today.reps3d >= L.tempoMinCycles + 1 && today.cycleMs / liftBase.cycleMs >= L.tempoRatio && today.cycleMs - liftBase.cycleMs >= L.tempoMinDeltaMs;
      const slowUp = today.upMs !== null && liftBase.upMs && today.reps3d >= L.tempoMinUps && today.upMs / liftBase.upMs >= L.tempoRatio && today.upMs - liftBase.upMs >= L.tempoMinDeltaMs;
      if (slowCycle || slowUp) result.moderate.push("slow");
      // 左右差：片側だけ 55% 以下（いつもは左右がそろっていて、その側が 4cm 以上下がり、両ひざの奥行きがそろっている）→ 強い印
      if (today.left !== null && today.right !== null && today.leftN >= L.minSideReps && today.rightN >= L.minSideReps && liftBase.left && liftBase.right && near(today.leftZ, today.rightZ, L.asymMaxZDiffM)) {
        const weak = today.left <= today.right ? "left" : "right";
        const other = weak === "left" ? "right" : "left";
        const baseRatio = Math.min(liftBase.left, liftBase.right) / Math.max(liftBase.left, liftBase.right);
        // 弱い側は中央値も上から25%も反対側の 55% 以下、時間の近い左右の組ごとの比の中央値も 55% 以下（両ひざとも小さくした区間が混じる日は左右差にしない）
        const weakHi = today[`${weak}Hi`];
        const pairs = today.lrRatio === null ? true : weak === "left" ? today.lrRatio <= L.asymRatio : today.lrRatio >= 1 / L.asymRatio;
        if (today[other] > 0 && today[weak] / today[other] <= L.asymRatio && (weakHi === null || weakHi <= L.asymRatio * today[other]) && pairs
          && baseRatio >= L.asymBaseRatio && liftBase[weak] - today[weak] >= L.asymDropM) result.strong.push(`asym-${weak}`);
      }
    }
    // 片側がまったく数えられない：片側 1回以下・反対側 4回以上。そのひざは映っていた（フレーム数が反対側の6割以上）。いつもは両側とも3割以上ずつ数えていた
    if (liftOk && today.reps3d >= L.collapseOtherMin) {
      [["left", today.leftN, today.leftFrames, today.rightN, today.rightFrames], ["right", today.rightN, today.rightFrames, today.leftN, today.leftFrames]].forEach(([name, n, frames, otherN, otherFrames]) => {
        if (n > L.collapseMaxReps || otherN < L.collapseOtherMin) return;
        if (frames === null || otherFrames === null || frames < L.collapseVisibleRatio * otherFrames) return;
        const recent = liftRows.slice(-L.collapseBaseSessions);
        const shared = recent.length >= L.collapseBaseSessions && recent.every((rec) => rec.reps3d > 0 && rec.leftN / rec.reps3d >= L.collapseBaseShare && rec.rightN / rec.reps3d >= L.collapseBaseShare);
        if (shared) result.strong.push(`collapse-${name}`);
      });
    }
    // 前かがみ・座る位置が低い：肩からひざ（深度）がいつもより 6cm 以上短い。同じ人（肩幅±3cm）・同じ椅子の位置（ひざの奥行き±30cm）のとき → 弱い印
    const body = options?.bodyMedians, bodyBase = options?.bodyBaseline;
    if (liftOk && body && bodyBase && (Number(bodyBase.sessions) || 0) >= L.trunkMinBodySessions
      && Number.isFinite(body.shoulderToKnee) && Number.isFinite(bodyBase.shoulderToKnee) && bodyBase.shoulderToKnee - body.shoulderToKnee >= L.trunkDropM
      && near(body.shoulderWidth, bodyBase.shoulderWidth, L.trunkSameShoulderM) && near(body.kneeZ, bodyBase.kneeZ, L.trunkSameKneeZM)) result.moderate.push("trunk");
    // ほとんど上げられない：座って判定できていたのに 1回以下（いつもは5回以上終えている）→ 強い印。4回未満で、3D の最大の上げ幅がいつもの半分未満 → 強い印
    if (personOk && repsBase && repsBase.reps >= L.attemptMinBaselineReps && today.readyS !== null && today.readyS >= L.attemptMinReadyS && today.reps <= L.attemptMaxReps) result.strong.push("attempt");
    else if (liftOk && today.reps < L.lowMaxReps && today.maxRise !== null && liftBase.peak && today.maxRise < L.lowMaxRiseRatio * liftBase.peak && today.readyS !== null && today.readyS >= L.attemptMinReadyS) result.strong.push("attempt");
    // 途中で終わった（弱い印）：いつもは終えている人が、2回以上・20秒以上座って判定できたのに、いつもの回数の半分に届かず終えた。目標が上がった日は見ない
    const targetOk = Boolean(repsBase) && today.target <= repsBase.maxTarget;
    if (!today.attempt && !today.completed && repsBase && targetOk && today.reps >= L.incompleteMinReps && today.readyS !== null && today.readyS >= L.incompleteMinReadyS && today.reps < L.incompleteFraction * repsBase.reps) result.moderate.push("incomplete");
    // 途中で終わる日が続く：直近10日のうち別の3日（今日を含む）が、どれも終えておらず、その日の最高の回数がいつもの半分未満 → 翌朝サマリー。
    // そのうち2日以上に「ほとんど上げられない」か「ひざ上げが小さい」もあれば強い印（即時）
    if (repsBase && targetOk && !today.completed) {
      const byDay = new Map();
      [...history, today].filter((rec) => today.at - rec.at <= L.streakWindowDays * 24 * 3600 * 1000).forEach((rec) => {
        const key = localDayOf(rec.at);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(rec);
      });
      const shortDays = [...byDay.values()].filter((rows) => rows.every((rec) => !rec.completed && rec.target <= repsBase.maxTarget) && Math.max(...rows.map((rec) => rec.reps)) < L.incompleteFraction * repsBase.reps);
      if (shortDays.length >= L.streakDays) {
        const todayFlag = result.strong.includes("attempt") || result.strong.includes("lift") || result.moderate.includes("lift");
        const corroborated = shortDays.filter((rows) => rows.some((rec) => rec.attempt || rec.lift1 || (rec === today && todayFlag))).length;
        if (corroborated >= 2) result.strong.push("streak");
        else if (health.lastStreakAt === null || today.at - health.lastStreakAt >= L.cooldownMs) result.summary = "streak";
      }
    }
    // ゆっくりした低下（数か月）：履歴が40件以上あるとき、古い方（6〜30件目）の中央値に対して直近10件の中央値が 65% 以下で 5cm 以上低い → 翌朝サマリー（30日に1回）
    const driftRows = sessionsOnly.filter((rec) => rec.at >= liftFrom && rec.reps3d >= L.minReps3d && rec.peak !== null && verified(rec));
    if (driftRows.length >= L.driftMinRows && today.peak !== null) {
      const anchor = median(driftRows.slice(L.driftAnchorFrom, L.driftAnchorTo).map((rec) => rec.peak));
      const recent = median([...driftRows.slice(-(L.driftRecent - 1)), today].map((rec) => rec.peak));
      if (anchor && recent !== null && recent <= L.driftRatio * anchor && anchor - recent >= L.driftDropM && (health.lastDriftAt === null || today.at - health.lastDriftAt >= L.driftCooldownMs)) {
        result.summary = result.summary || "drift";
        result.drift = { anchor: round3(anchor), recent: round3(recent) };
      }
    }
    // 1つの強い印「ひざ上げが半分以下」だけのときは、終えた運動で 40% 以下か他の印があれば即時。そうでなければ保留にし、次の運動でも 70% 以下なら知らせる
    const otherSignals = result.strong.length + result.moderate.length - (result.strong.includes("lift") ? 1 : 0);
    if (result.strong.includes("lift") && !(today.completed && (otherSignals > 0 || liftRatio <= L.liftSoloRatio))) {
      if (health.pending && liftRatio !== null && liftRatio <= L.liftConfirmRatio) result.confirmed = true;
      else {
        result.strong.splice(result.strong.indexOf("lift"), 1);
        result.moderate.push("lift");
        result.pending = { at: today.at, ratio: round3(liftRatio) };
      }
    } else if (health.pending && liftRatio !== null && liftRatio <= L.liftConfirmRatio && !result.strong.length && result.moderate.includes("lift")) {
      result.strong.push("lift");
      result.moderate.splice(result.moderate.indexOf("lift"), 1);
      result.confirmed = true;
    }
    result.score = result.strong.length * 2 + result.moderate.length;
    const moderateCore = result.moderate.includes("lift") || result.moderate.includes("trunk");
    let flagged = result.strong.length >= 1 || (result.moderate.length >= 2 && moderateCore);
    // 同じ日の前の運動が何も問題なければ、弱い印だけでは知らせない（午後に疲れている分は見ない）
    if (flagged && !result.strong.length && history.some((rec) => localDayOf(rec.at) === todayKey && rec.score === 0 && !rec.attempt)) flagged = false;
    if (!flagged) return result;
    // 同じ知らせは7日空ける。悪化（点が上がった）・新しい強い印は空けない。時計が1日以上戻っていたら（since が負）空けない方に倒す。同じ日に2度は知らせない
    const since = health.lastAlertAt !== null ? today.at - health.lastAlertAt : Infinity;
    const newStrong = result.strong.some((key) => !health.lastSignals.includes(key));
    const sameDay = health.lastAlertAt !== null && localDayOf(health.lastAlertAt) === todayKey;
    // 弱い印だけの組が、前の翌朝サマリー（7日以内）と同じ組でまた出た → 7日空けずに1度だけ即時に上げる（applyHealth が組を消すので、3度目からは空ける）
    const sameModerate = !result.strong.length && health.lastModerateAt !== null && today.at - health.lastModerateAt >= 0 && today.at - health.lastModerateAt < L.cooldownMs
      && [...result.moderate].sort().join() === [...health.lastModerate].sort().join();
    if (sameDay || (!sameModerate && since >= -dayMs && since < L.cooldownMs && result.score <= health.lastScore && !newStrong)) { result.cooldown = true; return result; }
    result.alert = true;
    result.first = health.alerts === 0;
    // 強い印は即時。弱い印2つは翌朝サマリー（次の運動でも同じ組なら即時）
    result.level = result.strong.length || sameModerate ? "immediate" : "summary";
    return result;
  }
  // 見守りの結果を watch.health と今日の履歴の行に書く（learnMarchSession / recordMarchAttempt から）
  function applyHealth(watch, record, health) {
    const h = hydrateHealth(watch.health);
    record.score = health.score;
    record.lift1 = health.strong.includes("lift") || health.moderate.includes("lift") ? 1 : 0;
    if (health.alert) {
      // lastSignals は強い印だけ（弱い印の「ひざ上げ」の翌日に強い「ひざ上げ」が出たら、新しい強い印として空けずに知らせる）
      Object.assign(h, { lastAlertAt: record.at, lastScore: health.score, lastSignals: [...health.strong].slice(0, 10), alerts: h.alerts + 1, goodAfterAlert: 0, recoveredAt: null });
      // 翌朝サマリーにした弱い印の組を覚える（次の運動でも同じ組なら即時）。即時に上げたら組は消す（同じ組で3度目は、ふつうに7日空ける）
      if (!health.strong.length && health.level === "summary") Object.assign(h, { lastModerateAt: record.at, lastModerate: [...health.moderate] });
      else Object.assign(h, { lastModerateAt: null, lastModerate: [] });
    } else if (health.score === 0) {
      Object.assign(h, { lastScore: 0, lastSignals: [] });
      // 知らせたあと、問題のない運動が2回続いたら「戻りました」を1度（基準が作れた＝比べられた日だけ数える）
      if (h.lastAlertAt !== null && h.recoveredAt === null && !health.skipped.length && !record.attempt) {
        h.goodAfterAlert += 1;
        if (h.goodAfterAlert >= HEALTH_LIMITS.recoverSessions) { h.recoveredAt = record.at; health.recovered = true; }
      }
    }
    h.pending = health.pending ? health.pending : (health.alert || health.confirmed || (health.score === 0 && !health.skipped.length) ? null : h.pending);
    if (health.summary === "streak") h.lastStreakAt = record.at;
    if (health.summary === "drift") h.lastDriftAt = record.at;
    watch.health = h;
    pushRing(watch.history, record, HEALTH_LIMITS.keepHistory);
  }
  const toCm = (meters) => Math.round(meters * 100);
  const FAMILY_FOOTER = "このお知らせは本人の画面には出ていません。回数や高さを増やすよう促す必要はありません。";
  // 家族への「いつもと違う足踏みのお知らせ」。診断はせず、何がいつもと違ったかと、声のかけ方だけを伝える。いちばん強い印を先に、cm はひざ上げの印が出たときだけ
  function familyHealthMessage(userName, health) {
    const t = health?.today || {};
    const b = health?.baseline || {};
    const strong = Array.isArray(health?.strong) ? health.strong : [];
    const moderate = Array.isArray(health?.moderate) ? health.moderate : [];
    const name = `${userName}さん`;
    const points = [];
    let advice = "体調や痛み、よく眠れているかなど、さりげなく声をかけてみてください。数日続くようなら、かかりつけの先生にご相談を。";
    if (strong.includes("attempt")) points.push(t.reps <= HEALTH_LIMITS.attemptMaxReps ? "座って始めたのに、足踏みがほとんど数えられませんでした（体はカメラに映っていました）" : "ひざがいつもの半分も上がらず、ほとんど数えられませんでした");
    const oneSided = strong.find((key) => key.startsWith("asym-") || key.startsWith("collapse-"));
    if (oneSided) {
      const side = oneSided.endsWith("left") ? "左" : "右";
      points.push(oneSided.startsWith("collapse-") ? `${side}ひざだけ、ほとんど上がりませんでした（反対のひざはいつも通り）` : `${side}ひざの上がりがいつもより小さめ（左 約${toCm(t.left)}cm／右 約${toCm(t.right)}cm）`);
      advice = "足や腰の痛み・転んだ覚えがないか、さりげなく聞いてみてください。顔や手足の片側のしびれ、ろれつが気になるときは、今日のうちに受診の相談をおすすめします。";
    }
    if ((strong.includes("lift") || moderate.includes("lift")) && Number.isFinite(t.peak) && Number.isFinite(b.peak)) points.push(`ひざの上がりがいつもよりかなり小さめ（今日 約${toCm(t.peak)}cm／いつも 約${toCm(b.peak)}cm）`);
    if (strong.includes("streak")) points.push(`${HEALTH_LIMITS.streakDays}日続けて、いつもの半分に届かず途中で終わっています`);
    if (moderate.includes("trunk")) points.push("座っている姿勢がいつもより前かがみ・低め");
    if (moderate.includes("slow")) points.push(Number.isFinite(t.cycleMs) && Number.isFinite(b.cycleMs) && b.cycleMs > 0 ? `1回がゆっくり（いつもの約${Math.round(t.cycleMs / b.cycleMs * 10) / 10}倍）` : "動きがいつもよりゆっくり");
    if (moderate.includes("incomplete") && !strong.includes("streak")) points.push("今日は途中で終わりました");
    const lines = ["いつもと違う足踏みのお知らせ"];
    if (health?.first) lines.push("（初めてのお知らせです）足踏みの大きさや速さがいつもと大きく違ったときだけ届きます。");
    lines.push(`${name}の今日の足踏みが、いつもとかなり違いました。`);
    if (points.length) lines.push(`気づいた点：${points.join("／")}`);
    lines.push(`椅子や座る位置、カメラの向きが変わっただけのこともあります。${advice}`);
    lines.push(FAMILY_FOOTER);
    return lines.join("\n");
  }
  // 翌朝サマリー向けの見守りの文（途中で終わる日が続く・数か月のゆっくりした低下・いつもの様子に戻った）
  function familyWatchSummary(userName, health) {
    const name = `${userName}さん`;
    const notes = [];
    if (health?.summary === "drift" && health.drift) notes.push(`${name}のいつものひざ上げが、この数か月で少しずつ小さくなっています（約${toCm(health.drift.anchor)}cm → 約${toCm(health.drift.recent)}cm）。無理のない範囲で、様子を見てあげてください。${FAMILY_FOOTER}`);
    if (health?.summary === "streak") notes.push(`${name}の足踏みが、途中で終わる日が続いています。気分や体調に変わりがないか、さりげなく聞いてみてください。${FAMILY_FOOTER}`);
    if (health?.recovered) notes.push(`${name}の足踏みは、いつもの様子に戻っています。`);
    return notes;
  }
  // 家族だけに届くお知らせ（completeSession が state.notifications に audience: "family" で入れる）。本人の画面には出さない。
  // レベルが上がった（体の数値を添える）・数え方をこの人に合わせた（下げた／戻した）・別の人らしい運動・見守りのサマリー・いつもと違う足踏みのお知らせ
  function familyNotesFromLearning(learning, state) {
    const notes = [];
    if (!learning || typeof learning !== "object") return notes;
    const userName = String(state?.userName || "ご本人");
    const name = `${userName}さん`;
    if (learning.otherPerson) {
      notes.push({ kind: "watch", important: false, immediate: false, message: `今日の運動は、いつもと体の大きさが違う方（お孫さんなど）の可能性があるため、${name}の分析には加えていません。記録と植物はそのままです。` });
      return notes;
    }
    const mm = (meters) => Math.round(meters * 1000) / 10;
    if (learning.levelUp && learning.after) {
      const info = getProfileSummary(learning.profile);
      const nums = [];
      if (info.typicalCm !== null) nums.push(`いつものひざ上げ 約${info.typicalCm}cm（左 ${info.leftCm}cm・右 ${info.rightCm}cm）`);
      if (info.upSec !== null) nums.push(`上げている時間 約${info.upSec}秒`);
      if (info.shoulderWidthCm !== null && info.shoulderToKneeCm !== null) nums.push(`肩幅 約${info.shoulderWidthCm}cm、肩からひざ 約${info.shoulderToKneeCm}cm`);
      if (info.usualDistanceM !== null) nums.push(`カメラまでの距離 約${info.usualDistanceM}m`);
      notes.push({ kind: "level", important: false, immediate: false,
        message: `体の分析がレベル${learning.after.level}「${learning.after.name}」になりました（足踏み ${info.reps}回ぶん）。${nums.length ? `覚えたこと：${nums.join("、")}。` : ""}本人の画面には「レベル${learning.after.level}」とだけ出ています。数字は本人には出ません。` });
    }
    if (learning.adaptedChanged && Number.isFinite(learning.liftMeters) && Number.isFinite(learning.liftMetersBefore) && learning.liftMeters !== learning.liftMetersBefore) {
      const attested = Number(learning.profile?.march?.attested) || 0;
      const lowered = learning.liftMeters < learning.liftMetersBefore;
      notes.push({ kind: "adapt", important: false, immediate: false,
        message: `数え方の調整のお知らせ\n${lowered
          ? `${name}のいつもの足踏みに合わせて、1回と数えるひざの高さの目安を ${mm(learning.liftMetersBefore)}cm → ${mm(learning.liftMeters)}cm に調整しました（はっきり数えた${attested}回から判断）。これは本人に合わせた数え方の調整で、体の変化を示すものではありません。`
          : `${name}のひざ上げが大きくなったので、1回と数えるひざの高さの目安を ${mm(learning.liftMetersBefore)}cm → ${mm(learning.liftMeters)}cm に戻しました。`}本人の画面は変わらず、このお知らせも本人には出ません。やり方を変えてもらう必要はありません。` });
    }
    familyWatchSummary(userName, learning.health).forEach((message) => notes.push({ kind: "watch", important: false, immediate: false, message }));
    if (learning.health?.alert) notes.push({ kind: "health", important: true, immediate: learning.health.level === "immediate", message: familyHealthMessage(userName, learning.health) });
    return notes;
  }
  // 回数 0 で終えた座って足踏み（テレビは運動の記録を残さない）。カメラの運動（pose / rgbd）のときだけ、見守りの履歴に「試み」として残し、
  // ほとんど上げられない日を見る。運動の記録・植物・体の分析・本人の画面は何も変わらない
  function recordMarchAttempt(inputState, input) {
    const state = hydrateState(JSON.parse(JSON.stringify(inputState)));
    const empty = { state, recorded: false, health: null, alert: null, otherPerson: false };
    if (!LEARN_SOURCES.has(input?.source)) return empty;
    const L = PROFILE_LIMITS;
    const p = state.bodyProfile;
    const samples = Array.isArray(input?.bodySamples) ? input.bodySamples.filter((item) => item && typeof item === "object") : [];
    const bodyKeys = ["shoulderWidth", "shoulderToKnee", "shoulderY", "kneeZ"];
    const bodyMedians = samples.length >= L.minBodySamples ? Object.fromEntries(bodyKeys.map((key) => [key, median(samples.map((item) => item[key]).filter(Number.isFinite))])) : null;
    const identity = assessSamePerson(p, bodyMedians);
    if (!identity.same) return { ...empty, otherPerson: true };
    const quality = input?.quality && typeof input.quality === "object" ? input.quality : emptyMarchQuality();
    const nowMs = input?.now instanceof Date ? input.now.getTime() : Number.isFinite(input?.now) ? input.now : Date.now();
    const record = marchHistoryRecord([], { quality, bodyMedians, target: input?.target, completed: false, attempt: true, personVerified: identity.checked && identity.same, trackingQuality: input?.trackingQuality, validRatio: input?.validRatio }, nowMs);
    const bodyBaseline = p && p.body.sessions ? { sessions: p.body.sessions, shoulderWidth: median(p.body.shoulderWidth), shoulderToKnee: median(p.body.shoulderToKnee), kneeZ: median(p.body.kneeZ) } : null;
    const health = assessMarchHealth(state.watch, record, { bodyMedians, bodyBaseline, hasBody: Boolean(p) && p.body.sessions >= HEALTH_LIMITS.samePersonMinSessions });
    applyHealth(state.watch, record, health);
    let alert = null;
    if (health.alert) {
      alert = { kind: "health", important: true, immediate: health.level === "immediate", message: familyHealthMessage(String(state.userName || "ご本人"), health) };
      state.notifications.unshift({ id: `family-${nowMs}-attempt`, timestamp: new Date(nowMs).toISOString(), audience: "family", ...alert });
      state.notifications = capNotifications(state.notifications);
    }
    return { state, recorded: true, health, alert, otherPerson: false };
  }
  // 保留にしたひざ上げの印（次の運動で確かめるつもりだった）が3日たっても次の運動がない → 翌朝サマリーで家族にひと言。アプリの起動時に呼ぶ
  function settlePendingWatch(inputState, nowValue) {
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Number.isFinite(nowValue) ? nowValue : Date.now();
    const pending = inputState?.watch?.health?.pending;
    if (!pending || nowMs - pending.at < HEALTH_LIMITS.pendingDays * 24 * 3600 * 1000) return { state: inputState, changed: false };
    const state = hydrateState(JSON.parse(JSON.stringify(inputState)));
    state.watch.health.pending = null;
    state.notifications.unshift({ id: `family-${nowMs}-pending`, timestamp: new Date(nowMs).toISOString(), audience: "family", kind: "watch", important: false, immediate: false,
      message: `${state.userName}さんの先日の足踏みが、いつもより小さめでした（いつもの約${Math.round(pending.ratio * 100)}%）。その後、運動していません。体調に変わりがないか、ひと声かけてみてください。${FAMILY_FOOTER}` });
    state.notifications = capNotifications(state.notifications);
    return { state, changed: true };
  }

  function createBodyProfile() {
    return {
      version: PROFILE_VERSION, algorithm: ALGORITHM_VERSION, updatedAt: null,
      march: { sessions: 0, reps: 0, attested: 0, left: { reps: 0, peaks: [] }, right: { reps: 0, peaks: [] }, upMs: [], zRest: [], liftMeters: null },
      body: { sessions: 0, shoulderWidth: [], shoulderToKnee: [], shoulderY: [], kneeZ: [] },
      quality: { restSd: [], kneeDepthAdoption: [] }
    };
  }
  // 読み込み。版・判定の版が違えば null（別の判定で測った最高点は比べられない）。数でないもの・範囲外は捨て、履歴の長さを切る。
  // 保存されていた liftMeters は信用せず、証拠から毎回作り直す（壊れた保存値でしきい値が下がることはない）
  function hydrateBodyProfile(raw) {
    if (!raw || typeof raw !== "object" || raw.version !== PROFILE_VERSION || raw.algorithm !== ALGORITHM_VERSION || !raw.march || typeof raw.march !== "object") return null;
    const L = PROFILE_LIMITS;
    // 回数は数（有限）だけ受け付け、上限を置く（壊れた保存値の "Infinity回ぶん" やレベル4を防ぐ）
    const count = (value) => (typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), 0, 1000000) : 0);
    const ring = (list, bounds, keep) => (Array.isArray(list) ? list.filter((value) => typeof value === "number" && inBounds(value, bounds)).slice(-keep) : []);
    const m = raw.march;
    const b = raw.body && typeof raw.body === "object" ? raw.body : {};
    const q = raw.quality && typeof raw.quality === "object" ? raw.quality : {};
    const side = (item) => ({ reps: count(item?.reps), peaks: ring(item?.peaks, PROFILE_BOUNDS.peak, L.keep) });
    const profile = {
      version: PROFILE_VERSION, algorithm: ALGORITHM_VERSION,
      updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : null,
      march: {
        sessions: count(m.sessions), reps: count(m.reps), attested: count(m.attested), left: side(m.left), right: side(m.right),
        upMs: ring(m.upMs, PROFILE_BOUNDS.upMs, L.keep).map(Math.round), zRest: ring(m.zRest, PROFILE_BOUNDS.zRest, L.keepSessions), liftMeters: null
      },
      body: {
        sessions: count(b.sessions), shoulderWidth: ring(b.shoulderWidth, PROFILE_BOUNDS.shoulderWidth, L.keepSessions),
        shoulderToKnee: ring(b.shoulderToKnee, PROFILE_BOUNDS.shoulderToKnee, L.keepSessions),
        shoulderY: ring(b.shoulderY, PROFILE_BOUNDS.shoulderY, L.keepSessions), kneeZ: ring(b.kneeZ, PROFILE_BOUNDS.kneeZ, L.keepSessions)
      },
      quality: { restSd: ring(q.restSd, PROFILE_BOUNDS.restSd, L.keepSessions), kneeDepthAdoption: ring(q.kneeDepthAdoption, PROFILE_BOUNDS.kneeDepthAdoption, L.keepSessions) }
    };
    profile.march.liftMeters = learnedLiftMeters(profile);
    return profile;
  }
  // 1回数えた update（updatePoseCounter の rep: true）から、体の分析に渡す数値だけを取り出す。
  // 入力元が pose / rgbd 以外（デモ・模擬・簡易）は null。デモボタン・Spaceキー・簡易判定は判定の update を作らないので、ここへは来ない
  function pickLearnableRep(update, source) {
    if (!update?.rep || !LEARN_SOURCES.has(source) || (update.side !== "left" && update.side !== "right")) return null;
    const num = (value) => (Number.isFinite(value) ? value : null);
    return {
      source, side: update.side, peakMeters: num(update.peakMeters), upMs: num(update.upMs), mode: update.mode === "3d" || update.mode === "2d" ? update.mode : null,
      otherMeters: num(update.otherMeters), zRestMeters: num(update.zRestMeters), sinceUnsureMs: num(update.sinceUnsureMs),
      // 1回にかかった時間（前の1回から。家族への見守りのテンポ）
      cycleMs: num(update.cycleDurationMs)
    };
  }
  // はっきり数えた1回か（しきい値を動かす証拠に使えるか）。すべて満たすこと
  function isAttestedMarchRep(rep) {
    const L = PROFILE_LIMITS;
    return Boolean(rep) && rep.mode === "3d"
      && Number.isFinite(rep.peakMeters) && rep.peakMeters >= L.teachMinPeak && rep.peakMeters <= L.teachMaxPeak
      && Number.isFinite(rep.upMs) && rep.upMs >= L.teachMinUpMs && rep.upMs <= L.teachMaxUpMs
      && Number.isFinite(rep.otherMeters) && rep.otherMeters <= L.teachMaxOther
      && (!Number.isFinite(rep.sinceUnsureMs) || rep.sinceUnsureMs >= L.teachQuietMs);
  }
  // 計測の質（判定の counter.march から）。セッションの途中で判定を作り直す（一時停止）ときは、先に mergeMarchQuality で足しておく
  function emptyMarchQuality() {
    return { kneeFrames: 0, kneeDepthFrames: 0, restWindowSds: [], leftFrames: 0, rightFrames: 0, readyMs: 0, maxRise3d: null };
  }
  function marchQualitySnapshot(counter) {
    const march = counter?.march;
    if (!march) return emptyMarchQuality();
    return {
      kneeFrames: march.kneeFrames || 0, kneeDepthFrames: march.kneeDepthFrames || 0, restWindowSds: Array.isArray(march.restWindowSds) ? [...march.restWindowSds] : [],
      leftFrames: march.sideFrames?.left || 0, rightFrames: march.sideFrames?.right || 0, readyMs: march.readyMs || 0, maxRise3d: Number.isFinite(march.maxRise3d) ? march.maxRise3d : null
    };
  }
  function mergeMarchQuality(accumulator, snapshot) {
    const acc = accumulator && typeof accumulator === "object" ? accumulator : emptyMarchQuality();
    if (!Array.isArray(acc.restWindowSds)) acc.restWindowSds = [];
    acc.kneeFrames = (Number(acc.kneeFrames) || 0) + (Number(snapshot?.kneeFrames) || 0);
    acc.kneeDepthFrames = (Number(acc.kneeDepthFrames) || 0) + (Number(snapshot?.kneeDepthFrames) || 0);
    acc.restWindowSds.push(...(Array.isArray(snapshot?.restWindowSds) ? snapshot.restWindowSds.filter(Number.isFinite) : []));
    acc.leftFrames = (Number(acc.leftFrames) || 0) + (Number(snapshot?.leftFrames) || 0);
    acc.rightFrames = (Number(acc.rightFrames) || 0) + (Number(snapshot?.rightFrames) || 0);
    acc.readyMs = (Number(acc.readyMs) || 0) + (Number(snapshot?.readyMs) || 0);
    const rises = [acc.maxRise3d, snapshot?.maxRise3d].filter(Number.isFinite);
    acc.maxRise3d = rises.length ? Math.max(...rises) : null;
    while (acc.restWindowSds.length > 400) acc.restWindowSds.shift();
    return acc;
  }
  // 座って静止している間の体の大きさ（深度カメラの3D座標：カメラ座標、m、y下向き）。ブラウザの推定（腰を原点にした座標）には使わない（app.js が rgbd のときだけ呼ぶ）。
  // 両ひざが下りて候補もない・肩2点とひざ2点に深度がある・肩の深度が左右でそろっている（ももを上げると片方の肩の深度が跳ぶ）・ひざが肩より 35cm 以上手前（座っている）ときだけ
  function sampleBodySpans(counter, world) {
    const march = counter?.march;
    if (!march || !Array.isArray(world)) return null;
    const now = march.frameAt;
    const resting = (side) => side.phase === "down" && side.candidate === null && side.rise !== null && Number.isFinite(now) && now - side.lastSeenAt <= 300
      && Math.abs(side.rise - Math.max(0, side.floor)) < .02;
    if (!resting(march.left) || !resting(march.right)) return null;
    const ok = (point) => Boolean(point) && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z) && point.z > 0;
    const [ls, rs, lk, rk] = [11, 12, 25, 26].map((index) => world[index]);
    if (![ls, rs, lk, rk].every(ok)) return null;
    if (ls.z < .8 || rs.z < .8 || Math.abs(ls.z - rs.z) > .15 || lk.z < .9 || rk.z < .9) return null;
    const far = ls.z >= rs.z ? ls : rs;
    if (far.z - (lk.z + rk.z) / 2 < .35) return null;
    return { shoulderWidth: Math.hypot(ls.x - rs.x, ls.y - rs.y, ls.z - rs.z), shoulderToKnee: Math.max(lk.y, rk.y) - far.y, shoulderY: far.y, kneeZ: (lk.z + rk.z) / 2 };
  }
  // 証拠が足りるときだけ、この人の小さめの上げ（下から25%の最高点）の半分を「上げた」の高さにする（.005 刻みに四捨五入）。.05〜.06 の外には出ない。
  // 静止中の揺れ（標準偏差の中央値）の4倍より下げず、揺れが測れていない間は下げない。証拠が足りなければ null（既定のまま）
  function learnedLiftMeters(profile) {
    const L = PROFILE_LIMITS;
    const m = profile?.march;
    if (!m || m.attested < L.minAttested || m.left.peaks.length < L.minPerKnee || m.right.peaks.length < L.minPerKnee || m.sessions < L.minSessions) return null;
    const evidence = [...m.left.peaks, ...m.right.peaks];
    if (evidence.length < L.minAttested) return null;
    const p25 = percentileOf(evidence, .25);
    let floor = L.liftFloor;
    const restSd = Array.isArray(profile.quality?.restSd) ? profile.quality.restSd : [];
    if (restSd.length >= L.restSdMinSessions) floor = Math.max(floor, Math.ceil(L.restSdFloorFactor * median(restSd) / L.liftStep - 1e-9) * L.liftStep);
    else if (L.restSdRequired) floor = L.liftCeil;
    floor = Math.min(floor, L.liftCeil);
    return round3(Math.round(clamp(L.liftRatio * p25, floor, L.liftCeil) / L.liftStep) * L.liftStep);
  }
  // 数え方への反映（createPoseCounter の options.limits）。liftMeters を下げるときだけ上書きし（nearMiss も同じ差で）、他は何も変えない。
  // 保存値は使わず、証拠から計算する。adaptEnabled が false・証拠不足・.06 のままなら {}（既定どおり）
  function marchOverridesFromProfile(profile) {
    const L = PROFILE_LIMITS;
    if (!L.adaptEnabled) return {};
    const lift = learnedLiftMeters(hydrateBodyProfile(profile) || createBodyProfile());
    if (!Number.isFinite(lift) || lift < L.liftFloor || lift >= MARCH_LIMITS.liftMeters) return {};
    return { liftMeters: lift, nearMissMeters: round3(lift - L.nearMissGap) };
  }
  // セッションの終わりに呼ぶ（app.js finishSession、流し直しの道具）。learned: pickLearnableRep の列、bodySamples: sampleBodySpans の列、quality: mergeMarchQuality の結果。
  // 戻り値の profile を completeSession に渡す（実績に数えるセッションのときだけ確定される）
  // input.watch（state.watch）を渡すと、家族への見守りも評価して watch（更新した写し）と health を返す。completeSession がそれを state に入れる
  function learnMarchSession(profile, input) {
    const L = PROFILE_LIMITS;
    const p = hydrateBodyProfile(profile) || createBodyProfile();
    const w = hydrateWatch(input?.watch);
    const before = getAnalysisLevel(p);
    const liftBefore = marchOverridesFromProfile(profile).liftMeters ?? MARCH_LIMITS.liftMeters;
    const learned = Array.isArray(input?.learned) ? input.learned.filter((rep) => rep && LEARN_SOURCES.has(rep.source) && (rep.side === "left" || rep.side === "right")) : [];
    // 覚える1回が1つもない運動（デモ・模擬・簡易だけ）はセッションに数えず、何も変えない
    if (!learned.length) {
      return {
        profile: hydrateBodyProfile(profile), learnedReps: 0, attested: 0, bodyLearned: false, before, after: before, levelUp: false,
        kneeDepthAdoption: null, restSdM: null, liftMeters: liftBefore, liftMetersBefore: liftBefore, adaptedChanged: false,
        watch: w, health: null, otherPerson: false, identity: { checked: false, same: true, shoulderDiff: null, spanDiff: null }
      };
    }
    // 体の大きさ（深度で測った静止中の中央値）。覚えている肩幅と大きく違えば別の人らしいので、このセッションは覚えず（回数・証拠・見守りの履歴に入れず）、知らせもしない
    const samples = Array.isArray(input?.bodySamples) ? input.bodySamples.filter((item) => item && typeof item === "object") : [];
    const bodyKeys = ["shoulderWidth", "shoulderToKnee", "shoulderY", "kneeZ"];
    const bodyMedians = samples.length >= L.minBodySamples ? Object.fromEntries(bodyKeys.map((key) => [key, median(samples.map((item) => item[key]).filter(Number.isFinite))])) : null;
    const identity = assessSamePerson(p, bodyMedians);
    // 体の大きさの基準（今日を足す前）：前かがみの印用。hasBody: この人の体の大きさを覚えているか（覚えていれば、確かめられた日だけ体の大きさに頼る印を出す）
    const bodyBaseline = p.body.sessions ? { sessions: p.body.sessions, shoulderWidth: median(p.body.shoulderWidth), shoulderToKnee: median(p.body.shoulderToKnee), kneeZ: median(p.body.kneeZ) } : null;
    const hasBody = p.body.sessions >= HEALTH_LIMITS.samePersonMinSessions;
    if (!identity.same) {
      return {
        profile: hydrateBodyProfile(profile), learnedReps: learned.length, attested: 0, bodyLearned: false, before, after: before, levelUp: false,
        kneeDepthAdoption: null, restSdM: null, liftMeters: liftBefore, liftMetersBefore: liftBefore, adaptedChanged: false, watch: w, health: null, otherPerson: true, identity
      };
    }
    let attested = 0;
    learned.forEach((rep) => {
      p.march.reps += 1;
      p.march[rep.side].reps += 1;
      if (!isAttestedMarchRep(rep)) return;
      attested += 1;
      p.march.attested += 1;
      pushRing(p.march[rep.side].peaks, round3(rep.peakMeters), L.keep);
      pushRing(p.march.upMs, Math.round(rep.upMs), L.keep);
    });
    const zRests = learned.filter((rep) => rep.mode === "3d" && Number.isFinite(rep.zRestMeters)).map((rep) => rep.zRestMeters);
    if (zRests.length >= L.minZRestReps) {
      const z = median(zRests);
      if (inBounds(z, PROFILE_BOUNDS.zRest)) pushRing(p.march.zRest, round3(z), L.keepSessions);
    }
    let bodyLearned = false;
    if (bodyMedians && bodyKeys.every((key) => inBounds(bodyMedians[key], PROFILE_BOUNDS[key]))) {
      bodyKeys.forEach((key) => pushRing(p.body[key], round3(bodyMedians[key]), L.keepSessions));
      p.body.sessions += 1;
      bodyLearned = true;
    }
    const quality = input?.quality && typeof input.quality === "object" ? input.quality : emptyMarchQuality();
    const kneeFrames = Number(quality.kneeFrames) || 0;
    const kneeDepthAdoption = kneeFrames >= L.minQualityFrames ? round3(clamp((Number(quality.kneeDepthFrames) || 0) / kneeFrames, 0, 1)) : null;
    if (kneeDepthAdoption !== null) pushRing(p.quality.kneeDepthAdoption, kneeDepthAdoption, L.keepSessions);
    const sds = Array.isArray(quality.restWindowSds) ? quality.restWindowSds.filter((value) => inBounds(value, PROFILE_BOUNDS.restSd)) : [];
    const restSdM = sds.length >= L.minQualityWindows ? round4(median(sds)) : null;
    if (restSdM !== null) pushRing(p.quality.restSd, restSdM, L.keepSessions);
    // 家族への見守り：今日の数値を履歴（今日を含まない）と比べてから、履歴に足す。見守りが失敗しても体の分析（学習）は進める
    const nowMs = input?.now instanceof Date ? input.now.getTime() : Number.isFinite(input?.now) ? input.now : Date.now();
    let health = null;
    try {
      const record = marchHistoryRecord(learned, {
        quality, bodyMedians, target: input?.target, completed: input?.completed === true, restSdM, kneeDepthAdoption, liftMeters: liftBefore,
        trackingQuality: input?.trackingQuality, validRatio: input?.validRatio, personVerified: identity.checked && identity.same, attempt: false
      }, nowMs);
      health = assessMarchHealth(w, record, { bodyMedians, bodyBaseline, hasBody });
      applyHealth(w, record, health);
    } catch (error) {
      health = { alert: false, error: String(error && error.message || error).slice(0, 120), strong: [], moderate: [], skipped: ["error"], score: 0 };
    }
    p.march.sessions += 1;
    p.march.liftMeters = learnedLiftMeters(p);
    p.updatedAt = new Date(nowMs).toISOString();
    const after = getAnalysisLevel(p);
    const liftAfter = marchOverridesFromProfile(p).liftMeters ?? MARCH_LIMITS.liftMeters;
    return {
      profile: p, learnedReps: learned.length, attested, bodyLearned, before, after, levelUp: after.level > before.level,
      kneeDepthAdoption, restSdM, liftMeters: liftAfter, liftMetersBefore: liftBefore, adaptedChanged: liftAfter !== liftBefore,
      watch: w, health, otherPerson: false, identity
    };
  }
  // 分析レベル（0〜5）。実績に数えた足踏みの回数・左右それぞれの回数・セッション数で決める。じっくり育つ（よしさん 2026-10-06：ずっと使ってもらう前提）：
  // 1日1回、5回ずつなら 1・8・20・40・80 日目、10回ずつなら 1・5・12・25・50 日目に上がる。レベル1だけは初日に上がる（最初の日から育ちが見える）
  // 情報として見せるだけで、数え方には関係ない（数え方は learnedLiftMeters の証拠の条件で別に決まる）。名前と文は「覚える」の言い方にし、「合わせた・変えた」とは言わない
  const ANALYSIS_LEVELS = [
    { level: 1, name: "覚え始め", reps: 5, each: 0, sessions: 1 },
    { level: 2, name: "ひざの上げ方", reps: 40, each: 15, sessions: 5 },
    { level: 3, name: "あなたの足踏み", reps: 100, each: 40, sessions: 12 },
    { level: 4, name: "よく知っています", reps: 200, each: 80, sessions: 25 },
    { level: 5, name: "長いおつきあい", reps: 400, each: 160, sessions: 50 }
  ];
  function getAnalysisLevel(profile) {
    const m = profile && typeof profile === "object" && profile.march ? profile.march : null;
    const reps = m ? Number(m.reps) || 0 : 0;
    const each = m ? Math.min(Number(m.left?.reps) || 0, Number(m.right?.reps) || 0) : 0;
    const sessions = m ? Number(m.sessions) || 0 : 0;
    const hasBody = Boolean(profile?.body) && (Number(profile.body.sessions) || 0) >= 1;
    let current = { level: 0, name: "はじめまして" };
    ANALYSIS_LEVELS.forEach((rule) => { if (reps >= rule.reps && each >= rule.each && sessions >= rule.sessions) current = rule; });
    const messages = {
      0: "今日の足踏みから覚えます。",
      1: hasBody ? "体の大きさを覚えました。" : "足踏みを覚え始めました。",
      2: "ひざの上げ方を覚えました。",
      3: "あなたの足踏みを覚えました。",
      4: "あなたの足踏みをよく知っています。",
      5: "長く一緒に歩んできました。"
    };
    const nextRule = ANALYSIS_LEVELS.find((rule) => rule.level === current.level + 1) || null;
    const next = nextRule
      ? { level: nextRule.level, name: nextRule.name, repsLeft: Math.max(0, nextRule.reps - reps), eachLeft: Math.max(0, nextRule.each - each), sessionsLeft: Math.max(0, nextRule.sessions - sessions) }
      : null;
    return { level: current.level, name: current.name, message: messages[current.level], reps, each, sessions, hasBody, next };
  }
  // 表示用のまとめ（家族の画面・結果画面）。測れていない項目は null（表示しない）。cm・m・秒に丸める
  function getProfileSummary(profile) {
    const p = hydrateBodyProfile(profile);
    const level = getAnalysisLevel(p);
    const m = p ? p.march : createBodyProfile().march;
    const b = p ? p.body : createBodyProfile().body;
    const q = p ? p.quality : createBodyProfile().quality;
    const peaks = [...m.left.peaks, ...m.right.peaks];
    const cm = (value) => (value === null ? null : Math.round(value * 100));
    const enoughPeaks = peaks.length >= 10 && m.left.peaks.length >= 5 && m.right.peaks.length >= 5;
    const overrides = marchOverridesFromProfile(p);
    return {
      level, reps: m.reps, attested: m.attested, sessions: m.sessions, bodySessions: b.sessions,
      shoulderWidthCm: b.sessions >= 1 && b.shoulderWidth.length ? cm(median(b.shoulderWidth)) : null,
      shoulderToKneeCm: b.sessions >= 1 && b.shoulderToKnee.length ? cm(median(b.shoulderToKnee)) : null,
      usualDistanceM: m.zRest.length >= 2 ? Math.round(median(m.zRest) * 10) / 10 : null,
      typicalCm: enoughPeaks ? cm(median(peaks)) : null,
      leftCm: enoughPeaks ? cm(median(m.left.peaks)) : null,
      rightCm: enoughPeaks ? cm(median(m.right.peaks)) : null,
      upSec: m.upMs.length >= 10 ? Math.round(median(m.upMs) / 100) / 10 : null,
      liftCm: Math.round((overrides.liftMeters ?? MARCH_LIMITS.liftMeters) * 1000) / 10,
      adapted: Number.isFinite(overrides.liftMeters),
      depthSeen: b.sessions >= 1 || m.attested >= 1 || m.zRest.length >= 1,
      kneeDepthAdoption: q.kneeDepthAdoption.length ? median(q.kneeDepthAdoption) : null,
      restSdCm: q.restSd.length ? Math.round(median(q.restSd) * 1000) / 10 : null
    };
  }

  // ---- 精度の見え方（F5「自分に合った精度の確認」）。家族だけ：テレビの「ご家族・運営の方へ」（PINの先）と、家族の端末の PIN の先だけに出す ----
  // 本人の画面・家族の端末の「みんなで見る部分」（写しの shared）には入れない（cm などの体の数値を含むので）。
  // 座って足踏みの部品は読むだけ。数（cm・合わせ済みか・奥行きを使ったか）は getProfileSummary から取り、同じ計算を2つ作らない
  // 映り方（記録の tracking_quality）の境目。仮の値なので、PC の本物の記録で見直す
  const ACCURACY_SEEN = { good: 70, fair: 50 };
  // 記録の入力元 → カメラ（奥行きカメラ・ブラウザのカメラ）。練習（模擬・デモ・簡易・混在）と前の版の記録は null
  const ACCURACY_CAMERAS = { rgbd: "depth", pose: "browser" };
  function getAccuracyView(state, nowValue) {
    const L = PROFILE_LIMITS;
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue ?? Date.now());
    const profile = hydrateBodyProfile(state?.bodyProfile) || createBodyProfile();
    const m = profile.march;
    const summary = getProfileSummary(state?.bodyProfile);
    const analysis = summary.level;
    // この人に合わせる準備（learnedLiftMeters が null を返さなくなる条件と、揺れの記録。restSdRequired の間は揺れが測れるまで下げない）
    const steps = [
      { key: "attested", label: "はっきり数えられた足踏み", have: m.attested, need: L.minAttested },
      { key: "left", label: "左ひざ", have: m.left.peaks.length, need: L.minPerKnee },
      { key: "right", label: "右ひざ", have: m.right.peaks.length, need: L.minPerKnee },
      { key: "evidence", label: "左右あわせた足踏みの記録", have: m.left.peaks.length + m.right.peaks.length, need: L.minAttested },
      { key: "sessions", label: "座って足踏みをした回数", have: m.sessions, need: L.minSessions },
      { key: "steady", label: "じっと座っているときの揺れの記録", have: profile.quality.restSd.length, need: L.restSdMinSessions }
    ];
    // 準備はそろったが合わせていない＝この人には標準が合っている。合わせる仕組みを止めているときは、合っているかは分からないので false
    const ready = L.adaptEnabled && !summary.adapted && steps.every((step) => step.have >= step.need);
    const sessions = Array.isArray(state?.sessions) ? state.sessions.filter((item) => item && typeof item === "object") : [];
    const exerciseName = (id, fallback) => EXERCISES.find((item) => item.id === id)?.name || (typeof fallback === "string" ? fallback : "");
    // 最近5件（新しい順。state.sessions の並び）。練習はわけ（practiceReasonText）だけで、映り方は出さない
    const recent = sessions.slice(0, 5).map((session) => {
      const practice = !countsTowardProgress(session);
      const quality = session.tracking_quality;
      const measured = typeof quality === "number" && Number.isFinite(quality);
      return {
        at: typeof session.timestamp === "string" && Number.isFinite(Date.parse(session.timestamp)) ? session.timestamp : null,
        exerciseName: exerciseName(session.exercise_id, session.exercise_name),
        practice,
        reason: practice ? practiceReasonText(session) : null,
        seen: practice || !measured ? null : quality >= ACCURACY_SEEN.good ? "good" : quality >= ACCURACY_SEEN.fair ? "fair" : "poor",
        camera: Object.hasOwn(ACCURACY_CAMERAS, session.input_source) ? ACCURACY_CAMERAS[session.input_source] : null
      };
    });
    // この30日（今日を含む30の日付。getChartData(state, now, 30) と同じ範囲）の記録の数と、そのうち練習の数
    const today = localDateKey(now);
    const from = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
    const month = sessions.filter((item) => { const key = String(item.dateKey || ""); return key >= from && key <= today; });
    // 選べる運動ごと。人に合わせるのは座って足踏みだけ（ほかはどの人にも同じ標準の数え方）
    const unlocked = new Set((Array.isArray(state?.exercises) ? state.exercises : []).filter((item) => item && item.unlocked === true).map((item) => item.id));
    return {
      march: {
        level: analysis.level, levelName: analysis.name,
        next: analysis.next ? { level: analysis.next.level, repsLeft: analysis.next.repsLeft, eachLeft: analysis.next.eachLeft, sessionsLeft: analysis.next.sessionsLeft } : null,
        adaptEnabled: L.adaptEnabled, tuned: summary.adapted, ready, countHeightCm: summary.liftCm, standardCm: Math.round(MARCH_LIMITS.liftMeters * 1000) / 10,
        // 奥行きカメラを使ったか：体の分析に奥行きの記録があるか、最近5回の行に奥行きカメラの記録があるか（体の分析がまだない新しい人・
        // 「体の分析をやり直す」のあとでも、奥行きカメラの行の上に「ブラウザのカメラだけ」の文を出さない）
        steps, depthUsed: summary.depthSeen || recent.some((item) => item.camera === "depth")
      },
      recent,
      practice30: { total: month.length, practice: month.filter((item) => !countsTowardProgress(item)).length },
      exercises: EXERCISES.filter((item) => unlocked.has(item.id)).map((item) => ({ id: item.id, name: item.name, tuned: item.id === "chair-march" && summary.adapted }))
    };
  }

  function updatePoseCounter(counter, measurement, nowValue) {
    const now = Number(nowValue) || 0;
    counter.totalFrames += 1;
    if (counter.exerciseId === "chair-march") return updateMarchCounter(counter, measurement, now);
    if (EXCURSION_UNITS[counter.exerciseId]) return updateExcursionCounter(counter, measurement, now);
    return { rep: false, phase: counter.phase, quality: 0, rangePercent: 0, cycleDurationMs: null, message: measurement?.message || "必要な部位をカメラに映してください", side: null };
  }

  return {
    STORAGE_KEY,
    ALGORITHM_VERSION,
    INPUT_SOURCES,
    EXERCISES,
    localDateKey,
    makeDefaultState,
    hydrateState,
    addVoice,
    renameVoice,
    VOICE_NAME_LIMIT,
    selectVoice,
    removeVoice,
    noteVoiceArrival,
    clearVoiceArrival,
    VOICE_LIMIT,
    // 運動する人の名簿と PIN（F0）
    PEOPLE_KEY,
    ADMIN_OPTIONS_KEY,
    hydrateAdminOptions,
    PEOPLE_LIMIT,
    personStorageKey,
    makeDefaultPeople,
    hydratePeople,
    rebuildPeople,
    hydratePinRecord,
    addPerson,
    renamePerson,
    removePerson,
    validateNewPin,
    NOTIFICATION_LIMITS,
    capNotifications,
    CORRUPT_STORAGE_KEY,
    noteCorruptStorage,
    getExercise,
    getTarget,
    countsTowardProgress,
    resolveInputSource,
    POSE_ASSET_FILES,
    PRACTICE_REASONS,
    practiceReason,
    practiceReasonText,
    completeSession,
    getSummary,
    getChartData,
    getPlantStage,
    completeDailyQuest,
    // 家族の写真の写真あそび（F2）と、家族の端末へ送る写し（F1・4.5.5）
    familyPhotoGrowth,
    nextFamilyQuest,
    getDashboardSummary,
    nextLevelText,
    analysisNote,
    getWeekMarks,
    sharedNoticeLine,
    familyNoteLabel,
    buildFamilySnapshot,
    QUEST_WIPE_LIMITS,
    questWipeFromPose,
    LANDMARK,
    landmarkConfidence,
    insideFrame,
    visible,
    smoothLandmarks,
    measurePoseForExercise,
    measurePoseDetails,
    FRAMING_JOINTS,
    POSITION_LIMITS,
    MARCH_LIMITS,
    ARM_LIMITS,
    KNEE_LIMITS,
    STAND_LIMITS,
    STEP_LIMITS,
    KNEE_OPEN_LIMITS,
    TWIST_LIMITS,
    SHRUG_LIMITS,
    ARM_OPEN_LIMITS,
    SIDE_BEND_LIMITS,
    SEATED_HEEL_LIMITS,
    STANDING_POSTURE,
    STAND_HEEL_LIMITS,
    SQUAT_LIMITS,
    LIMITS_BY_EXERCISE,
    assessPosition,
    createPoseCounter,
    updatePoseCounter,
    // 体の分析（一緒に育つ）
    PROFILE_VERSION,
    PROFILE_LIMITS,
    createBodyProfile,
    hydrateBodyProfile,
    pickLearnableRep,
    isAttestedMarchRep,
    learnMarchSession,
    learnedLiftMeters,
    marchOverridesFromProfile,
    ANALYSIS_LEVELS,
    getAnalysisLevel,
    getProfileSummary,
    // 精度の見え方（家族だけ）
    getAccuracyView,
    sampleBodySpans,
    emptyMarchQuality,
    marchQualitySnapshot,
    mergeMarchQuality,
    // 家族への見守り（いつもと違う足踏みのお知らせ）と、家族だけに届くお知らせ
    WATCH_VERSION,
    HEALTH_LIMITS,
    createWatch,
    hydrateWatch,
    hydrateNotifications,
    marchHistoryRecord,
    assessSamePerson,
    assessMarchHealth,
    familyHealthMessage,
    familyWatchSummary,
    familyNotesFromLearning,
    recordMarchAttempt,
    settlePendingWatch
  };
});
