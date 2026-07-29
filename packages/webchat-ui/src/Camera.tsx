// Camera capture (T50, §12.5): a live preview dialog — snap a photo
// (canvas → image/jpeg) or record a clip (MediaRecorder → video/webm). The
// result is an ordinary File handed back to the composer's upload path.

import { useEffect, useRef, useState } from "react";
import { CLIP_MIME_CANDIDATES, captureName, pickRecorderMime } from "./draft";

export function CameraDialog(props: {
  onCaptured: (file: File) => void;
  onClose: () => void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video !== null) {
          video.srcObject = stream;
          void video.play();
        }
        setReady(true);
      })
      .catch(() => setError("camera unavailable or permission denied"));
    return () => {
      cancelled = true;
      recorderRef.current?.stop();
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    };
  }, []);

  const snapPhoto = (): void => {
    const video = videoRef.current;
    if (video === null) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob === null) return;
        props.onCaptured(
          new File([blob], captureName("photo", Date.now(), "image/jpeg"), {
            type: "image/jpeg",
          }),
        );
      },
      "image/jpeg",
      0.9,
    );
  };

  const toggleClip = (): void => {
    if (recording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      return;
    }
    const stream = streamRef.current;
    if (stream === null || typeof MediaRecorder === "undefined") return;
    const mime = pickRecorderMime(CLIP_MIME_CANDIDATES, (candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    );
    const recorder = new MediaRecorder(stream, mime !== undefined ? { mimeType: mime } : {});
    const parts: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => parts.push(event.data));
    recorder.addEventListener("stop", () => {
      const type = recorder.mimeType || "video/webm";
      props.onCaptured(new File(parts, captureName("clip", Date.now(), type), { type }));
    });
    recorder.start();
    recorderRef.current = recorder;
    setRecording(true);
  };

  return (
    <div className="camera-overlay">
      <dialog open className="camera-dialog" aria-label="Camera">
        {error !== undefined ? (
          <p className="error">{error}</p>
        ) : (
          <video ref={videoRef} muted playsInline className="camera-preview" />
        )}
        <div className="camera-controls">
          <button type="button" disabled={!ready || recording} onClick={snapPhoto}>
            📸 Photo
          </button>
          <button type="button" disabled={!ready} onClick={toggleClip}>
            {recording ? "⏹ Stop" : "🎬 Record"}
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  );
}
