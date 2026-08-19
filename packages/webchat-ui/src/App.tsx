// The panel (§12.7): login → [peer list | chat]. State lives in store.ts (pure,
// tested); this layer is wiring and DOM. Agent text renders as TEXT ONLY —
// React's default escaping is the §12.6 XSS stance, no HTML/markdown injection.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AccountMenu } from "./AccountMenu";
import { ChatView } from "./Chat";
import { CommandFanout } from "./CommandFanout";
import { Composer, type Draft } from "./Composer";
import { PeerList } from "./PeerList";
import { SettingsView } from "./Settings";
import { Toolbar } from "./Toolbar";
import { TransportView } from "./Transport";
import * as api from "./api";
import {
  DEFAULT_LANG,
  type Lang,
  type Messages,
  loadLang,
  parseMessages,
  saveLang,
  translator,
} from "./i18n";
import { I18nContext, useT } from "./i18n-context";
import { authMode, instanceName } from "./instance";
import { agentColor } from "./palette";
import { chatSurface, hasConsole } from "./peer-surface";
import { loadPref, savePref } from "./prefs";
import { quotePreview } from "./quote";
import { type ReactionsApi, ReactionsContext } from "./reactions-context";
import { type Route, parseRoute, routeHash } from "./route";
import type { ServerInfo } from "./server-info";
import { SESSION_CHECK_MS, renewDueAt } from "./session";
import {
  type PanelState,
  applyEvent,
  applyHistoryPage,
  applyOutgoing,
  applyPeers,
  applyReactions,
  initialState,
  reactionsOf,
  selectPeer,
  threadOf,
} from "./store";
import { type Theme, applyTheme, loadTheme } from "./theme";
import { type ToolId, loadToolbar, sameToolSurface, saveToolbar } from "./tools";
import {
  type ChatRecord,
  type PanelEvent,
  type PeerInfo,
  type ReactionView,
  peerKind,
} from "./types";
import { loadVisibility, saveVisibility, visiblePeers } from "./visibility";

type Action =
  | { kind: "peers"; peers: Parameters<typeof applyPeers>[1] }
  | { kind: "select"; peer: string | undefined }
  | { kind: "page"; peer: string; page: Parameters<typeof applyHistoryPage>[2] }
  | { kind: "outgoing"; record: ChatRecord }
  | { kind: "reactions"; messageId: string; reactions: readonly ReactionView[] }
  | { kind: "event"; event: PanelEvent };

