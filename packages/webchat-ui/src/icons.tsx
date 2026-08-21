// The shared icon set (T112): every icon in buttons, menus and the sidebar
// speaks ONE stroke language — the composer's (T102): 24-grid stroke SVGs,
// strokeWidth 2, round caps, currentColor (so themes and hover states tint
// them for free). No emoji glyphs — they disagree in weight and render
// differently across platforms.

function Icon(props: { size?: number; children: React.ReactNode }): React.JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

type IconProps = { size?: number };

/** The transport entry (FR-48) — radio waves around a dot. */
export const IconRadio = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="2" />
    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
    <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </Icon>
);

/** The operator account (FR-68) — a person silhouette. */
export const IconUser = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Icon>
);

/** The settings menu item and page (FR-76) — a gear. */
export const IconGear = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

/** Sign out / shutdown (FR-65, FR-68) — the power symbol. */
export const IconPower = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </Icon>
);

/** Pause the agent's communications (§16.6, FR-120) — the two bars. */
export const IconPause = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M10 4v16" />
    <path d="M16 4v16" />
  </Icon>
);

/** Resume a paused agent (§16.6, FR-120) — the play triangle. */
export const IconPlay = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M7 4l13 8-13 8z" />
  </Icon>
);

/** Reload the agent (FR-65) — a clockwise rotation arrow. */
export const IconRotate = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

/** Copy to clipboard (FR-61) — two stacked sheets. */
export const IconCopy = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Icon>
);

/** The markdown-source toggle (FR-61) — code chevrons. */
export const IconCode = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </Icon>
);

/** The per-message deep link (FR-75) — a chain. */
export const IconLink = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" />
  </Icon>
);

export const IconCheck = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const IconX = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

/** Queued/pending lifecycle tick (§12.4) — a clock face. */
export const IconClock = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </Icon>
);

/** In-flight lifecycle tick (§12.4) — a paper plane. */
export const IconSend = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M14.54 9.46 4.91 19.09" />
    <path d="M21.16 2.84 15.7 21.04a.55.55 0 0 1-1.04.05L11.5 12.5l-8.59-3.16a.55.55 0 0 1 .05-1.04z" />
  </Icon>
);

/** The download card for non-media attachments (§12.5) — a document. */
export const IconFile = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </Icon>
);

/** The chat-header actions menu trigger (T113) — three vertical dots. */
export const IconKebab = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="19" r="1" />
  </Icon>
);

/** Chat export (FR-84) — a download arrow into a tray. */
export const IconDownload = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <path d="M12 15V3" />
  </Icon>
);

/** Chat clearing (FR-84) — a trash bin. */
export const IconTrash = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);

/** Attach files (FR-70) — a paperclip. */
export const IconPaperclip = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </Icon>
);

/** The camera capture (FR-70) — a camera body with a lens. */
export const IconCamera = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </Icon>
);

/** Grow the composer full-screen (FR-70, T222) — arrows to the corners. */
export const IconExpand = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </Icon>
);

/** Shrink the grown composer back (T222) — the same arrows pointing inward. */
export const IconCollapse = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <polyline points="20 10 14 10 14 4" />
    <polyline points="4 14 10 14 10 20" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="10" y1="14" x2="3" y2="21" />
  </Icon>
);

/** Live console watch (FR-102) — a monitor screen on a stand. */
export const IconMonitor = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </Icon>
);

/** A broadcast group (§15, FR-106) — a folder holding its members. */
export const IconGroup = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </Icon>
);

/** A broadcast tag (§15, FR-107) — a label with its hole. */
export const IconTag = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.83 8.83a2 2 0 0 0 2.82 0l7.17-7.17a2 2 0 0 0 0-2.82z" />
    <circle cx="7" cy="7" r="1.2" />
  </Icon>
);

/** A tree/section disclosure caret (§15) — points right when collapsed, the
 *  caller rotates it down when the row is expanded (a CSS transform). */
export const IconChevron = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <polyline points="9 18 15 12 9 6" />
  </Icon>
);

/** Reply to a message (§12.7, FR-178) — an arrow curving back to the left. */
export const IconReply = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <polyline points="9 17 4 12 9 7" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </Icon>
);

/** The sidebar's agent filter (§12.7, FR-177) — a funnel; the toolbar toggle. */
export const IconFilter = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M3 4h18l-7 8.5V20l-4-2.5v-5z" />
  </Icon>
);

/** Add a reaction (§19.9, FR-168) — a smiley with a plus, the picker trigger. */
export const IconReaction = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <path d="M20.94 13A9 9 0 1 1 11 3.06" />
    <path d="M8.5 14.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5" />
    <circle cx="9" cy="10" r="0.8" />
    <circle cx="15" cy="10" r="0.8" />
    <line x1="19" y1="2" x2="19" y2="8" />
    <line x1="16" y1="5" x2="22" y2="5" />
  </Icon>
);

/** The prompt rack (§20.6, FR-187) — books standing on a shelf. */
export const IconShelf = (props: IconProps): React.JSX.Element => (
  <Icon {...props}>
    <rect x="4" y="4" width="4" height="13" rx="1" />
    <rect x="10" y="7" width="4" height="10" rx="1" />
    <path d="M17.5 7.2l3 .8-2.4 9-3-.8z" />
    <line x1="3" y1="20" x2="21" y2="20" />
  </Icon>
);
