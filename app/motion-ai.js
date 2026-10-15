import { FilesetResolver, PoseLandmarker } from "./assets/mediapipe/vision_bundle.mjs";

export const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31],
  [24, 26], [26, 28], [28, 30], [30, 32]
];

async function makeLandmarker(vision, delegate, modelFile) {
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: new URL(`./assets/mediapipe/${modelFile}`, import.meta.url).href,
      delegate
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: .58,
    minPosePresenceConfidence: .58,
    minTrackingConfidence: .62,
    outputSegmentationMasks: false
  });
}

export async function createPoseEngine() {
  const wasmRoot = new URL("./assets/mediapipe/wasm", import.meta.url).href;
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  let landmarker;
  let delegate = "GPU";
  let model = "Heavy";

  try {
    landmarker = await makeLandmarker(vision, delegate, "pose_landmarker_heavy.task");
  } catch (error) {
    model = "Full";
    try {
      landmarker = await makeLandmarker(vision, delegate, "pose_landmarker_full.task");
    } catch (gpuError) {
      delegate = "CPU";
      landmarker = await makeLandmarker(vision, delegate, "pose_landmarker_full.task");
    }
  }

  return {
    delegate,
    model,
    detect(video, timestamp) {
      const result = landmarker.detectForVideo(video, timestamp);
      return {
        landmarks: result?.landmarks?.[0] || null,
        worldLandmarks: result?.worldLandmarks?.[0] || null
      };
    },
    close() {
      landmarker.close();
    }
  };
}