// The panel is one operator (§12.1): anything that is not a listed peer is "us".
// In users mode (§17.7) that heuristic is not enough — the viewer's own name is
// a peer row too (the self-chat) — so `self()` names us outright when known; it
// is read late (a ref, not a value) because the identity arrives with the first
// api/peers, after the reducer is built.
const makeReducer =
  (isPeer: (name: string) => boolean, self: () => string | undefined) =>
  (state: PanelState, action: Action): PanelState => {
    switch (action.kind) {
      case "peers":
        return applyPeers(state, action.peers);
      case "select":
        return selectPeer(state, action.peer);
      case "page":
        return applyHistoryPage(state, action.peer, action.page);
      case "outgoing":
        return applyOutgoing(state, action.record, self());
      case "reactions":
        return applyReactions(state, action.messageId, action.reactions);
      case "event":
        return applyEvent(state, action.event, (name) => !isPeer(name), { self: self() });
      default:
        return state;
    }
  };

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean | undefined>(undefined);
  // Who is signed in (FR-68, §17.7) — the topbar account button (T234). The
  // panel learns the name from api/peers and reports it up; logging out clears
  // it so the next session cannot inherit the previous name.
  const [operator, setOperator] = useState<string | undefined>(undefined);
  // Their configured label (FR-156), when there is one — the account tooltip
  // reads "<title> (<name>)" so the label never hides who is actually signed in.
  const [operatorTitle, setOperatorTitle] = useState<string | undefined>(undefined);
  // The open 1:1 chat's peer (§12.10.5), reported up by the panel: the topbar
  // toolbar acts on it, and the header is drawn OUTSIDE the panel — the same
  // lift the account circle already uses for the logged-in name (T234). No extra
  // request: the data is the panel's `/api/peers` + WS statuses.
  const [surface, setSurface] = useState<PeerInfo | undefined>(undefined);
  // …but only when the BUTTONS would change (T280): the panel reports the peer on
  // every store update, and a header that re-rendered on each of them made the
  // console blink — React bails out when the state object stays the same.
  const onSurface = useCallback((peer: PeerInfo | undefined): void => {
    setSurface((current) => (sameToolSurface(current, peer) ? current : peer));
  }, []);
  // Logout (FR-68): revoke server-side, then drop to the login screen; a failed
  // call (expired session) still lands on login — that IS the logged-out state.
  const logout = useCallback((): void => {
    void api
      .logout()
      .catch(() => undefined)
      .then(() => {
        setOperator(undefined);
        setOperatorTitle(undefined);
        // the toolbar's chat half hangs off the open chat — the next session
        // must not inherit a peer from the previous one (§12.10.5)
        setSurface(undefined);
        setAuthed(false);
      });
  }, []);
  // Theme (§12.7, FR-59): light by default, persisted choice wins; the switch
  // lives on the settings page (T110) and flips <html data-theme>.
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  useEffect(() => applyTheme(theme), [theme]);
  // Auto-scroll (FR-62): a GLOBAL follow switch — ON keeps every feed (chats,
  // transport) pinned to the newest message; OFF (the default) keeps the
  // stick-when-near-bottom behavior. Persisted across reloads (FR-72).
  const [follow, setFollow] = useState(() => loadPref("follow", false));
  useEffect(() => savePref("follow", follow), [follow]);
  // Sidebar (FR-68): the logo is the collapse toggle — collapsed shows the icon
  // rail, expanded the text rows; expanded by default, persisted (FR-72).
  const [collapsed, setCollapsed] = useState(() => loadPref("collapsed", false));
  useEffect(() => savePref("collapsed", collapsed), [collapsed]);
  // Sidebar layout (§15): ON shows the classic FLAT agent list (no groups/tags);
  // OFF (the default) shows the group tree + Tags section. Persisted (FR-72).
  const [flatPeers, setFlatPeers] = useState(() => loadPref("flat-peers", false));
  useEffect(() => savePref("flat-peers", flatPeers), [flatPeers]);
  // Token-usage display: ON by default; OFF hides the chat-header token meter for a
  // lighter interface. Persisted (FR-72).
  const [showTokens, setShowTokens] = useState(() => loadPref("show-tokens", true));
  useEffect(() => savePref("show-tokens", showTokens), [showTokens]);
  // The two sidebar view toggles (FR-176/FR-177, T115). They live HERE, above the
  // panel, because two places flip each — the Settings switch inside the panel and
  // the topbar button outside it — and both must flip ONE state.
  // The agent-filter panel is OFF by default (operator, T291): a fresh browser gets
  // the sidebar it always had, and the panel arrives when asked for.
  const [agentFilter, setAgentFilter] = useState(() => loadPref("agent-filter", false));
  useEffect(() => savePref("agent-filter", agentFilter), [agentFilter]);
  // The sidebar Transport entry (T115): shown by default, hideable; the direct
  // #/transport URL keeps working either way.
  const [showTransport, setShowTransport] = useState(() => loadPref("transport", true));
  useEffect(() => savePref("transport", showTransport), [showTransport]);
  // The viewer's role (FR-131), reported up with their identity: the journal is an
  // admin capability, so its shortcut is not offered to a plain user (T291).
  const [role, setRole] = useState<"admin" | "user" | undefined>(undefined);
  // The pinned toolbar tools (§12.10, FR-174): empty by default, the Settings
  // switches own the set, localStorage keeps it per browser.
  const [tools, setTools] = useState<ReadonlySet<ToolId>>(() => loadToolbar());
  useEffect(() => saveToolbar(tools), [tools]);
  // Instance label (FR-90): the connector injected it into the shell; static post-load.
  const [brandName] = useState(instanceName);
  // Global message filter (T97, FR-71): one topbar field filters EVERY list —
  // chats and the transport feed; the views count what it hides.
  const [query, setQuery] = useState("");
  // UI language (T114, FR-78): English is the source and the default; a
  // non-English choice lazily fetches its OPTIONAL dictionary — a missing or
  // broken file just leaves the interface in English.
  const [lang, setLang] = useState<Lang>(() => loadLang());
  useEffect(() => saveLang(lang), [lang]);
  const [messages, setMessages] = useState<Messages | undefined>(undefined);
  useEffect(() => {
    if (lang === DEFAULT_LANG) {
      setMessages(undefined);
      return;
    }
    let stale = false; // a quick double-switch must not apply the older fetch
    void fetch(`assets/i18n/${lang}.json`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((raw: unknown) => {
        if (!stale) setMessages(raw === undefined ? undefined : parseMessages(raw));
      })
      .catch(() => {
        if (!stale) setMessages(undefined);
      });
    return () => {
      stale = true;
    };
  }, [lang]);
  // The translator is CONTEXT (T280): a fresh closure per render would republish
  // the context on every App re-render, and consumers that key effects off `t`
  // (the console's attach, §12.9) would tear themselves down and rebuild — the
  // dictionary is what it depends on, so that is its only dependency.
  const t = useMemo(() => translator(messages), [messages]);
  return (
    <I18nContext.Provider value={t}>
      <div className="app">
        <header className="topbar">
          {/* the designer's logo as-is (T88); the click collapses/expands the sidebar (FR-68).
              The configuration label (FR-90) sits next to it when set. */}
          <div className="topbar-brand">
            <button
              type="button"
              className="brand-button"
              title={collapsed ? t("Expand the sidebar") : t("Collapse the sidebar")}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              <img className="brand-logo" src="assets/logo.png" alt="TEAM AI" />
            </button>
            {brandName !== "" && (
              <span className="brand-name" title={brandName}>
                {brandName}
              </span>
            )}
          </div>
          {/* the pinned tools (§12.10) — right-hand block, tools → filter → account */}
          {authed === true && (
            <Toolbar
              enabled={tools}
              peer={surface}
              agentFilter={agentFilter}
              onAgentFilter={setAgentFilter}
              transport={showTransport}
              onTransport={setShowTransport}
              {...(role !== undefined ? { viewerRole: role } : {})}
              onSettings={() => {
                location.hash = routeHash({ view: "settings" });
              }}
              onLogout={logout}
            />
          )}
          {authed === true && (
            <span className="topbar-search">
              <input
                type="search"
                placeholder={t("Filter messages…")}
                aria-label={t("Filter messages in chats and transport")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query !== "" && (
                <button
                  type="button"
                  className="search-clear"
                  aria-label={t("Clear the message filter")}
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              )}
            </span>
          )}
          {/* the account circle (T234) — the topbar's right corner, no name */}
          {authed === true && (
            <AccountMenu
              operator={operator}
              title={operatorTitle}
              onLogout={logout}
              onSettings={() => {
                location.hash = routeHash({ view: "settings" });
              }}
            />
          )}
        </header>
        {authed === true ? (
          <Panel
            follow={follow}
            onFollow={setFollow}
            theme={theme}
            onTheme={setTheme}
            lang={lang}
            onLang={setLang}
            flat={flatPeers}
            onFlat={setFlatPeers}
            agentFilter={agentFilter}
            onAgentFilter={setAgentFilter}
            transport={showTransport}
            onTransport={setShowTransport}
            viewerRole={role}
            showTokens={showTokens}
            onShowTokens={setShowTokens}
            tools={tools}
            onTools={setTools}
            collapsed={collapsed}
            query={query}
            onIdentity={(name, title, myRole) => {
              setOperator(name);
              setOperatorTitle(title);
              setRole(myRole);
            }}
            onSurface={onSurface}
            onAuthLost={() => setAuthed(false)}
          />
        ) : (
          <Login
            checking={authed === undefined}
            onProbe={(ok) => setAuthed(ok)}
            onLoggedIn={() => setAuthed(true)}
          />
        )}
      </div>
    </I18nContext.Provider>
  );
}

