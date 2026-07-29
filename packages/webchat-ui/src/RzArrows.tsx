// Rendezvous markers (§8.2, FR-105): small red arrows shown before an agent's name,
// after its status dot — in the sidebar row and the chat header alike. ↑ when the
// agent is WAITING to reach a peer ("я жду"); ↓ when a peer is WAITING for it ("меня
// ждут"). Zero, one, or both. Purely derived from the peer's FR-105 flags.

import { useT } from "./i18n-context";
import type { PeerInfo } from "./types";

export function RzArrows(props: {
  peer: Pick<PeerInfo, "waiting" | "awaited">;
}): React.JSX.Element | null {
  const t = useT();
  const waiting = props.peer.waiting === true;
  const awaited = props.peer.awaited === true;
  if (!waiting && !awaited) return null;
  return (
    <span className="rz-arrows">
      {waiting && (
        <span className="rz-arrow up" title={t("waiting to reach a peer")}>
          ↑
        </span>
      )}
      {awaited && (
        <span className="rz-arrow down" title={t("a peer is waiting to reach it")}>
          ↓
        </span>
      )}
    </span>
  );
}
