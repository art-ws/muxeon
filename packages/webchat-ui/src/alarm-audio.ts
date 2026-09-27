// The browser half of an alarm's loudness (§22.6.4/§22.6.5): the synthesized
// sound, the one-voice-per-browser rule and the OS notification. Everything here
// talks to a browser API with a policy attached, and the policies are written down
// where they bite:
//
//   - AUTOPLAY: a page may not make a sound before the person has touched it. The
//     AudioContext is created (or resumed) on the first pointer/key event of the
//     tab; until then `audioUnlocked()` is false and the modal says so.
//   - ONE VOICE: every open panel tab gets the same push. The tab holding the Web
//     Lock `muxeon-alarm-audio` speaks (sound + OS notification); the others stay
//     silent — three tabs must not make a three-part choir. Web Locks exist only in
//     a secure context; without them every tab speaks: a choir beats silence.
//   - NOTIFICATIONS need a permission asked from a gesture, and a secure context
//     (HTTPS or loopback) — without one they are simply "unavailable".

import type { AlarmSound } from "./alarm-look";

let context: AudioContext | undefined;
const unlockListeners = new Set<() => void>();

/** Has this tab been touched, so it may make a sound? */
export const audioUnlocked = (): boolean => context?.state === "running";

/** Called once the tab becomes able to sound; returns the unsubscribe. */
export function onAudioUnlock(listener: () => void): () => void {
  unlockListeners.add(listener);
  return () => unlockListeners.delete(listener);
}

/**
 * Arm the unlock: the first pointer or key event of the tab creates/resumes the
 * AudioContext (a login without a reload counts; a reload starts over). Returns
 * the disarm for the panel's unmount.
 */
export function installAudioUnlock(): () => void {
  const unlock = (): void => {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtor === undefined) return;
    context ??= new AudioCtor();
    void context.resume().then(() => {
      if (context?.state !== "running") return;
      for (const event of ["pointerdown", "keydown"] as const) {
        document.removeEventListener(event, unlock, true);
      }
      for (const listener of unlockListeners) listener();
    });
  };
  for (const event of ["pointerdown", "keydown"] as const) {
    document.addEventListener(event, unlock, true);
  }
  return () => {
    for (const event of ["pointerdown", "keydown"] as const) {
      document.removeEventListener(event, unlock, true);
    }
  };
}

/**
 * Play one alarm signal: `pulses` short tones at `freq`, `gain` of full volume, a
 * soft envelope so it is a chime and not a click. No audio files — the tone is
 * derived from K, so it is as continuous as the color. False when the tab may not
 * sound yet.
 */
export function playAlarmSound(sound: AlarmSound): boolean {
  if (context === undefined || context.state !== "running") return false;
  const beep = 0.18;
  const gap = 0.12;
  const start = context.currentTime + 0.02;
  for (let i = 0; i < sound.pulses; i++) {
    const at = start + i * (beep + gap);
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = sound.wave;
    oscillator.frequency.value = sound.freq;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(sound.gain, at + 0.02);
    envelope.gain.linearRampToValueAtTime(0, at + beep);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + beep + 0.02);
  }
  return true;
}

let voice = false;
let voiceClaimed = false;

/** Does THIS tab speak for the browser (§22.6.4)? */
export const hasVoice = (): boolean => voice;

/**
 * Ask for the voice. The lock is held for the life of the tab (a promise that
 * never settles); when the holder closes, the browser hands it to the next tab
 * in line. Idempotent.
 */
export function claimVoice(): void {
  if (voiceClaimed) return;
  voiceClaimed = true;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks === undefined) {
    voice = true; // no Web Locks (not a secure context) — a choir beats silence
    return;
  }
  void locks.request("muxeon-alarm-audio", () => {
    voice = true;
    return new Promise<never>(() => undefined);
  });
}

export type NotificationPermissionState = "granted" | "denied" | "default" | "unavailable";

/** What the browser allows right now — shown as is in Settings (§22.7). */
export function notificationState(): NotificationPermissionState {
  if (typeof Notification === "undefined" || !window.isSecureContext) return "unavailable";
  return Notification.permission;
}

/** Ask for the permission — call it from a click, or the browser ignores it. */
export async function requestNotifications(): Promise<NotificationPermissionState> {
  if (notificationState() === "unavailable") return "unavailable";
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationState();
  }
}

/**
 * Show (or replace) the OS notification of one agent's alarm (§22.6.5). The tag is
 * per agent, so a newer alarm REPLACES the older one in the notification center —
 * one pain per agent there too.
 */
export function showAlarmNotification(options: {
  readonly agent: string;
  readonly title: string;
  readonly body: string;
  readonly renotify: boolean;
  readonly requireInteraction: boolean;
  readonly silent: boolean;
  readonly onClick: () => void;
}): Notification | undefined {
  if (notificationState() !== "granted") return undefined;
  try {
    const notification = new Notification(options.title, {
      body: options.body,
      tag: `muxeon-alarm:${options.agent}`,
      requireInteraction: options.requireInteraction,
      silent: options.silent,
      renotify: options.renotify,
    } as NotificationOptions & { renotify: boolean });
    notification.onclick = () => {
      window.focus();
      notification.close();
      options.onClick();
    };
    return notification;
  } catch {
    return undefined; // e.g. a platform that allows notifications only from a service worker
  }
}