function Login(props: {
  checking: boolean;
  onProbe: (authed: boolean) => void;
  onLoggedIn: () => void;
}): React.JSX.Element {
  const t = useT();
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Users mode (§17.2): the served shell says so, so the form asks WHO is
  // signing in; a legacy single-operator panel keeps the password-only card.
  const usersMode = authMode() === "users";

  useEffect(() => {
    if (!props.checking) return;
    void fetch("api/peers").then((response) => props.onProbe(response.ok));
  }, [props.checking, props.onProbe]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(password, usersMode ? user : undefined);
      props.onLoggedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "login failed");
    } finally {
      setBusy(false);
    }
  };

  if (props.checking) return <div className="login-screen">…</div>;
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <img className="login-logo" src="assets/logo.png" alt="TEAM AI" />
        {usersMode && (
          <input
            type="text"
            autoComplete="username"
            placeholder={t("User")}
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        )}
        <input
          type="password"
          autoComplete="current-password"
          placeholder={t(usersMode ? "Password" : "Operator password")}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="submit"
          disabled={busy || password.length === 0 || (usersMode && user.length === 0)}
        >
          {t("Sign in")}
        </button>
        {error !== undefined && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

/** Live transport rows kept in memory (FR-48); older ones page from the log. */
const TRANSPORT_LIVE_CAP = 500;

function Panel(props: {
  follow: boolean;
  onFollow: (follow: boolean) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  lang: Lang;
  onLang: (lang: Lang) => void;
  /** Sidebar layout (§15): true = flat agent list, false = group tree + Tags. */
  flat: boolean;
  onFlat: (flat: boolean) => void;
  /** The sidebar's agent-filter panel (FR-176) — the Settings switch and the topbar button. */
  agentFilter: boolean;
  onAgentFilter: (show: boolean) => void;
  /** The sidebar Transport entry (T115) — same pair of switches (FR-177). */
  transport: boolean;
  onTransport: (show: boolean) => void;
  /** The viewer's role (FR-131) — owned by App, which the toolbar reads too. */
  viewerRole: "admin" | "user" | undefined;
  /** Token-usage display: true (default) shows the chat-header token meter, false hides it. */
  showTokens: boolean;
  onShowTokens: (show: boolean) => void;
  /** Pinned toolbar tools (§12.10, FR-173) — the settings page switches them. */
  tools: ReadonlySet<ToolId>;
  onTools: (tools: ReadonlySet<ToolId>) => void;
  collapsed: boolean;
  /** Global message filter (FR-71) — applied by the chat and transport views. */
  query: string;
  /**
   * Reports the logged-in name — its configured label (FR-156) and its role
   * (FR-131) — upward (T234/T291): the topbar account button and the toolbar
   * live outside this panel, and the journal shortcut needs the role.
   */
  onIdentity: (
    operator: string | undefined,
    title?: string | undefined,
    role?: "admin" | "user" | undefined,
  ) => void;
  /**
   * Reports the OPEN 1:1 chat's peer upward (§12.10.5) — the topbar toolbar acts
   * on it and the header lives outside this panel. Undefined whenever there is no
   * such chat (home, settings, transport, a broadcast target).
   */
  onSurface: (peer: PeerInfo | undefined) => void;
  onAuthLost: () => void;
}): React.JSX.Element {
  const t = useT();
  const peerSet = useRef(new Set<string>());
  // The logged-in user (§17.7, FR-127): the self-chat's name, the "mine" side of
  // every bubble and the mirror target of the reducer. A legacy panel (§17.9)
  // leaves it undefined and keeps the pre-§17 behavior.
  const selfName = useRef<string | undefined>(undefined);
  const [self, setSelf] = useState<string | undefined>(undefined);
  const reducer = useRef(
    makeReducer(
      (name) => peerSet.current.has(name),
      () => selfName.current,
    ),
  ).current;
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The transport view (FR-48): live rows from the WS push; the page fetch
  // inside TransportView covers history and reconnect catch-up.
  const [transportLive, setTransportLive] = useState<readonly ChatRecord[]>([]);
  // Routing (FR-60): the hash is the source of truth for the open view — deep
  // links and back/forward come for free; navigation just writes the hash.
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The operator's role (FR-131) — in users mode the logged-in user's (§17.7);
  // their own row (self-chat, FR-128) arrives inside `peers` like any other. It
  // is OWNED by App (T291): the topbar toolbar reads it too, and one fetch must
  // not become two readings of who is signed in.
  const role = props.viewerRole;

  // Agent visibility (T110, FR-76): the settings checklist decides which agents
  // the sidebar shows — "all" (default) or only the picked set; persisted.
  const [visibility, setVisibility] = useState(() => loadVisibility());
  useEffect(() => saveVisibility(visibility), [visibility]);

  // Server build info (FR-91) for the Settings footer — static, fetched once.
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>(undefined);
  useEffect(() => {
    void api
      .fetchServerInfo()
      .then(setServerInfo)
      .catch(() => undefined);
  }, []);

  // Session auto-renewal (T125, FR-86): learn when the token dies, slide it
  // forward at the half-life of the window — an open panel never logs itself
  // out, a closed one expires on the server's schedule. A 401 on renew means
  // the session is already gone — the regular auth-lost path takes over.
  useEffect(() => {
    let dueAt = Number.POSITIVE_INFINITY;
    const learn = (expiresAt: number | undefined): void => {
      if (typeof expiresAt === "number") dueAt = renewDueAt(Date.now(), expiresAt);
    };
    void api
      .sessionInfo()
      .then((info) => learn(info.expiresAt))
      .catch(() => undefined); // a hiccup — the next 401 lands on login anyway
    const tick = (): void => {
      if (Date.now() < dueAt) return;
      dueAt = Number.POSITIVE_INFINITY; // one renewal in flight at a time
      api
        .renewSession()
        .then((renewed) => learn(renewed.expiresAt))
        .catch((failure) => {
          if (failure instanceof api.ApiError && failure.status === 401) props.onAuthLost();
        });
    };
    const timer = setInterval(tick, SESSION_CHECK_MS);
    window.addEventListener("focus", tick); // a woken laptop renews immediately
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [props.onAuthLost]);

  // initial peers + the live feed
  const onIdentity = props.onIdentity;
  useEffect(() => {
    void api.fetchPeers().then(({ peers, operator: me, user, role: myRole }) => {
      for (const peer of peers) peerSet.current.add(peer.name);
      // In users mode the operator's OWN row rides in `peers` (FR-128) — that is
      // where their configured title comes from; a legacy panel has no user, so
      // no title (FR-156).
      onIdentity(me ?? "operator", peers.find((peer) => peer.name === user)?.title, myRole);
      // `user` exists only in users mode (§17.2) — that is exactly when there is
      // a self-chat to mirror into; a legacy panel leaves it undefined.
      selfName.current = user;
      setSelf(user);
      dispatch({ kind: "peers", peers });
    });
    return api.connectFeed({
      onEvent: (event) => {
        if (event.type === "transport") {
          setTransportLive((live) => [...live.slice(-(TRANSPORT_LIVE_CAP - 1)), event.record]);
          return;
        }
        dispatch({ kind: "event", event });
      },
      onAuthLost: props.onAuthLost,
    });
  }, [props.onAuthLost, onIdentity]);

  // The route drives the store: an open chat selects the peer (badge + server
  // watermark) and lazily loads its first history page; home/transport deselect.
  useEffect(() => {
    if (route.view !== "chat") {
      dispatch({ kind: "select", peer: undefined });
      return;
    }
    const peer = route.peer;
    dispatch({ kind: "select", peer });
    // groups/tags (§15) have no unread watermark — skip markRead for a known
    // broadcast target; an unknown/not-yet-loaded name is treated as an agent.
    // A user chat (§17.7) DOES have one: a colleague's message is unread exactly
    // like an agent's, so opening it must move the server watermark too.
    const known = stateRef.current.peers.find((info) => info.name === peer);
    const kind = known === undefined ? "agent" : peerKind(known);
    if (kind === "agent" || kind === "user") void api.markRead(peer);
    if (!threadOf(stateRef.current, peer).loaded) {
      void api.fetchHistory(peer).then((page) => dispatch({ kind: "page", peer, page }));
    }
  }, [route]);

  const navigate = useCallback((target: Route): void => {
    location.hash = routeHash(target);
  }, []);

  const loadOlder = useCallback((peer: string): void => {
    const cursor = threadOf(stateRef.current, peer).nextBefore;
    if (cursor === undefined) return;
    void api.fetchHistory(peer, cursor).then((page) => dispatch({ kind: "page", peer, page }));
  }, []);

  const send = useCallback(async (to: string, draft: Draft, replyTo?: string): Promise<void> => {
    const id = api.newMessageId(); // §10.9: the client owns the retry id
    const blobs = draft.blobs.map((blob) => blob.id);
    await api.sendMessage({
      to,
      id,
      ...(draft.text !== "" ? { text: draft.text } : {}),
      ...(blobs.length > 0 ? { blobs } : {}),
      // The quote travels in the ENVELOPE (FR-178) — the payload is what was
      // typed, nothing is pasted into it.
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    dispatch({
      kind: "outgoing",
      record: {
        id,
        // Our own NAME (T236): the bubble prints its route (FR-148), and the
        // placeholder used to surface there as a literal "(me) → agent". The
        // server echoes the same record with the same name — the id dedup keeps
        // one bubble. A legacy panel (§17.9) has no name and keeps the marker.
        from: selfName.current ?? "(me)",
        to,
        kind: "message",
        ts: Date.now(),
        ...(replyTo !== undefined ? { replyTo } : {}),
        payload:
          blobs.length === 0
            ? draft.text
            : {
                ...(draft.text !== "" ? { text: draft.text } : {}),
                blobs: draft.blobs.map((blob) => ({
                  blob: blob.id,
                  name: blob.name,
                  mime: blob.mime,
                  size: blob.size,
                })),
              },
      },
    });
  }, []);

  const openChat = route.view === "chat" ? route.peer : undefined;
  const openPeer =
    openChat !== undefined ? state.peers.find((info) => info.name === openChat) : undefined;
  // Groups & tags (§15) are input-only broadcast targets: no live status, so no
  // "thinking" wash.
  const openIsBroadcast = openPeer !== undefined && chatSurface(openPeer) === "broadcast";
  // Console-backed affordances (slash commands FR-66, the console §12.9) exist
  // only behind an AGENT: a person (§17.7) has no terminal, so the
  // server would reject them — the composer must not offer them at all.
  const openHasConsole = hasConsole(openPeer);
  // Reactions (§19, FR-161/FR-168): are they configured on this server at all?
  // One probe at mount — a 409 (REACTIONS_DISABLED) means no catalog, so no bubble
  // ever draws a trigger. The picker re-reads the catalog when it opens, because
  // the Recent order moves as the stand reacts (§19.8).
  const [reactionsEnabled, setReactionsEnabled] = useState(false);
  useEffect(() => {
    void api
      .fetchReactionCatalog()
      .then((catalog) => setReactionsEnabled(catalog.items.length > 0))
      .catch(() => setReactionsEnabled(false));
  }, []);
  const reactionsApi = useMemo<ReactionsApi>(
    () => ({
      enabled: reactionsEnabled,
      reactionsOf: (messageId) => reactionsOf(stateRef.current, messageId),
      onChanged: (messageId, reactions) => dispatch({ kind: "reactions", messageId, reactions }),
    }),
    [reactionsEnabled],
  );
  // The toolbar's chat half follows the open chat (§12.10.5). The peer object is
  // the store's, so this fires when the chat changes AND when its status/flags
  // do — a pinned Pause button must show the pause the WS push just brought.
  const onSurface = props.onSurface;
  useEffect(() => onSurface(openPeer), [openPeer, onSurface]);
  // The message being answered (FR-178, T292): picked in the feed, shown as the
  // composer's chip, sent as the envelope's `replyTo`. It lives HERE because the
  // feed and the composer are siblings — and it is dropped when the chat changes
  // (a quote belongs to one conversation) or when the send lands.
  const [replyTo, setReplyTo] = useState<ChatRecord | undefined>(undefined);
  // Command-fanout modal (§15.8, FR-115): launched from a group/tag chat, seeded
  // with that target; closed automatically when the open chat changes.
  const [commandOpen, setCommandOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to CLOSE the modal whenever the open chat changes (the body doesn't read openChat, it reacts to it)
  useEffect(() => setCommandOpen(false), [openChat]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: same — a quote is dropped when the open chat changes
  useEffect(() => setReplyTo(undefined), [openChat]);
  return (
    <ReactionsContext.Provider value={reactionsApi}>
      <div className="panel">
        <PeerList
          peers={visiblePeers(state.peers, visibility)}
          selected={openChat}
          onSelect={(peer) => navigate({ view: "chat", peer })}
          transportSelected={route.view === "transport"}
          /* The journal is an admin capability (§17.7, FR-131): a plain user gets no
           entry at all — the endpoint answers 403 for them anyway. */
          {...(props.transport && role !== "user"
            ? { onTransport: () => navigate({ view: "transport" }) }
            : {})}
          flat={props.flat}
          collapsed={props.collapsed}
          filterPanel={props.agentFilter}
        />
        {route.view === "transport" ? (
          <main className="chat-pane">
            <TransportView
              live={transportLive}
              follow={props.follow}
              query={props.query}
              {...(route.from !== undefined ? { from: route.from } : {})}
              {...(route.to !== undefined ? { to: route.to } : {})}
              // FR-85: the selection PROJECTS into the URL and round-trips back via
              // the route; replace() — filter toggles must not pile up in history
              onFilters={(from, to) =>
                location.replace(
                  routeHash({
                    view: "transport",
                    ...(from.length > 0 ? { from } : {}),
                    ...(to.length > 0 ? { to } : {}),
                  }),
                )
              }
            />
          </main>
        ) : route.view === "settings" ? (
          <main className="chat-pane">
            {/* the checklist gets the FULL list of AGENTS — hidden agents must stay
              pickable; groups/tags (§15) are not per-agent visibility toggles */}
            <SettingsView
              follow={props.follow}
              onFollow={props.onFollow}
              theme={props.theme}
              onTheme={props.onTheme}
              lang={props.lang}
              onLang={props.onLang}
              transport={props.transport}
              onTransport={props.onTransport}
              flat={props.flat}
              onFlat={props.onFlat}
              agentFilter={props.agentFilter}
              onAgentFilter={props.onAgentFilter}
              showTokens={props.showTokens}
              onShowTokens={props.onShowTokens}
              tools={props.tools}
              onTools={props.onTools}
              peers={state.peers.filter(
                // local agents only — a federated peer (§18.4) is not a visibility toggle
                (peer) => peerKind(peer) === "agent" && peer.server === undefined,
              )}
              visibility={visibility}
              onVisibility={setVisibility}
              serverInfo={serverInfo}
            />
          </main>
        ) : openChat !== undefined ? (
          /* the agent's accent tints the whole pane (FR-73): a soft gradient
           normally, an animated one while the agent is thinking (busy) */
          <main
            className={`chat-pane tinted${openPeer?.status === "busy" ? " thinking" : ""}`}
            style={
              { "--agent-color": agentColor(openChat, openPeer?.color) } as React.CSSProperties
            }
          >
            <ChatView
              peer={openPeer}
              thread={threadOf(state, openChat)}
              phases={state.phases}
              isPeer={(name) => peerSet.current.has(name)}
              self={self}
              onLoadOlder={() => loadOlder(openChat)}
              follow={props.follow}
              showTokens={props.showTokens}
              query={props.query}
              anchor={route.view === "chat" ? route.message : undefined}
              onReply={setReplyTo}
            />
            {openIsBroadcast && (
              /* a group/tag can't receive a one-directional broadcast COMMAND on the
               message path — the slash-command fan-out (§15.8, FR-115) runs it on
               the INTERSECTION of the target + any extra selectors, per-agent */
              <div className="broadcast-actions">
                <button
                  type="button"
                  className="cmdfan-launch"
                  onClick={() => setCommandOpen(true)}
                >
                  {t("⌘ Slash command")}
                </button>
              </div>
            )}
            <Composer
              key={openChat}
              peer={openChat}
              onSend={async (draft) => {
                await send(openChat, draft, replyTo?.id);
                setReplyTo(undefined); // the quote belongs to the message that just left
              }}
              {...(replyTo !== undefined
                ? {
                    replyTo: {
                      id: replyTo.id,
                      author: replyTo.from,
                      preview: quotePreview(replyTo, t),
                    },
                    onCancelReply: () => setReplyTo(undefined),
                  }
                : {})}
              commands={openHasConsole ? (openPeer?.commands ?? []) : []}
              onCommand={(slash) => api.runAgentCommand(openChat, slash)}
              /* the pause note (§16.6, FR-120); a group/tag is never paused (§16.1) */
              paused={openIsBroadcast ? false : openPeer?.paused === true}
              /* …but for a person the same flag is their do-not-disturb (§17.8) */
              dnd={chatSurface(openPeer) === "person"}
            />
            {commandOpen && (
              <CommandFanout
                peers={state.peers}
                initialSelector={openChat}
                onClose={() => setCommandOpen(false)}
              />
            )}
          </main>
        ) : (
          <main className="chat-pane empty">{t("Select an agent to start chatting")}</main>
        )}
      </div>
    </ReactionsContext.Provider>
  );
}
