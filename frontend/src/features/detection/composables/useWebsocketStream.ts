import { ref, Ref } from "vue";
import { useWebSocket, WebSocketOptions } from "@/composables/useWebsocket";
import { useDetectionStore } from "@/features/detection";
import { useStore as useFPSStore } from "@/features/settings/stores/fps";

export interface WebsocketStreamParams extends WebSocketOptions {
  canvasRef: Ref<HTMLImageElement | null>;
}

const extractFrameWithMetadata = (data: ArrayBuffer) => {
  // Extract first 8 bytes for the timestamp (Double-precision float, 8 bytes)
  const dataView = new DataView(data);
  const timestamp = dataView.getFloat64(0, true);

  // Extract the next 8 bytes for the FPS (Double-precision float)
  const fps = dataView.getFloat64(8, true);

  // The rest of the data is the frame (starting from the 16th byte)
  const blob = new Blob([data.slice(16)], { type: "image/jpeg" });


  return { timestamp, serverFps: fps, blob };
};

export const useWebsocketStream = (params: WebsocketStreamParams) => {
  const detectionStore = useDetectionStore();
  const fpsStore = useFPSStore();
  const imgInitted = ref(false);
  const imgLoading = ref(true);
  const currentImageBlobUrl = ref<string>();

  let lastPerf: number = 0;
  let lastFPS: number = 0;

  let pending: ArrayBuffer | null = null;
  let pumping = false;

  const updateClientFPS = () => {
    const perf = performance.now();

    if (perf - lastPerf >= 1000) {
      const fps = lastFPS;
      lastPerf = perf;
      lastFPS = 0;
      fpsStore.updateFPS(fps);
    } else {
      lastFPS += 1;
    }
  };

  const handleImageOnLoad = () => {
    if (imgLoading.value) {
      imgLoading.value = false;
    }
    if (!imgInitted.value) {
      imgInitted.value = true;
    }
  };
  
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pending) {
        const buf = pending;
        pending = null;

        updateClientFPS();

        // preserve existing "pass-through" behavior
        if (params.onMessage) {
          params.onMessage(buf);
        }

        const urlCreator = window.URL || window.webkitURL;

        // free previous blob URL
        if (currentImageBlobUrl.value) {
          urlCreator.revokeObjectURL(currentImageBlobUrl.value);
          currentImageBlobUrl.value = undefined;
        }

        const { timestamp, serverFps, blob } = extractFrameWithMetadata(buf);
        const imageUrl = urlCreator.createObjectURL(blob);

        detectionStore.setCurrentFrameTimestamp(timestamp);
        fpsStore.updateServerFPS(serverFps);

        if (params.canvasRef.value) {
          params.canvasRef.value.onload = handleImageOnLoad;
          params.canvasRef.value.src = imageUrl;
          currentImageBlobUrl.value = imageUrl;

          if (imgInitted.value && imgLoading.value) {
            imgLoading.value = false;
          }
        } else {
          // no img element mounted yet; don't leak
          urlCreator.revokeObjectURL(imageUrl);
        }
      }
    } finally {
      pumping = false;
    }
  };

  const handleOnMessage = (data: MessageEvent["data"]) => {
    // WebSocket binaryType is "arraybuffer", but keep a safe cast.
    pending = data as ArrayBuffer;
    void pump();
  };


  
  const handleOnClose = () => {
    if (params.onClose) {
      params.onClose();
    }
    const urlCreator = window.URL || window.webkitURL;
    if (currentImageBlobUrl.value) {
      urlCreator.revokeObjectURL(currentImageBlobUrl.value);
      currentImageBlobUrl.value = undefined;
    }
    imgLoading.value = true;
    fpsStore.updateFPS(null);
    lastPerf = 0;
    lastFPS = 0;
  };

  const {
    ws,
    initWS,
    send,
    closeWS,
    cleanup,
    retry,
    connected,
    active,
    loading,
    reconnectEnabled,
  } = useWebSocket({
    ...params,
    binaryType: "arraybuffer",
    onMessage: handleOnMessage,
    onClose: handleOnClose,
  });

  return {
    ws,
    initWS,
    send,
    closeWS,
    cleanup,
    retry,
    connected,
    active,
    loading,
    reconnectEnabled,
    handleImageOnLoad,
    imgInitted,
    imgLoading,
  };
};
