// 端末サービス（device-service、127.0.0.1）からPoseFrameを受け取るアダプター。
// テレビUIはカメラを直接開かず、このサービスがカメラの唯一の所有者になる。
(function (root) {
  "use strict";

  // PoseFrameの関節名 → MediaPipe Poseの番号
  const JOINT_INDEX = {
    left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14, left_wrist: 15, right_wrist: 16,
    left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26, left_ankle: 27, right_ankle: 28
  };

  // 骨格の線（motion-ai.js の POSE_CONNECTIONS のうち、PoseFrame に含まれる12関節の分）
  const CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]
  ];

  function readConfig(search) {
    const params = new URLSearchParams(search || "");
    if (params.get("sensor") !== "local") return null;
    const port = Number(params.get("sensorPort")) || 8770;
    return { port, token: params.get("token") || "" };
  }

  // PoseFrame → logic.js が受け取れる正規化33点と、深度が取れた関節だけの3D座標（m）
  function toLandmarks(frame) {
    if (!frame || !Array.isArray(frame.joints) || !frame.joints.length) return { landmarks: null, world: null };
    const landmarks = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, visibility: 0, presence: 0 }));
    const world = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, z: NaN }));
    let depthJoints = 0;
    frame.joints.forEach((joint) => {
      const index = JOINT_INDEX[joint.name];
      if (index === undefined) return;
      landmarks[index] = { x: joint.image_x, y: joint.image_y, z: 0, visibility: joint.visibility, presence: joint.visibility };
      if (joint.depth_valid && Number.isFinite(joint.z)) {
        world[index] = { x: joint.x, y: joint.y, z: joint.z };
        depthJoints += 1;
      }
    });
    return { landmarks, world: depthJoints ? world : null };
  }

  // 指定した関節（MediaPipe番号）のうち、深度が取れたものの距離の中央値（m）。ひとつもなければ null。
  function medianDepth(frame, indices) {
    const wanted = new Set(indices);
    const values = (frame?.joints || [])
      .filter((joint) => wanted.has(JOINT_INDEX[joint.name]) && joint.depth_valid && Number.isFinite(joint.z))
      .map((joint) => joint.z)
      .sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }

  // 画像の縦1（0〜1の座標）あたりの焦点距離 fy ÷（画像の高さ−1）。ひざの画像上の上下を、奥行きを掛けて m に換算するのに使う。
  // 端末サービスの PoseFrame の intrinsics から求める（縦置きで回したときも、回した後の値が届く）。なければ null
  function normalizedFy(frame) {
    const intrinsics = frame?.intrinsics;
    const fy = Number(intrinsics?.fy);
    const height = Number(intrinsics?.height);
    return Number.isFinite(fy) && fy > 0 && Number.isFinite(height) && height > 1 ? fy / (height - 1) : null;
  }

  // 接続が切れたときのつなぎ直し：待ち時間（ms）は約1・2・4・8秒、その後は8秒ごと。約60秒つながらなければ諦める
  const RECONNECT = { delaysMs: [1000, 2000, 4000, 8000], giveUpMs: 60000, helloTimeoutMs: 4000 };

  class LocalSensorClient {
    // handlers: onFrame, onStatus, onDisconnect（諦めたときだけ）, onReconnecting(attempt), onReconnected(hello)
    // options: つなぎ直しの待ち時間などを変える（テスト用）。省略時は RECONNECT
    constructor(config, handlers, options) {
      this.config = config;
      this.handlers = handlers || {};
      this.options = { ...RECONNECT, ...(options || {}) };
      this.socket = null;
      this.closed = false;
      this.exerciseId = null;
      this.reconnectTimer = null;
    }

    // 最初の接続：hello で解決、時間切れ・切断で失敗（この段階ではつなぎ直さない）
    connect(timeoutMs = 4000) {
      return this.open(timeoutMs);
    }

    open(timeoutMs) {
      return new Promise((resolve, reject) => {
        const url = `ws://127.0.0.1:${this.config.port}/events?token=${encodeURIComponent(this.config.token)}`;
        let settled = false;
        let established = false; // hello が届いた接続だけ、切れたらつなぎ直す（時間切れで閉じた接続は対象外）
        const socket = new WebSocket(url);
        this.socket = socket;
        const timer = setTimeout(() => { if (!settled) { settled = true; socket.close(); reject(new Error("timeout")); } }, timeoutMs);
        socket.addEventListener("message", (event) => {
          let data;
          try { data = JSON.parse(event.data); } catch (error) { return; }
          if (data.type === "hello" && !settled) { settled = true; established = true; clearTimeout(timer); resolve(data); }
          if (this.closed || this.socket !== socket) return;
          if (data.type === "pose_frame") this.handlers.onFrame?.(data);
          if (data.type === "camera_status" || data.type === "hello") this.handlers.onStatus?.(data);
        });
        socket.addEventListener("close", () => {
          clearTimeout(timer);
          if (!settled) { settled = true; reject(new Error("closed")); return; }
          if (established && !this.closed && this.socket === socket) this.reconnect();
        });
        socket.addEventListener("error", () => {});
      });
    }

    // つながっていた接続が思いがけず切れた（端末サービスの再起動など）：待ってはつなぎ直し、最後の運動で camera.start を送り直す
    reconnect() {
      const { delaysMs, giveUpMs, helloTimeoutMs } = this.options;
      const startedAt = Date.now();
      let attempt = 0;
      const next = () => {
        if (this.closed) return;
        if (Date.now() - startedAt >= giveUpMs) {
          this.socket = null;
          this.handlers.onDisconnect?.();
          return;
        }
        const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
        attempt += 1;
        this.handlers.onReconnecting?.(attempt);
        this.reconnectTimer = setTimeout(async () => {
          this.reconnectTimer = null;
          if (this.closed) return;
          let hello;
          try {
            hello = await this.open(helloTimeoutMs);
          } catch (error) {
            next();
            return;
          }
          if (this.closed) return;
          if (this.exerciseId !== null) this.start(this.exerciseId);
          // 新しい hello を渡す（起動し直した端末サービスが、色つき映像を出すかどうかが変わっているかもしれない）
          this.handlers.onReconnected?.(hello);
        }, delay);
      };
      next();
    }

    start(exerciseId) {
      this.exerciseId = exerciseId;
      this.send({ type: "camera.start", exercise_id: exerciseId });
    }

    send(payload) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.send({ type: "camera.stop" });
      this.socket?.close();
    }
  }

  // 端末サービスの色つき映像の小さな絵（serve --color-preview のときだけ）。1通は頭12バイト（"MLP1"・フレーム番号 uint32・幅 uint16・
  // 高さ uint16、ビッグエンディアン）のあとに画像（JPEG か、模擬カメラの PNG）。形が違うものは null（捨てる）
  const PREVIEW_MAGIC = [0x4d, 0x4c, 0x50, 0x31];
  function readPreviewFrame(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 12) return null;
    const bytes = new Uint8Array(buffer);
    if (PREVIEW_MAGIC.some((value, index) => bytes[index] !== value)) return null;
    const view = new DataView(buffer);
    const image = bytes.subarray(12);
    const type = image[0] === 0xff && image[1] === 0xd8 ? "image/jpeg"
      : image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47 ? "image/png" : null;
    if (!type) return null;
    return { frameId: view.getUint32(4), width: view.getUint16(8), height: view.getUint16(10), type, image };
  }

  // 色つき映像を受け取るだけ（1回つないだら使い捨て。開き直すときは新しく作る）。絵は保存しない
  class PreviewClient {
    // handlers: onImage(blob, { frameId, width, height }), onClose()（端末サービスの側から閉じたときだけ）
    constructor(config, handlers) {
      this.config = config;
      this.handlers = handlers || {};
      this.socket = null;
      this.closed = false;
    }

    open() {
      const socket = new WebSocket(`ws://127.0.0.1:${this.config.port}/preview?token=${encodeURIComponent(this.config.token)}`);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        if (this.closed || this.socket !== socket) return;
        const frame = readPreviewFrame(event.data);
        if (frame) this.handlers.onImage?.(new Blob([frame.image], { type: frame.type }), { frameId: frame.frameId, width: frame.width, height: frame.height });
      });
      socket.addEventListener("close", () => {
        if (this.closed || this.socket !== socket) return;
        this.socket = null;
        this.handlers.onClose?.();
      });
      socket.addEventListener("error", () => {});
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.socket?.close();
      this.socket = null;
    }
  }

  root.MotionLinkLocalSensor = { readConfig, toLandmarks, medianDepth, normalizedFy, LocalSensorClient, RECONNECT, JOINT_INDEX, CONNECTIONS,
    readPreviewFrame, PreviewClient };
  if (typeof module === "object" && module.exports) module.exports = root.MotionLinkLocalSensor;
})(typeof globalThis !== "undefined" ? globalThis : this);
